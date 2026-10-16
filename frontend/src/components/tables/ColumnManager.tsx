"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Columns3, RotateCcw } from "lucide-react";
import type { ColumnDefinition } from "@/lib/column-preferences";

interface ColumnManagerProps<T> {
  /** All column definitions for the table (including hidden ones). */
  allColumns: ColumnDefinition<T>[];
  /** The user's current preferences. */
  preferences: { order: string[]; hidden: string[] };
  /** Toggle a column's visibility. */
  onToggle: (columnId: string) => void;
  /** Move a column up or down in display order. */
  onMove: (columnId: string, direction: "up" | "down") => void;
  /** Restore default layout. */
  onReset: () => void;
  /** Live-region announcement for the most recent change. */
  announcement: string;
  /** Table name used in labels, e.g. "transactions". */
  tableLabel: string;
}

/**
 * Column customization control: show/hide columns, reorder them, and reset
 * to defaults. Fully keyboard accessible — checkboxes toggle visibility,
 * arrow buttons reorder, and every change is announced via the shared
 * live region.
 */
export default function ColumnManager<T>({
  allColumns,
  preferences,
  onToggle,
  onMove,
  onReset,
  announcement,
  tableLabel,
}: ColumnManagerProps<T>) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close on Escape and return focus to the trigger.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  const orderedColumns = preferences.order
    .map((id) => allColumns.find((column) => column.id === id))
    .filter((column): column is ColumnDefinition<T> => Boolean(column));

  return (
    <div ref={containerRef} className="relative inline-block text-left">
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid={`column-manager-${tableLabel}`}
        className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] hover:border-[var(--accent-primary)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
      >
        <Columns3 className="h-4 w-4" aria-hidden="true" />
        Columns
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={`Customize ${tableLabel} columns`}
          data-testid={`column-manager-panel-${tableLabel}`}
          className="absolute right-0 z-30 mt-2 w-72 rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4 shadow-2xl"
        >
          <h3 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">
            Customize columns
          </h3>
          <ul className="space-y-1">
            {orderedColumns.map((column, index) => {
              const checked = !preferences.hidden.includes(column.id);
              return (
                <li
                  key={column.id}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--bg-card-hover)]"
                >
                  <input
                    type="checkbox"
                    id={`column-toggle-${tableLabel}-${column.id}`}
                    checked={checked}
                    disabled={column.required}
                    onChange={() => onToggle(column.id)}
                    className="h-4 w-4 rounded border-gray-600 bg-gray-800 accent-[var(--accent-primary)]"
                  />
                  <label
                    htmlFor={`column-toggle-${tableLabel}-${column.id}`}
                    className={`flex-1 text-sm text-[var(--text-primary)] ${
                      column.required ? "opacity-60" : "cursor-pointer"
                    }`}
                  >
                    {column.header}
                    {column.required && (
                      <span className="ml-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                        required
                      </span>
                    )}
                  </label>
                  <button
                    type="button"
                    onClick={() => onMove(column.id, "up")}
                    disabled={index === 0}
                    aria-label={`Move ${column.header} column up`}
                    className="rounded p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                  >
                    <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onMove(column.id, "down")}
                    disabled={index === orderedColumns.length - 1}
                    aria-label={`Move ${column.header} column down`}
                    className="rounded p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                  >
                    <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            onClick={onReset}
            data-testid={`column-manager-reset-${tableLabel}`}
            className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--border-color)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent-primary)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            Reset to defaults
          </button>
        </div>
      )}
    </div>
  );
}
