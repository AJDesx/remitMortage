"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { createContext, useContext, useEffect, useState } from "react";

const STORAGE_KEY = "remitmortgage-demo-mode";

type DemoModeContextType = {
  isDemoMode: boolean;
  enterDemoMode: () => void;
  exitDemoMode: () => void;
};

const DemoModeContext = createContext<DemoModeContextType | undefined>(undefined);

/**
 * Tracks whether the app is in sandbox/demo mode, where the dashboard is
 * populated from mocked data instead of a connected wallet or live backend.
 * Scoped to sessionStorage so it never silently lingers into a real session
 * started in a new tab.
 */
export function DemoModeProvider({ children }: { children: React.ReactNode }) {
  const [isDemoMode, setIsDemoMode] = useState(false);

  useEffect(() => {
    try {
      setIsDemoMode(sessionStorage.getItem(STORAGE_KEY) === "true");
    } catch {
      /* storage unavailable */
    }
  }, []);

  function enterDemoMode() {
    setIsDemoMode(true);
    try {
      sessionStorage.setItem(STORAGE_KEY, "true");
    } catch {
      /* storage unavailable */
    }
  }

  function exitDemoMode() {
    setIsDemoMode(false);
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
  }

  return (
    <DemoModeContext.Provider value={{ isDemoMode, enterDemoMode, exitDemoMode }}>
      {children}
    </DemoModeContext.Provider>
  );
}

export function useDemoMode() {
  const ctx = useContext(DemoModeContext);
  if (!ctx) throw new Error("useDemoMode must be used within DemoModeProvider");
  return ctx;
}

export default DemoModeContext;
