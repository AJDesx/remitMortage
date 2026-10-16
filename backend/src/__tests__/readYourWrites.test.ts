// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

jest.mock("../services/redis.js", () => ({ getRedisClient: () => null }));

import {
  clearReadYourWritesMarkers,
  recordSessionWrite,
  replicaHasCaughtUp,
  shouldReadFromPrimary,
} from "../services/readYourWrites.js";

describe("read-your-writes routing", () => {
  beforeEach(() => {
    clearReadYourWritesMarkers();
    delete process.env.READ_YOUR_WRITES_ENABLED;
    delete process.env.READ_YOUR_WRITES_WINDOW_SECONDS;
  });

  it("routes a session to primary while the replica replay time trails its write", async () => {
    recordSessionWrite("session-a", 10_000);

    expect(await shouldReadFromPrimary("session-a", 5, 12_000)).toBe(true);
    expect(await shouldReadFromPrimary("session-b", 5, 12_000)).toBe(false);
    expect(await shouldReadFromPrimary("session-a", 1, 12_000)).toBe(false);
  });

  it("keeps the primary when replica lag cannot be measured", async () => {
    recordSessionWrite("session-a", 10_000);

    expect(await shouldReadFromPrimary("session-a", null, 11_000)).toBe(true);
  });

  it("uses the replica after its replay timestamp passes the last write", () => {
    expect(replicaHasCaughtUp(10_000, 2, 12_000)).toBe(true);
    expect(replicaHasCaughtUp(10_000, 3, 12_000)).toBe(false);
  });
});
