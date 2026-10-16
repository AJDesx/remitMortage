"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useEffect, useRef } from "react";
import { Toaster, useToasterStore } from "react-hot-toast";
import { announce } from "@/lib/announcer";

/**
 * Mirrors react-hot-toast toasts into the shared screen-reader announcer so
 * they are read exactly once. The Toaster's own per-toast live attributes are
 * switched off below to avoid double announcements.
 */
function useAnnounceHotToasts() {
  const { toasts } = useToasterStore();
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    toasts.forEach((t) => {
      if (!t.visible || seen.current.has(t.id)) return;
      seen.current.add(t.id);
      if (t.type === "loading" || typeof t.message !== "string") return;
      announce(t.message, { priority: t.type === "error" ? "assertive" : "polite" });
    });

    const live = new Set(toasts.map((t) => t.id));
    seen.current.forEach((id) => {
      if (!live.has(id)) seen.current.delete(id);
    });
  }, [toasts]);
}

export function HotToaster() {
  useAnnounceHotToasts();

  return (
    <Toaster
      position="top-right"
      toastOptions={{
        duration: 4000,
        ariaProps: { role: "status", "aria-live": "off" },
        style: {
          background: "var(--bg-card)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-color)",
          borderRadius: "var(--radius-md)",
          fontSize: "0.875rem",
        },
        success: {
          iconTheme: { primary: "#10b981", secondary: "#fff" },
        },
        error: {
          iconTheme: { primary: "#ef4444", secondary: "#fff" },
        },
      }}
    />
  );
}
