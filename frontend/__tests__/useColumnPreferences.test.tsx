// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { act, renderHook, waitFor } from "@testing-library/react";
import { useColumnPreferences } from "../src/hooks/useColumnPreferences";
import { columnPreferencesStorageKey, type ColumnDefinition } from "../src/lib/column-preferences";

type Row = { a: string; b: string; c: string };

const COLUMNS: ColumnDefinition<Row>[] = [
  { id: "a", header: "Alpha", render: (row) => row.a },
  { id: "b", header: "Beta", render: (row) => row.b },
  { id: "c", header: "Gamma", required: true, render: (row) => row.c },
];

beforeEach(() => {
  window.localStorage.clear();
});

function stored(userId: string | null = "GABC") {
  const raw = window.localStorage.getItem(columnPreferencesStorageKey("tx", userId));
  return raw ? JSON.parse(raw) : null;
}

describe("useColumnPreferences", () => {
  it("starts from defaults and loads stored preferences for the user", async () => {
    window.localStorage.setItem(
      columnPreferencesStorageKey("tx", "GABC"),
      JSON.stringify({ order: ["b", "a", "c"], hidden: ["a"], widths: {} })
    );

    const { result } = renderHook(() => useColumnPreferences("tx", "GABC", COLUMNS));

    await waitFor(() => {
      expect(result.current.preferences.order).toEqual(["b", "a", "c"]);
    });
    expect(result.current.columns.map((column) => column.id)).toEqual(["b", "c"]);
  });

  it("keeps separate layouts per user", async () => {
    window.localStorage.setItem(
      columnPreferencesStorageKey("tx", "GABC"),
      JSON.stringify({ order: ["b", "a", "c"], hidden: ["a"], widths: {} })
    );

    const { result, rerender } = renderHook(
      ({ userId }: { userId: string }) => useColumnPreferences("tx", userId, COLUMNS),
      { initialProps: { userId: "GABC" } }
    );
    await waitFor(() => expect(result.current.preferences.hidden).toEqual(["a"]));

    rerender({ userId: "GDEF" });
    await waitFor(() => expect(result.current.preferences.hidden).toEqual([]));
  });

  it("toggles a column and persists the change", async () => {
    const { result } = renderHook(() => useColumnPreferences("tx", "GABC", COLUMNS));

    act(() => result.current.toggleColumn("a"));

    expect(result.current.preferences.hidden).toEqual(["a"]);
    expect(result.current.announcement).toMatch(/alpha hidden/i);
    await waitFor(() => expect(stored()?.hidden).toEqual(["a"]));
  });

  it("refuses to hide a required column", () => {
    const { result } = renderHook(() => useColumnPreferences("tx", "GABC", COLUMNS));

    act(() => result.current.toggleColumn("c"));

    expect(result.current.preferences.hidden).toEqual([]);
    expect(result.current.announcement).toMatch(/required/i);
  });

  it("keeps at least one column visible", () => {
    const twoColumns: ColumnDefinition<Row>[] = [
      { id: "a", header: "Alpha", render: (row) => row.a },
      { id: "b", header: "Beta", render: (row) => row.b },
    ];
    const { result } = renderHook(() => useColumnPreferences("tx2", "GABC", twoColumns));

    act(() => result.current.toggleColumn("a"));
    expect(result.current.preferences.hidden).toEqual(["a"]);

    // Hiding the last remaining visible column is refused.
    act(() => result.current.toggleColumn("b"));
    expect(result.current.preferences.hidden).toEqual(["a"]);
    expect(result.current.announcement).toMatch(/at least one column/i);
    expect(result.current.columns).toHaveLength(1);
  });

  it("moves a column up and down and announces the new position", () => {
    const { result } = renderHook(() => useColumnPreferences("tx", "GABC", COLUMNS));

    act(() => result.current.moveColumn("b", "up"));
    expect(result.current.preferences.order).toEqual(["b", "a", "c"]);
    expect(result.current.announcement).toMatch(/moved up to position 1/i);

    act(() => result.current.moveColumn("b", "down"));
    expect(result.current.preferences.order).toEqual(["a", "b", "c"]);
    expect(result.current.announcement).toMatch(/moved down to position 2/i);
  });

  it("does not move past the ends of the list", () => {
    const { result } = renderHook(() => useColumnPreferences("tx", "GABC", COLUMNS));

    act(() => result.current.moveColumn("a", "up"));
    expect(result.current.preferences.order).toEqual(["a", "b", "c"]);
    expect(result.current.announcement).toMatch(/already at the start/i);
  });

  it("resizes a column, clamped to its minimum, and persists", async () => {
    const { result } = renderHook(() => useColumnPreferences("tx", "GABC", COLUMNS));

    act(() => result.current.resizeColumn("a", 240));
    expect(result.current.preferences.widths.a).toBe(240);
    expect(result.current.announcement).toMatch(/resized to 240 pixels/i);

    act(() => result.current.resizeColumn("a", 10));
    expect(result.current.preferences.widths.a).toBe(80);

    await waitFor(() => expect(stored()?.widths.a).toBe(80));
  });

  it("resets to defaults and clears stored widths", async () => {
    const { result } = renderHook(() => useColumnPreferences("tx", "GABC", COLUMNS));

    act(() => result.current.toggleColumn("a"));
    act(() => result.current.resizeColumn("b", 300));
    act(() => result.current.resetToDefaults());

    expect(result.current.preferences).toEqual({
      order: ["a", "b", "c"],
      hidden: [],
      widths: {},
    });
    expect(result.current.announcement).toMatch(/reset to defaults/i);
    await waitFor(() => {
      expect(stored()).toEqual({ order: ["a", "b", "c"], hidden: [], widths: {} });
    });
  });
});
