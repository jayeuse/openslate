/**
 * The department dashboard's grid (docs/specs/openview-dashboard.md, "The grid"):
 * 4 columns by 5 rows, each widget a rectangle of whole cells within the size
 * rules of its kind. The size rules and layout checks mirror the server's
 * `backend/app/systems/openview/dashboards/placement.py` exactly, so a refusal
 * names the same widget the editor shows. The rest (moves, sizes at a place,
 * free space, presets, reading order) is editor-only and pure.
 */

export const GRID_COLUMNS = 4;
export const GRID_ROWS = 5;
export const GRID_CELLS = GRID_COLUMNS * GRID_ROWS;

export type WidgetKind =
  "number" | "bar" | "line" | "pie" | "table" | "records";

export type SizeRule = {
  label: string;
  minColumns: number;
  minRows: number;
  maxColumns: number;
  maxRows: number;
};

export const SIZE_RULES: Record<WidgetKind, SizeRule> = {
  number: {
    label: "number",
    minColumns: 1,
    minRows: 1,
    maxColumns: 2,
    maxRows: 1,
  },
  bar: {
    label: "bar chart",
    minColumns: 2,
    minRows: 2,
    maxColumns: 4,
    maxRows: 3,
  },
  line: {
    label: "line chart",
    minColumns: 2,
    minRows: 2,
    maxColumns: 4,
    maxRows: 3,
  },
  pie: {
    label: "pie chart",
    minColumns: 2,
    minRows: 2,
    maxColumns: 3,
    maxRows: 3,
  },
  table: {
    label: "table",
    minColumns: 2,
    minRows: 2,
    maxColumns: 4,
    maxRows: 5,
  },
  records: {
    label: "records list",
    minColumns: 2,
    minRows: 2,
    maxColumns: 4,
    maxRows: 5,
  },
};

/** The size-rule kind: the widget type, or the chart type for a chart widget. */
export function widgetKind(
  widgetType: "summary" | "workload" | "records" | "chart",
  chartType: "bar" | "line" | "pie" | null | undefined,
): WidgetKind {
  if (widgetType === "summary") return "number";
  if (widgetType === "workload") return "table";
  if (widgetType === "records") return "records";
  return chartType ?? "bar";
}

export type Placement = {
  column: number;
  row: number;
  columnSpan: number;
  rowSpan: number;
};

export type Size = { columns: number; rows: number };

export function sizeAllowed(kind: WidgetKind, columns: number, rows: number) {
  const rule = SIZE_RULES[kind];
  return (
    rule.minColumns <= columns &&
    columns <= rule.maxColumns &&
    rule.minRows <= rows &&
    rows <= rule.maxRows
  );
}

export function insideGrid(placement: Placement): boolean {
  return (
    placement.column >= 0 &&
    placement.row >= 0 &&
    placement.columnSpan >= 1 &&
    placement.rowSpan >= 1 &&
    placement.column + placement.columnSpan <= GRID_COLUMNS &&
    placement.row + placement.rowSpan <= GRID_ROWS
  );
}

export function placementCells(placement: Placement): string[] {
  const cells: string[] = [];
  for (let row = placement.row; row < placement.row + placement.rowSpan; row++)
    for (
      let column = placement.column;
      column < placement.column + placement.columnSpan;
      column++
    )
      cells.push(`${column},${row}`);
  return cells;
}

export type LayoutIssueCode = "outside_grid" | "size_not_allowed" | "overlap";
export type LayoutIssue = {
  index: number;
  code: LayoutIssueCode;
  message: string;
};

/** Every rule each widget breaks, in list order; an empty list means it fits. */
export function layoutIssues(
  widgets: readonly { kind: WidgetKind; placement: Placement }[],
): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const owners = new Map<string, number>();
  widgets.forEach(({ kind, placement }, index) => {
    const rule = SIZE_RULES[kind];
    if (!sizeAllowed(kind, placement.columnSpan, placement.rowSpan))
      issues.push({
        index,
        code: "size_not_allowed",
        message: `A ${rule.label} must be ${rule.minColumns} × ${rule.minRows} to ${rule.maxColumns} × ${rule.maxRows} (columns × rows)`,
      });
    if (!insideGrid(placement)) {
      issues.push({
        index,
        code: "outside_grid",
        message: `This widget does not fit inside the ${GRID_COLUMNS} × ${GRID_ROWS} grid`,
      });
      return;
    }
    const cells = placementCells(placement);
    const covered = [
      ...new Set(
        cells.flatMap((cell) => {
          const owner = owners.get(cell);
          return owner === undefined ? [] : [owner];
        }),
      ),
    ].sort((a, b) => a - b);
    if (covered.length)
      issues.push({
        index,
        code: "overlap",
        message: `This widget overlaps widget ${covered[0] + 1}`,
      });
    for (const cell of cells) if (!owners.has(cell)) owners.set(cell, index);
  });
  return issues;
}

/** One item on the grid; unplaced items (a migration result) cover nothing. */
export type GridItem = { key: string; placement: Placement | null };

function occupiedCells(items: readonly GridItem[], except?: string) {
  const cells = new Set<string>();
  for (const item of items)
    if (item.key !== except && item.placement)
      for (const cell of placementCells(item.placement)) cells.add(cell);
  return cells;
}

/** Whether a placement is inside the grid and clear of every other item. */
export function placementFits(
  items: readonly GridItem[],
  placement: Placement,
  except?: string,
): boolean {
  if (!insideGrid(placement)) return false;
  const taken = occupiedCells(items, except);
  return placementCells(placement).every((cell) => !taken.has(cell));
}

export function freeCells(items: readonly GridItem[]) {
  const taken = occupiedCells(items);
  const cells: { column: number; row: number }[] = [];
  for (let row = 0; row < GRID_ROWS; row++)
    for (let column = 0; column < GRID_COLUMNS; column++)
      if (!taken.has(`${column},${row}`)) cells.push({ column, row });
  return cells;
}

/**
 * The largest free rectangle whose top-left corner is this cell (most cells;
 * a tie keeps the wider one). An empty cell's "Add" offers this space.
 */
export function freeSpaceAt(
  items: readonly GridItem[],
  column: number,
  row: number,
): Placement | null {
  let best: Placement | null = null;
  for (let rows = 1; row + rows <= GRID_ROWS; rows++)
    for (let columns = 1; column + columns <= GRID_COLUMNS; columns++) {
      const candidate = { column, row, columnSpan: columns, rowSpan: rows };
      if (!placementFits(items, candidate)) continue;
      const area = columns * rows;
      const bestArea = best ? best.columnSpan * best.rowSpan : 0;
      if (
        area > bestArea ||
        (area === bestArea && best && columns > best.columnSpan)
      )
        best = candidate;
    }
  return best;
}

/**
 * The size a kind takes in a free space: the largest allowed size that fits
 * inside it (most cells, then wider), or null when even its smallest does not.
 */
export function sizeInSpace(kind: WidgetKind, space: Size): Size | null {
  const rule = SIZE_RULES[kind];
  let best: Size | null = null;
  for (
    let rows = rule.minRows;
    rows <= Math.min(rule.maxRows, space.rows);
    rows++
  )
    for (
      let columns = rule.minColumns;
      columns <= Math.min(rule.maxColumns, space.columns);
      columns++
    ) {
      const area = columns * rows;
      const bestArea = best ? best.columns * best.rows : 0;
      if (
        area > bestArea ||
        (area === bestArea && best && columns > best.columns)
      )
        best = { columns, rows };
    }
  return best;
}

/** The first place, row by row, where a size fits; null when the grid is full. */
export function firstFreePlacement(
  items: readonly GridItem[],
  size: Size,
  except?: string,
): Placement | null {
  for (let row = 0; row + size.rows <= GRID_ROWS; row++)
    for (let column = 0; column + size.columns <= GRID_COLUMNS; column++) {
      const placement = {
        column,
        row,
        columnSpan: size.columns,
        rowSpan: size.rows,
      };
      if (placementFits(items, placement, except)) return placement;
    }
  return null;
}

export type Direction = "left" | "right" | "up" | "down";
const STEP: Record<Direction, [number, number]> = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1],
};

export type GridChange =
  { ok: true; placement: Placement } | { ok: false; reason: string };

/** Move one cell; a move past the edge or onto another widget is refused. */
export function moveItem(
  items: readonly GridItem[],
  key: string,
  direction: Direction,
): GridChange {
  const placement = items.find((item) => item.key === key)?.placement;
  if (!placement) return { ok: false, reason: "not on the grid" };
  const [dx, dy] = STEP[direction];
  const next = {
    ...placement,
    column: placement.column + dx,
    row: placement.row + dy,
  };
  if (!insideGrid(next)) return { ok: false, reason: "at the edge" };
  if (!placementFits(items, next, key))
    return { ok: false, reason: "another widget is there" };
  return { ok: true, placement: next };
}

/** Resize from the top-left corner; the size rules and the grid limit it. */
export function resizeItem(
  items: readonly GridItem[],
  key: string,
  kind: WidgetKind,
  size: Size,
): GridChange {
  const placement = items.find((item) => item.key === key)?.placement;
  if (!placement) return { ok: false, reason: "not on the grid" };
  const rule = SIZE_RULES[kind];
  if (size.columns < rule.minColumns || size.rows < rule.minRows)
    return { ok: false, reason: `too small for a ${rule.label}` };
  if (size.columns > rule.maxColumns || size.rows > rule.maxRows)
    return { ok: false, reason: `too large for a ${rule.label}` };
  const next = { ...placement, columnSpan: size.columns, rowSpan: size.rows };
  if (!insideGrid(next)) return { ok: false, reason: "past the grid edge" };
  if (!placementFits(items, next, key))
    return { ok: false, reason: "another widget is in the way" };
  return { ok: true, placement: next };
}

export type SizeOption = Size &
  ({ allowed: true } | { allowed: false; reason: string });

/**
 * The sizes a widget's menu lists (BD8): every size its kind allows, each
 * disabled with its reason when it does not fit where the widget is, after
 * the smallest size (1 × 1) when the kind cannot take it.
 */
export function sizeOptions(
  items: readonly GridItem[],
  key: string,
  kind: WidgetKind,
): SizeOption[] {
  const rule = SIZE_RULES[kind];
  const options: SizeOption[] = [];
  if (rule.minColumns > 1 || rule.minRows > 1)
    options.push({
      columns: 1,
      rows: 1,
      allowed: false,
      reason: `too small for a ${rule.label}`,
    });
  for (let rows = rule.minRows; rows <= rule.maxRows; rows++)
    for (let columns = rule.minColumns; columns <= rule.maxColumns; columns++) {
      const change = resizeItem(items, key, kind, { columns, rows });
      options.push(
        change.ok
          ? { columns, rows, allowed: true }
          : { columns, rows, allowed: false, reason: change.reason },
      );
    }
  return options;
}

/**
 * Whole cells a pointer covers from a widget's top-left corner. `cell` is one
 * cell's width or height in pixels and `gap` the space between cells.
 */
export function snapSpan(pixels: number, cell: number, gap: number): number {
  return Math.max(1, Math.round((pixels + gap) / (cell + gap)));
}

/** The cells a pointer drag moves a widget, from its offset in pixels. */
export function snapOffset(pixels: number, cell: number, gap: number): number {
  return Math.round(pixels / (cell + gap));
}

/** Phones stack widgets in reading order: row, then column (BD12). */
export function readingOrder<T extends GridItem>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    if (!a.placement || !b.placement)
      return Number(!a.placement) - Number(!b.placement);
    return (
      a.placement.row - b.placement.row ||
      a.placement.column - b.placement.column
    );
  });
}

export type PresetSpace = { kind: WidgetKind; placement: Placement };
export type Preset = { id: string; label: string; spaces: PresetSpace[] };

function space(
  kind: WidgetKind,
  column: number,
  row: number,
  columnSpan: number,
  rowSpan: number,
): PresetSpace {
  return { kind, placement: { column, row, columnSpan, rowSpan } };
}
const fourNumbers = (row: number) =>
  [0, 1, 2, 3].map((column) => space("number", column, row, 1, 1));

/** docs/specs/openview-dashboard.md, "Presets". */
export const PRESETS: readonly Preset[] = [
  {
    id: "overview",
    label: "Overview",
    spaces: [
      ...fourNumbers(0),
      space("bar", 0, 1, 2, 2),
      space("line", 2, 1, 2, 2),
      space("table", 0, 3, 2, 2),
      space("records", 2, 3, 2, 2),
    ],
  },
  {
    id: "one-big-trend",
    label: "One big trend",
    spaces: [...fourNumbers(0), space("line", 0, 1, 4, 3), ...fourNumbers(4)],
  },
  {
    id: "lists-first",
    label: "Lists first",
    spaces: [
      space("bar", 0, 0, 2, 2),
      space("pie", 2, 0, 2, 2),
      space("records", 0, 2, 4, 3),
    ],
  },
];

/** Split a list into runs of at most `size` (a snapshot batch holds 12). */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    result.push(items.slice(index, index + size));
  return result;
}

/**
 * The sizes a kind can take with its top-left corner at a cell, largest first
 * (most cells, then wider): what the builder offers for an empty cell, a
 * preset space or an edited widget (`except` is the item being replaced).
 */
export function sizesAt(
  items: readonly GridItem[],
  column: number,
  row: number,
  kind: WidgetKind,
  except?: string,
): Size[] {
  const rule = SIZE_RULES[kind];
  const sizes: Size[] = [];
  for (let rows = rule.minRows; rows <= rule.maxRows; rows++)
    for (let columns = rule.minColumns; columns <= rule.maxColumns; columns++)
      if (
        placementFits(
          items,
          { column, row, columnSpan: columns, rowSpan: rows },
          except,
        )
      )
        sizes.push({ columns, rows });
  return sizes.sort(
    (a, b) => b.columns * b.rows - a.columns * a.rows || b.columns - a.columns,
  );
}
