// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

const THEME_STORAGE_KEY = "remitmortgage-theme";
const PALETTE_STORAGE_KEY = "remitmortgage-palette";
const MODE_STORAGE_KEY = "remitmortgage-theme-mode";
const SCHEDULE_STORAGE_KEY = "remitmortgage-theme-schedule";

import { DEFAULT_SCHEDULE, isValidSchedule } from "./theme-schedule";
import type { Theme, ThemeMode, ThemeSchedule } from "./theme-schedule";

export type { Theme, ThemeMode, ThemeSchedule };
export type ColorPalette = "default" | "colorblind";

export interface ThemeConfig {
  theme: Theme;
  palette: ColorPalette;
}

// ── Theme (light/dark) ────────────────────────────────────────────────────────

export function getStoredTheme(): Theme | null {
  if (typeof window === "undefined") return null;
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return null;
}

export function isSystemDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : true;
}

export function getSystemTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function resolveTheme(): Theme {
  return getStoredTheme() ?? getSystemTheme();
}

export function persistTheme(t: Theme) {
  localStorage.setItem(THEME_STORAGE_KEY, t);
}

// ── Color Palette (default/colorblind) ────────────────────────────────────────

export function getStoredPalette(): ColorPalette | null {
  if (typeof window === "undefined") return null;
  const stored = localStorage.getItem(PALETTE_STORAGE_KEY);
  if (stored === "default" || stored === "colorblind") return stored;
  return null;
}

export function resolvePalette(): ColorPalette {
  return getStoredPalette() ?? "default";
}

export function persistPalette(p: ColorPalette) {
  localStorage.setItem(PALETTE_STORAGE_KEY, p);
}

// ── Mode (system/scheduled/manual) + schedule ─────────────────────────────────

/** Without a stored mode, an explicit past choice means manual; otherwise follow the system. */
export function resolveMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const stored = localStorage.getItem(MODE_STORAGE_KEY);
  if (stored === "system" || stored === "scheduled" || stored === "manual") return stored;
  return getStoredTheme() ? "manual" : "system";
}

export function persistMode(mode: ThemeMode) {
  localStorage.setItem(MODE_STORAGE_KEY, mode);
}

export function resolveSchedule(): ThemeSchedule {
  if (typeof window === "undefined") return DEFAULT_SCHEDULE;
  try {
    const parsed = JSON.parse(localStorage.getItem(SCHEDULE_STORAGE_KEY) ?? "null");
    return isValidSchedule(parsed) ? parsed : DEFAULT_SCHEDULE;
  } catch {
    return DEFAULT_SCHEDULE;
  }
}

export function persistSchedule(schedule: ThemeSchedule) {
  localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(schedule));
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

// ── Combined Theme Config ──────────────────────────────────────────────────────

export function resolveThemeConfig(): ThemeConfig {
  return {
    theme: resolveTheme(),
    palette: resolvePalette(),
  };
}

export function applyThemeConfig(config: ThemeConfig, opts: { animate?: boolean } = {}) {
  const root = document.documentElement;
  const changed = root.getAttribute("data-theme") !== config.theme;
  // Fade only automatic switches, and never under reduced motion.
  if (opts.animate && changed && !prefersReducedMotion()) {
    root.classList.add("theme-transition");
    window.setTimeout(() => root.classList.remove("theme-transition"), 400);
  }
  root.setAttribute("data-theme", config.theme);
  root.style.colorScheme = config.theme;
  root.setAttribute("data-palette", config.palette);
}

export function persistThemeConfig(config: ThemeConfig) {
  persistTheme(config.theme);
  persistPalette(config.palette);
}

// ── Legacy compatibility ───────────────────────────────────────────────────────

export function applyTheme(t: Theme) {
  applyThemeConfig({ theme: t, palette: resolvePalette() });
}
