// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { create } from "zustand";
import type { Theme, ThemeMode, ThemeSchedule, ColorPalette, ThemeConfig } from "../lib/theme";
import {
  resolveMode,
  resolveSchedule,
  resolvePalette,
  getStoredTheme,
  isSystemDark,
  applyThemeConfig,
  persistThemeConfig,
  persistMode,
  persistSchedule,
  persistTheme,
  persistPalette,
} from "../lib/theme";
import { resolveEffectiveTheme, withSunTimes } from "../lib/theme-schedule";

interface ThemeState {
  /** The theme currently applied (the result of resolving `mode`). */
  theme: Theme;
  palette: ColorPalette;
  mode: ThemeMode;
  schedule: ThemeSchedule;
  setMode: (mode: ThemeMode) => void;
  setSchedule: (schedule: ThemeSchedule) => void;
  /** Re-resolve the theme for `now` (system change, schedule boundary, tab refocus). */
  syncTheme: (now?: Date) => void;
  /** Explicitly choosing a theme switches to manual mode, as before. */
  setTheme: (t: Theme) => void;
  setPalette: (p: ColorPalette) => void;
  setThemeConfig: (config: ThemeConfig) => void;
  toggleTheme: () => void;
  togglePalette: () => void;
}

/** Theme state as stored on this device. Exported so tests can re-initialise the store. */
export function readInitialThemeState(now = new Date()): Pick<ThemeState, "theme" | "palette" | "mode" | "schedule"> {
  const mode = resolveMode();
  const schedule = withSunTimes(resolveSchedule(), now);
  const theme = resolveEffectiveTheme({
    mode,
    manualTheme: getStoredTheme() ?? (isSystemDark() ? "dark" : "light"),
    systemDark: isSystemDark(),
    schedule,
    now,
  });
  return { theme, palette: resolvePalette(), mode, schedule };
}

export const useThemeStore = create<ThemeState>((set, get) => {
  const apply = (next: Partial<Pick<ThemeState, "theme" | "palette">>, animate = false) => {
    const state = { ...get(), ...next };
    applyThemeConfig({ theme: state.theme, palette: state.palette }, { animate });
    set(next);
  };

  return {
    ...readInitialThemeState(),

    setMode: (next) => {
      const { theme: current } = get();
      persistMode(next);
      // Entering manual mode keeps the theme the user is looking at.
      if (next === "manual") persistTheme(getStoredTheme() ?? current);
      set({ mode: next });
      get().syncTheme();
    },

    setSchedule: (next) => {
      const resolved = withSunTimes(next, new Date());
      persistSchedule(resolved);
      set({ schedule: resolved });
      get().syncTheme();
    },

    syncTheme: (now = new Date()) => {
      const { mode: m, schedule: s, theme: current } = get();
      const fresh = withSunTimes(s, now);
      if (fresh.start !== s.start || fresh.end !== s.end) {
        persistSchedule(fresh); // keep the pre-paint script's copy current
        set({ schedule: fresh });
      }
      const next = resolveEffectiveTheme({
        mode: m,
        manualTheme: getStoredTheme() ?? current,
        systemDark: isSystemDark(),
        schedule: fresh,
        now,
      });
      // Also re-apply when the DOM disagrees (e.g. the boot script did not run).
      if (next !== current || document.documentElement.getAttribute("data-theme") !== next) {
        apply({ theme: next }, next !== current && m !== "manual");
      }
    },

    setTheme: (t: Theme) => {
      persistMode("manual");
      persistTheme(t);
      set({ mode: "manual" });
      apply({ theme: t });
    },

    setPalette: (p: ColorPalette) => {
      persistPalette(p);
      apply({ palette: p });
    },

    setThemeConfig: (config: ThemeConfig) => {
      persistMode("manual");
      persistThemeConfig(config);
      set({ mode: "manual" });
      apply(config);
    },

    toggleTheme: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),

    togglePalette: () => get().setPalette(get().palette === "default" ? "colorblind" : "default"),
  };
});
