"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState } from "react";
import { useThemeStore } from "@/app/stores/useThemeStore";
import type { ThemeMode } from "@/app/lib/theme";

const MODES: { id: ThemeMode; label: string; hint: string }[] = [
  { id: "system", label: "System", hint: "Follow your device setting." },
  { id: "scheduled", label: "Scheduled", hint: "Dark during set hours or between sunset and sunrise." },
  { id: "manual", label: "Manual", hint: "Stay on the theme you pick below." },
];

export default function ThemeModeSettings() {
  const { mode, schedule, setMode, setSchedule } = useThemeStore();
  const [geoError, setGeoError] = useState("");

  const useLocation = () => {
    setGeoError("");
    if (!navigator.geolocation) {
      setGeoError("Location is not available in this browser.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setSchedule({ ...schedule, kind: "sun", lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setGeoError("Could not read your location. Use custom hours instead.")
    );
  };

  const inputCls = "rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-white";

  return (
    <div className="space-y-3" data-testid="theme-mode-settings">
      <h3 className="text-xs font-bold uppercase tracking-wider text-cyan-400">Theme Mode</h3>
      <div role="radiogroup" aria-label="Theme mode" className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            onClick={() => setMode(m.id)}
            className={`rounded-xl border p-4 text-left transition-all ${
              mode === m.id
                ? "border-cyan-500 bg-cyan-500/10"
                : "border-slate-800 bg-slate-950/40 text-slate-400 hover:border-slate-700"
            }`}
          >
            <span className="block text-sm font-bold text-white">{m.label}</span>
            <span className="block text-xs text-slate-400 mt-1">{m.hint}</span>
          </button>
        ))}
      </div>

      {mode === "scheduled" && (
        <fieldset className="space-y-3 rounded-xl border border-slate-800 p-4">
          <legend className="px-1 text-xs text-slate-400">Dark mode schedule</legend>
          <div className="flex flex-wrap gap-4 text-sm text-slate-300">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="schedule-kind"
                checked={schedule.kind === "custom"}
                onChange={() => setSchedule({ ...schedule, kind: "custom" })}
              />
              Custom hours
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="schedule-kind"
                checked={schedule.kind === "sun"}
                onChange={() => setSchedule({ ...schedule, kind: "sun" })}
              />
              Sunset to sunrise
            </label>
          </div>

          {schedule.kind === "custom" ? (
            <div className="flex flex-wrap gap-4 text-sm text-slate-300">
              <label className="flex items-center gap-2">
                Dark from
                <input
                  type="time"
                  className={inputCls}
                  value={schedule.start}
                  onChange={(e) => e.target.value && setSchedule({ ...schedule, start: e.target.value })}
                />
              </label>
              <label className="flex items-center gap-2">
                until
                <input
                  type="time"
                  className={inputCls}
                  value={schedule.end}
                  onChange={(e) => e.target.value && setSchedule({ ...schedule, end: e.target.value })}
                />
              </label>
            </div>
          ) : (
            <div className="space-y-2 text-sm text-slate-300">
              <button type="button" onClick={useLocation} className="rounded-lg border border-cyan-500 px-3 py-2 text-cyan-300">
                {schedule.lat === undefined ? "Use my location" : "Update my location"}
              </button>
              <p className="text-xs text-slate-400">
                {schedule.lat === undefined
                  ? "Location is needed to calculate sunset and sunrise; until then the default hours apply."
                  : `Dark from ${schedule.start} until ${schedule.end} today. Your location stays on this device.`}
              </p>
              {geoError && <p role="alert" className="text-xs text-red-400">{geoError}</p>}
            </div>
          )}
        </fieldset>
      )}
    </div>
  );
}
