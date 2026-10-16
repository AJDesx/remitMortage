// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  computeSunTimes,
  isDarkAt,
  isValidSchedule,
  msUntilNextSwitch,
  parseTime,
  resolveEffectiveTheme,
  withSunTimes,
  type ThemeSchedule,
} from "../src/app/lib/theme-schedule";

const at = (h: number, m = 0, s = 0) => new Date(2026, 5, 15, h, m, s);
const overnight: ThemeSchedule = { kind: "custom", start: "20:00", end: "07:00" };
const daytime: ThemeSchedule = { kind: "custom", start: "09:00", end: "17:00" };

describe("isDarkAt boundaries", () => {
  it("overnight window is dark from the start minute, light from the end minute", () => {
    expect(isDarkAt(at(19, 59), overnight)).toBe(false);
    expect(isDarkAt(at(20, 0), overnight)).toBe(true);
    expect(isDarkAt(at(23, 59), overnight)).toBe(true);
    expect(isDarkAt(at(0, 0), overnight)).toBe(true);
    expect(isDarkAt(at(6, 59), overnight)).toBe(true);
    expect(isDarkAt(at(7, 0), overnight)).toBe(false);
  });

  it("same-day window", () => {
    expect(isDarkAt(at(8, 59), daytime)).toBe(false);
    expect(isDarkAt(at(9, 0), daytime)).toBe(true);
    expect(isDarkAt(at(16, 59), daytime)).toBe(true);
    expect(isDarkAt(at(17, 0), daytime)).toBe(false);
  });

  it("start === end is an empty window", () => {
    expect(isDarkAt(at(12), { kind: "custom", start: "08:00", end: "08:00" })).toBe(false);
  });

  it("invalid times never go dark", () => {
    expect(isDarkAt(at(23), { kind: "custom", start: "25:00", end: "07:00" })).toBe(false);
  });
});

describe("msUntilNextSwitch", () => {
  it("counts to the end while dark and to the start while light", () => {
    expect(msUntilNextSwitch(at(6, 0), overnight)).toBe(60 * 60_000);
    expect(msUntilNextSwitch(at(19, 0), overnight)).toBe(60 * 60_000);
  });
  it("wraps past midnight", () => {
    expect(msUntilNextSwitch(at(23, 0), overnight)).toBe(8 * 60 * 60_000);
  });
  it("accounts for seconds", () => {
    expect(msUntilNextSwitch(at(19, 59, 30), overnight)).toBe(30_000);
  });
  it("is exactly on the boundary -> next switch is the opposite edge, a day or half away", () => {
    expect(msUntilNextSwitch(at(20, 0), overnight)).toBe(11 * 60 * 60_000);
  });
  it("is null for an empty window", () => {
    expect(msUntilNextSwitch(at(1), { kind: "custom", start: "08:00", end: "08:00" })).toBeNull();
  });
});

describe("resolveEffectiveTheme", () => {
  const base = { manualTheme: "light" as const, systemDark: true, schedule: overnight, now: at(22) };
  it("manual ignores system and schedule", () => {
    expect(resolveEffectiveTheme({ ...base, mode: "manual" })).toBe("light");
  });
  it("system follows the OS", () => {
    expect(resolveEffectiveTheme({ ...base, mode: "system" })).toBe("dark");
    expect(resolveEffectiveTheme({ ...base, mode: "system", systemDark: false })).toBe("light");
  });
  it("scheduled follows the clock, not the OS", () => {
    expect(resolveEffectiveTheme({ ...base, mode: "scheduled", systemDark: false })).toBe("dark");
    expect(resolveEffectiveTheme({ ...base, mode: "scheduled", now: at(12) })).toBe("light");
  });
});

describe("sunrise / sunset", () => {
  it("London near the June solstice is roughly 04:45 / 21:20 UTC-adjusted", () => {
    const sun = computeSunTimes(new Date(Date.UTC(2026, 5, 21, 12)), 51.5, -0.12);
    expect(sun).not.toBeNull();
    // Compare as UTC-equivalent minutes so the test is timezone independent.
    const d = new Date(Date.UTC(2026, 5, 21, 12));
    const utc = (hhmm: string) => (parseTime(hhmm)! + d.getTimezoneOffset() + 1440) % 1440;
    expect(Math.abs(utc(sun!.sunrise) - (3 * 60 + 43))).toBeLessThanOrEqual(10);
    expect(Math.abs(utc(sun!.sunset) - (20 * 60 + 21))).toBeLessThanOrEqual(10);
  });
  it("returns null in polar night", () => {
    expect(computeSunTimes(new Date(2026, 11, 21), 80, 0)).toBeNull();
  });
  it("withSunTimes fills start/end for kind sun and leaves custom alone", () => {
    const sun = withSunTimes({ kind: "sun", start: "18:00", end: "06:00", lat: 51.5, lng: -0.12 }, at(12));
    expect(isValidSchedule(sun)).toBe(true);
    expect(sun.start).not.toBe("18:00");
    expect(withSunTimes(overnight, at(12))).toBe(overnight);
  });
});
