import { expect, test } from "@playwright/test";

import {
  PRESETS,
  chunks,
  firstFreePlacement,
  freeCells,
  freeSpaceAt,
  layoutIssues,
  moveItem,
  readingOrder,
  resizeItem,
  sizeInSpace,
  sizeOptions,
  sizesAt,
  snapOffset,
  snapSpan,
  widgetKind,
  type GridItem,
} from "../../../src/components/systems/openview/domain/dashboard-grid";

// docs/specs/openview-dashboard.md, "The grid", "Size rules", "Presets",
// BD7, BD8 and BD12. The layout checks mirror the server's placement.py.

const at = (
  column: number,
  row: number,
  columnSpan: number,
  rowSpan: number,
) => ({
  column,
  row,
  columnSpan,
  rowSpan,
});

test("layout issues name each broken rule by list index, as the server does", () => {
  expect(
    layoutIssues([
      { kind: "number", placement: at(0, 0, 2, 1) },
      { kind: "bar", placement: at(1, 0, 2, 2) },
      { kind: "pie", placement: at(0, 1, 4, 2) },
      { kind: "line", placement: at(3, 3, 2, 2) },
      { kind: "records", placement: at(0, 3, 2, 2) },
    ]),
  ).toEqual([
    { index: 1, code: "overlap", message: "This widget overlaps widget 1" },
    {
      index: 2,
      code: "size_not_allowed",
      message: "A pie chart must be 2 × 2 to 3 × 3 (columns × rows)",
    },
    { index: 2, code: "overlap", message: "This widget overlaps widget 2" },
    {
      index: 3,
      code: "outside_grid",
      message: "This widget does not fit inside the 4 × 5 grid",
    },
  ]);
});

test("the size rule kind is the chart type for a chart and the widget type otherwise", () => {
  expect(widgetKind("summary", null)).toBe("number");
  expect(widgetKind("workload", null)).toBe("table");
  expect(widgetKind("records", null)).toBe("records");
  expect(widgetKind("chart", "pie")).toBe("pie");
  expect(widgetKind("chart", "line")).toBe("line");
});

const overview: GridItem[] = [
  { key: "n1", placement: at(0, 0, 1, 1) },
  { key: "n2", placement: at(1, 0, 1, 1) },
  { key: "bar", placement: at(0, 1, 2, 2) },
  { key: "line", placement: at(2, 1, 2, 2) },
  { key: "lost", placement: null },
];

test("moves step one cell and stop at the edge or another widget", () => {
  expect(moveItem(overview, "n2", "right")).toEqual({
    ok: true,
    placement: at(2, 0, 1, 1),
  });
  expect(moveItem(overview, "n1", "left")).toEqual({
    ok: false,
    reason: "at the edge",
  });
  expect(moveItem(overview, "n1", "right")).toEqual({
    ok: false,
    reason: "another widget is there",
  });
  expect(moveItem(overview, "bar", "down")).toEqual({
    ok: true,
    placement: at(0, 2, 2, 2),
  });
  expect(moveItem(overview, "lost", "down")).toEqual({
    ok: false,
    reason: "not on the grid",
  });
});

test("resizing keeps the size rules, the grid edge and the other widgets", () => {
  expect(resizeItem(overview, "line", "line", { columns: 2, rows: 3 })).toEqual(
    {
      ok: true,
      placement: at(2, 1, 2, 3),
    },
  );
  expect(resizeItem(overview, "line", "line", { columns: 1, rows: 2 })).toEqual(
    {
      ok: false,
      reason: "too small for a line chart",
    },
  );
  expect(resizeItem(overview, "line", "line", { columns: 3, rows: 2 })).toEqual(
    {
      ok: false,
      reason: "past the grid edge",
    },
  );
  expect(resizeItem(overview, "bar", "bar", { columns: 3, rows: 2 })).toEqual({
    ok: false,
    reason: "another widget is in the way",
  });
  expect(resizeItem(overview, "n1", "number", { columns: 1, rows: 2 })).toEqual(
    {
      ok: false,
      reason: "too large for a number",
    },
  );
});

test("the size menu lists the kind's sizes with the reason each cannot be taken here", () => {
  expect(sizeOptions(overview, "line", "pie")).toEqual([
    {
      columns: 1,
      rows: 1,
      allowed: false,
      reason: "too small for a pie chart",
    },
    { columns: 2, rows: 2, allowed: true },
    { columns: 3, rows: 2, allowed: false, reason: "past the grid edge" },
    { columns: 2, rows: 3, allowed: true },
    { columns: 3, rows: 3, allowed: false, reason: "past the grid edge" },
  ]);
  expect(sizeOptions(overview, "n1", "number")).toEqual([
    { columns: 1, rows: 1, allowed: true },
    {
      columns: 2,
      rows: 1,
      allowed: false,
      reason: "another widget is in the way",
    },
  ]);
});

test("an empty cell offers its largest free space and each kind takes the largest size inside it", () => {
  expect(freeCells(overview)).toHaveLength(10);
  expect(freeSpaceAt(overview, 2, 0)).toEqual(at(2, 0, 2, 1));
  expect(freeSpaceAt(overview, 0, 3)).toEqual(at(0, 3, 4, 2));
  expect(freeSpaceAt(overview, 0, 0)).toBeNull();
  expect(sizeInSpace("bar", { columns: 4, rows: 2 })).toEqual({
    columns: 4,
    rows: 2,
  });
  expect(sizeInSpace("pie", { columns: 4, rows: 2 })).toEqual({
    columns: 3,
    rows: 2,
  });
  expect(sizeInSpace("number", { columns: 2, rows: 2 })).toEqual({
    columns: 2,
    rows: 1,
  });
  expect(sizeInSpace("bar", { columns: 2, rows: 1 })).toBeNull();
});

test("a new widget takes the first free place, row by row", () => {
  expect(firstFreePlacement(overview, { columns: 2, rows: 1 })).toEqual(
    at(2, 0, 2, 1),
  );
  expect(firstFreePlacement(overview, { columns: 4, rows: 3 })).toBeNull();
});

test("pointer distances snap to whole cells", () => {
  // 130px cells with 12px gaps: a corner dragged 290px covers two cells.
  expect(snapSpan(290, 130, 12)).toBe(2);
  expect(snapSpan(10, 130, 12)).toBe(1);
  expect(snapOffset(-150, 130, 12)).toBe(-1);
  expect(snapOffset(60, 130, 12)).toBe(0);
});

test("phones read widgets by row, then column, with unplaced widgets last", () => {
  expect(readingOrder(overview).map((item) => item.key)).toEqual([
    "n1",
    "n2",
    "bar",
    "line",
    "lost",
  ]);
});

test("every preset fits the grid within the size rules", () => {
  for (const preset of PRESETS) expect(layoutIssues(preset.spaces)).toEqual([]);
  expect(PRESETS.map((preset) => preset.label)).toEqual([
    "Overview",
    "One big trend",
    "Lists first",
  ]);
});

test("snapshot batches split at twelve queries", () => {
  expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
});

test("the builder offers the sizes a kind can take from a cell, largest first", () => {
  expect(sizesAt(overview, 0, 3, "pie")).toEqual([
    { columns: 3, rows: 2 },
    { columns: 2, rows: 2 },
  ]);
  expect(sizesAt(overview, 2, 0, "bar")).toEqual([]);
  expect(sizesAt(overview, 2, 1, "line", "line")).toEqual([
    { columns: 2, rows: 3 },
    { columns: 2, rows: 2 },
  ]);
});
