// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Graceful shutdown with connection draining (issue #827).
 *
 * Uses a real HTTP server for the request scenarios and a fake worker with the
 * same close()/moveToWait() contract as BullMQ for the job scenarios.
 */

import http from "http";
import type { AddressInfo } from "net";
import express from "express";
import request from "supertest";

jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../services/db.js", () => ({
  prisma: { $queryRaw: jest.fn().mockResolvedValue([{ "?column?": 1 }]) },
}));
jest.mock("../config.js", () => ({ loadConfig: () => ({ horizonUrl: "http://horizon.invalid" }) }));

import {
  ActiveJobTracker,
  drainWorker,
  gracefulShutdown,
  getInFlightRequestCount,
  inFlightRequestTracker,
  isShuttingDown,
  loadShutdownTimeouts,
  resetGracefulShutdown,
  type DrainableWorker,
} from "../services/gracefulShutdown.js";
import { healthRouter } from "../routes/health.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => resetGracefulShutdown());

// ── helpers ──────────────────────────────────────────────────────────────

function buildApp(slowMs = 300) {
  const app = express();
  app.use(inFlightRequestTracker());
  app.use("/api/health", healthRouter);
  app.get("/slow", async (_req, res) => {
    await sleep(slowMs);
    res.json({ done: true });
  });
  app.get("/fast", (_req, res) => res.json({ done: true }));
  return app;
}

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

function get(port: number, path: string, agent?: http.Agent): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http
      .get({ port, path, agent: agent ?? false }, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null, headers: res.headers })
        );
      })
      .on("error", reject);
  });
}

/** A BullMQ-shaped worker running jobs we control the completion of. */
function fakeWorker() {
  const running = new Map<string, { finish: () => void; requeue: jest.Mock }>();
  const completed: string[] = [];
  const requeued: string[] = [];
  const tracker = new ActiveJobTracker();
  let closing: Promise<void> | null = null;
  const closeCalls: Array<boolean | undefined> = [];

  const processor = tracker.wrap(async (job: { id: string; moveToWait: jest.Mock }) => {
    await new Promise<void>((resolve) => running.set(job.id, { finish: resolve, requeue: job.moveToWait }));
    running.delete(job.id);
    completed.push(job.id);
  });

  const worker: DrainableWorker = {
    close: jest.fn(async (force?: boolean) => {
      closeCalls.push(force);
      if (force) return;
      // Graceful close resolves only once every running job has finished.
      closing ??= (async () => {
        while (running.size > 0) await sleep(5);
      })();
      await closing;
    }),
  };

  const start = (id: string) => {
    const moveToWait = jest.fn(async () => {
      requeued.push(id);
      return 0;
    });
    const done = processor({ id, moveToWait } as any, `token-${id}`);
    return { done, moveToWait };
  };

  return { worker, tracker, start, running, completed, requeued, closeCalls };
}

// ── readiness ────────────────────────────────────────────────────────────

describe("readiness probe", () => {
  it("is ready while serving", async () => {
    const res = await request(buildApp()).get("/api/health/ready");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
  });

  it("fails immediately once shutdown begins, without consulting the database", async () => {
    const { server } = await listen(buildApp());
    const { prisma } = jest.requireMock("../services/db.js");
    prisma.$queryRaw.mockClear();

    const pending = gracefulShutdown("SIGTERM", { server, requestTimeoutMs: 1_000, jobTimeoutMs: 1_000 });
    expect(isShuttingDown()).toBe(true);

    const app = buildApp();
    const ready = await request(app).get("/api/health/ready");
    expect(ready.status).toBe(503);
    expect(ready.body.status).toBe("shutting_down");
    expect(prisma.$queryRaw).not.toHaveBeenCalled();

    // The general health check fails too; liveness keeps passing.
    expect((await request(app).get("/api/health")).status).toBe(503);
    expect((await request(app).get("/api/health/live")).status).toBe(200);
    await pending;
  });
});

// ── in-flight request ────────────────────────────────────────────────────

describe("shutdown during an active request", () => {
  it("lets the in-flight request complete, then refuses new connections", async () => {
    const { server, port } = await listen(buildApp(300));
    const closeResources = jest.fn().mockResolvedValue(undefined);

    const inFlight = get(port, "/slow");
    await sleep(50);
    expect(getInFlightRequestCount()).toBe(1);

    const shutdown = gracefulShutdown("SIGTERM", {
      server,
      requestTimeoutMs: 5_000,
      jobTimeoutMs: 1_000,
      closeResources: [{ name: "db", close: closeResources }],
    });

    // The request that started before SIGTERM still succeeds...
    const res = await inFlight;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ done: true });

    const result = await shutdown;
    expect(result.http.forced).toBe(false);
    expect(getInFlightRequestCount()).toBe(0);
    // ...and shared resources are only closed after it finished.
    expect(closeResources).toHaveBeenCalledTimes(1);
    expect(server.listening).toBe(false);

    // ...while a brand-new connection can no longer be made.
    await expect(get(port, "/fast")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("turns away a new request on an already-open keep-alive connection with 503", async () => {
    const { server, port } = await listen(buildApp(300));
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

    expect((await get(port, "/fast", agent)).status).toBe(200); // socket now idle but open
    const inFlight = get(port, "/slow", agent);
    await sleep(50);
    const shutdown = gracefulShutdown("SIGTERM", { server, requestTimeoutMs: 5_000, jobTimeoutMs: 1_000 });
    await sleep(20);

    // Queued behind the slow request on the same socket, so it starts after SIGTERM.
    const late = get(port, "/fast", agent);
    expect((await inFlight).status).toBe(200);
    const lateRes = await late.catch(() => null);
    // Either rejected with 503 on the old socket, or the socket was already closed.
    if (lateRes) {
      expect(lateRes.status).toBe(503);
      expect(lateRes.body.error).toBe("shutting_down");
      expect(lateRes.headers["retry-after"]).toBe("1");
    }
    await shutdown;
    agent.destroy();
  });

  it("cuts off requests still running at the timeout", async () => {
    const { server, port } = await listen(buildApp(2_000));
    const inFlight = get(port, "/slow").catch((e) => e);
    await sleep(50);

    const result = await gracefulShutdown("SIGTERM", { server, requestTimeoutMs: 100, jobTimeoutMs: 100 });
    expect(result.http.forced).toBe(true);
    expect(result.http.inFlightAtTimeout).toBe(1);
    expect((await inFlight).message).toMatch(/socket hang up|ECONNRESET/);
  });

  it("serves the real response before closing an idle keep-alive socket", async () => {
    const { server, port } = await listen(buildApp());
    const agent = new http.Agent({ keepAlive: true });
    expect((await get(port, "/fast", agent)).status).toBe(200);

    // An idle keep-alive socket must not hold the drain open until its timeout.
    const startedAt = Date.now();
    const result = await gracefulShutdown("SIGTERM", { server, requestTimeoutMs: 5_000, jobTimeoutMs: 1_000 });
    expect(result.http.forced).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    agent.destroy();
  });
});

// ── active job ───────────────────────────────────────────────────────────

describe("shutdown during an active job", () => {
  it("waits for a running job to finish and neither loses nor reruns it", async () => {
    const w = fakeWorker();
    const job = w.start("job-1");
    await sleep(10);
    expect(w.tracker.size).toBe(1);

    const draining = drainWorker("notifications", w.worker, 5_000, w.tracker);
    await sleep(30);
    // Still running: the drain is waiting, nothing was forced or requeued.
    expect(w.completed).toEqual([]);
    expect(w.requeued).toEqual([]);

    w.running.get("job-1")!.finish();
    await job.done;
    const result = await draining;

    expect(result).toEqual({ name: "notifications", forced: false, requeued: 0 });
    expect(w.completed).toEqual(["job-1"]); // ran to completion exactly once
    expect(job.moveToWait).not.toHaveBeenCalled(); // so it is not requeued/duplicated
    expect(w.closeCalls).toEqual([undefined]); // graceful close only, never forced
    expect(w.tracker.size).toBe(0);
  });

  it("requeues a job that outlives the timeout instead of losing it", async () => {
    const w = fakeWorker();
    const stuck = w.start("stuck");
    const finishing = w.start("finishing");
    await sleep(10);
    w.running.get("finishing")!.finish();
    await finishing.done;

    const result = await drainWorker("webhooks", w.worker, 50, w.tracker);

    expect(result).toEqual({ name: "webhooks", forced: true, requeued: 1 });
    // Only the job still running was handed back to the queue, once, with its lock token.
    expect(w.requeued).toEqual(["stuck"]);
    expect(stuck.moveToWait).toHaveBeenCalledTimes(1);
    expect(stuck.moveToWait).toHaveBeenCalledWith("token-stuck");
    expect(finishing.moveToWait).not.toHaveBeenCalled();
    expect(w.completed).toEqual(["finishing"]);
    // Requeue happens before the worker is cut loose (so locks are still held).
    expect(w.closeCalls).toEqual([undefined, true]);
  });

  it("keeps going when a job cannot be requeued", async () => {
    const w = fakeWorker();
    const job = w.start("locked");
    await sleep(10);
    job.moveToWait.mockRejectedValueOnce(new Error("Missing lock"));

    const result = await drainWorker("analytics", w.worker, 30, w.tracker);
    expect(result).toEqual({ name: "analytics", forced: true, requeued: 0 });
    expect(w.closeCalls).toEqual([undefined, true]);
  });

  it("drains workers alongside the HTTP server in a full shutdown", async () => {
    const { server } = await listen(buildApp());
    const w = fakeWorker();
    const job = w.start("job-1");
    await sleep(10);
    setTimeout(() => w.running.get("job-1")!.finish(), 60);

    const result = await gracefulShutdown("SIGTERM", {
      server,
      requestTimeoutMs: 1_000,
      jobTimeoutMs: 1_000,
      drainWorkers: [(timeout) => drainWorker("notifications", w.worker, timeout, w.tracker)],
    });
    await job.done;

    expect(result.workers).toEqual([{ name: "notifications", forced: false, requeued: 0 }]);
    expect(w.completed).toEqual(["job-1"]);
    expect(w.requeued).toEqual([]);
  });
});

// ── orchestration ────────────────────────────────────────────────────────

describe("gracefulShutdown", () => {
  it("stops schedulers, then closes shared resources in order after draining", async () => {
    const { server } = await listen(buildApp());
    const order: string[] = [];
    const w = fakeWorker();

    await gracefulShutdown("SIGTERM", {
      server,
      requestTimeoutMs: 1_000,
      jobTimeoutMs: 1_000,
      stopSchedulers: [() => order.push("scheduler-a"), () => order.push("scheduler-b")],
      drainWorkers: [
        async () => {
          order.push("workers-drained");
        },
      ],
      closeResources: [
        { name: "queues", close: async () => void order.push("queues") },
        { name: "redis", close: async () => void order.push("redis") },
        { name: "database", close: async () => void order.push("database") },
      ],
    });

    expect(order).toEqual(["scheduler-a", "scheduler-b", "workers-drained", "queues", "redis", "database"]);
    expect(w.closeCalls).toEqual([]);
  });

  it("still closes the remaining resources when one fails, and reports it", async () => {
    const { server } = await listen(buildApp());
    const database = jest.fn().mockResolvedValue(undefined);

    const result = await gracefulShutdown("SIGTERM", {
      server,
      requestTimeoutMs: 1_000,
      jobTimeoutMs: 1_000,
      closeResources: [
        { name: "redis", close: async () => Promise.reject(new Error("boom")) },
        { name: "database", close: database },
      ],
    });

    expect(database).toHaveBeenCalledTimes(1);
    expect(result.errors).toEqual(["redis"]);
  });

  it("runs once even when signalled repeatedly", async () => {
    const { server } = await listen(buildApp());
    const stop = jest.fn();
    const plan = { server, requestTimeoutMs: 1_000, jobTimeoutMs: 1_000, stopSchedulers: [stop] };

    const first = gracefulShutdown("SIGTERM", plan);
    const second = gracefulShutdown("SIGINT", plan);
    expect(second).toBe(first);
    await first;
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("loadShutdownTimeouts", () => {
  it("defaults inside a 30s termination grace period", () => {
    const t = loadShutdownTimeouts({});
    expect(Math.max(t.requestTimeoutMs, t.jobTimeoutMs)).toBeLessThan(30_000);
  });

  it("honours overrides and ignores invalid values", () => {
    expect(loadShutdownTimeouts({ SHUTDOWN_REQUEST_TIMEOUT_MS: "2500", SHUTDOWN_JOB_TIMEOUT_MS: "nope" })).toEqual({
      requestTimeoutMs: 2_500,
      jobTimeoutMs: 15_000,
    });
  });
});
