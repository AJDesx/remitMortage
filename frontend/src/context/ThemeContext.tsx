"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { createContext, useContext, useEffect } from "react";
import { useThemeStore } from "@/app/stores/useThemeStore";
import { msUntilNextSwitch } from "@/app/lib/theme-schedule";
import type { Theme } from "@/app/lib/theme";

type ThemeContextType = {
  theme: Theme;
};

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

// setTimeout stores its delay as a 32-bit int; longer delays fire immediately.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useThemeStore((s) => s.theme);
  const mode = useThemeStore((s) => s.mode);
  const schedule = useThemeStore((s) => s.schedule);

  // Apply once on mount (covers the case where the boot script could not run)
  // and follow the OS while in System mode.
  useEffect(() => {
    useThemeStore.getState().syncTheme();
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => useThemeStore.getState().syncTheme();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Scheduled mode: flip at the next boundary without a reload, and re-check
  // when the tab wakes up (timers are throttled/suspended while hidden).
  useEffect(() => {
    if (mode !== "scheduled") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      const now = new Date();
      const wait = msUntilNextSwitch(now, useThemeStore.getState().schedule);
      if (wait === null) return;
      timer = setTimeout(() => {
        useThemeStore.getState().syncTheme();
        arm();
      }, Math.min(wait + 250, MAX_TIMEOUT_MS));
    };
    const onVisible = () => {
      if (document.visibilityState === "hidden") return;
      useThemeStore.getState().syncTheme();
      arm();
    };
    arm();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [mode, schedule]);

  return <ThemeContext.Provider value={{ theme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

export default ThemeContext;
