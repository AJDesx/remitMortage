"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_MIN_COLUMN_WIDTH,
  defaultColumnPreferences,
  loadColumnPreferences,
  saveColumnPreferences,
  visibleColumns,
  type ColumnDefinition,
  type ColumnPreferences,
} from "@/lib/column-preferences";

interface UseColumnPreferencesResult<T> {
  /** Effective preferences (order, hidden, widths). */
  preferences: ColumnPreferences;
  /** Columns to render, in the user's order, excluding hidden ones. */
  columns: ColumnDefinition<T>[];
  /** Screen-reader announcement for the most recent change. */
  announcement: string;
  /** Show or hide a column (required columns cannot be hidden). */
  toggleColumn: (columnId: string) => void;
  /** Move a column one slot up or down in display order. */
  moveColumn: (columnId: string, direction: "up" | "down") => void;
  /** Set a column's width in pixels (clamped to its minimum). */
  resizeColumn: (columnId: string, width: number) => void;
  /** Restore the default layout and clear stored preferences. */
  resetToDefaults: () => void;
}

/**
 * Per-user, per-table column preferences: show/hide, reorder, resize, and
 * reset, persisted to localStorage and announced via a live-region string.
 */
export function useColumnPreferences<T>(
  tableId: string,
  userId: string | null,
  columns: ColumnDefinition<T>[]
): UseColumnPreferencesResult<T> {
  // Column definitions are expected to be stable (module-level constants);
  // key off their ids so a new array identity does not reset preferences.
  const columnKey = columns.map((column) => column.id).join("|");
  const columnsRef = useRef(columns);
  useEffect(() => {
    columnsRef.current = columns;
  }, [columns]);

  const [preferences, setPreferences] = useState<ColumnPreferences>(() =>
    defaultColumnPreferences(columns)
  );
  const [announcement, setAnnouncement] = useState("");
  const loadedFor = useRef<string | null>(null);

  // Load stored preferences once per table/user (localStorage is only
  // available client-side, so this runs after hydration).
  useEffect(() => {
    const key = `${tableId}:${userId ?? "anonymous"}`;
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    setPreferences(loadColumnPreferences(tableId, userId, columnsRef.current));
  }, [tableId, userId]);

  // Persist on every change (but not before the initial load above).
  useEffect(() => {
    if (loadedFor.current === null) return;
    saveColumnPreferences(tableId, userId, preferences);
  }, [preferences, tableId, userId]);

  const toggleColumn = useCallback((columnId: string) => {
    const column = columnsRef.current.find((candidate) => candidate.id === columnId);
    if (!column) return;

    setPreferences((current) => {
      const hiding = !current.hidden.includes(columnId);
      if (hiding && column.required) {
        setAnnouncement(`Column ${column.header} is required and cannot be hidden.`);
        return current;
      }
      // Keep at least one column visible.
      if (hiding && visibleColumns(columnsRef.current, current).length <= 1) {
        setAnnouncement("At least one column must stay visible.");
        return current;
      }
      setAnnouncement(`Column ${column.header} ${hiding ? "hidden" : "shown"}.`);
      return {
        ...current,
        hidden: hiding
          ? [...current.hidden, columnId]
          : current.hidden.filter((id) => id !== columnId),
      };
    });
  }, []);

  const moveColumn = useCallback((columnId: string, direction: "up" | "down") => {
    setPreferences((current) => {
      const index = current.order.indexOf(columnId);
      if (index === -1) return current;
      const target = direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= current.order.length) {
        const column = columnsRef.current.find((candidate) => candidate.id === columnId);
        setAnnouncement(
          `Column ${column?.header ?? columnId} is already at the ${direction === "up" ? "start" : "end"}.`
        );
        return current;
      }
      const order = [...current.order];
      [order[index], order[target]] = [order[target], order[index]];
      const column = columnsRef.current.find((candidate) => candidate.id === columnId);
      setAnnouncement(
        `Column ${column?.header ?? columnId} moved ${direction} to position ${target + 1} of ${order.length}.`
      );
      return { ...current, order };
    });
  }, []);

  const resizeColumn = useCallback((columnId: string, width: number) => {
    setPreferences((current) => {
      const column = columnsRef.current.find((candidate) => candidate.id === columnId);
      if (!column) return current;
      const min = column.minWidth ?? DEFAULT_MIN_COLUMN_WIDTH;
      const next = Math.max(min, Math.round(width));
      setAnnouncement(`Column ${column.header} resized to ${next} pixels.`);
      return { ...current, widths: { ...current.widths, [columnId]: next } };
    });
  }, []);

  const resetToDefaults = useCallback(() => {
    setPreferences(defaultColumnPreferences(columnsRef.current));
    setAnnouncement("Column layout reset to defaults.");
  }, []);

  const effectiveColumns = useMemo(
    () => visibleColumns(columns, preferences),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columnKey, preferences]
  );

  return {
    preferences,
    columns: effectiveColumns,
    announcement,
    toggleColumn,
    moveColumn,
    resizeColumn,
    resetToDefaults,
  };
}
