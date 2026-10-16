"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { useDemoMode } from "@/context/DemoModeContext";

export default function DemoModeBanner() {
  const { isDemoMode, exitDemoMode } = useDemoMode();
  const router = useRouter();

  if (!isDemoMode) return null;

  function handleExit() {
    exitDemoMode();
    router.push("/onboarding");
  }

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[60] bg-gradient-to-r from-cyan-600 to-blue-600 text-white shadow-xl"
      role="status"
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
        <span className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-bold uppercase tracking-wider">
          <Sparkles className="h-4 w-4 shrink-0" />
          Demo Mode — exploring with sample data, no wallet connected
        </span>
        <button
          type="button"
          onClick={handleExit}
          className="shrink-0 rounded-lg bg-white/20 px-3 py-1.5 text-xs font-semibold hover:bg-white/30 transition-colors"
        >
          Exit demo &amp; connect a real wallet
        </button>
      </div>
    </div>
  );
}
