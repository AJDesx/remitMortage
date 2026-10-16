// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Admin full-text search across loans, applicants and KYC documents
 * (issue #826).
 *
 * Admins used to find records only by exact identifier. This searches the
 * fields they actually remember — an applicant's name fragment, a status, a
 * wallet address prefix, a document file name — with PostgreSQL full-text
 * indexes (see adminSearchSql.ts), and returns one relevance-ranked,
 * paginated list.
 *
 *  - Permissions: each caller may search only the entity types their identity
 *    is allowed (API-key callers have no accountable person behind them, so
 *    KYC documents are off-limits to them by default). Entity types the
 *    caller may not see are never queried, and asking for one is a 403.
 *  - PII: results never carry names, full addresses or file names. Each hit
 *    has a masked label and snippet plus the id to open the record through
 *    the normal, access-controlled endpoints.
 *  - Audit: every search (and every denied attempt) is written to the audit
 *    log with who searched for what.
 *  - Safety: user text is reduced to alphanumeric tokens and bound as a
 *    parameter; it is never interpolated into SQL or tsquery operators.
 */

import { prisma } from "./db.js";
import { logAudit } from "./audit.js";
import { LOAN_SEARCH_SQL, APPLICANT_SEARCH_SQL, DOCUMENT_SEARCH_SQL } from "./adminSearchSql.js";

export const SEARCH_ENTITIES = ["loans", "applicants", "documents"] as const;
export type SearchEntity = (typeof SEARCH_ENTITIES)[number];
export type SearchResultType = "loan" | "applicant" | "document";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;
/** page * pageSize may not exceed this: deep offsets are served by narrowing the query, not paging. */
export const MAX_RESULT_WINDOW = 500;
export const MAX_QUERY_LENGTH = 100;
const MAX_TOKENS = 8;
const MAX_TOKEN_LENGTH = 64;
const MIN_TOKEN_LENGTH = 2;

export class AdminSearchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 400,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

// ── Permissions ──────────────────────────────────────────────────────────

export type CallerKind = "wallet" | "api-key";

export interface SearchCaller {
  kind: CallerKind;
  /** Wallet address, or "admin-api-key". Recorded in the audit log. */
  actor: string;
  ipAddress?: string;
}

export interface SearchPolicy {
  /** Entity types a static admin API key may search. */
  apiKeyEntities: readonly SearchEntity[];
}

/**
 * `ADMIN_SEARCH_API_KEY_ENTITIES` is a comma-separated allow-list. Default:
 * loans and applicants — KYC documents stay with identifiable admins.
 */
export function loadSearchPolicy(env: NodeJS.ProcessEnv = process.env): SearchPolicy {
  const raw = env.ADMIN_SEARCH_API_KEY_ENTITIES;
  if (raw === undefined) return { apiKeyEntities: ["loans", "applicants"] };
  const entities = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is SearchEntity => (SEARCH_ENTITIES as readonly string[]).includes(s));
  return { apiKeyEntities: entities };
}

export function permittedEntities(caller: SearchCaller, policy: SearchPolicy = loadSearchPolicy()): SearchEntity[] {
  return caller.kind === "wallet" ? [...SEARCH_ENTITIES] : SEARCH_ENTITIES.filter((e) => policy.apiKeyEntities.includes(e));
}

// ── Query parsing ────────────────────────────────────────────────────────

/**
 * Turns free text into a prefix-matching tsquery: every word must match
 * (AND) and each matches as a prefix, so "smi" finds "Smith". Only letters
 * and digits survive, so no tsquery operator or quote can be injected.
 */
export function buildTsQuery(raw: string): { tsQuery: string; tokens: string[] } {
  const tokens = (raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length >= MIN_TOKEN_LENGTH)
    .map((t) => t.slice(0, MAX_TOKEN_LENGTH))
    .slice(0, MAX_TOKENS);
  return { tsQuery: tokens.map((t) => `${t}:*`).join(" & "), tokens };
}

// ── PII masking ──────────────────────────────────────────────────────────

/** `GABCDEFGH…WXYZ` → `GABC…WXYZ`. */
export function maskAddress(address: string): string {
  return address.length <= 10 ? `${address.slice(0, 2)}…` : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** `john_smith.pdf` → `j***_s***.pdf`: word shapes survive, the words do not. */
export function maskFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : "";
  const stem = ext ? name.slice(0, dot) : name;
  return stem.replace(/[\p{L}\p{N}]+/gu, (word) => `${word[0]}***`) + ext;
}

/** The first 8 characters of a UUID are enough to recognise a record, and are not PII. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

// ── Search ───────────────────────────────────────────────────────────────

export interface AdminSearchInput {
  query: unknown;
  entities?: unknown;
  page?: unknown;
  pageSize?: unknown;
  caller: SearchCaller;
  policy?: SearchPolicy;
}

export interface SearchHit {
  type: SearchResultType;
  id: string;
  /** Relevance, 0..1, comparable across entity types. */
  rank: number;
  title: string;
  /** Masked, PII-safe one-liner. */
  snippet: string;
  /** Which kind of field matched, e.g. "status" or "applicant name" (never the value). */
  matchedFields: string[];
  status: string | null;
  createdAt: Date;
}

export interface AdminSearchResponse {
  query: string;
  page: number;
  pageSize: number;
  total: number;
  totals: Partial<Record<SearchEntity, number>>;
  hasMore: boolean;
  results: SearchHit[];
}

interface Row {
  id: string;
  rank: number;
  sources: string[];
  total: bigint | number;
  status?: string;
  originalName?: string;
  createdAt: Date;
  applicantAddress: string;
}

const ENTITY_ORDER: Record<SearchResultType, number> = { loan: 0, applicant: 1, document: 2 };

const ENTITY_CONFIG: Record<
  SearchEntity,
  { type: SearchResultType; sql: string }
> = {
  loans: { type: "loan", sql: LOAN_SEARCH_SQL },
  applicants: { type: "applicant", sql: APPLICANT_SEARCH_SQL },
  documents: { type: "document", sql: DOCUMENT_SEARCH_SQL },
};

function positiveInt(value: unknown, name: string, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = typeof value === "number" ? value : /^\d+$/.test(String(value)) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new AdminSearchError("invalid_field", `${name} must be a positive integer`);
  }
  return n;
}

function parseEntities(value: unknown): SearchEntity[] | undefined {
  if (value === undefined || value === "") return undefined;
  const list = (Array.isArray(value) ? value : String(value).split(",")).map((s) => String(s).trim()).filter(Boolean);
  const unknown = list.filter((e) => !(SEARCH_ENTITIES as readonly string[]).includes(e));
  if (unknown.length > 0 || list.length === 0) {
    throw new AdminSearchError("invalid_field", `entities must be a comma-separated list of: ${SEARCH_ENTITIES.join(", ")}`);
  }
  return [...new Set(list)] as SearchEntity[];
}

function matchedFields(type: SearchResultType, row: Row, tokens: string[]): string[] {
  const matchesText = (text: string | undefined) =>
    !!text && tokens.some((t) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(t)));
  const fields: string[] = [];
  if (row.sources.includes("name")) fields.push("applicant name");
  if (row.sources.includes("record")) {
    if (type === "document") fields.push("file name");
    else if (matchesText(row.status)) fields.push("status");
    else if (type === "applicant" && matchesText(row.applicantAddress)) fields.push("wallet address");
    else fields.push("details");
  }
  return fields;
}

function toHit(type: SearchResultType, row: Row, tokens: string[]): SearchHit {
  const address = maskAddress(row.applicantAddress);
  let title: string;
  let snippet: string;
  if (type === "loan") {
    title = `Loan ${shortId(row.id)}`;
    snippet = `${row.status ?? "Unknown"} loan for applicant ${address}`;
  } else if (type === "applicant") {
    title = `Applicant ${address}`;
    snippet = `${row.status ?? "Unknown"} applicant ${address}`;
  } else {
    const file = maskFileName(row.originalName ?? "document");
    title = `Document ${shortId(row.id)}`;
    snippet = `KYC document ${file} uploaded by ${address}`;
  }
  return {
    type,
    id: row.id,
    rank: Number(row.rank),
    title,
    snippet,
    matchedFields: matchedFields(type, row, tokens),
    status: type === "document" ? null : (row.status ?? null),
    createdAt: row.createdAt,
  };
}

/** Highest rank first; ties broken by type then id so pages never overlap or reorder. */
function compareHits(a: SearchHit, b: SearchHit): number {
  return b.rank - a.rank || ENTITY_ORDER[a.type] - ENTITY_ORDER[b.type] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export async function adminSearch(input: AdminSearchInput): Promise<AdminSearchResponse> {
  const { caller } = input;
  const permitted = permittedEntities(caller, input.policy);

  const raw = typeof input.query === "string" ? input.query.trim() : "";
  if (raw.length === 0) throw new AdminSearchError("invalid_field", "q is required");
  if (raw.length > MAX_QUERY_LENGTH) {
    throw new AdminSearchError("invalid_field", `q must be at most ${MAX_QUERY_LENGTH} characters`);
  }
  const { tsQuery, tokens } = buildTsQuery(raw);
  if (tokens.length === 0) {
    throw new AdminSearchError("invalid_field", `q must contain at least one word of ${MIN_TOKEN_LENGTH}+ letters or digits`);
  }

  const page = positiveInt(input.page, "page", 1);
  const pageSize = positiveInt(input.pageSize, "pageSize", DEFAULT_PAGE_SIZE);
  if (pageSize > MAX_PAGE_SIZE) {
    throw new AdminSearchError("invalid_field", `pageSize must be at most ${MAX_PAGE_SIZE}`);
  }
  const window = page * pageSize;
  if (window > MAX_RESULT_WINDOW) {
    throw new AdminSearchError(
      "result_window_exceeded",
      `Only the top ${MAX_RESULT_WINDOW} results can be paged through; narrow the search instead`
    );
  }

  const requested = parseEntities(input.entities);
  const forbidden = (requested ?? []).filter((e) => !permitted.includes(e));
  if (forbidden.length > 0) {
    await logAudit({
      action: "ADMIN_SEARCH_DENIED",
      actorAddress: caller.actor,
      ipAddress: caller.ipAddress,
      metadata: { query: raw, requested, forbidden, permitted },
    });
    throw new AdminSearchError(
      "forbidden_entity",
      `You are not permitted to search: ${forbidden.join(", ")}`,
      403,
      { forbidden, permitted }
    );
  }
  const entities = requested ?? permitted;
  if (entities.length === 0) {
    throw new AdminSearchError("forbidden_entity", "You are not permitted to search any record type", 403);
  }

  // Each entity returns its own top `window` hits; the merged top `window`
  // is then exact, so any page can be cut from it.
  const perEntity = await Promise.all(
    entities.map(async (entity) => {
      const { type, sql } = ENTITY_CONFIG[entity];
      const rows = (await prisma.$queryRawUnsafe(sql, tsQuery, window)) as Row[];
      return { entity, type, rows };
    })
  );

  const totals: Partial<Record<SearchEntity, number>> = {};
  const hits: SearchHit[] = [];
  for (const { entity, type, rows } of perEntity) {
    totals[entity] = rows.length > 0 ? Number(rows[0].total) : 0;
    for (const row of rows) hits.push(toHit(type, row, tokens));
  }
  hits.sort(compareHits);

  const total = Object.values(totals).reduce((sum, n) => sum + (n ?? 0), 0);
  const results = hits.slice((page - 1) * pageSize, window);

  await logAudit({
    action: "ADMIN_SEARCH",
    actorAddress: caller.actor,
    ipAddress: caller.ipAddress,
    metadata: { query: raw, entities, page, pageSize, resultCount: results.length, total, totals },
  });

  return { query: raw, page, pageSize, total, totals, hasMore: window < total, results };
}
