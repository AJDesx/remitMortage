// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

// Pure scheduling helpers for the "Scheduled" theme mode. No DOM, no storage:
// everything takes the current Date so boundaries are unit-testable.

export type Theme = "light" | "dark";
export type ThemeMode = "system" | "scheduled" | "manual";

export interface ThemeSchedule {
  /** "custom": user-chosen hours. "sun": dark between sunset and sunrise at lat/lng. */
  kind: "custom" | "sun";
  /** "HH:MM" when dark mode starts. For kind "sun" this is the computed sunset. */
  start: string;
  /** "HH:MM" when dark mode ends. For kind "sun" this is the computed sunrise. */
  end: string;
  lat?: number;
  lng?: number;
}

export const DEFAULT_SCHEDULE: ThemeSchedule = { kind: "custom", start: "20:00", end: "07:00" };

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MINUTES = 24 * 60;

export function parseTime(value: string): number | null {
  const m = TIME_RE.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function formatTime(minutes: number): string {
  const m = ((Math.round(minutes) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function isValidSchedule(value: unknown): value is ThemeSchedule {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<ThemeSchedule>;
  return (
    (s.kind === "custom" || s.kind === "sun") &&
    typeof s.start === "string" &&
    typeof s.end === "string" &&
    parseTime(s.start) !== null &&
    parseTime(s.end) !== null
  );
}

function minuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Dark window is [start, end). It may wrap midnight (20:00 -> 07:00).
 * start === end is an empty window (always light) rather than 24h of dark.
 */
export function isDarkAt(date: Date, schedule: ThemeSchedule): boolean {
  const start = parseTime(schedule.start);
  const end = parseTime(schedule.end);
  if (start === null || end === null || start === end) return false;
  const now = minuteOfDay(date);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** Milliseconds from `date` until the theme next flips; null if it never will. */
export function msUntilNextSwitch(date: Date, schedule: ThemeSchedule): number | null {
  const start = parseTime(schedule.start);
  const end = parseTime(schedule.end);
  if (start === null || end === null || start === end) return null;
  const nowMs = date.getHours() * 3_600_000 + date.getMinutes() * 60_000 + date.getSeconds() * 1000 + date.getMilliseconds();
  const target = (isDarkAt(date, schedule) ? end : start) * 60_000;
  const delta = target - nowMs;
  return delta > 0 ? delta : delta + DAY_MINUTES * 60_000;
}

export interface ResolveInput {
  mode: ThemeMode;
  manualTheme: Theme;
  systemDark: boolean;
  schedule: ThemeSchedule;
  now: Date;
}

export function resolveEffectiveTheme({ mode, manualTheme, systemDark, schedule, now }: ResolveInput): Theme {
  if (mode === "manual") return manualTheme;
  if (mode === "scheduled") return isDarkAt(now, schedule) ? "dark" : "light";
  return systemDark ? "dark" : "light";
}

/**
 * Local-time sunrise/sunset for a date and location (NOAA approximation,
 * accurate to a couple of minutes). Returns null during polar day/night.
 */
export function computeSunTimes(date: Date, lat: number, lng: number): { sunrise: string; sunset: string } | null {
  const rad = Math.PI / 180;
  const dayOfYear = Math.round(
    (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 0)) / 86_400_000
  );
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1);
  const eqTime =
    229.18 *
    (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);
  const cosHa = Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl)) - Math.tan(lat * rad) * Math.tan(decl);
  if (cosHa > 1 || cosHa < -1) return null;
  const ha = Math.acos(cosHa) / rad;
  const offset = date.getTimezoneOffset(); // minutes: UTC - local
  const toLocal = (utcMinutes: number) => utcMinutes - offset;
  return {
    sunrise: formatTime(toLocal(720 - 4 * (lng + ha) - eqTime)),
    sunset: formatTime(toLocal(720 - 4 * (lng - ha) - eqTime)),
  };
}

/** For kind "sun", refresh start/end from the coordinates for `date`; otherwise unchanged. */
export function withSunTimes(schedule: ThemeSchedule, date: Date): ThemeSchedule {
  if (schedule.kind !== "sun" || schedule.lat === undefined || schedule.lng === undefined) return schedule;
  const sun = computeSunTimes(date, schedule.lat, schedule.lng);
  return sun ? { ...schedule, start: sun.sunset, end: sun.sunrise } : schedule;
}
