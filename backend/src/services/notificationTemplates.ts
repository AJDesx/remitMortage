// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Admin-managed notification template versioning (issue #825).
 *
 * Templates used to live only in code, so rewording an email needed a deploy
 * and there was no history. Admins can now keep versioned templates per
 * (template key, locale):
 *
 *   Draft ──publish──▶ Published ──(newer publish / rollback)──▶ Superseded
 *                         ▲                                         │
 *                         └──────────────── rollback ───────────────┘
 *
 *  - Sends resolve the Published version when they are dispatched, so a
 *    publish affects the *next* sends only; mail already sent is untouched.
 *  - Only variables the template's sender actually supplies may be used;
 *    anything else is rejected when a draft is saved, so a typo can never
 *    reach a customer as a literal "{{amout}}".
 *  - Content is immutable once published (also enforced by a database trigger).
 *    Rolling back re-publishes an earlier version rather than editing history.
 *  - Every change is audit-logged with the acting admin and what changed.
 *  - With no published version, callers fall back to the built-in templates.
 */

import { prisma } from "./db.js";
import { logAudit } from "./audit.js";
import { getCurrentTenant } from "./tenant.js";
import { SUPPORTED_LOCALES, isValidLocale, type Locale } from "../i18n/index.js";
import logger from "../utils/logger.js";

// ── Template registry ────────────────────────────────────────────────────

export interface TemplateDefinition {
  key: string;
  description: string;
  /** Variables the sender provides for this template. `brand` is always available too. */
  variables: readonly string[];
  /** Realistic values used by preview when the admin supplies none. */
  sampleData: Readonly<Record<string, string>>;
}

/** Variables available to every template, supplied by the platform. */
export const GLOBAL_VARIABLES: readonly string[] = ["brand"];

export const TEMPLATE_DEFINITIONS: readonly TemplateDefinition[] = [
  {
    key: "deposit_receipt",
    description: "Sent when an escrow deposit is confirmed.",
    variables: ["amount", "transactionId"],
    sampleData: { amount: "1,250.00", transactionId: "9f2c4e1ab7d3" },
  },
  {
    key: "repayment_reminder",
    description: "Sent ahead of a loan repayment due date.",
    variables: ["amount", "dueDate"],
    sampleData: { amount: "420.00", dueDate: "2026-11-01" },
  },
  {
    key: "loan_status_update",
    description: "Sent when a loan application changes status.",
    variables: ["loanId", "status"],
    sampleData: { loanId: "b7c1a3e0-5d2f-4c8e-9a41-0f6d2e8b7c13", status: "Approved" },
  },
];

export function getTemplateDefinition(key: string): TemplateDefinition | undefined {
  return TEMPLATE_DEFINITIONS.find((d) => d.key === key);
}

export function allowedVariables(def: TemplateDefinition): string[] {
  return [...GLOBAL_VARIABLES, ...def.variables];
}

export class NotificationTemplateError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 400,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

// ── Placeholders ─────────────────────────────────────────────────────────

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 50_000;
const MAX_NOTE_LENGTH = 500;
const PUBLISH_RETRIES = 3;

/** Names used as `{{name}}` in `text`, in order of first appearance. */
export function extractVariables(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) names.add(match[1]);
  return [...names];
}

/** True when `text` has `{{` or `}}` that is not part of a well-formed placeholder. */
function hasStrayBraces(text: string): boolean {
  return /\{\{|\}\}/.test(text.replace(PLACEHOLDER, ""));
}

/**
 * Rejects content that uses a variable the template's sender does not supply,
 * names a variable illegally, or has an unbalanced `{{` / `}}`.
 */
export function validateTemplateContent(key: string, subject: unknown, body: unknown): { subject: string; body: string } {
  const def = getTemplateDefinition(key);
  if (!def) {
    throw new NotificationTemplateError("unknown_template", `Unknown template "${key}"`, 404, {
      templates: TEMPLATE_DEFINITIONS.map((d) => d.key),
    });
  }
  if (typeof subject !== "string" || subject.trim().length === 0) {
    throw new NotificationTemplateError("invalid_field", "subject must be a non-empty string");
  }
  if (typeof body !== "string" || body.trim().length === 0) {
    throw new NotificationTemplateError("invalid_field", "body must be a non-empty string");
  }
  if (subject.length > MAX_SUBJECT_LENGTH || /[\r\n]/.test(subject)) {
    throw new NotificationTemplateError(
      "invalid_field",
      `subject must be a single line of at most ${MAX_SUBJECT_LENGTH} characters`
    );
  }
  if (body.length > MAX_BODY_LENGTH) {
    throw new NotificationTemplateError("invalid_field", `body must be at most ${MAX_BODY_LENGTH} characters`);
  }

  const allowed = allowedVariables(def);
  const used = [...new Set([...extractVariables(subject), ...extractVariables(body)])];
  const unsupported = used.filter((name) => !allowed.includes(name));
  const malformed = hasStrayBraces(subject) || hasStrayBraces(body);

  if (unsupported.length > 0 || malformed) {
    const parts: string[] = [];
    if (unsupported.length > 0) {
      parts.push(`unsupported variable${unsupported.length > 1 ? "s" : ""}: ${unsupported.map((n) => `{{${n}}}`).join(", ")}`);
    }
    if (malformed) parts.push("unbalanced or malformed {{ }} placeholder");
    throw new NotificationTemplateError(
      "invalid_variables",
      `Template rejected — ${parts.join("; ")}. Supported: ${allowed.map((n) => `{{${n}}}`).join(", ")}`,
      422,
      { unsupported, malformed, allowed }
    );
  }
  return { subject: subject.trim(), body };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Substitutes `{{name}}` placeholders. Values are HTML-escaped when `html` is set. */
export function renderText(text: string, vars: Record<string, unknown>, html: boolean): string {
  return text.replace(PLACEHOLDER, (_m, name: string) => {
    const raw = vars[name];
    const value = raw === undefined || raw === null ? "" : String(raw);
    return html ? escapeHtml(value) : value;
  });
}

function renderVersion(version: { subject: string; body: string }, vars: Record<string, unknown>) {
  return {
    // The subject is plain text; strip anything that could break the header.
    subject: renderText(version.subject, vars, false).replace(/[\r\n]+/g, " ").trim(),
    body: renderText(version.body, vars, true),
  };
}

// ── Input helpers ────────────────────────────────────────────────────────

function requireLocale(value: unknown): Locale {
  if (typeof value !== "string" || !isValidLocale(value)) {
    throw new NotificationTemplateError("invalid_field", `locale must be one of: ${SUPPORTED_LOCALES.join(", ")}`);
  }
  return value;
}

function optionalNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_NOTE_LENGTH) {
    throw new NotificationTemplateError(
      "invalid_field",
      `changeNote must be a non-empty string of at most ${MAX_NOTE_LENGTH} characters when provided`
    );
  }
  return value.trim();
}

interface Actor {
  actor: string;
  ipAddress?: string;
}

interface FieldChange {
  field: "subject" | "body";
  before: string | null;
  after: string;
}

function diffContent(
  before: { subject: string; body: string } | null,
  after: { subject: string; body: string }
): FieldChange[] {
  const changes: FieldChange[] = [];
  if (before?.subject !== after.subject) changes.push({ field: "subject", before: before?.subject ?? null, after: after.subject });
  if (before?.body !== after.body) changes.push({ field: "body", before: before?.body ?? null, after: after.body });
  return changes;
}

async function loadVersion(id: string) {
  const row = await prisma.notificationTemplateVersion.findUnique({ where: { id } });
  if (!row) throw new NotificationTemplateError("not_found", "Template version not found", 404);
  return row;
}

// ── Drafts ───────────────────────────────────────────────────────────────

export interface CreateDraftInput extends Actor {
  key: string;
  locale: unknown;
  subject: unknown;
  body: unknown;
  changeNote?: unknown;
}

/** Creates the next version of a template as a draft. Nothing is sent from it yet. */
export async function createDraft(input: CreateDraftInput) {
  const locale = requireLocale(input.locale);
  const content = validateTemplateContent(input.key, input.subject, input.body);
  const changeNote = optionalNote(input.changeNote);

  for (let attempt = 1; ; attempt++) {
    const latest = await prisma.notificationTemplateVersion.findFirst({
      where: { key: input.key, locale },
      orderBy: { version: "desc" },
    });
    try {
      const created = await prisma.notificationTemplateVersion.create({
        data: {
          key: input.key,
          locale,
          version: (latest?.version ?? 0) + 1,
          status: "Draft",
          subject: content.subject,
          body: content.body,
          changeNote,
          createdBy: input.actor,
        },
      });
      await logAudit({
        action: "NOTIFICATION_TEMPLATE_DRAFT_CREATED",
        actorAddress: input.actor,
        ipAddress: input.ipAddress,
        metadata: { key: input.key, locale, version: created.version, versionId: created.id, changeNote },
      });
      return created;
    } catch (err: any) {
      // A concurrent draft claimed this version number: take the next one.
      if (err?.code === "P2002" && attempt < PUBLISH_RETRIES) continue;
      if (err?.code === "P2002") {
        throw new NotificationTemplateError("version_conflict", "Concurrent template edits; retry", 409);
      }
      throw err;
    }
  }
}

export interface UpdateDraftInput extends Actor {
  versionId: string;
  subject?: unknown;
  body?: unknown;
  changeNote?: unknown;
}

/** Edits a draft. Published and superseded versions are immutable. */
export async function updateDraft(input: UpdateDraftInput) {
  const existing = await loadVersion(input.versionId);
  if (existing.status !== "Draft") {
    throw new NotificationTemplateError(
      "not_a_draft",
      `Version ${existing.version} is ${existing.status.toLowerCase()} and cannot be edited; create a new draft instead`,
      409
    );
  }
  const content = validateTemplateContent(
    existing.key,
    input.subject === undefined ? existing.subject : input.subject,
    input.body === undefined ? existing.body : input.body
  );
  const changeNote = input.changeNote === undefined ? existing.changeNote : optionalNote(input.changeNote);

  const changes = diffContent(existing, content);
  const updated = await prisma.notificationTemplateVersion.update({
    where: { id: existing.id },
    data: { subject: content.subject, body: content.body, changeNote, updatedBy: input.actor },
  });
  await logAudit({
    action: "NOTIFICATION_TEMPLATE_DRAFT_UPDATED",
    actorAddress: input.actor,
    ipAddress: input.ipAddress,
    metadata: {
      key: existing.key,
      locale: existing.locale,
      version: existing.version,
      versionId: existing.id,
      changes,
    },
  });
  return updated;
}

// ── Publish / rollback ───────────────────────────────────────────────────

export interface PublishInput extends Actor {
  versionId: string;
}

/** Makes a draft the live version for its template and locale. Affects later sends only. */
export async function publishVersion(input: PublishInput) {
  const target = await loadVersion(input.versionId);
  if (target.status === "Published") {
    throw new NotificationTemplateError("already_published", `Version ${target.version} is already live`, 409);
  }
  if (target.status === "Superseded") {
    throw new NotificationTemplateError(
      "not_a_draft",
      `Version ${target.version} was live before; use rollback to restore it`,
      409
    );
  }
  // Re-validate: the variable registry may have changed since the draft was saved.
  validateTemplateContent(target.key, target.subject, target.body);

  const { previous, published } = await switchLiveVersion(target, input.actor);

  await logAudit({
    action: "NOTIFICATION_TEMPLATE_PUBLISHED",
    actorAddress: input.actor,
    ipAddress: input.ipAddress,
    metadata: {
      key: target.key,
      locale: target.locale,
      version: published.version,
      versionId: published.id,
      previousVersion: previous?.version ?? null,
      changes: diffContent(previous, published),
      changeNote: published.changeNote,
    },
  });
  return published;
}

/**
 * Atomically retires the current live version (if any) and promotes `target`.
 * The partial unique index guarantees a concurrent switch cannot leave two live.
 */
async function switchLiveVersion(target: { id: string; key: string; locale: string }, actor: string) {
  try {
    return await prisma.$transaction(async (tx: typeof prisma) => {
      const previous = await tx.notificationTemplateVersion.findFirst({
        where: { key: target.key, locale: target.locale, status: "Published" },
      });
      if (previous) {
        await tx.notificationTemplateVersion.update({
          where: { id: previous.id },
          data: { status: "Superseded" },
        });
      }
      const published = await tx.notificationTemplateVersion.update({
        where: { id: target.id },
        data: { status: "Published", publishedBy: actor, publishedAt: new Date() },
      });
      return { previous: previous ?? null, published };
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      throw new NotificationTemplateError("version_conflict", "Another publish happened concurrently; retry", 409);
    }
    throw err;
  }
}

export interface RollbackInput extends Actor {
  key: string;
  locale: unknown;
  /** Version to restore. Defaults to the most recent earlier version that was live. */
  toVersion?: unknown;
  reason?: unknown;
}

/** Restores an earlier live version as the current one. Recorded in the audit log. */
export async function rollbackTemplate(input: RollbackInput) {
  if (!getTemplateDefinition(input.key)) {
    throw new NotificationTemplateError("unknown_template", `Unknown template "${input.key}"`, 404);
  }
  const locale = requireLocale(input.locale);
  const reason = optionalNote(input.reason);

  const current = await prisma.notificationTemplateVersion.findFirst({
    where: { key: input.key, locale, status: "Published" },
  });
  if (!current) {
    throw new NotificationTemplateError("no_published_version", "No version is published, so there is nothing to roll back", 409);
  }

  let target;
  if (input.toVersion !== undefined && input.toVersion !== null) {
    const n = Number(input.toVersion);
    if (!Number.isInteger(n) || n < 1) {
      throw new NotificationTemplateError("invalid_field", "toVersion must be a positive integer");
    }
    if (n === current.version) {
      throw new NotificationTemplateError("already_published", `Version ${n} is already live`, 409);
    }
    target = await prisma.notificationTemplateVersion.findFirst({ where: { key: input.key, locale, version: n } });
    if (!target) throw new NotificationTemplateError("not_found", `Version ${n} not found`, 404);
  } else {
    const earlier = await prisma.notificationTemplateVersion.findMany({
      where: { key: input.key, locale, status: "Superseded" },
      orderBy: { version: "desc" },
    });
    target = earlier.find((v: { version: number }) => v.version < current.version);
    if (!target) {
      throw new NotificationTemplateError("no_previous_version", "There is no earlier published version to roll back to", 409);
    }
  }
  if (!target.publishedAt) {
    throw new NotificationTemplateError(
      "never_published",
      `Version ${target.version} was never published; publish it instead of rolling back to it`,
      409
    );
  }
  // The registry may have dropped a variable since; never restore something that can't render.
  validateTemplateContent(input.key, target.subject, target.body);

  const { previous, published } = await switchLiveVersion(target, input.actor);

  await logAudit({
    action: "NOTIFICATION_TEMPLATE_ROLLED_BACK",
    actorAddress: input.actor,
    ipAddress: input.ipAddress,
    metadata: {
      key: input.key,
      locale,
      fromVersion: previous?.version ?? null,
      toVersion: published.version,
      versionId: published.id,
      changes: diffContent(previous, published),
      reason,
    },
  });
  return published;
}

// ── Preview ──────────────────────────────────────────────────────────────

export interface PreviewInput {
  key: string;
  /** Preview a stored version… */
  versionId?: unknown;
  /** …or unsaved content. */
  subject?: unknown;
  body?: unknown;
  /** Overrides for the key's sample data. */
  sampleData?: unknown;
}

/**
 * Renders a template with sample data so an admin can check it before
 * publishing. Unsaved content goes through the same variable validation as a
 * save, so a preview that works is one that can be published.
 */
export async function previewTemplate(input: PreviewInput) {
  const def = getTemplateDefinition(input.key);
  if (!def) throw new NotificationTemplateError("unknown_template", `Unknown template "${input.key}"`, 404);

  let source: { subject: string; body: string };
  let version: number | null = null;
  if (input.versionId !== undefined) {
    if (typeof input.versionId !== "string") {
      throw new NotificationTemplateError("invalid_field", "versionId must be a string");
    }
    const stored = await loadVersion(input.versionId);
    if (stored.key !== input.key) {
      throw new NotificationTemplateError("invalid_field", `Version ${stored.version} belongs to "${stored.key}", not "${input.key}"`);
    }
    source = validateTemplateContent(stored.key, stored.subject, stored.body);
    version = stored.version;
  } else {
    source = validateTemplateContent(input.key, input.subject, input.body);
  }

  const overrides: Record<string, string> = {};
  if (input.sampleData !== undefined) {
    if (typeof input.sampleData !== "object" || input.sampleData === null || Array.isArray(input.sampleData)) {
      throw new NotificationTemplateError("invalid_field", "sampleData must be an object");
    }
    for (const [name, value] of Object.entries(input.sampleData as Record<string, unknown>)) {
      if (!allowedVariables(def).includes(name)) {
        throw new NotificationTemplateError("invalid_variables", `sampleData has unsupported variable "${name}"`, 422, {
          unsupported: [name],
          allowed: allowedVariables(def),
        });
      }
      overrides[name] = String(value);
    }
  }

  const vars = { brand: getCurrentTenant().name, ...def.sampleData, ...overrides };
  return { key: input.key, version, usedVariables: [...new Set([...extractVariables(source.subject), ...extractVariables(source.body)])], sampleData: vars, ...renderVersion(source, vars) };
}

// ── Queries ──────────────────────────────────────────────────────────────

export async function listVersions(key: string, locale?: unknown) {
  if (!getTemplateDefinition(key)) {
    throw new NotificationTemplateError("unknown_template", `Unknown template "${key}"`, 404);
  }
  const where: Record<string, unknown> = { key };
  if (locale !== undefined) where.locale = requireLocale(locale);
  return prisma.notificationTemplateVersion.findMany({
    where,
    orderBy: [{ locale: "asc" }, { version: "desc" }],
  });
}

/** Every template with its allowed variables and the live version per locale. */
export async function listTemplates() {
  const live = await prisma.notificationTemplateVersion.findMany({ where: { status: "Published" } });
  return TEMPLATE_DEFINITIONS.map((def) => ({
    key: def.key,
    description: def.description,
    variables: allowedVariables(def),
    published: SUPPORTED_LOCALES.map((locale) => {
      const v = live.find((r: { key: string; locale: string }) => r.key === def.key && r.locale === locale);
      return {
        locale,
        version: v?.version ?? null,
        versionId: v?.id ?? null,
        publishedAt: v?.publishedAt ?? null,
        publishedBy: v?.publishedBy ?? null,
      };
    }),
  }));
}

// ── Send-time resolution ─────────────────────────────────────────────────

function normalizeLocale(raw: string | null | undefined): Locale {
  const primary = (raw ?? "").toLowerCase().split(/[-_]/)[0];
  return isValidLocale(primary) ? primary : "en";
}

/**
 * Renders the live version of a template for a send. Returns null when no
 * version is published for the locale — the caller then uses the built-in
 * template — and also when the lookup fails, so a database hiccup degrades to
 * the built-in wording instead of dropping the email.
 */
export async function renderPublishedTemplate(
  key: string,
  rawLocale: string | null | undefined,
  vars: Record<string, unknown>
): Promise<{ subject: string; body: string; version: number } | null> {
  const def = getTemplateDefinition(key);
  if (!def) return null;
  const locale = normalizeLocale(rawLocale);
  try {
    const live = await prisma.notificationTemplateVersion.findFirst({
      where: { key, locale, status: "Published" },
    });
    if (!live) return null;
    return { ...renderVersion(live, { brand: getCurrentTenant().name, ...vars }), version: live.version };
  } catch (err) {
    logger.error("[notification-templates] failed to resolve published template; using built-in", { key, locale, err });
    return null;
  }
}
