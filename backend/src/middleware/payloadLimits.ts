// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Request payload size and shape limits (issue #828).
 *
 * Oversized or deeply nested JSON can exhaust memory and CPU before any
 * validation runs, so every request is checked against limits resolved for its
 * route, in this order:
 *
 *   1. `Content-Length` is compared with the byte limit before a single body
 *      byte is read.
 *   2. For chunked bodies the stream is aborted as soon as it crosses the limit
 *      (the underlying body parser enforces this while reading).
 *   3. The raw JSON text is scanned for nesting depth and array length with a
 *      constant-memory byte scanner *before* `JSON.parse` allocates the object
 *      graph.
 *
 * All rejections are `413` with a machine-readable code and increment
 * `remitmortgage_payload_rejected_total`.
 *
 * Defaults are small. Larger limits are opt-in per route via {@link RouteLimit}
 * (see {@link DEFAULT_ROUTE_LIMITS}); the defaults can be tuned with
 * `PAYLOAD_MAX_BYTES`, `PAYLOAD_MAX_JSON_DEPTH` and `PAYLOAD_MAX_ARRAY_LENGTH`.
 */

import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { payloadRejectedTotal } from "../services/metrics.js";
import logger from "../utils/logger.js";

export interface PayloadLimits {
  /** Maximum request body size in bytes. */
  maxBytes: number;
  /** Maximum JSON nesting depth (`{"a":1}` has depth 1). */
  maxDepth: number;
  /** Maximum number of elements in any single JSON array. */
  maxArrayLength: number;
}

/** A route override: any omitted limit inherits the default. */
export interface RouteLimit extends Partial<PayloadLimits> {
  /** Request path prefix, matched on path-segment boundaries (`/api/kyc` matches `/api/kyc/upload`). */
  prefix: string;
}

export type PayloadRejectionReason = "too_large" | "too_deep" | "array_too_long";

const ERROR_CODES: Record<PayloadRejectionReason, string> = {
  too_large: "payload_too_large",
  too_deep: "json_too_deep",
  array_too_long: "json_array_too_long",
};

const KB = 1024;
const MB = 1024 * KB;

export const BASE_PAYLOAD_LIMITS: PayloadLimits = {
  maxBytes: 100 * KB,
  maxDepth: 20,
  maxArrayLength: 1_000,
};

/**
 * Explicit larger limits. Only routes that legitimately take big bodies are
 * listed; everything else gets the small default. The upload routes carry
 * multipart bodies, so only their byte limit is relevant (multer applies its
 * own per-file limit underneath this one, with headroom for the envelope).
 */
export const DEFAULT_ROUTE_LIMITS: readonly RouteLimit[] = [
  { prefix: "/api/kyc", maxBytes: 11 * MB },
  { prefix: "/api/loan/import", maxBytes: 6 * MB },
  // Email provider event batches arrive as one large JSON array.
  { prefix: "/api/webhooks/email-events", maxBytes: 1 * MB, maxArrayLength: 10_000 },
];

export class PayloadLimitError extends Error {
  readonly statusCode = 413;
  constructor(
    readonly reason: PayloadRejectionReason,
    message: string
  ) {
    super(message);
    this.name = "PayloadLimitError";
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** Base limits with `PAYLOAD_MAX_*` environment overrides applied. */
export function loadPayloadLimits(env: NodeJS.ProcessEnv = process.env): PayloadLimits {
  return {
    maxBytes: positiveInt(env.PAYLOAD_MAX_BYTES, BASE_PAYLOAD_LIMITS.maxBytes),
    maxDepth: positiveInt(env.PAYLOAD_MAX_JSON_DEPTH, BASE_PAYLOAD_LIMITS.maxDepth),
    maxArrayLength: positiveInt(env.PAYLOAD_MAX_ARRAY_LENGTH, BASE_PAYLOAD_LIMITS.maxArrayLength),
  };
}

function matchesPrefix(path: string, prefix: string): boolean {
  const normalized = prefix.length > 1 && prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return path === normalized || path.startsWith(`${normalized}/`);
}

export interface ResolvedLimits extends PayloadLimits {
  /** Matched route prefix, or `default`; used as the metric label. */
  route: string;
}

/** Resolves the limits for a request path. The longest matching prefix wins. */
export function resolveLimits(
  path: string,
  defaults: PayloadLimits,
  routes: readonly RouteLimit[]
): ResolvedLimits {
  let best: RouteLimit | undefined;
  for (const rule of routes) {
    if (matchesPrefix(path, rule.prefix) && (!best || rule.prefix.length > best.prefix.length)) {
      best = rule;
    }
  }
  if (!best) return { ...defaults, route: "default" };
  return {
    maxBytes: best.maxBytes ?? defaults.maxBytes,
    maxDepth: best.maxDepth ?? defaults.maxDepth,
    maxArrayLength: best.maxArrayLength ?? defaults.maxArrayLength,
    route: best.prefix,
  };
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

/**
 * Scans raw JSON text and throws {@link PayloadLimitError} when it nests deeper
 * than `maxDepth` or holds an array with more than `maxArrayLength` elements.
 *
 * It never builds the value, tracks only the open containers, and bails out at
 * the first violation, so its cost is bounded by the (already size-limited)
 * body. Malformed JSON is not diagnosed here — the JSON parser rejects it
 * afterwards.
 */
export function assertJsonShape(
  body: Uint8Array,
  limits: Pick<PayloadLimits, "maxDepth" | "maxArrayLength">
): void {
  // One entry per open container. For arrays: -1 = no element seen yet, else
  // the element count so far. Objects are marked with -2.
  const stack: number[] = [];
  let inString = false;

  const startValue = () => {
    const top = stack.length - 1;
    if (top >= 0 && stack[top] === -1) stack[top] = 1;
  };

  for (let i = 0; i < body.length; i++) {
    const byte = body[i];

    if (inString) {
      if (byte === BACKSLASH) i++;
      else if (byte === QUOTE) inString = false;
      continue;
    }
    if (isWhitespace(byte)) continue;

    switch (byte) {
      case QUOTE:
        startValue();
        inString = true;
        break;
      case OPEN_BRACE:
      case OPEN_BRACKET:
        startValue();
        stack.push(byte === OPEN_BRACKET ? -1 : -2);
        if (stack.length > limits.maxDepth) {
          throw new PayloadLimitError(
            "too_deep",
            `JSON nesting exceeds the maximum depth of ${limits.maxDepth}`
          );
        }
        break;
      case CLOSE_BRACE:
      case CLOSE_BRACKET:
        stack.pop();
        break;
      case COMMA: {
        const top = stack.length - 1;
        if (top >= 0 && stack[top] >= 0) {
          stack[top]++;
          if (stack[top] > limits.maxArrayLength) {
            throw new PayloadLimitError(
              "array_too_long",
              `JSON array exceeds the maximum length of ${limits.maxArrayLength}`
            );
          }
        }
        break;
      }
      default:
        // Number, true/false/null literal, or the ':' of an object member.
        if (byte !== 0x3a) startValue();
    }
  }
}

export interface PayloadLimitsOptions {
  defaults?: PayloadLimits;
  routes?: readonly RouteLimit[];
}

function reject(
  res: Response,
  req: Request,
  reason: PayloadRejectionReason,
  route: string,
  message: string,
  limits: PayloadLimits
): void {
  payloadRejectedTotal.inc({ reason, route });
  logger.warn("[payload-limits] request rejected", {
    reason,
    route,
    method: req.method,
    path: req.originalUrl || req.url,
    contentLength: req.headers["content-length"],
  });
  if (!res.headersSent) {
    // The unread body must not be left to keep the socket busy.
    res.setHeader("Connection", "close");
    res.status(413).json({
      error: ERROR_CODES[reason],
      message,
      statusCode: 413,
      limits: {
        maxBytes: limits.maxBytes,
        maxDepth: limits.maxDepth,
        maxArrayLength: limits.maxArrayLength,
      },
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Drop-in replacement for `express.json()` that enforces per-route payload
 * limits. Mount it once, before any other body consumer.
 */
export function payloadLimits(options: PayloadLimitsOptions = {}): RequestHandler {
  const defaults = options.defaults ?? loadPayloadLimits();
  const routes = options.routes ?? DEFAULT_ROUTE_LIMITS;
  // One parser per distinct byte limit; parsing options are otherwise identical.
  const parsers = new Map<string, RequestHandler>();

  const parserFor = (limits: ResolvedLimits): RequestHandler => {
    const key = `${limits.maxBytes}:${limits.maxDepth}:${limits.maxArrayLength}`;
    let parser = parsers.get(key);
    if (!parser) {
      parser = express.json({
        limit: limits.maxBytes,
        verify: (_req, _res, buf) => assertJsonShape(buf, limits),
      });
      parsers.set(key, parser);
    }
    return parser;
  };

  return (req: Request, res: Response, next: NextFunction) => {
    const limits = resolveLimits(req.path, defaults, routes);

    const declared = req.headers["content-length"];
    if (declared !== undefined) {
      const length = Number(declared);
      if (Number.isFinite(length) && length > limits.maxBytes) {
        return reject(
          res,
          req,
          "too_large",
          limits.route,
          `Request body of ${length} bytes exceeds the ${limits.maxBytes} byte limit for this route`,
          limits
        );
      }
    }

    parserFor(limits)(req, res, (err?: unknown) => {
      if (!err) return next();

      const e = err as { type?: string; status?: number; statusCode?: number; reason?: PayloadRejectionReason };
      // body-parser wraps errors thrown from `verify`; the original is the cause.
      const cause = (err as { cause?: unknown }).cause ?? err;
      const limitError = cause instanceof PayloadLimitError ? cause : err instanceof PayloadLimitError ? err : null;

      if (limitError) {
        return reject(res, req, limitError.reason, limits.route, limitError.message, limits);
      }
      if (e.type === "entity.too.large") {
        return reject(
          res,
          req,
          "too_large",
          limits.route,
          `Request body exceeds the ${limits.maxBytes} byte limit for this route`,
          limits
        );
      }
      return next(err);
    });
  };
}
