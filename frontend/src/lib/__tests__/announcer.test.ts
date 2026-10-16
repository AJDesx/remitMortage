// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { announceToast, announcer, createAnnouncer, type Announcement } from "../announcer";

describe("createAnnouncer", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function collect(instance = createAnnouncer()) {
    const received: Announcement[] = [];
    instance.subscribe((a) => received.push(a));
    return { instance, received };
  }

  it("emits polite and assertive messages with their priority", () => {
    const { instance, received } = collect();
    instance.announce("Saved");
    instance.announce("Failed", { priority: "assertive" });

    expect(received.map((a) => [a.priority, a.message])).toEqual([
      ["polite", "Saved"],
      ["assertive", "Failed"],
    ]);
  });

  it("ignores empty messages and normalises whitespace", () => {
    const { instance, received } = collect();
    expect(instance.announce("   ")).toBe(false);
    instance.announce("  Deposit \n confirmed ");
    expect(received.map((a) => a.message)).toEqual(["Deposit confirmed"]);
  });

  it("drops identical consecutive messages inside the de-dupe window", () => {
    const { instance, received } = collect();
    expect(instance.announce("Deposit confirmed", { priority: "assertive" })).toBe(true);
    expect(instance.announce("Deposit confirmed", { priority: "assertive" })).toBe(false);
    expect(received).toHaveLength(1);

    jest.advanceTimersByTime(instance.config.dedupeWindowMs + 1);
    expect(instance.announce("Deposit confirmed", { priority: "assertive" })).toBe(true);
    expect(received).toHaveLength(2);
  });

  it("allows an identical message again once a different one intervened", () => {
    const { instance, received } = collect(createAnnouncer({ minIntervalMs: 0 }));
    instance.announce("A");
    instance.announce("B");
    instance.announce("A");
    expect(received.map((a) => a.message)).toEqual(["A", "B", "A"]);
  });

  it("rate limits polite bursts and flushes them in order", () => {
    const { instance, received } = collect(createAnnouncer({ minIntervalMs: 1000 }));
    instance.announce("one");
    instance.announce("two");
    instance.announce("three");
    expect(received.map((a) => a.message)).toEqual(["one"]);

    jest.advanceTimersByTime(1000);
    expect(received.map((a) => a.message)).toEqual(["one", "two"]);
    jest.advanceTimersByTime(1000);
    expect(received.map((a) => a.message)).toEqual(["one", "two", "three"]);
  });

  it("bounds the queue by discarding the oldest queued message", () => {
    const { instance, received } = collect(createAnnouncer({ minIntervalMs: 1000, maxQueue: 2 }));
    ["a", "b", "c", "d"].forEach((m) => instance.announce(m));
    jest.advanceTimersByTime(5000);
    expect(received.map((a) => a.message)).toEqual(["a", "c", "d"]);
  });

  it("never delays assertive messages behind the polite rate limit", () => {
    const { instance, received } = collect();
    instance.announce("polite one");
    instance.announce("polite two");
    instance.announce("Transaction failed", { priority: "assertive" });
    expect(received.map((a) => a.message)).toEqual(["polite one", "Transaction failed"]);
  });

  it("stops delivering after unsubscribe", () => {
    const instance = createAnnouncer();
    const listener = jest.fn();
    const unsubscribe = instance.subscribe(listener);
    unsubscribe();
    instance.announce("hello");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("announceToast", () => {
  beforeEach(() => announcer.reset());

  it("announces errors assertively and successes politely", () => {
    const received: Announcement[] = [];
    const unsubscribe = announcer.subscribe((a) => received.push(a));

    announceToast("error", "Deposit failed", "Insufficient balance");
    announceToast("success", "Vote cast");
    unsubscribe();

    expect(received[0]).toMatchObject({
      priority: "assertive",
      message: "Error: Deposit failed. Insufficient balance",
    });
    expect(received[1]).toMatchObject({ priority: "polite", message: "Vote cast" });
  });
});
