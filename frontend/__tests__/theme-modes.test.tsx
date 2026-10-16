// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { act, render } from "@testing-library/react";
import { useThemeStore, readInitialThemeState } from "../src/app/stores/useThemeStore";
import { ThemeProvider } from "../src/context/ThemeContext";
import { THEME_BOOT_SCRIPT } from "../src/app/lib/theme-boot";
import { isDarkAt, type ThemeSchedule } from "../src/app/lib/theme-schedule";

let systemDark = false;
let reducedMotion = false;
const mqListeners = new Set<() => void>();

function installMatchMedia() {
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query.includes("reduced-motion") ? reducedMotion : query.includes("dark") ? systemDark : false;
    },
    media: query,
    addEventListener: (_: string, cb: () => void) => mqListeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => mqListeners.delete(cb),
  })) as unknown as typeof window.matchMedia;
}

// Re-read storage into the store, as a page load would.
async function loadFresh() {
  const store = useThemeStore;
  store.setState(readInitialThemeState());
  return { store, ThemeProvider, render, act };
}

const html = () => document.documentElement;
const schedule: ThemeSchedule = { kind: "custom", start: "20:00", end: "07:00" };

beforeEach(() => {
  jest.useFakeTimers();
  localStorage.clear();
  html().removeAttribute("data-theme");
  html().className = "";
  systemDark = false;
  reducedMotion = false;
  mqListeners.clear();
  installMatchMedia();
});
afterEach(() => jest.useRealTimers());

function runBoot() {
  new Function(THEME_BOOT_SCRIPT)();
}

describe("System mode", () => {
  it("defaults to system and follows OS changes without a reload", async () => {
    const { store, ThemeProvider, render, act } = await loadFresh();
    render(<ThemeProvider><span /></ThemeProvider>);
    expect(store.getState().mode).toBe("system");
    expect(html()).toHaveAttribute("data-theme", "light");
    systemDark = true;
    act(() => mqListeners.forEach((cb) => cb()));
    expect(html()).toHaveAttribute("data-theme", "dark");
  });
});

describe("Manual mode", () => {
  it("a stored explicit theme from before this feature is treated as manual", async () => {
    localStorage.setItem("remitmortgage-theme", "dark");
    const { store, act } = await loadFresh();
    expect(store.getState().mode).toBe("manual");
    expect(store.getState().theme).toBe("dark");
  });

  it("ignores OS changes", async () => {
    const { store, ThemeProvider, render, act } = await loadFresh();
    render(<ThemeProvider><span /></ThemeProvider>);
    act(() => store.getState().setTheme("light"));
    systemDark = true;
    act(() => mqListeners.forEach((cb) => cb()));
    expect(html()).toHaveAttribute("data-theme", "light");
    expect(localStorage.getItem("remitmortgage-theme-mode")).toBe("manual");
  });

  it("toggleTheme and the palette keep working", async () => {
    const { store, act } = await loadFresh();
    act(() => store.getState().setTheme("dark"));
    act(() => store.getState().toggleTheme());
    expect(html()).toHaveAttribute("data-theme", "light");
    act(() => store.getState().togglePalette());
    expect(html()).toHaveAttribute("data-palette", "colorblind");
    expect(localStorage.getItem("remitmortgage-palette")).toBe("colorblind");
  });
});

describe("Scheduled mode", () => {
  it("switches at the configured time without a reload", async () => {
    jest.setSystemTime(new Date(2026, 5, 15, 19, 59, 0));
    const { store, ThemeProvider, render, act } = await loadFresh();
    act(() => {
      store.getState().setSchedule(schedule);
      store.getState().setMode("scheduled");
    });
    render(<ThemeProvider><span /></ThemeProvider>);
    expect(html()).toHaveAttribute("data-theme", "light");

    act(() => { jest.advanceTimersByTime(61_000); });
    expect(html()).toHaveAttribute("data-theme", "dark");
    expect(store.getState().theme).toBe("dark");

    // ...and back to light at 07:00 the next morning.
    act(() => { jest.advanceTimersByTime(11 * 3_600_000 + 5_000); });
    expect(html()).toHaveAttribute("data-theme", "light");
  });

  it("starts dark when loaded inside the window, regardless of the OS", async () => {
    jest.setSystemTime(new Date(2026, 5, 15, 23, 0));
    systemDark = false;
    localStorage.setItem("remitmortgage-theme-mode", "scheduled");
    localStorage.setItem("remitmortgage-theme-schedule", JSON.stringify(schedule));
    const { store, act } = await loadFresh();
    expect(store.getState().theme).toBe("dark");
  });

  it("persists mode and schedule", async () => {
    const { store, act } = await loadFresh();
    act(() => {
      store.getState().setSchedule({ ...schedule, start: "21:30" });
      store.getState().setMode("scheduled");
    });
    expect(localStorage.getItem("remitmortgage-theme-mode")).toBe("scheduled");
    expect(JSON.parse(localStorage.getItem("remitmortgage-theme-schedule")!).start).toBe("21:30");
  });

  it("does not overwrite the manual theme choice", async () => {
    jest.setSystemTime(new Date(2026, 5, 15, 23, 0));
    const { store, act } = await loadFresh();
    act(() => store.getState().setTheme("light"));
    act(() => { store.getState().setSchedule(schedule); store.getState().setMode("scheduled"); });
    expect(store.getState().theme).toBe("dark");
    expect(localStorage.getItem("remitmortgage-theme")).toBe("light");
  });

  it("re-syncs when the tab becomes visible again", async () => {
    jest.setSystemTime(new Date(2026, 5, 15, 12, 0));
    const { store, ThemeProvider, render, act } = await loadFresh();
    act(() => { store.getState().setSchedule(schedule); store.getState().setMode("scheduled"); });
    render(<ThemeProvider><span /></ThemeProvider>);
    expect(html()).toHaveAttribute("data-theme", "light");
    jest.setSystemTime(new Date(2026, 5, 15, 22, 0)); // clock jumped while timers were suspended
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(html()).toHaveAttribute("data-theme", "dark");
  });

  it("fades the switch normally but not under reduced motion", async () => {
    jest.setSystemTime(new Date(2026, 5, 15, 19, 59, 59));
    const { store, ThemeProvider, render, act } = await loadFresh();
    act(() => { store.getState().setSchedule(schedule); store.getState().setMode("scheduled"); });
    render(<ThemeProvider><span /></ThemeProvider>);
    act(() => { jest.advanceTimersByTime(1_300); });
    expect(html().classList.contains("theme-transition")).toBe(true);

    jest.setSystemTime(new Date(2026, 5, 16, 6, 59, 59));
    html().classList.remove("theme-transition");
    reducedMotion = true;
    act(() => { jest.advanceTimersByTime(24 * 3_600_000); });
    expect(html().classList.contains("theme-transition")).toBe(false);
  });
});

describe("pre-paint boot script", () => {
  it("manual: applies the stored theme", () => {
    localStorage.setItem("remitmortgage-theme", "dark");
    runBoot();
    expect(html()).toHaveAttribute("data-theme", "dark");
  });

  it("system: applies the OS theme when nothing is stored (no flash)", () => {
    systemDark = true;
    runBoot();
    expect(html()).toHaveAttribute("data-theme", "dark");
  });

  it("palette is restored", () => {
    localStorage.setItem("remitmortgage-palette", "colorblind");
    runBoot();
    expect(html()).toHaveAttribute("data-palette", "colorblind");
  });

  it.each([
    [19, 59], [20, 0], [23, 59], [0, 0], [6, 59], [7, 0], [12, 0],
  ])("scheduled at %i:%i agrees with isDarkAt", (h, m) => {
    jest.setSystemTime(new Date(2026, 5, 15, h, m));
    localStorage.setItem("remitmortgage-theme-mode", "scheduled");
    localStorage.setItem("remitmortgage-theme-schedule", JSON.stringify(schedule));
    runBoot();
    const expected = isDarkAt(new Date(), schedule) ? "dark" : "light";
    expect(html()).toHaveAttribute("data-theme", expected);
  });

  it("survives corrupt storage", () => {
    localStorage.setItem("remitmortgage-theme-mode", "scheduled");
    localStorage.setItem("remitmortgage-theme-schedule", "{nope");
    expect(() => runBoot()).not.toThrow();
  });
});
