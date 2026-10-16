// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import type { ReactNode } from "react";

/**
 * Per-user table column preferences.
 *
 * Preferences are keyed by table id + user id in localStorage, so each user
 * keeps their own column layout for each table. Preferences are validated
 * against the table's current column definitions on load: unknown columns are
 * dropped, newly added columns are appended, hidden "required" columns are
 * restored, and out-of-range widths are clamped.
 */

export interface ColumnDefinition<T> {
  /** Stable identifier used in preferences storage. */
  id: string;
  /** Visible header label. */
  header: string;
  /** Default width in pixels (optional — columns may auto-size). */
  defaultWidth?: number;
  /** Minimum width in pixels when resizing. Defaults to 80. */
  minWidth?: number;
  /** Text alignment for the column cells. */
  align?: "left" | "right";
  /** Required columns cannot be hidden (e.g. an actions column). */
  required?: boolean;
  /** Cell renderer for a row. */
  render: (row: T) => ReactNode;
}

export interface ColumnPreferences {
  /** Column ids in display order. */
  order: string[];
  /** Column ids the user has hidden. */
  hidden: string[];
  /** User-resized widths in pixels, by column id. */
  widths: Record<string, number>;
}

export const DEFAULT_MIN_COLUMN_WIDTH = 80;

const STORAGE_PREFIX = "column-prefs";

/** Storage key scoped to a table and user. */
export function columnPreferencesStorageKey(tableId: string, userId: string | null): string {
  return `${STORAGE_PREFIX}:${tableId}:${userId ?? "anonymous"}`;
}

/** The default layout: every column visible, in definition order. */
export function defaultColumnPreferences<T>(columns: ColumnDefinition<T>[]): ColumnPreferences {
  return {
    order: columns.map((column) => column.id),
    hidden: [],
    widths: {},
  };
}

function clampWidth(value: unknown, column: { minWidth?: number }): number | undefined {
  const min = column.minWidth ?? DEFAULT_MIN_COLUMN_WIDTH;
  const width = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : NaN;
  if (Number.isNaN(width)) return undefined;
  return Math.max(min, width);
}

/**
 * Merge stored (or otherwise untrusted) preferences with the current column
 * definitions, producing a valid layout. Never throws on malformed input.
 */
export function mergeColumnPreferences<T>(
  stored: unknown,
  columns: ColumnDefinition<T>[]
): ColumnPreferences {
  const defaults = defaultColumnPreferences(columns);
  if (!stored || typeof stored !== "object") return defaults;

  const candidate = stored as Partial<ColumnPreferences>;
  const known = new Set(columns.map((column) => column.id));

  // Keep only known ids, preserve stored order, append newly added columns.
  const storedOrder = Array.isArray(candidate.order)
    ? candidate.order.filter((id): id is string => typeof id === "string" && known.has(id))
    : [];
  const missing = defaults.order.filter((id) => !storedOrder.includes(id));
  const order = [...storedOrder, ...missing];

  const hiddenRaw = Array.isArray(candidate.hidden) ? candidate.hidden : [];
  const hidden = hiddenRaw.filter(
    (id): id is string =>
      typeof id === "string" &&
      known.has(id) &&
      !columns.find((column) => column.id === id)?.required
  );

  const widths: Record<string, number> = {};
  if (candidate.widths && typeof candidate.widths === "object") {
    for (const column of columns) {
      const width = clampWidth((candidate.widths as Record<string, unknown>)[column.id], column);
      if (width !== undefined) widths[column.id] = width;
    }
  }

  return { order, hidden, widths };
}

/** Load preferences for a table/user; falls back to defaults. */
export function loadColumnPreferences<T>(
  tableId: string,
  userId: string | null,
  columns: ColumnDefinition<T>[]
): ColumnPreferences {
  if (typeof window === "undefined") return defaultColumnPreferences(columns);
  try {
    const raw = window.localStorage.getItem(columnPreferencesStorageKey(tableId, userId));
    if (!raw) return defaultColumnPreferences(columns);
    return mergeColumnPreferences(JSON.parse(raw), columns);
  } catch {
    return defaultColumnPreferences(columns);
  }
}

/** Persist preferences for a table/user. Silently no-ops when unavailable. */
export function saveColumnPreferences(
  tableId: string,
  userId: string | null,
  preferences: ColumnPreferences
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      columnPreferencesStorageKey(tableId, userId),
      JSON.stringify(preferences)
    );
  } catch {
    // storage full or blocked — preferences stay in memory only
  }
}

/** The columns to render, in the user's order, excluding hidden ones. */
export function visibleColumns<T>(
  columns: ColumnDefinition<T>[],
  preferences: ColumnPreferences
): ColumnDefinition<T>[] {
  const byId = new Map(columns.map((column) => [column.id, column]));
  return preferences.order
    .map((id) => byId.get(id))
    .filter((column): column is ColumnDefinition<T> => Boolean(column))
    .filter((column) => !preferences.hidden.includes(column.id));
}

/** Width to apply for a column (user width or the definition default). */
export function columnWidth<T>(
  column: ColumnDefinition<T>,
  preferences: ColumnPreferences
): number | undefined {
  return preferences.widths[column.id] ?? column.defaultWidth;
}
