// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Admin-managed notification template versioning (issue #825).
 *
 * Prisma is replaced with an in-memory table so the real service and router run
 * end to end: drafts, publish, rollback, preview, variable validation, audit
 * entries, and the send-time lookup that decides what the next email says.
 */

import express from "express";
import request from "supertest";

type Row = Record<string, any>;
const rows: Row[] = [];
const auditEntries: any[] = [];
let seq = 0;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}
function sortBy(list: Row[], orderBy: any): Row[] {
  const clauses = (Array.isArray(orderBy) ? orderBy : [orderBy]).filter(Boolean);
  return [...list].sort((a, b) => {
    for (const clause of clauses) {
      const [field, dir] = Object.entries(clause)[0] as [string, "asc" | "desc"];
      if (a[field] !== b[field]) return (a[field] < b[field] ? -1 : 1) * (dir === "desc" ? -1 : 1);
    }
    return 0;
  });
}

const table = {
  findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null),
  findFirst: jest.fn(async ({ where, orderBy }: any = {}) => sortBy(rows.filter((r) => matches(r, where)), orderBy)[0] ?? null),
  findMany: jest.fn(async ({ where, orderBy }: any = {}) => sortBy(rows.filter((r) => matches(r, where)), orderBy)),
  create: jest.fn(async ({ data }: any) => {
    if (rows.some((r) => r.key === data.key && r.locale === data.locale && r.version === data.version)) {
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    }
    const row = {
      id: `ntv-${++seq}`,
      status: "Draft",
      createdAt: new Date(),
      updatedAt: new Date(),
      updatedBy: null,
      publishedBy: null,
      publishedAt: null,
      changeNote: null,
      ...data,
    };
    rows.push(row);
    return row;
  }),
  update: jest.fn(async ({ where, data }: any) => {
    const row = rows.find((r) => r.id === where.id)!;
    // Mirrors the partial unique index: only one Published per (key, locale).
    if (
      data.status === "Published" &&
      rows.some((r) => r.id !== row.id && r.key === row.key && r.locale === row.locale && r.status === "Published")
    ) {
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    }
    Object.assign(row, data, { updatedAt: new Date() });
    return row;
  }),
};

jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../services/audit.js", () => ({
  logAudit: async (entry: any) => {
    auditEntries.push(entry);
  },
}));
jest.mock("../services/tenant.js", () => ({
  getCurrentTenant: () => ({ name: "RemitMortgage" }),
}));
jest.mock("../config.js", () => ({ loadConfig: () => ({ adminApiKey: "test-admin-key" }) }));
jest.mock("../middleware/auth.js", () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    if (req.headers.authorization === "Bearer test-admin-key") {
      req.user = { walletAddress: "GADMIN", network: "testnet" };
      Object.defineProperty(req, "ip", { value: "127.0.0.1", configurable: true });
      return next();
    }
    return res.status(401).json({ error: "unauthorized" });
  },
}));
jest.mock("../services/db.js", () => ({
  prisma: {
    notificationTemplateVersion: table,
    $transaction: async (fn: any) => fn({ notificationTemplateVersion: table }),
  },
}));

import { notificationTemplatesAdminRouter } from "../routes/notificationTemplates.js";
import {
  createDraft,
  extractVariables,
  publishVersion,
  renderPublishedTemplate,
  rollbackTemplate,
  validateTemplateContent,
} from "../services/notificationTemplates.js";

const app = express();
app.use(express.json());
app.use("/api/admin", notificationTemplatesAdminRouter);

const auth = { Authorization: "Bearer test-admin-key" };
const BASE = "/api/admin/notification-templates";
const actor = { actor: "GADMIN", ipAddress: "127.0.0.1" };

beforeEach(() => {
  rows.length = 0;
  auditEntries.length = 0;
  seq = 0;
  jest.clearAllMocks();
});

async function draft(subject: string, body: string, locale = "en", key = "deposit_receipt") {
  return createDraft({ key, locale, subject, body, ...actor });
}
async function live(subject: string, body: string, locale = "en", key = "deposit_receipt") {
  const d = await draft(subject, body, locale, key);
  return publishVersion({ versionId: d.id, ...actor });
}
const lastAudit = () => auditEntries[auditEntries.length - 1];

describe("variable validation", () => {
  it("extracts placeholders with optional inner whitespace", () => {
    expect(extractVariables("Hi {{ amount }} and {{amount}} for {{transactionId}}")).toEqual(["amount", "transactionId"]);
  });

  it("accepts the template's own variables and the global brand", () => {
    expect(() =>
      validateTemplateContent("deposit_receipt", "Receipt - {{brand}}", "<p>{{amount}} / {{transactionId}}</p>")
    ).not.toThrow();
  });

  it("rejects a variable the sender does not supply, naming it and the supported ones", () => {
    try {
      validateTemplateContent("deposit_receipt", "Receipt", "<p>Hi {{firstName}}, you sent {{amout}}</p>");
      throw new Error("expected rejection");
    } catch (e: any) {
      expect(e.code).toBe("invalid_variables");
      expect(e.httpStatus).toBe(422);
      expect(e.details.unsupported).toEqual(["firstName", "amout"]);
      expect(e.details.allowed).toEqual(["brand", "amount", "transactionId"]);
      expect(e.message).toContain("{{firstName}}");
    }
  });

  it("does not let one template use another's variables", () => {
    expect(() => validateTemplateContent("deposit_receipt", "x", "{{dueDate}}")).toThrow(/unsupported/);
    expect(() => validateTemplateContent("repayment_reminder", "x", "{{dueDate}} {{amount}}")).not.toThrow();
  });

  it("rejects unbalanced placeholders", () => {
    expect(() => validateTemplateContent("deposit_receipt", "x", "{{amount")).toThrow(/malformed/);
    expect(() => validateTemplateContent("deposit_receipt", "x", "amount}}")).toThrow(/malformed/);
    expect(() => validateTemplateContent("deposit_receipt", "x", "{{ }}")).toThrow(/unsupported|malformed/);
  });

  it("rejects an unknown template key, blank content and multi-line subjects", () => {
    expect(() => validateTemplateContent("nope", "x", "y")).toThrow(/Unknown template/);
    expect(() => validateTemplateContent("deposit_receipt", "  ", "y")).toThrow(/subject/);
    expect(() => validateTemplateContent("deposit_receipt", "x", "")).toThrow(/body/);
    expect(() => validateTemplateContent("deposit_receipt", "a\nb", "y")).toThrow(/single line/);
  });
});

describe("drafts", () => {
  it("numbers versions per template and locale, starting at 1", async () => {
    expect((await draft("a", "b")).version).toBe(1);
    expect((await draft("a2", "b2")).version).toBe(2);
    expect((await draft("es", "b", "es")).version).toBe(1);
    expect((await draft("a", "b", "en", "repayment_reminder")).version).toBe(1);
  });

  it("records who created it and audits the creation", async () => {
    const d = await draft("a", "b");
    expect(d).toMatchObject({ status: "Draft", createdBy: "GADMIN" });
    expect(lastAudit()).toMatchObject({
      action: "NOTIFICATION_TEMPLATE_DRAFT_CREATED",
      actorAddress: "GADMIN",
      metadata: { key: "deposit_receipt", locale: "en", version: 1 },
    });
  });

  it("retries the version number when a concurrent draft takes it", async () => {
    table.findFirst.mockResolvedValueOnce(null); // stale read: thinks nothing exists
    await draft("first", "b");
    const second = await draft("second", "b");
    expect(second.version).toBe(2);
  });

  it("rejects an unsupported locale", async () => {
    await expect(draft("a", "b", "de")).rejects.toMatchObject({ code: "invalid_field" });
  });

  it("edits a draft and audits what changed", async () => {
    const d = await draft("Old subject", "<p>{{amount}}</p>");
    const res = await request(app).put(`${BASE}/versions/${d.id}`).set(auth).send({ subject: "New subject" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ subject: "New subject", body: "<p>{{amount}}</p>", updatedBy: "GADMIN" });
    expect(lastAudit()).toMatchObject({
      action: "NOTIFICATION_TEMPLATE_DRAFT_UPDATED",
      metadata: { changes: [{ field: "subject", before: "Old subject", after: "New subject" }] },
    });
  });

  it("refuses to edit a published version", async () => {
    const v = await live("s", "b");
    const res = await request(app).put(`${BASE}/versions/${v.id}`).set(auth).send({ subject: "tamper" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_a_draft");
    expect(rows[0].subject).toBe("s");
  });
});

describe("publish", () => {
  it("makes the draft live, records the publisher and audits the change against the previous version", async () => {
    await live("Receipt v1", "<p>one {{amount}}</p>");
    const d2 = await draft("Receipt v2", "<p>two {{amount}}</p>");

    const res = await request(app).post(`${BASE}/versions/${d2.id}/publish`).set(auth);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: 2, status: "Published", publishedBy: "GADMIN" });
    expect(res.body.publishedAt).toBeTruthy();
    expect(rows.find((r) => r.version === 1)!.status).toBe("Superseded");
    expect(rows.filter((r) => r.status === "Published")).toHaveLength(1);
    expect(lastAudit()).toMatchObject({
      action: "NOTIFICATION_TEMPLATE_PUBLISHED",
      actorAddress: "GADMIN",
      metadata: {
        version: 2,
        previousVersion: 1,
        changes: [
          { field: "subject", before: "Receipt v1", after: "Receipt v2" },
          { field: "body", before: "<p>one {{amount}}</p>", after: "<p>two {{amount}}</p>" },
        ],
      },
    });
  });

  it("only affects the next sends: mail rendered before the publish keeps its wording", async () => {
    await live("Old wording {{amount}}", "<p>old</p>");
    const before = await renderPublishedTemplate("deposit_receipt", "en", { amount: "10" });
    expect(before).toMatchObject({ subject: "Old wording 10", version: 1 });

    // A draft is not live: sends still use v1.
    const d2 = await draft("New wording {{amount}}", "<p>new</p>");
    expect((await renderPublishedTemplate("deposit_receipt", "en", { amount: "10" }))!.version).toBe(1);

    await publishVersion({ versionId: d2.id, ...actor });
    const after = await renderPublishedTemplate("deposit_receipt", "en", { amount: "10" });
    expect(after).toMatchObject({ subject: "New wording 10", version: 2 });
    // The earlier render is a plain string already; nothing retroactively changed.
    expect(before!.subject).toBe("Old wording 10");
  });

  it("publishes per locale independently", async () => {
    await live("English", "b", "en");
    await live("Español", "b", "es");
    expect(rows.filter((r) => r.status === "Published")).toHaveLength(2);
    expect((await renderPublishedTemplate("deposit_receipt", "es-MX", {}))!.subject).toBe("Español");
    expect((await renderPublishedTemplate("deposit_receipt", "en-GB", {}))!.subject).toBe("English");
  });

  it("rejects publishing a version that is already live or was live before", async () => {
    const v1 = await live("s1", "b");
    await expect(publishVersion({ versionId: v1.id, ...actor })).rejects.toMatchObject({ code: "already_published" });
    await live("s2", "b");
    await expect(publishVersion({ versionId: v1.id, ...actor })).rejects.toMatchObject({
      code: "not_a_draft",
      message: expect.stringContaining("rollback"),
    });
  });

  it("returns 409 when a concurrent publish wins the live slot", async () => {
    const d = await draft("s", "b");
    table.update.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    const res = await request(app).post(`${BASE}/versions/${d.id}/publish`).set(auth);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("version_conflict");
  });

  it("404s for an unknown version", async () => {
    const res = await request(app).post(`${BASE}/versions/missing/publish`).set(auth);
    expect(res.status).toBe(404);
  });
});

describe("invalid-variable rejection over the API", () => {
  it("rejects a draft using an unsupported variable with 422 and saves nothing", async () => {
    const res = await request(app)
      .post(`${BASE}/deposit_receipt/versions`)
      .set(auth)
      .send({ locale: "en", subject: "Hi {{firstName}}", body: "<p>{{amount}}</p>" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("invalid_variables");
    expect(res.body.details.unsupported).toEqual(["firstName"]);
    expect(rows).toHaveLength(0);
    expect(auditEntries).toHaveLength(0);
  });

  it("rejects an edit that introduces an unsupported variable and keeps the stored draft intact", async () => {
    const d = await draft("ok", "<p>{{amount}}</p>");
    const res = await request(app).put(`${BASE}/versions/${d.id}`).set(auth).send({ body: "<p>{{secret}}</p>" });
    expect(res.status).toBe(422);
    expect(rows[0].body).toBe("<p>{{amount}}</p>");
  });

  it("refuses to publish a draft whose variables are no longer supported", async () => {
    const d = await draft("ok", "b");
    rows[0].body = "{{removedVariable}}"; // e.g. the registry dropped a variable since the draft was saved
    await expect(publishVersion({ versionId: d.id, ...actor })).rejects.toMatchObject({ code: "invalid_variables" });
    expect(rows[0].status).toBe("Draft");
  });
});

describe("rollback", () => {
  it("restores the previous version, supersedes the current one and audits who did it", async () => {
    await live("Receipt v1", "<p>one</p>");
    await live("Receipt v2", "<p>two</p>");

    const res = await request(app).post(`${BASE}/deposit_receipt/rollback`).set(auth).send({ locale: "en", reason: "Typo in v2" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: 1, status: "Published", subject: "Receipt v1" });
    expect(rows.find((r) => r.version === 2)!.status).toBe("Superseded");
    expect(rows.filter((r) => r.status === "Published")).toHaveLength(1);
    expect(lastAudit()).toMatchObject({
      action: "NOTIFICATION_TEMPLATE_ROLLED_BACK",
      actorAddress: "GADMIN",
      ipAddress: "127.0.0.1",
      metadata: {
        key: "deposit_receipt",
        locale: "en",
        fromVersion: 2,
        toVersion: 1,
        reason: "Typo in v2",
        changes: [
          { field: "subject", before: "Receipt v2", after: "Receipt v1" },
          { field: "body", before: "<p>two</p>", after: "<p>one</p>" },
        ],
      },
    });
  });

  it("makes the next sends use the restored wording again", async () => {
    await live("Wording A", "b");
    await live("Wording B", "b");
    expect((await renderPublishedTemplate("deposit_receipt", "en", {}))!.subject).toBe("Wording B");
    await rollbackTemplate({ key: "deposit_receipt", locale: "en", ...actor });
    expect((await renderPublishedTemplate("deposit_receipt", "en", {}))!.subject).toBe("Wording A");
  });

  it("can roll back to a specific earlier version, and forward again", async () => {
    await live("v1", "b");
    await live("v2", "b");
    await live("v3", "b");

    await rollbackTemplate({ key: "deposit_receipt", locale: "en", toVersion: 1, ...actor });
    expect((await renderPublishedTemplate("deposit_receipt", "en", {}))!.version).toBe(1);

    await rollbackTemplate({ key: "deposit_receipt", locale: "en", toVersion: 3, ...actor });
    expect((await renderPublishedTemplate("deposit_receipt", "en", {}))!.version).toBe(3);
    expect(rows.filter((r) => r.status === "Published")).toHaveLength(1);
  });

  it("walks back one step at a time by default", async () => {
    await live("v1", "b");
    await live("v2", "b");
    await live("v3", "b");
    await rollbackTemplate({ key: "deposit_receipt", locale: "en", ...actor });
    await rollbackTemplate({ key: "deposit_receipt", locale: "en", ...actor });
    expect((await renderPublishedTemplate("deposit_receipt", "en", {}))!.version).toBe(1);
    await expect(rollbackTemplate({ key: "deposit_receipt", locale: "en", ...actor })).rejects.toMatchObject({
      code: "no_previous_version",
    });
  });

  it("refuses when nothing is live, when the target is current, or when it was never published", async () => {
    await expect(rollbackTemplate({ key: "deposit_receipt", locale: "en", ...actor })).rejects.toMatchObject({
      code: "no_published_version",
    });

    await live("v1", "b");
    await draft("never live", "b"); // v2 draft
    await expect(rollbackTemplate({ key: "deposit_receipt", locale: "en", toVersion: 1, ...actor })).rejects.toMatchObject({
      code: "already_published",
    });
    await expect(rollbackTemplate({ key: "deposit_receipt", locale: "en", toVersion: 2, ...actor })).rejects.toMatchObject({
      code: "never_published",
    });
    await expect(rollbackTemplate({ key: "deposit_receipt", locale: "en", toVersion: 9, ...actor })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("does not touch other locales or templates", async () => {
    await live("en1", "b", "en");
    await live("en2", "b", "en");
    await live("es1", "b", "es");
    await rollbackTemplate({ key: "deposit_receipt", locale: "en", ...actor });
    expect((await renderPublishedTemplate("deposit_receipt", "es", {}))!.subject).toBe("es1");
  });
});

describe("preview", () => {
  it("renders unsaved content with the template's sample data", async () => {
    const res = await request(app)
      .post(`${BASE}/deposit_receipt/preview`)
      .set(auth)
      .send({ subject: "Receipt - {{brand}}", body: "<p>Received {{amount}} USDC (tx {{transactionId}})</p>" });

    expect(res.status).toBe(200);
    expect(res.body.subject).toBe("Receipt - RemitMortgage");
    expect(res.body.body).toBe("<p>Received 1,250.00 USDC (tx 9f2c4e1ab7d3)</p>");
    expect(res.body.usedVariables).toEqual(["brand", "amount", "transactionId"]);
    expect(rows).toHaveLength(0); // previewing saves nothing
  });

  it("lets the admin override sample values, and HTML-escapes them", async () => {
    const res = await request(app)
      .post(`${BASE}/deposit_receipt/preview`)
      .set(auth)
      .send({ subject: "s", body: "<p>{{amount}}</p>", sampleData: { amount: "<script>alert(1)</script>" } });
    expect(res.body.body).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  });

  it("previews a stored version", async () => {
    const d = await draft("Stored {{amount}}", "<p>{{transactionId}}</p>");
    const res = await request(app).post(`${BASE}/deposit_receipt/preview`).set(auth).send({ versionId: d.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: 1, subject: "Stored 1,250.00" });
  });

  it("applies the same variable validation as saving", async () => {
    const res = await request(app)
      .post(`${BASE}/deposit_receipt/preview`)
      .set(auth)
      .send({ subject: "s", body: "{{nope}}" });
    expect(res.status).toBe(422);
    expect(res.body.details.unsupported).toEqual(["nope"]);
  });

  it("rejects sample data for variables the template does not have", async () => {
    const res = await request(app)
      .post(`${BASE}/deposit_receipt/preview`)
      .set(auth)
      .send({ subject: "s", body: "b", sampleData: { dueDate: "x" } });
    expect(res.status).toBe(422);
  });

  it("rejects a version from a different template", async () => {
    const d = await draft("s", "b", "en", "repayment_reminder");
    const res = await request(app).post(`${BASE}/deposit_receipt/preview`).set(auth).send({ versionId: d.id });
    expect(res.status).toBe(400);
  });
});

describe("send-time resolution", () => {
  it("returns null when nothing is published, so the built-in template is used", async () => {
    expect(await renderPublishedTemplate("deposit_receipt", "en", {})).toBeNull();
    await draft("only a draft", "b");
    expect(await renderPublishedTemplate("deposit_receipt", "en", {})).toBeNull();
  });

  it("returns null for templates that are not managed", async () => {
    expect(await renderPublishedTemplate("lockout", "en", {})).toBeNull();
  });

  it("falls back to null (built-in wording) instead of failing the send when the lookup errors", async () => {
    table.findFirst.mockRejectedValueOnce(new Error("db down"));
    expect(await renderPublishedTemplate("deposit_receipt", "en", {})).toBeNull();
  });

  it("escapes variable values in the body but not in the plain-text subject", async () => {
    await live("Tx {{transactionId}}", "<p>{{transactionId}}</p>");
    const out = await renderPublishedTemplate("deposit_receipt", "en", { transactionId: "<b>&" });
    expect(out!.body).toBe("<p>&lt;b&gt;&amp;</p>");
    expect(out!.subject).toBe("Tx <b>&");
  });

  it("cannot be used for header injection through a variable", async () => {
    await live("Tx {{transactionId}}", "b");
    const out = await renderPublishedTemplate("deposit_receipt", "en", { transactionId: "x\r\nBcc: evil@example.com" });
    expect(out!.subject).not.toMatch(/[\r\n]/);
  });
});

describe("authorization and listing", () => {
  it("rejects unauthenticated callers on every route", async () => {
    expect((await request(app).get(BASE)).status).toBe(401);
    expect((await request(app).post(`${BASE}/deposit_receipt/versions`).send({})).status).toBe(401);
    expect((await request(app).post(`${BASE}/versions/x/publish`)).status).toBe(401);
    expect((await request(app).post(`${BASE}/deposit_receipt/rollback`).send({})).status).toBe(401);
  });

  it("lists templates with their variables and the live version per locale", async () => {
    await live("s", "b", "en");
    const res = await request(app).get(BASE).set(auth);
    expect(res.status).toBe(200);
    const deposit = res.body.templates.find((t: any) => t.key === "deposit_receipt");
    expect(deposit.variables).toEqual(["brand", "amount", "transactionId"]);
    expect(deposit.published.find((p: any) => p.locale === "en")).toMatchObject({ version: 1, publishedBy: "GADMIN" });
    expect(deposit.published.find((p: any) => p.locale === "fr")).toMatchObject({ version: null });
  });

  it("returns version history newest first, filterable by locale", async () => {
    await live("v1", "b");
    await live("v2", "b");
    await live("es", "b", "es");
    const res = await request(app).get(`${BASE}/deposit_receipt/versions?locale=en`).set(auth);
    expect(res.body.versions.map((v: any) => v.version)).toEqual([2, 1]);
    expect((await request(app).get(`${BASE}/nope/versions`).set(auth)).status).toBe(404);
  });
});
