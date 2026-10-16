// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Admin full-text search (issue #826).
 *
 * PostgreSQL does the matching and per-entity ranking, so the database is
 * replaced with canned rows per query. What is under test is everything the
 * application owns: query sanitising, permission filtering, merging the three
 * ranked lists, pagination, PII masking and auditing. A final test ties the
 * query expressions to the migration's indexes so they cannot drift apart.
 */

import fs from "fs";
import path from "path";
import express from "express";
import request from "supertest";

type Row = Record<string, any>;
const auditEntries: any[] = [];
const dbRows: { loans: Row[]; applicants: Row[]; documents: Row[] } = { loans: [], applicants: [], documents: [] };

jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../services/audit.js", () => ({
  logAudit: async (entry: any) => {
    auditEntries.push(entry);
  },
}));
jest.mock("../config.js", () => ({ loadConfig: () => ({ adminApiKey: "test-admin-key" }) }));
jest.mock("../middleware/auth.js", () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    Object.defineProperty(req, "ip", { value: "10.0.0.7", configurable: true });
    if (req.headers.authorization === "Bearer test-admin-key") return next(); // static key: no req.user
    if (req.headers.authorization === "Bearer wallet-admin") {
      req.user = { walletAddress: "GADMINWALLET", network: "testnet" };
      return next();
    }
    return res.status(401).json({ error: "unauthorized" });
  },
}));

const mockQuery = jest.fn();
jest.mock("../services/db.js", () => ({
  prisma: { $queryRawUnsafe: (...args: any[]) => mockQuery(...args) },
}));

import { adminSearchRouter } from "../routes/adminSearch.js";
import {
  adminSearch,
  buildTsQuery,
  loadSearchPolicy,
  maskAddress,
  maskFileName,
  permittedEntities,
  type SearchCaller,
} from "../services/adminSearch.js";
import {
  LOAN_SEARCH_SQL,
  APPLICANT_SEARCH_SQL,
  DOCUMENT_SEARCH_SQL,
  LOAN_VECTOR,
  APPLICANT_VECTOR,
  OCR_NAME_VECTOR,
  DOCUMENT_VECTOR,
} from "../services/adminSearchSql.js";

const app = express();
app.use("/api/admin", adminSearchRouter);

const wallet: SearchCaller = { kind: "wallet", actor: "GADMINWALLET", ipAddress: "10.0.0.7" };
const apiKey: SearchCaller = { kind: "api-key", actor: "admin-api-key", ipAddress: "10.0.0.7" };

const T0 = new Date("2026-10-01T00:00:00Z");
const ADDR = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUWXYZ";

const loanRow = (id: string, rank: number, extra: Row = {}) => ({
  id, rank, sources: ["record"], total: 1, status: "Pending", createdAt: T0, applicantAddress: ADDR, ...extra,
});
const applicantRow = (id: string, rank: number, extra: Row = {}) => ({
  id, rank, sources: ["name"], total: 1, status: "ELIGIBLE", createdAt: T0, applicantAddress: ADDR, ...extra,
});
const documentRow = (id: string, rank: number, extra: Row = {}) => ({
  id, rank, sources: ["record"], total: 1, originalName: "John_Smith_passport.pdf", createdAt: T0, applicantAddress: ADDR, ...extra,
});

beforeEach(() => {
  auditEntries.length = 0;
  dbRows.loans = [];
  dbRows.applicants = [];
  dbRows.documents = [];
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql: string, _q: string, limit: number) => {
    const rows = sql === LOAN_SEARCH_SQL ? dbRows.loans : sql === APPLICANT_SEARCH_SQL ? dbRows.applicants : dbRows.documents;
    const withTotal = rows.map((r) => ({ ...r, total: BigInt(rows.length) })); // COUNT(*) arrives as bigint
    return withTotal.slice(0, limit); // the SQL's ORDER BY + LIMIT
  });
});

const queried = () => mockQuery.mock.calls.map(([sql]) => (sql === LOAN_SEARCH_SQL ? "loans" : sql === APPLICANT_SEARCH_SQL ? "applicants" : "documents"));

describe("buildTsQuery", () => {
  it("makes every word a prefix match and ANDs them", () => {
    expect(buildTsQuery("Smi  pending")).toEqual({ tsQuery: "smi:* & pending:*", tokens: ["smi", "pending"] });
  });

  it("strips everything but letters and digits, so nothing can be injected into the tsquery", () => {
    const { tsQuery } = buildTsQuery(`smith' | !(drop) & <-> \\ "x"; --`);
    expect(tsQuery).toBe("smith:* & drop:*");
    expect(tsQuery).not.toMatch(/['"\\|!()<>;-]/);
  });

  it("splits apostrophes and hyphens like the index does, and drops one-letter tokens", () => {
    expect(buildTsQuery("O'Neil Mary-Ann").tokens).toEqual(["neil", "mary", "ann"]);
  });

  it("keeps non-ASCII letters and caps the number of terms", () => {
    expect(buildTsQuery("José Müller").tokens).toEqual(["josé", "müller"]);
    expect(buildTsQuery("aa bb cc dd ee ff gg hh ii jj").tokens).toHaveLength(8);
  });

  it("yields no tokens for punctuation-only input", () => {
    expect(buildTsQuery("!!! ??? a").tokens).toEqual([]);
  });
});

describe("masking", () => {
  it("keeps only the ends of a wallet address", () => {
    expect(maskAddress(ADDR)).toBe("GABC…WXYZ");
    expect(maskAddress("GSHORT")).toBe("GS…");
  });

  it("keeps the shape of a file name but none of its words", () => {
    expect(maskFileName("John_Smith_passport.pdf")).toBe("J***_S***_p***.pdf");
    expect(maskFileName("mary-ann.oneil.id.png")).toBe("m***-a***.o***.i***.png");
  });
});

describe("ranking", () => {
  it("merges loans, applicants and documents into one list ordered by relevance", async () => {
    dbRows.loans = [loanRow("loan-a", 0.9), loanRow("loan-b", 0.2)];
    dbRows.applicants = [applicantRow("app-a", 0.5)];
    dbRows.documents = [documentRow("doc-a", 0.7), documentRow("doc-b", 0.1)];

    const res = await adminSearch({ query: "smith", caller: wallet });

    expect(res.results.map((r) => r.id)).toEqual(["loan-a", "doc-a", "app-a", "loan-b", "doc-b"]);
    expect(res.results.map((r) => r.type)).toEqual(["loan", "document", "applicant", "loan", "document"]);
    expect(res.results.map((r) => r.rank)).toEqual([0.9, 0.7, 0.5, 0.2, 0.1]);
    expect(res.total).toBe(5);
    expect(res.totals).toEqual({ loans: 2, applicants: 1, documents: 2 });
  });

  it("breaks ties deterministically by type, then id", async () => {
    dbRows.loans = [loanRow("zz", 0.5), loanRow("aa", 0.5)];
    dbRows.applicants = [applicantRow("mm", 0.5)];
    dbRows.documents = [documentRow("bb", 0.5)];
    const res = await adminSearch({ query: "smith", caller: wallet });
    expect(res.results.map((r) => r.id)).toEqual(["aa", "zz", "mm", "bb"]);
  });

  it("passes the sanitised prefix query as a bound parameter, not as SQL text", async () => {
    await adminSearch({ query: `Smi'; DROP TABLE "Applicant"; --`, caller: wallet });
    for (const [sql, tsQuery] of mockQuery.mock.calls) {
      expect(tsQuery).toBe("smi:* & drop:* & table:* & applicant:*");
      expect(sql).not.toContain("DROP");
      expect(sql).toMatch(/\$1/);
    }
  });

  it("describes what kind of field matched without exposing its value", async () => {
    dbRows.loans = [loanRow("l1", 0.9, { sources: ["record"], status: "Pending" }), loanRow("l2", 0.8, { sources: ["name"] })];
    dbRows.applicants = [applicantRow("a1", 0.7, { sources: ["record"], status: "PENDING" })];
    dbRows.documents = [documentRow("d1", 0.6, { sources: ["record", "name"] })];
    const res = await adminSearch({ query: "pending", caller: wallet });
    const byId = Object.fromEntries(res.results.map((r) => [r.id, r.matchedFields]));
    expect(byId).toEqual({
      l1: ["status"],
      l2: ["applicant name"],
      a1: ["status"],
      d1: ["applicant name", "file name"],
    });
  });
});

describe("pagination", () => {
  beforeEach(() => {
    dbRows.loans = Array.from({ length: 7 }, (_, i) => loanRow(`loan-${i}`, 0.9 - i * 0.1));
    dbRows.applicants = Array.from({ length: 4 }, (_, i) => applicantRow(`app-${i}`, 0.85 - i * 0.1));
  });

  it("returns consecutive, non-overlapping pages that together equal the full ranking", async () => {
    const all = (await adminSearch({ query: "smith", caller: wallet, pageSize: 50 })).results.map((r) => r.id);
    expect(all).toHaveLength(11);

    const pages: string[][] = [];
    for (const page of [1, 2, 3, 4]) {
      pages.push((await adminSearch({ query: "smith", caller: wallet, page, pageSize: 3 })).results.map((r) => r.id));
    }
    expect(pages.map((p) => p.length)).toEqual([3, 3, 3, 2]);
    expect(pages.flat()).toEqual(all);
    expect(new Set(pages.flat()).size).toBe(11);
  });

  it("reports the true total and whether more pages exist", async () => {
    const first = await adminSearch({ query: "smith", caller: wallet, page: 1, pageSize: 5 });
    expect(first).toMatchObject({ page: 1, pageSize: 5, total: 11, hasMore: true });
    const last = await adminSearch({ query: "smith", caller: wallet, page: 3, pageSize: 5 });
    expect(last).toMatchObject({ total: 11, hasMore: false });
    expect(last.results).toHaveLength(1);
  });

  it("asks each entity query for exactly the rows the requested page can need", async () => {
    await adminSearch({ query: "smith", caller: wallet, page: 3, pageSize: 4 });
    for (const [, , limit] of mockQuery.mock.calls) expect(limit).toBe(12);
  });

  it("returns an empty page past the end instead of failing", async () => {
    const res = await adminSearch({ query: "smith", caller: wallet, page: 9, pageSize: 10 });
    expect(res.results).toEqual([]);
    expect(res.total).toBe(11);
  });

  it("defaults to page 1 of 20 and rejects invalid pagination", async () => {
    expect(await adminSearch({ query: "smith", caller: wallet })).toMatchObject({ page: 1, pageSize: 20 });
    await expect(adminSearch({ query: "smith", caller: wallet, page: 0 })).rejects.toMatchObject({ code: "invalid_field" });
    await expect(adminSearch({ query: "smith", caller: wallet, page: "x" })).rejects.toMatchObject({ code: "invalid_field" });
    await expect(adminSearch({ query: "smith", caller: wallet, pageSize: 51 })).rejects.toMatchObject({ code: "invalid_field" });
  });

  it("refuses to page beyond the result window", async () => {
    await expect(adminSearch({ query: "smith", caller: wallet, page: 11, pageSize: 50 })).rejects.toMatchObject({
      code: "result_window_exceeded",
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("permission filtering", () => {
  beforeEach(() => {
    dbRows.loans = [loanRow("loan-1", 0.5)];
    dbRows.applicants = [applicantRow("app-1", 0.5)];
    dbRows.documents = [documentRow("doc-1", 0.5)];
  });

  it("lets an identified admin wallet search everything", async () => {
    const res = await adminSearch({ query: "smith", caller: wallet });
    expect(queried().sort()).toEqual(["applicants", "documents", "loans"]);
    expect(res.results.map((r) => r.type).sort()).toEqual(["applicant", "document", "loan"]);
  });

  it("never queries, or returns, entity types the caller may not see", async () => {
    const res = await adminSearch({ query: "smith", caller: apiKey });
    expect(queried().sort()).toEqual(["applicants", "loans"]);
    expect(res.results.map((r) => r.type).sort()).toEqual(["applicant", "loan"]);
    expect(res.totals).toEqual({ loans: 1, applicants: 1 });
    expect(JSON.stringify(res)).not.toContain("doc-1");
  });

  it("rejects an explicit request for a forbidden type with 403, runs no query and audits the attempt", async () => {
    await expect(adminSearch({ query: "smith", entities: "documents,loans", caller: apiKey })).rejects.toMatchObject({
      code: "forbidden_entity",
      httpStatus: 403,
    });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(auditEntries).toEqual([
      expect.objectContaining({
        action: "ADMIN_SEARCH_DENIED",
        actorAddress: "admin-api-key",
        metadata: expect.objectContaining({ forbidden: ["documents"], permitted: ["loans", "applicants"] }),
      }),
    ]);
  });

  it("narrows to the requested subset", async () => {
    await adminSearch({ query: "smith", entities: "loans", caller: wallet });
    expect(queried()).toEqual(["loans"]);
  });

  it("validates the entities list", async () => {
    await expect(adminSearch({ query: "smith", entities: "loans,payments", caller: wallet })).rejects.toMatchObject({
      code: "invalid_field",
    });
  });

  it("reads the API-key allow-list from the environment, ignoring unknown names", () => {
    expect(loadSearchPolicy({}).apiKeyEntities).toEqual(["loans", "applicants"]);
    expect(loadSearchPolicy({ ADMIN_SEARCH_API_KEY_ENTITIES: "loans, bogus" }).apiKeyEntities).toEqual(["loans"]);
    expect(permittedEntities(apiKey, loadSearchPolicy({ ADMIN_SEARCH_API_KEY_ENTITIES: "" }))).toEqual([]);
  });

  it("denies a caller with no permitted record types outright", async () => {
    await expect(
      adminSearch({ query: "smith", caller: apiKey, policy: { apiKeyEntities: [] } })
    ).rejects.toMatchObject({ httpStatus: 403 });
  });
});

describe("PII-safe snippets", () => {
  it("never returns names, full wallet addresses or file names", async () => {
    dbRows.loans = [loanRow("11111111-2222-3333-4444-555555555555", 0.9, { sources: ["name"] })];
    dbRows.applicants = [applicantRow("aaaaaaaa-2222-3333-4444-555555555555", 0.8)];
    dbRows.documents = [documentRow("dddddddd-2222-3333-4444-555555555555", 0.7)];

    // The query echo is the admin's own input; the stored name/file name must not appear anywhere else.
    const res = await adminSearch({ query: "kyc", caller: wallet });
    const wire = JSON.stringify(res);

    expect(wire).not.toContain(ADDR);
    expect(wire).not.toMatch(/John|Smith|passport/i);
    expect(res.results.map((r) => r.snippet)).toEqual([
      "Pending loan for applicant GABC…WXYZ",
      "ELIGIBLE applicant GABC…WXYZ",
      "KYC document J***_S***_p***.pdf uploaded by GABC…WXYZ",
    ]);
    expect(res.results.map((r) => r.title)).toEqual(["Loan 11111111", "Applicant GABC…WXYZ", "Document dddddddd"]);
  });
});

describe("audit", () => {
  it("records who searched for what, with the outcome", async () => {
    dbRows.loans = [loanRow("l1", 0.9), loanRow("l2", 0.8)];
    await adminSearch({ query: "  Smith  ", entities: "loans", caller: wallet, page: 1, pageSize: 1 });

    expect(auditEntries).toEqual([
      {
        action: "ADMIN_SEARCH",
        actorAddress: "GADMINWALLET",
        ipAddress: "10.0.0.7",
        metadata: {
          query: "Smith",
          entities: ["loans"],
          page: 1,
          pageSize: 1,
          resultCount: 1,
          total: 2,
          totals: { loans: 2 },
        },
      },
    ]);
  });

  it("does not audit a malformed request that never ran a search", async () => {
    await expect(adminSearch({ query: "!", caller: wallet })).rejects.toMatchObject({ code: "invalid_field" });
    expect(auditEntries).toHaveLength(0);
  });
});

describe("GET /api/admin/search", () => {
  const auth = { wallet: { Authorization: "Bearer wallet-admin" }, key: { Authorization: "Bearer test-admin-key" } };

  beforeEach(() => {
    dbRows.loans = [loanRow("loan-1", 0.9)];
    dbRows.documents = [documentRow("doc-1", 0.5)];
  });

  it("requires admin authentication", async () => {
    expect((await request(app).get("/api/admin/search?q=smith")).status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns ranked results for a wallet admin and audits the search under their address", async () => {
    const res = await request(app).get("/api/admin/search?q=smith&pageSize=10").set(auth.wallet);
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: any) => r.id)).toEqual(["loan-1", "doc-1"]);
    expect(auditEntries[0]).toMatchObject({ action: "ADMIN_SEARCH", actorAddress: "GADMINWALLET" });
  });

  it("limits a static API key to loans and applicants, and audits it as admin-api-key", async () => {
    const res = await request(app).get("/api/admin/search?q=smith").set(auth.key);
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: any) => r.id)).toEqual(["loan-1"]);
    expect(auditEntries[0]).toMatchObject({ action: "ADMIN_SEARCH", actorAddress: "admin-api-key" });

    const denied = await request(app).get("/api/admin/search?q=smith&entities=documents").set(auth.key);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: "forbidden_entity", details: { forbidden: ["documents"] } });
  });

  it.each([
    ["missing q", "/api/admin/search"],
    ["blank q", "/api/admin/search?q=%20%20"],
    ["too-short q", "/api/admin/search?q=a"],
    ["oversized q", `/api/admin/search?q=${"a".repeat(101)}`],
    ["bad page", "/api/admin/search?q=smith&page=-1"],
    ["bad entities", "/api/admin/search?q=smith&entities=users"],
  ])("rejects %s with 400", async (_name, url) => {
    const res = await request(app).get(url).set(auth.wallet);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_field");
  });

  it("treats repeated q parameters as invalid rather than coercing them", async () => {
    const res = await request(app).get("/api/admin/search?q=smith&q=jones").set(auth.wallet);
    expect(res.status).toBe(400);
  });

  it("returns 500 without leaking internals when the database fails", async () => {
    mockQuery.mockRejectedValueOnce(new Error('relation "KycOcrResult" does not exist'));
    const res = await request(app).get("/api/admin/search?q=smith").set(auth.wallet);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "search_failed" });
  });
});

describe("indexes match the queries", () => {
  const migration = fs.readFileSync(
    path.join(__dirname, "../../prisma/migrations/20261017010000_admin_full_text_search/migration.sql"),
    "utf8"
  );
  // The migration spreads one expression over several lines; compare ignoring whitespace.
  const squash = (s: string) => s.replace(/\s+/g, " ");

  it.each([
    ["loan", LOAN_VECTOR, LOAN_SEARCH_SQL],
    ["applicant", APPLICANT_VECTOR, APPLICANT_SEARCH_SQL],
    ["OCR name", OCR_NAME_VECTOR, LOAN_SEARCH_SQL],
    ["document", DOCUMENT_VECTOR, DOCUMENT_SEARCH_SQL],
  ])("%s tsvector expression is indexed verbatim and used verbatim by the query", (_name, vector, sql) => {
    expect(squash(migration)).toContain(squash(vector));
    expect(squash(sql)).toContain(squash(vector));
  });
});
