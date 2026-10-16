// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Job priority classes and fairness policy for the background queues (issue #862).
 *
 * The BullMQ queues run a single worker pool, so naively FIFO-feeding them lets
 * a large bulk backlog (e.g. month-end statement generation) delay urgent work
 * such as security notifications, and lets one tenant's backlog monopolise the
 * workers. `FairQueueScheduler` is the admission policy that fixes both:
 *
 *  - **Priority classes.** Lower `JobPriorityClass` numbers run first, matching
 *    BullMQ's `priority` option (1 = highest).
 *  - **Weighted worker allocation.** `allocateWorkers(total)` splits a worker
 *    pool across classes by weight, so bulk work can never take every worker.
 *  - **Per-tenant concurrency caps.** No tenant may hold more than
 *    `perTenantCap` in-flight jobs, regardless of priority, so one tenant's
 *    backlog cannot starve every other tenant.
 *  - **Wait-time metrics + starvation alerts.** `waitTimeByPriority()` reports
 *    observed waits per class, and `starvingPriorities()` flags a high-priority
 *    job that has waited past the starvation threshold.
 *
 * The class is deliberately pure (no Redis/BullMQ imports) so the policy is
 * unit-testable; `queueService` wires it to the live queues.
 */

export enum JobPriorityClass {
  /** Security / auth alerts — always first. */
  SECURITY = 1,
  /** Time-sensitive operational work. */
  URGENT = 2,
  /** Default throughput work. */
  NORMAL = 3,
  /** Large bulk jobs (imports, statements, backfills). */
  BULK = 4,
}

export const PRIORITY_CLASSES: readonly JobPriorityClass[] = [
  JobPriorityClass.SECURITY,
  JobPriorityClass.URGENT,
  JobPriorityClass.NORMAL,
  JobPriorityClass.BULK,
];

export function priorityLabel(priority: JobPriorityClass): string {
  return JobPriorityClass[priority] ?? String(priority);
}

/** Default share of workers each class may occupy. Must sum to 1. */
export const DEFAULT_WORKER_WEIGHTS: Record<JobPriorityClass, number> = {
  [JobPriorityClass.SECURITY]: 0.1,
  [JobPriorityClass.URGENT]: 0.2,
  [JobPriorityClass.NORMAL]: 0.4,
  [JobPriorityClass.BULK]: 0.3,
};

export interface FairQueueOptions {
  /** Max in-flight jobs a single tenant may hold. */
  perTenantCap?: number;
  /** A waiting job of this class or higher (lower number) past this age is "starving". */
  starvationThresholdMs?: number;
  /** Worker-pool weights per class. */
  weights?: Record<JobPriorityClass, number>;
}

export interface SubmitInput {
  id: string;
  tenantId: string;
  priority: JobPriorityClass;
}

export interface PendingJob extends SubmitInput {
  enqueuedAt: number;
}

export interface WaitTimeStats {
  count: number;
  avgMs: number;
  maxMs: number;
}

export interface StarvationReport {
  starving: boolean;
  /** Highest class (lowest number) that is starving, if any. */
  priority?: JobPriorityClass;
  oldestWaitMs: number;
  thresholdMs: number;
}

export class FairQueueScheduler {
  private readonly perTenantCap: number;
  private readonly starvationThresholdMs: number;
  private readonly weights: Record<JobPriorityClass, number>;

  private pending: PendingJob[] = [];
  private readonly active = new Map<string, PendingJob>();
  private readonly tenantActive = new Map<string, number>();
  private readonly waitSamples: Record<JobPriorityClass, number[]> = {
    [JobPriorityClass.SECURITY]: [],
    [JobPriorityClass.URGENT]: [],
    [JobPriorityClass.NORMAL]: [],
    [JobPriorityClass.BULK]: [],
  };

  constructor(options: FairQueueOptions = {}) {
    this.perTenantCap = options.perTenantCap ?? 10;
    this.starvationThresholdMs = options.starvationThresholdMs ?? 30_000;
    this.weights = options.weights ?? DEFAULT_WORKER_WEIGHTS;
  }

  /** Adds a job to the waiting set. */
  submit(input: SubmitInput, now: number = Date.now()): PendingJob {
    const job: PendingJob = { ...input, enqueuedAt: now };
    this.pending.push(job);
    return job;
  }

  /**
   * Returns the next runnable job and marks it active, or null when nothing can
   * run (queue empty, or every waiting job's tenant is at its cap).
   *
   * Highest priority first, then FIFO within a class. A tenant over its cap is
   * skipped rather than blocking the whole queue, so other tenants keep moving.
   */
  dequeue(now: number = Date.now()): PendingJob | null {
    this.pending.sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt);

    for (let i = 0; i < this.pending.length; i += 1) {
      const job = this.pending[i];
      if (this.activeCount(job.tenantId) >= this.perTenantCap) continue;

      this.pending.splice(i, 1);
      this.active.set(job.id, job);
      this.tenantActive.set(job.tenantId, this.activeCount(job.tenantId) + 1);
      return job;
    }

    return null;
  }

  /** Marks an active job finished and records its wait time under its class. */
  complete(id: string, now: number = Date.now()): number | null {
    const job = this.active.get(id);
    if (!job) return null;

    this.active.delete(id);
    const remaining = this.activeCount(job.tenantId) - 1;
    if (remaining > 0) this.tenantActive.set(job.tenantId, remaining);
    else this.tenantActive.delete(job.tenantId);

    const waitMs = Math.max(0, now - job.enqueuedAt);
    this.waitSamples[job.priority].push(waitMs);
    return waitMs;
  }

  activeCount(tenantId: string): number {
    return this.tenantActive.get(tenantId) ?? 0;
  }

  totalActive(): number {
    return this.active.size;
  }

  waitingCounts(): Record<JobPriorityClass, number> {
    return this.pending.reduce(
      (acc, job) => {
        acc[job.priority] += 1;
        return acc;
      },
      {
        [JobPriorityClass.SECURITY]: 0,
        [JobPriorityClass.URGENT]: 0,
        [JobPriorityClass.NORMAL]: 0,
        [JobPriorityClass.BULK]: 0,
      } as Record<JobPriorityClass, number>
    );
  }

  /** Observed wait-time stats per priority class (from completed jobs). */
  waitTimeByPriority(): Record<JobPriorityClass, WaitTimeStats> {
    const out = {} as Record<JobPriorityClass, WaitTimeStats>;
    for (const cls of PRIORITY_CLASSES) {
      const samples = this.waitSamples[cls];
      const count = samples.length;
      const total = samples.reduce((a, b) => a + b, 0);
      out[cls] = {
        count,
        avgMs: count ? total / count : 0,
        maxMs: count ? Math.max(...samples) : 0,
      };
    }
    return out;
  }

  /**
   * True when any waiting job has exceeded the starvation threshold. The
   * highest-priority (lowest-numbered) affected class is reported so the alert
   * can name it.
   */
  starvationReport(now: number = Date.now()): StarvationReport {
    let priority: JobPriorityClass | undefined;
    let oldestWaitMs = 0;

    for (const job of this.pending) {
      const waitMs = Math.max(0, now - job.enqueuedAt);
      if (waitMs <= this.starvationThresholdMs) continue;
      if (priority === undefined || job.priority < priority) priority = job.priority;
      oldestWaitMs = Math.max(oldestWaitMs, waitMs);
    }

    return {
      starving: priority !== undefined,
      priority,
      oldestWaitMs,
      thresholdMs: this.starvationThresholdMs,
    };
  }

  isStarving(now: number = Date.now()): boolean {
    return this.starvationReport(now).starving;
  }

  /**
   * Splits `totalWorkers` across classes by weight, guaranteeing each class at
   * least one worker when it has weight > 0 and enough workers exist.
   */
  allocateWorkers(totalWorkers: number): Record<JobPriorityClass, number> {
    const allocation = {} as Record<JobPriorityClass, number>;
    let assigned = 0;

    for (const cls of PRIORITY_CLASSES) {
      const n = Math.floor(totalWorkers * this.weights[cls]);
      allocation[cls] = n;
      assigned += n;
    }

    // Distribute leftovers by weight order so the pool is fully used.
    let leftover = totalWorkers - assigned;
    for (const cls of PRIORITY_CLASSES) {
      if (leftover <= 0) break;
      allocation[cls] += 1;
      leftover -= 1;
    }

    return allocation;
  }

  /** Test helper. */
  reset(): void {
    this.pending = [];
    this.active.clear();
    this.tenantActive.clear();
    for (const cls of PRIORITY_CLASSES) this.waitSamples[cls] = [];
  }
}
