// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  columnPreferencesStorageKey,
  defaultColumnPreferences,
  loadColumnPreferences,
  mergeColumnPreferences,
  saveColumnPreferences,
  visibleColumns,
  type ColumnDefinition,
} from "../src/lib/column-preferences";

type Row = { a: string; b: string; c: string };

const COLUMNS: ColumnDefinition<Row>[] = [
  { id: "a", header: "A", render: (row) => row.a },
  { id: "b", header: "B", render: (row) => row.b },
  { id: "c", header: "C", required: true, render: (row) => row.c },
];

beforeEach(() => {
  window.localStorage.clear();
});

describe("defaultColumnPreferences", () => {
  it("shows every column in definition order", () => {
    expect(defaultColumnPreferences(COLUMNS)).toEqual({
      order: ["a", "b", "c"],
      hidden: [],
      widths: {},
    });
  });
});

describe("mergeColumnPreferences", () => {
  it("returns defaults for null or malformed input", () => {
    const defaults = defaultColumnPreferences(COLUMNS);
    expect(mergeColumnPreferences(null, COLUMNS)).toEqual(defaults);
    expect(mergeColumnPreferences("nope", COLUMNS)).toEqual(defaults);
    expect(mergeColumnPreferences(42, COLUMNS)).toEqual(defaults);
  });

  it("keeps the stored order and appends newly added columns", () => {
    const merged = mergeColumnPreferences({ order: ["b", "a"] }, COLUMNS);
    expect(merged.order).toEqual(["b", "a", "c"]);
  });

  it("drops unknown column ids", () => {
    const merged = mergeColumnPreferences({ order: ["a", "ghost", "b", "c"] }, COLUMNS);
    expect(merged.order).toEqual(["a", "b", "c"]);
  });

  it("restores hidden required columns", () => {
    const merged = mergeColumnPreferences({ hidden: ["a", "c"] }, COLUMNS);
    expect(merged.hidden).toEqual(["a"]);
  });

  it("clamps out-of-range widths to the minimum", () => {
    const merged = mergeColumnPreferences({ widths: { a: 10, b: 200.4, c: Number.NaN } }, COLUMNS);
    expect(merged.widths.a).toBe(80); // default minimum
    expect(merged.widths.b).toBe(200);
    expect(merged.widths.c).toBeUndefined();
  });
});

describe("persistence", () => {
  it("scopes keys by table and user", () => {
    expect(columnPreferencesStorageKey("tx", "GABC")).toBe("column-prefs:tx:GABC");
    expect(columnPreferencesStorageKey("tx", null)).toBe("column-prefs:tx:anonymous");
  });

  it("round-trips preferences per user", () => {
    saveColumnPreferences("tx", "GABC", {
      order: ["b", "a", "c"],
      hidden: ["a"],
      widths: { b: 220 },
    });
    saveColumnPreferences("tx", "GDEF", defaultColumnPreferences(COLUMNS));

    const forAbc = loadColumnPreferences("tx", "GABC", COLUMNS);
    expect(forAbc.order).toEqual(["b", "a", "c"]);
    expect(forAbc.hidden).toEqual(["a"]);
    expect(forAbc.widths.b).toBe(220);

    // A different user keeps their own layout.
    const forDef = loadColumnPreferences("tx", "GDEF", COLUMNS);
    expect(forDef.hidden).toEqual([]);
    expect(forDef.order).toEqual(["a", "b", "c"]);
  });

  it("falls back to defaults when nothing is stored", () => {
    expect(loadColumnPreferences("tx", "GABC", COLUMNS)).toEqual(defaultColumnPreferences(COLUMNS));
  });

  it("falls back to defaults when storage is corrupted", () => {
    window.localStorage.setItem(columnPreferencesStorageKey("tx", "GABC"), "{not json");
    expect(loadColumnPreferences("tx", "GABC", COLUMNS)).toEqual(defaultColumnPreferences(COLUMNS));
  });
});

describe("visibleColumns", () => {
  it("orders and filters columns per preferences", () => {
    const prefs = { order: ["c", "a", "b"], hidden: ["b"], widths: {} };
    expect(visibleColumns(COLUMNS, prefs).map((column) => column.id)).toEqual(["c", "a"]);
  });

  it("ignores stale ids that no longer exist", () => {
    const prefs = { order: ["ghost", "a"], hidden: [], widths: {} };
    expect(visibleColumns(COLUMNS, prefs).map((column) => column.id)).toEqual(["a"]);
  });
});
