// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { createHmac } from "node:crypto";
import {
  ChatOpsService,
  RateLimiter,
  buildSlackMessage,
  buildTeamsMessage,
  providersForSeverity,
  verifySlackSignature,
  verifyTeamsSignature,
  type ChatOpsAlert,
  type ChatOpsProvider,
  type ChatOpsTransport,
} from "../services/chatOps.js";

const SLACK_SECRET = "slack-signing-secret";
const TEAMS_SECRET = "teams-signing-secret";

function slackSignature(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

class RecordingTransport implements ChatOpsTransport {
  public calls: Array<{ provider: ChatOpsProvider; payload: Record<string, unknown> }> = [];
  async post(provider: ChatOpsProvider, _url: string, payload: Record<string, unknown>) {
    this.calls.push({ provider, payload });
    return true;
  }
}

const criticalAlert: ChatOpsAlert = {
  id: "alert-1",
  severity: "critical",
  title: "DB pool exhaustion",
  summary: "connections at 100%",
  url: "https://ops.example/alerts/1",
  runbookUrl: "https://ops.example/runbooks/db",
};

describe("ChatOps routing and message building", () => {
  it("routes providers per severity", () => {
    expect(providersForSeverity("critical")).toEqual(["slack", "teams"]);
    expect(providersForSeverity("high")).toEqual(["slack"]);
    expect(providersForSeverity("low")).toEqual([]);
  });

  it("builds a Slack message with a link and an acknowledge button", () => {
    const message = buildSlackMessage(criticalAlert) as any;
    const actions = message.blocks.find((b: any) => b.type === "actions");
    const labels = actions.elements.map((e: any) => e.text.text);
    expect(labels).toEqual(expect.arrayContaining(["View alert", "Acknowledge"]));

    const ack = actions.elements.find((e: any) => e.action_id === "chatops_ack");
    expect(ack).toMatchObject({ value: "alert-1" });
  });

  it("builds a Teams message with a link and an acknowledge action", () => {
    const message = buildTeamsMessage(criticalAlert) as any;
    const card = message.attachments[0].content;
    const actionTypes = card.actions.map((a: any) => a.type);
    expect(actionTypes).toContain("Action.OpenUrl");
    const ack = card.actions.find((a: any) => a.type === "Action.Submit");
    expect(ack.data).toEqual({ action: "chatops_ack", alertId: "alert-1" });
  });
});

describe("ChatOps signature verification", () => {
  const now = 1_700_000_000_000; // seconds: 1_700_000_000
  const timestamp = String(Math.floor(now / 1000));
  const body = JSON.stringify({ actions: [{ value: "alert-1" }] });

  it("accepts a valid Slack signature", () => {
    const signature = slackSignature(SLACK_SECRET, timestamp, body);
    expect(
      verifySlackSignature({ signingSecret: SLACK_SECRET, timestamp, body, signature }, now)
    ).toBe(true);
  });

  it("rejects an invalid Slack signature", () => {
    expect(
      verifySlackSignature(
        { signingSecret: SLACK_SECRET, timestamp, body, signature: "v0=deadbeef" },
        now
      )
    ).toBe(false);
  });

  it("rejects a stale Slack timestamp", () => {
    const signature = slackSignature(SLACK_SECRET, timestamp, body);
    expect(
      verifySlackSignature(
        { signingSecret: SLACK_SECRET, timestamp, body, signature },
        now + 10 * 60 * 1000
      )
    ).toBe(false);
  });

  it("verifies a Teams HMAC signature", () => {
    const good = `HMAC ${createHmac("sha256", TEAMS_SECRET).update(body).digest("base64")}`;
    expect(verifyTeamsSignature({ signingSecret: TEAMS_SECRET, body, signature: good })).toBe(true);
    expect(
      verifyTeamsSignature({ signingSecret: TEAMS_SECRET, body, signature: "HMAC bad" })
    ).toBe(false);
  });
});

describe("ChatOpsService", () => {
  function service(transport: ChatOpsTransport, rateLimitPerMinute = 30) {
    return new ChatOpsService(
      {
        slack: { webhookUrl: "https://hooks.slack.test", signingSecret: SLACK_SECRET },
        teams: { webhookUrl: "https://hooks.teams.test", signingSecret: TEAMS_SECRET },
        rateLimitPerMinute,
      },
      transport
    );
  }

  it("delivers a critical alert to both channels", async () => {
    const transport = new RecordingTransport();
    const result = await service(transport).dispatch(criticalAlert);

    expect(result.delivered).toEqual(["slack", "teams"]);
    expect(transport.calls.map((c) => c.provider)).toEqual(["slack", "teams"]);
  });

  it("rate-limits outgoing messages per channel", async () => {
    const transport = new RecordingTransport();
    const svc = service(transport, 1);

    const first = await svc.dispatch(criticalAlert, 0);
    expect(first.delivered).toEqual(["slack", "teams"]);

    const second = await svc.dispatch({ ...criticalAlert, id: "alert-2" }, 100);
    expect(second.delivered).toEqual([]);
    expect(second.skipped.every((s) => s.reason === "rate_limited")).toBe(true);
  });

  it("acks an alert when the Slack signature is valid and rejects a forged one", () => {
    const svc = service(new RecordingTransport());
    const now = Date.now();
    const timestamp = String(Math.floor(now / 1000));
    const body = JSON.stringify({ actions: [{ action_id: "chatops_ack", value: "alert-9" }] });
    const signature = slackSignature(SLACK_SECRET, timestamp, body);

    const bad = svc.handleAck("slack", {
      headers: { "x-slack-signature": "v0=forged", "x-slack-request-timestamp": timestamp },
      rawBody: body,
    });
    expect(bad).toMatchObject({ ok: false, status: 401 });

    const good = svc.handleAck("slack", {
      headers: { "x-slack-signature": signature, "x-slack-request-timestamp": timestamp },
      rawBody: body,
    });
    expect(good).toEqual({ ok: true, alertId: "alert-9" });
    expect(svc.isAcknowledged("alert-9")).toBe(true);
  });
});

describe("RateLimiter", () => {
  it("blocks once the per-minute budget is exhausted", () => {
    const limiter = new RateLimiter(2);
    expect(limiter.tryConsume("slack", 0)).toBe(true);
    expect(limiter.tryConsume("slack", 1)).toBe(true);
    expect(limiter.tryConsume("slack", 2)).toBe(false);
    // Budget refills after the window elapses.
    expect(limiter.tryConsume("slack", 61_000)).toBe(true);
  });
});
