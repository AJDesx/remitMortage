// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Tamper-evident hash chain for the audit log (issue #861).
 *
 * Anyone with database write access could previously alter or delete audit rows
 * without leaving a trace. Each audit entry now carries, in its `metadata`:
 *
 *   - `__chainPrevHash` — the `__chainHash` of the previous entry (or the
 *     genesis hash for the first entry), and
 *   - `__chainHash`     — SHA-256 over `prevHash` + the entry's canonical
 *     content.
 *
 * Editing, inserting or deleting a row breaks the recomputed chain, and the
 * head hash can be published to an external store so history cannot be silently
 * rewritten. The reserved keys are stripped before canonicalisation, so the
 * hash covers only the entry's real content.
 *
 * The primitives here are pure so they can be verified against rows fetched
 * from the database or supplied directly in tests.
 */

import { createHash } from "node:crypto";
import { prisma } from "./db.js";
import logger from "../utils/logger.js";

export const CHAIN_HASH_KEY = "__chainHash";
export const CHAIN_PREV_KEY = "__chainPrevHash";
export const GENESIS_PREV_HASH = "0".repeat(64);

export type AuditMetadata = Record<string, unknown>;

export interface AuditEntryInput {
  id: string;
  action: string;
  actorAddress?: string | null;
  ipAddress?: string | null;
  metadata?: AuditMetadata | null;
  createdAt: string | Date;
}

export interface ChainedAuditEntry extends AuditEntryInput {
  chainHash: string;
  chainPrevHash: string;
}

export interface ChainVerification {
  ok: boolean;
  /** Number of entries verified before a break (or the full count when ok). */
  verified: number;
  /** Chain head hash after the verified prefix. */
  head: string;
  brokenAt?: { index: number; id?: string; reason: "previous_hash_mismatch" | "hash_mismatch" };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Removes the reserved chain keys so they are not part of the hashed content. */
export function stripChainKeys(metadata: AuditMetadata | null | undefined): AuditMetadata | null {
  if (!metadata) return null;
  const { [CHAIN_HASH_KEY]: _h, [CHAIN_PREV_KEY]: _p, ...rest } = metadata;
  return rest;
}

/** Deterministic canonical form of an entry's real content. */
export function canonicalEntry(entry: AuditEntryInput): string {
  return stableStringify({
    action: entry.action,
    actorAddress: entry.actorAddress ?? null,
    ipAddress: entry.ipAddress ?? null,
    metadata: stripChainKeys(entry.metadata),
    createdAt: toIso(entry.createdAt),
  });
}

/** SHA-256 over `prevHash` + the entry's canonical content. */
export function computeChainHash(entry: AuditEntryInput, prevHash: string): string {
  return createHash("sha256").update(`${prevHash}:${canonicalEntry(entry)}`).digest("hex");
}

/** Returns `metadata` with the chain fields attached for persistence. */
export function withChainMetadata(
  metadata: AuditMetadata | null | undefined,
  chainHash: string,
  chainPrevHash: string
): AuditMetadata {
  return { ...(stripChainKeys(metadata) ?? {}), [CHAIN_PREV_KEY]: chainPrevHash, [CHAIN_HASH_KEY]: chainHash };
}

export function storedChainHash(entry: AuditEntryInput): string | undefined {
  const value = entry.metadata?.[CHAIN_HASH_KEY];
  return typeof value === "string" ? value : undefined;
}

export function storedChainPrevHash(entry: AuditEntryInput): string | undefined {
  const value = entry.metadata?.[CHAIN_PREV_KEY];
  return typeof value === "string" ? value : undefined;
}

/** Builds a fully linked chain from un-chained entries (used for backfill/tests). */
export function buildChain(entries: AuditEntryInput[], anchorPrevHash = GENESIS_PREV_HASH): ChainedAuditEntry[] {
  let prev = anchorPrevHash;
  const out: ChainedAuditEntry[] = [];
  for (const entry of entries) {
    const chainHash = computeChainHash(entry, prev);
    out.push({ ...entry, chainHash, chainPrevHash: prev });
    prev = chainHash;
  }
  return out;
}

/**
 * Verifies linkage and content of a contiguous range of entries.
 *
 * `anchorPrevHash` is the hash the first entry must chain back to — the
 * genesis hash when verifying from the start of the log, or the hash of the
 * entry immediately before the range.
 */
export function verifyChain(
  entries: AuditEntryInput[],
  anchorPrevHash: string = GENESIS_PREV_HASH
): ChainVerification {
  let prev = anchorPrevHash;
  let verified = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const storedPrev = storedChainPrevHash(entry);
    const storedHash = storedChainHash(entry);

    if (storedPrev !== prev) {
      return {
        ok: false,
        verified,
        head: prev,
        brokenAt: { index: i, id: entry.id, reason: "previous_hash_mismatch" },
      };
    }

    const expected = computeChainHash(entry, storedPrev);
    if (storedHash !== expected) {
      return {
        ok: false,
        verified,
        head: prev,
        brokenAt: { index: i, id: entry.id, reason: "hash_mismatch" },
      };
    }

    prev = storedHash!;
    verified += 1;
  }

  return { ok: true, verified, head: prev };
}

export interface ChainHead {
  hash: string;
  count: number;
  publishedAt: string;
}

/** External store for the chain head (e.g. object storage, a transparency log). */
export interface ChainHeadSink {
  publish(head: ChainHead): Promise<void>;
}

/**
 * Publishes the current chain head so history cannot be silently rewritten.
 * A later verification recomputes the head and compares it to the published
 * value.
 */
export async function publishChainHead(
  entries: AuditEntryInput[],
  sink: ChainHeadSink,
  now: Date = new Date()
): Promise<ChainHead> {
  const { head } = verifyChain(entries);
  const chainHead: ChainHead = { hash: head, count: entries.length, publishedAt: now.toISOString() };
  await sink.publish(chainHead);
  return chainHead;
}

/** In-memory sink, useful for tests and as a no-op default. */
export class InMemoryChainHeadSink implements ChainHeadSink {
  public heads: ChainHead[] = [];

  async publish(head: ChainHead): Promise<void> {
    this.heads.push(head);
  }

  get latest(): ChainHead | undefined {
    return this.heads[this.heads.length - 1];
  }
}

/** DB-backed sink writing the head to a small JSON line via logger (best effort). */
export class LoggingChainHeadSink implements ChainHeadSink {
  async publish(head: ChainHead): Promise<void> {
    logger.info("[audit-chain] published chain head", head);
  }
}

/**
 * Reads a contiguous range from the audit log (oldest first) and verifies the
 * chain. When `from` is supplied the immediately preceding entry is fetched to
 * anchor the range; otherwise the range is verified from genesis.
 */
export async function verifyAuditRange(
  range: { from?: Date; to?: Date } = {}
): Promise<ChainVerification> {
  const rows = (await prisma.auditLog.findMany({
    where: {
      ...(range.from ? { createdAt: { gte: range.from } } : {}),
      ...(range.to ? { createdAt: { lte: range.to } } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })) as unknown as Array<AuditEntryInput & { metadata?: AuditMetadata | null }>;

  let anchor = GENESIS_PREV_HASH;
  if (range.from) {
    const before = (await prisma.auditLog.findFirst({
      where: { createdAt: { lt: range.from } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    })) as unknown as (AuditEntryInput & { metadata?: AuditMetadata | null }) | null;
    anchor = (before && storedChainHash(before)) ?? GENESIS_PREV_HASH;
  }

  return verifyChain(rows, anchor);
}
