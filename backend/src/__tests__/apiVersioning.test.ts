// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Tests for the API versioning policy (issue #847).
 *
 * Acceptance criteria under test:
 * 1. Responses from a deprecated endpoint carry deprecation and sunset
 *    information.
 * 2. Per-version usage is visible to the team.
 */

import express from "express";
import request from "supertest";
import {
  CURRENT_API_VERSION,
  DEPRECATED_ENDPOINTS,
  deprecated,
} from "../middleware/apiVersioning.js";
import { httpMetricsMiddleware } from "../middleware/metricsMiddleware.js";
import { httpRequestsByVersionTotal } from "../services/metrics.js";

function resetDeprecatedEndpoints() {
  DEPRECATED_ENDPOINTS.length = 0;
}

describe("deprecated() middleware (acceptance criterion 1)", () => {
  beforeEach(resetDeprecatedEndpoints);

  it("sets Deprecation and Sunset headers as HTTP-dates", async () => {
    const app = express();
    app.get(
      "/old",
      deprecated("GET", "/api/old", { deprecatedOn: "2026-10-15", sunsetOn: "2027-01-15" }),
      (_req, res) => res.json({ ok: true })
    );

    const res = await request(app).get("/old");

    expect(res.status).toBe(200);
    expect(res.headers["deprecation"]).toBe(new Date("2026-10-15").toUTCString());
    expect(res.headers["sunset"]).toBe(new Date("2027-01-15").toUTCString());
  });

  it("sets a Link header with rel=successor-version when a successor is given", async () => {
    const app = express();
    app.get(
      "/old",
      deprecated("GET", "/api/old", {
        deprecatedOn: "2026-10-15",
        sunsetOn: "2027-01-15",
        successorPath: "/api/new",
      }),
      (_req, res) => res.json({ ok: true })
    );

    const res = await request(app).get("/old");

    expect(res.headers["link"]).toBe('</api/new>; rel="successor-version"');
  });

  it("omits the Link header when there is no successor", async () => {
    const app = express();
    app.get(
      "/old",
      deprecated("GET", "/api/old", { deprecatedOn: "2026-10-15", sunsetOn: "2027-01-15" }),
      (_req, res) => res.json({ ok: true })
    );

    const res = await request(app).get("/old");

    expect(res.headers["link"]).toBeUndefined();
  });

  it("sets X-Deprecation-Notice when a note is given, and omits it otherwise", async () => {
    const app = express();
    app.get(
      "/with-note",
      deprecated("GET", "/api/with-note", {
        deprecatedOn: "2026-10-15",
        sunsetOn: "2027-01-15",
        note: "Use /api/new instead.",
      }),
      (_req, res) => res.json({ ok: true })
    );
    app.get(
      "/without-note",
      deprecated("GET", "/api/without-note", { deprecatedOn: "2026-10-15", sunsetOn: "2027-01-15" }),
      (_req, res) => res.json({ ok: true })
    );

    const withNote = await request(app).get("/with-note");
    const withoutNote = await request(app).get("/without-note");

    expect(withNote.headers["x-deprecation-notice"]).toBe("Use /api/new instead.");
    expect(withoutNote.headers["x-deprecation-notice"]).toBeUndefined();
  });

  it("registers the endpoint in DEPRECATED_ENDPOINTS at call time, not only after a request hits it", () => {
    deprecated("POST", "/api/legacy-thing", {
      deprecatedOn: "2026-10-15",
      sunsetOn: "2027-01-15",
      successorPath: "/api/new-thing",
    });

    // No request was ever made — the registry must already reflect it.
    expect(DEPRECATED_ENDPOINTS).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/api/legacy-thing",
        deprecatedOn: "2026-10-15",
        sunsetOn: "2027-01-15",
        successorPath: "/api/new-thing",
      }),
    ]);
  });

  it("uppercases the method in the registry regardless of how it was passed", () => {
    deprecated("get", "/api/lowercase-method", { deprecatedOn: "2026-10-15", sunsetOn: "2027-01-15" });
    expect(DEPRECATED_ENDPOINTS[0].method).toBe("GET");
  });
});

describe("per-version request metrics (acceptance criterion 2)", () => {
  async function valueFor(version: string, method: string, route: string): Promise<number> {
    const metric = await httpRequestsByVersionTotal.get();
    const match = metric.values.find(
      (v) => v.labels.version === version && v.labels.method === method && v.labels.route === route
    );
    return match?.value ?? 0;
  }

  it("defaults to CURRENT_API_VERSION and sets the Api-Version response header when the client sends none", async () => {
    const app = express();
    app.use(httpMetricsMiddleware);
    app.get("/api/thing", (_req, res) => res.json({ ok: true }));

    const before = await valueFor(CURRENT_API_VERSION, "GET", "/api/thing");
    const res = await request(app).get("/api/thing");
    const after = await valueFor(CURRENT_API_VERSION, "GET", "/api/thing");

    expect(res.headers["api-version"]).toBe(CURRENT_API_VERSION);
    expect(after).toBe(before + 1);
  });

  it("tracks a client-declared version separately from the default", async () => {
    const app = express();
    app.use(httpMetricsMiddleware);
    app.get("/api/versioned-thing", (_req, res) => res.json({ ok: true }));

    const before = await valueFor("2", "GET", "/api/versioned-thing");
    const res = await request(app).get("/api/versioned-thing").set("Api-Version", "2");
    const after = await valueFor("2", "GET", "/api/versioned-thing");

    expect(res.headers["api-version"]).toBe("2");
    expect(after).toBe(before + 1);
  });
});
