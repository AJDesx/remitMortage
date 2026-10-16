// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * API versioning policy enforcement (issue #847). See
 * docs/API_VERSIONING_POLICY.md for the full policy and rationale.
 *
 * Convention: this API is versioned by an `Api-Version` header, not a URL
 * path prefix (there is no `/api/v1/...`). Every existing endpoint is
 * implicitly version `CURRENT_API_VERSION` ("1") — introducing path-based
 * versioning retroactively would itself be the breaking change this policy
 * exists to prevent. A client may send `Api-Version: <n>` to declare which
 * version it expects; the server always echoes the version it actually
 * served back in the `Api-Version` response header (see
 * middleware/metricsMiddleware.ts, which also tags the per-version request
 * counter from the same header on every request).
 *
 * `deprecated()` is applied per-route to mark a specific endpoint
 * deprecated: it sets the `Deprecation` and `Sunset` headers (RFC 8594/
 * draft-ietf-httpapi-deprecation-header) and, when a replacement exists, a
 * `Link` header with `rel="successor-version"` so a well-behaved client can
 * discover where to migrate to without reading docs.
 */

import { Request, Response, NextFunction } from "express";

export const CURRENT_API_VERSION = "1";

export interface DeprecationOptions {
  /** HTTP-date or ISO 8601 date the endpoint was marked deprecated. */
  deprecatedOn: string;
  /** HTTP-date or ISO 8601 date the endpoint will stop working. Must be in the future when registered. */
  sunsetOn: string;
  /** Path or URL of the replacement endpoint, if one exists. */
  successorPath?: string;
  /** Free-text migration note surfaced in a custom header for humans reading responses/logs. */
  note?: string;
}

export interface DeprecatedEndpointEntry extends DeprecationOptions {
  method: string;
  path: string;
}

/**
 * Central registry of every endpoint marked deprecated via `deprecated()`
 * below. Populated as a side effect of applying the middleware to a route —
 * this is what backs `GET /api/admin/api-versions/usage`'s deprecation
 * listing, so the set of deprecated endpoints is visible without grepping
 * the codebase.
 */
export const DEPRECATED_ENDPOINTS: DeprecatedEndpointEntry[] = [];

function toHttpDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toUTCString();
}

/**
 * Marks a route deprecated. Pass the method and the FULL mounted path
 * (including the router's own base path, since that's what's useful in a
 * visibility report) explicitly rather than inferring them from the
 * request — inferring from `req` would only populate the registry after a
 * request actually hits the route, leaving a freshly deployed deprecation
 * invisible until then. Register it like any other route middleware:
 *
 *   router.get("/old-thing", deprecated("GET", "/api/old-thing", {
 *     deprecatedOn: "2026-10-01",
 *     sunsetOn: "2027-01-01",
 *     successorPath: "/api/new-thing",
 *   }), handler)
 */
export function deprecated(method: string, path: string, options: DeprecationOptions) {
  DEPRECATED_ENDPOINTS.push({ ...options, method: method.toUpperCase(), path });

  return function deprecationMiddleware(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader("Deprecation", toHttpDate(options.deprecatedOn));
    res.setHeader("Sunset", toHttpDate(options.sunsetOn));
    if (options.successorPath) {
      res.setHeader("Link", `<${options.successorPath}>; rel="successor-version"`);
    }
    if (options.note) {
      res.setHeader("X-Deprecation-Notice", options.note);
    }
    next();
  };
}
