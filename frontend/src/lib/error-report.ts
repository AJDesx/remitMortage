// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import * as Sentry from "@sentry/nextjs";

// Scrubbing runs on everything before it leaves the browser. Order matters:
// specific tokens (JWTs, Stellar keys) are replaced before the generic digit
// and hex patterns can half-match them.
const SCRUBBERS: [RegExp, string][] = [
  [/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "[token]"],
  [/\b(Bearer|Basic)\s+[\w.~+/=-]{8,}/gi, "$1 [token]"],
  [/\bS[A-Z2-7]{55}\b/g, "[stellar-secret]"],
  [/\b[GCM][A-Z2-7]{55}\b/g, "[stellar-address]"],
  [/\b0x[0-9a-fA-F]{40}\b/g, "[address]"],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]"],
  [/\b[0-9a-fA-F]{32,}\b/g, "[hash]"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[uuid]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[number]"],
  [/(?<!\w)\+?\d[\d\s().-]{8,}\d/g, "[phone]"],
  [/([?&](?:token|key|secret|password|auth|code|email|address)=)[^&\s#]+/gi, "$1[redacted]"],
];

export function scrubText(input: string | undefined | null): string {
  if (!input) return "";
  return SCRUBBERS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), input);
}

/** Drop query/hash and replace id-like path segments so routes carry no identifiers. */
export function anonymizeRoute(pathname: string): string {
  const path = pathname.split(/[?#]/)[0] || "/";
  return (
    path
      .split("/")
      .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) || /^[A-Z2-7]{40,}$/.test(seg) ? "[id]" : seg))
      .join("/") || "/"
  );
}

export function generateErrorId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return "ERR-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export interface ErrorReport {
  errorId: string;
  route: string;
  description: string;
  errorName: string;
  errorMessage: string;
  context: {
    browser: string;
    viewport: string;
    locale: string;
    online: boolean;
    timestamp: string;
  };
}

function browserFamily(ua: string): string {
  if (/edg\//i.test(ua)) return "Edge";
  if (/firefox\//i.test(ua)) return "Firefox";
  if (/chrome\//i.test(ua)) return "Chrome";
  if (/safari\//i.test(ua)) return "Safari";
  return "Other";
}

export interface BuildReportInput {
  errorId: string;
  pathname: string;
  description: string;
  error: Error;
}

/** Build the report. Only coarse, non-identifying context is attached. */
export function buildReport({ errorId, pathname, description, error }: BuildReportInput): ErrorReport {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  return {
    errorId,
    route: anonymizeRoute(pathname),
    description: scrubText(description).slice(0, 2000),
    errorName: scrubText(error.name),
    errorMessage: scrubText(error.message).slice(0, 500),
    context: {
      browser: browserFamily(nav?.userAgent ?? ""),
      viewport: typeof window !== "undefined" ? `${window.innerWidth}x${window.innerHeight}` : "unknown",
      locale: nav?.language ?? "unknown",
      online: nav?.onLine ?? true,
      timestamp: new Date().toISOString(),
    },
  };
}

/** Capture the crash itself (scrubbed) so a later report can be linked to it. */
export function captureRenderError(error: Error & { digest?: string }, errorId: string, pathname: string): string {
  const safe = new Error(scrubText(error.message));
  safe.name = error.name;
  safe.stack = scrubText(error.stack);
  return Sentry.captureException(safe, {
    tags: { error_id: errorId, route: anonymizeRoute(pathname), boundary: "route" },
    extra: error.digest ? { digest: error.digest } : undefined,
  });
}

export function submitReport(report: ErrorReport, associatedEventId?: string): void {
  Sentry.captureFeedback({
    message: `[${report.errorId}] ${report.description || "(no description)"}`,
    associatedEventId,
    tags: { error_id: report.errorId, route: report.route },
  });
}
