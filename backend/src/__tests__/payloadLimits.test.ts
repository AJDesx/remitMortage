// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Request payload size and shape limits (issue #828).
 */

import http from "http";
import type { AddressInfo } from "net";
import express from "express";
import request from "supertest";

jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  assertJsonShape,
  loadPayloadLimits,
  payloadLimits,
  resolveLimits,
  PayloadLimitError,
  DEFAULT_ROUTE_LIMITS,
  type PayloadLimitsOptions,
} from "../middleware/payloadLimits.js";
import { metricsRegistry } from "../services/metrics.js";

const DEFAULTS = { maxBytes: 1_000, maxDepth: 5, maxArrayLength: 10 };

function buildApp(options: PayloadLimitsOptions = {}) {
  const app = express();
  app.use(payloadLimits({ defaults: DEFAULTS, routes: [], ...options }));
  app.post("/*splat", (req, res) => res.json({ ok: true, body: req.body }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
  return app;
}

function nested(depth: number): string {
  return "[".repeat(depth) + "]".repeat(depth);
}

async function rejectedCount(reason: string, route: string): Promise<number> {
  const metric = await metricsRegistry.getSingleMetricAsString("remitmortgage_payload_rejected_total");
  const line = metric.split("\n").find((l) => l.includes(`reason="${reason}"`) && l.includes(`route="${route}"`));
  return line ? Number(line.split(" ").pop()) : 0;
}

describe("assertJsonShape", () => {
  const limits = { maxDepth: 3, maxArrayLength: 3 };
  const check = (json: string) => assertJsonShape(Buffer.from(json), limits);

  it("accepts documents at exactly the limits", () => {
    expect(() => check('{"a":{"b":{"c":1}}}')).not.toThrow();
    expect(() => check("[1,2,3]")).not.toThrow();
  });

  it("rejects nesting beyond maxDepth, for objects and arrays alike", () => {
    expect(() => check('{"a":{"b":{"c":{"d":1}}}}')).toThrow(PayloadLimitError);
    expect(() => check("[[[[1]]]]")).toThrow(/maximum depth of 3/);
  });

  it("rejects arrays longer than maxArrayLength", () => {
    expect(() => check("[1,2,3,4]")).toThrow(/maximum length of 3/);
    try {
      check("[1,2,3,4]");
    } catch (e) {
      expect((e as PayloadLimitError).reason).toBe("array_too_long");
    }
  });

  it("counts elements of an array per array, not across siblings", () => {
    expect(() => check("[[1,2,3],[1,2,3],[1,2,3]]")).not.toThrow();
    expect(() => check('{"a":[1,2,3],"b":[1,2,3],"c":1,"d":2,"e":3,"f":4}')).not.toThrow();
  });

  it("does not count commas inside objects as array elements", () => {
    expect(() => check('[{"a":1,"b":2,"c":3,"d":4}]')).not.toThrow();
  });

  it("ignores brackets, commas and escaped quotes inside strings", () => {
    expect(() => check('{"a":"[[[[[[[[,,,,,,,,,"}')).not.toThrow();
    expect(() => check('["\\"[[[[,,,,", "]]]]"]')).not.toThrow();
  });

  it("treats nested containers and strings as array elements", () => {
    expect(() => check('[{"a":1},{"a":2},{"a":3}]')).not.toThrow();
    expect(() => check('[{"a":1},{"a":2},{"a":3},{"a":4}]')).toThrow(PayloadLimitError);
    expect(() => check('["a","b","c","d"]')).toThrow(PayloadLimitError);
  });

  it("leaves empty arrays and malformed input to the JSON parser", () => {
    expect(() => check("[]")).not.toThrow();
    expect(() => check('{"a":')).not.toThrow();
  });
});

describe("resolveLimits / loadPayloadLimits", () => {
  const routes = [
    { prefix: "/api/upload", maxBytes: 5_000 },
    { prefix: "/api/upload/special", maxBytes: 9_000, maxDepth: 8 },
  ];

  it("falls back to the defaults for unmatched paths", () => {
    expect(resolveLimits("/api/other", DEFAULTS, routes)).toEqual({ ...DEFAULTS, route: "default" });
  });

  it("applies a route override and inherits the limits it does not set", () => {
    expect(resolveLimits("/api/upload/file", DEFAULTS, routes)).toEqual({
      maxBytes: 5_000,
      maxDepth: 5,
      maxArrayLength: 10,
      route: "/api/upload",
    });
  });

  it("prefers the longest matching prefix", () => {
    expect(resolveLimits("/api/upload/special/x", DEFAULTS, routes)).toMatchObject({
      maxBytes: 9_000,
      maxDepth: 8,
      route: "/api/upload/special",
    });
  });

  it("matches on path-segment boundaries only", () => {
    expect(resolveLimits("/api/uploads", DEFAULTS, routes).route).toBe("default");
  });

  it("keeps the shipped defaults small, with explicit larger limits only for upload routes", () => {
    const base = loadPayloadLimits({});
    expect(base.maxBytes).toBeLessThanOrEqual(100 * 1024);
    expect(resolveLimits("/api/kyc/upload", base, DEFAULT_ROUTE_LIMITS).maxBytes).toBeGreaterThan(base.maxBytes);
    expect(resolveLimits("/api/loan/import", base, DEFAULT_ROUTE_LIMITS).maxBytes).toBeGreaterThan(base.maxBytes);
    expect(resolveLimits("/api/borrower/profile", base, DEFAULT_ROUTE_LIMITS).maxBytes).toBe(base.maxBytes);
  });

  it("reads overrides from the environment and ignores invalid values", () => {
    expect(
      loadPayloadLimits({ PAYLOAD_MAX_BYTES: "2048", PAYLOAD_MAX_JSON_DEPTH: "7", PAYLOAD_MAX_ARRAY_LENGTH: "abc" })
    ).toEqual({ maxBytes: 2048, maxDepth: 7, maxArrayLength: 1_000 });
  });
});

describe("payloadLimits middleware", () => {
  it("parses a body within every limit", async () => {
    const res = await request(buildApp()).post("/echo").send({ a: [1, 2, 3], b: { c: 1 } });
    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ a: [1, 2, 3], b: { c: 1 } });
  });

  it("rejects an oversized body with 413 from Content-Length, before reading it", async () => {
    const before = await rejectedCount("too_large", "default");
    const res = await request(buildApp())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ blob: "x".repeat(2_000) }));

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      error: "payload_too_large",
      statusCode: 413,
      limits: { maxBytes: 1_000, maxDepth: 5, maxArrayLength: 10 },
    });
    expect(res.body.message).toMatch(/exceeds the 1000 byte limit/);
    expect(await rejectedCount("too_large", "default")).toBe(before + 1);
  });

  it("never runs the route handler or JSON.parse for an oversized body", async () => {
    const parse = jest.spyOn(JSON, "parse");
    const handler = jest.fn();
    const app = express();
    app.use(payloadLimits({ defaults: DEFAULTS, routes: [] }));
    app.post("/echo", handler);

    const res = await request(app)
      .post("/echo")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ blob: "x".repeat(5_000) }));

    expect(res.status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
    // (supertest itself JSON.parses the response, so look only for the request body.)
    expect(parse.mock.calls.some(([text]) => typeof text === "string" && text.includes("xxxxx"))).toBe(false);
    parse.mockRestore();
  });

  it("rejects a chunked body that crosses the limit without a Content-Length", async () => {
    const server = http.createServer(buildApp()).listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { port, method: "POST", path: "/echo", headers: { "Content-Type": "application/json" } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          }
        );
        req.on("error", reject);
        // No Content-Length is sent, so Node uses chunked transfer encoding.
        req.write('{"blob":"');
        req.write("x".repeat(4_000));
        req.end('"}');
      });
      expect(status).toBe(413);
    } finally {
      server.close();
    }
  });

  it("rejects JSON nested deeper than the limit and counts the metric", async () => {
    const before = await rejectedCount("too_deep", "default");
    const res = await request(buildApp())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send(nested(6));
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("json_too_deep");
    expect(res.body.message).toMatch(/maximum depth of 5/);
    expect(await rejectedCount("too_deep", "default")).toBe(before + 1);
  });

  it("accepts JSON nested exactly at the limit", async () => {
    const res = await request(buildApp())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send(nested(5));
    expect(res.status).toBe(200);
  });

  it("rejects arrays longer than the limit and counts the metric", async () => {
    const before = await rejectedCount("array_too_long", "default");
    const res = await request(buildApp())
      .post("/echo")
      .send({ items: Array.from({ length: 11 }, (_, i) => i) });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("json_array_too_long");
    expect(await rejectedCount("array_too_long", "default")).toBe(before + 1);
  });

  it("accepts an array of exactly the maximum length", async () => {
    const res = await request(buildApp())
      .post("/echo")
      .send({ items: Array.from({ length: 10 }, (_, i) => i) });
    expect(res.status).toBe(200);
  });

  it("still reports malformed JSON as a client error, not a payload limit", async () => {
    const res = await request(buildApp())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send('{"a":');
    expect(res.status).toBe(400);
  });

  describe("per-route overrides", () => {
    const routes = [
      { prefix: "/api/upload", maxBytes: 10_000 },
      { prefix: "/api/batch", maxArrayLength: 50 },
      { prefix: "/api/deep", maxDepth: 9 },
    ];
    const big = JSON.stringify({ blob: "x".repeat(5_000) });

    it("allows a larger body only on the overridden route", async () => {
      const app = buildApp({ routes });
      const ok = await request(app).post("/api/upload/file").set("Content-Type", "application/json").send(big);
      expect(ok.status).toBe(200);

      const rejected = await request(app).post("/api/other").set("Content-Type", "application/json").send(big);
      expect(rejected.status).toBe(413);
    });

    it("still enforces the overridden byte limit and labels the metric with the route", async () => {
      const before = await rejectedCount("too_large", "/api/upload");
      const res = await request(buildApp({ routes }))
        .post("/api/upload/file")
        .set("Content-Type", "application/json")
        .send(JSON.stringify({ blob: "x".repeat(12_000) }));
      expect(res.status).toBe(413);
      expect(res.body.limits.maxBytes).toBe(10_000);
      expect(await rejectedCount("too_large", "/api/upload")).toBe(before + 1);
    });

    it("allows a longer array only on the overridden route", async () => {
      const app = buildApp({ routes });
      const items = Array.from({ length: 40 }, (_, i) => i);
      expect((await request(app).post("/api/batch").send({ items })).status).toBe(200);
      expect((await request(app).post("/api/elsewhere").send({ items })).status).toBe(413);
    });

    it("allows deeper nesting only on the overridden route", async () => {
      const app = buildApp({ routes });
      const send = (path: string) =>
        request(app).post(path).set("Content-Type", "application/json").send(nested(8));
      expect((await send("/api/deep")).status).toBe(200);
      expect((await send("/api/shallow")).status).toBe(413);
    });

    it("rejects an oversized upload by Content-Length even for non-JSON content types", async () => {
      const res = await request(buildApp({ routes: [{ prefix: "/api/upload", maxBytes: 2_000 }] }))
        .post("/api/upload/file")
        .set("Content-Type", "multipart/form-data; boundary=x")
        .send("x".repeat(5_000));
      expect(res.status).toBe(413);
    });
  });
});
