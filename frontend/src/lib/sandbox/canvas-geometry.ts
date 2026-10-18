/**
 * Canvas geometry for the Sandbox: sizes, default placement, frame growth,
 * and drop rules. Pure and engine-free, so isolated tests own it. Every box
 * here is absolute: canvas units from the canvas origin, the same form the
 * owner's layout (`SandboxCanvasLayout`) stores.
 */

import {
  FIELD_TYPE_META,
  type SandboxCanvasLayout,
  type SandboxFieldType,
} from "./model";

/** The shared canvas unit used by node dragging and the visual world grid. */
export const SANDBOX_GRID_SIZE = 24;

/** Major grid dots repeat every four minor cells (96px), as on the website. */
export const SANDBOX_GRID_MAJOR_SIZE = SANDBOX_GRID_SIZE * 4;

/**
 * Zoom range for the canvas. The whole diagram scales uniformly (like an ERD)
 * and the 50% floor keeps field text readable; the minimap shows the rest.
 */
export const SANDBOX_ZOOM = { min: 0.5, max: 1.5, fitMin: 0.5 } as const;

/** Compact module cards with aligned field names and quiet type labels. */
export const MODULE_TABLE = {
  width: 232,
  headerHeight: 34,
  rowHeight: 26,
  splitX: 144,
} as const;

export const DEPARTMENT_WIDTH = 680;
/** Height of the department head band that holds the name. */
export const DEPARTMENT_HEAD_HEIGHT = 40;
/** A department frame never shrinks below this, and starts here when empty. */
export const DEPARTMENT_MIN = { width: 336, height: 144 } as const;
/** Space a frame keeps around its modules: 24 on three sides, 48 on top. */
const FRAME_MARGIN = { side: 24, top: 48 } as const;

const DEPARTMENT_COLUMN_WIDTH = 760;
const DEPARTMENT_ORIGIN = 48;
const MODULE_GUTTER = 32;
const MODULE_COLUMN_GAP = 80;
const MODULE_TOP_OFFSET = 56;
const MODULE_SIDE_OFFSET = 42;
const MODULE_COLUMNS = 2;

export interface CanvasPosition {
  x: number;
  y: number;
}

export interface CanvasBox extends CanvasPosition {
  width: number;
  height: number;
}

export type CanvasFeedback = "drop" | "moving" | null;

export type SandboxDropKind = "department" | "module" | "field";

const DROP_KINDS: readonly SandboxDropKind[] = [
  "department",
  "module",
  "field",
];

export const FIELD_TYPES = Object.keys(FIELD_TYPE_META) as SandboxFieldType[];

export function isFieldType(value: string): value is SandboxFieldType {
  return (FIELD_TYPES as readonly string[]).includes(value);
}

export function isDropKind(value: string): value is SandboxDropKind {
  return (DROP_KINDS as readonly string[]).includes(value);
}

export function dragKindFromTransfer(
  dataTransfer: DataTransfer,
): SandboxDropKind | null {
  const directKind = dataTransfer.getData("application/x-sandbox-kind");
  if (isDropKind(directKind)) return directKind;
  const transferTypes = new Set(Array.from(dataTransfer.types));
  for (const kind of DROP_KINDS) {
    if (
      transferTypes.has(`application/x-sandbox-kind-${kind}`) ||
      transferTypes.has(`application/x-sandbox-${kind}`)
    ) {
      return kind;
    }
  }
  return null;
}

/** Snap a canvas point to the canvas unit without changing its origin. */
export function snapSandboxPosition(
  position: CanvasPosition,
  size = SANDBOX_GRID_SIZE,
): CanvasPosition {
  return {
    x: Math.round(position.x / size) * size,
    y: Math.round(position.y / size) * size,
  };
}

/**
 * Department identity: four colors per theme, cycled in department order and
 * always shown beside the department name. `--dept-n-band` fills the
 * department head and `--dept-n-card` the module header; each theme decides
 * how loud they are.
 */
export function departmentTone(departmentIndex: number): number {
  return (((departmentIndex % 4) + 4) % 4) + 1;
}

export function truncateLabel(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

/** Table height: header plus one row per field (one placeholder row when empty). */
export function moduleTableHeight(fieldCount: number): number {
  return (
    MODULE_TABLE.headerHeight + Math.max(fieldCount, 1) * MODULE_TABLE.rowHeight
  );
}

/**
 * A relationship line. A relationship is dashed in the action color; a
 * handoff connects modules in different departments and is a solid neutral
 * line, so the key can name both. Both end in an arrowhead at the target
 * module. Values are SVG presentation attributes, so the look stylesheets
 * can still override them.
 */
export function relationshipLineAttrs(selected = false, handoff = false) {
  return {
    "data-sandbox-line": "true",
    "data-sandbox-edge-kind": handoff ? "handoff" : "relationship",
    stroke: selected
      ? "var(--primary)"
      : handoff
        ? "var(--canvas-edge)"
        : "var(--action)",
    strokeWidth: selected ? 2 : 1.6,
    strokeDasharray: handoff ? "" : "5 4",
  } as const;
}

function rowHeights(moduleHeights: readonly number[]): number[] {
  const rows: number[] = [];
  for (let index = 0; index < moduleHeights.length; index += MODULE_COLUMNS) {
    rows.push(
      Math.max(moduleHeights[index] ?? 0, moduleHeights[index + 1] ?? 0),
    );
  }
  return rows;
}

/** The starting height of a department that holds modules of these heights. */
export function departmentHeight(moduleHeights: readonly number[]): number {
  const rows = rowHeights(moduleHeights);
  return Math.max(
    180,
    MODULE_TOP_OFFSET +
      rows.reduce((total, value) => total + value, 0) +
      MODULE_GUTTER * Math.max(rows.length - 1, 0) +
      34,
  );
}

/** The starting size of a department frame with these module heights. */
export function departmentSize(moduleHeights: readonly number[]): {
  width: number;
  height: number;
} {
  return moduleHeights.length === 0
    ? { ...DEPARTMENT_MIN }
    : { width: DEPARTMENT_WIDTH, height: departmentHeight(moduleHeights) };
}

export function departmentPosition(index: number): CanvasPosition {
  return {
    x: DEPARTMENT_ORIGIN + index * DEPARTMENT_COLUMN_WIDTH,
    y: DEPARTMENT_ORIGIN,
  };
}

/** Default spot for the module at `index` inside a department frame. */
export function modulePosition(
  department: CanvasPosition,
  index: number,
  moduleHeights: readonly number[],
): CanvasPosition {
  const row = Math.floor(index / MODULE_COLUMNS);
  const column = index % MODULE_COLUMNS;
  const y =
    department.y +
    MODULE_TOP_OFFSET +
    rowHeights(moduleHeights)
      .slice(0, row)
      .reduce((total, value) => total + value + MODULE_GUTTER, 0);
  return {
    x:
      department.x +
      MODULE_SIDE_OFFSET +
      column * (MODULE_TABLE.width + MODULE_COLUMN_GAP),
    y: y + (column === 0 ? 0 : Math.min((moduleHeights[index] ?? 0) / 4, 14)),
  };
}

/**
 * Grow a frame only as needed to hold its modules with their margins; never
 * shrink it and never move a module. Growing left or up moves the frame's
 * origin, so callers that store child positions relative to the frame must
 * shift them back by the same amount.
 */
export function fitFrame(
  frame: CanvasBox,
  modules: readonly CanvasBox[],
): CanvasBox {
  const x = Math.min(
    frame.x,
    ...modules.map((box) => box.x - FRAME_MARGIN.side),
  );
  const y = Math.min(
    frame.y,
    ...modules.map((box) => box.y - FRAME_MARGIN.top),
  );
  const width = Math.max(
    DEPARTMENT_MIN.width,
    frame.x + frame.width - x,
    ...modules.map((box) => box.x + box.width - x + FRAME_MARGIN.side),
  );
  const height = Math.max(
    DEPARTMENT_MIN.height,
    frame.y + frame.height - y,
    ...modules.map((box) => box.y + box.height - y + FRAME_MARGIN.side),
  );
  return { x, y, width, height };
}

/**
 * The size a frame takes when its resize grip asks for `width` × `height`:
 * it still holds every module, and pointer resizing snaps to the grid unless
 * `free` (Alt, or a keyboard step).
 */
export function resizeFrame(
  frame: CanvasBox,
  modules: readonly CanvasBox[],
  width: number,
  height: number,
  free: boolean,
): { width: number; height: number } {
  const snap = (value: number) =>
    free ? value : Math.round(value / SANDBOX_GRID_SIZE) * SANDBOX_GRID_SIZE;
  return {
    width: Math.max(
      DEPARTMENT_MIN.width,
      ...modules.map((box) => box.x + box.width - frame.x + FRAME_MARGIN.side),
      snap(width),
    ),
    height: Math.max(
      DEPARTMENT_MIN.height,
      ...modules.map((box) => box.y + box.height - frame.y + FRAME_MARGIN.side),
      snap(height),
    ),
  };
}

export function boxContains(box: CanvasBox, point: CanvasPosition): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

/** The canvas as boxes, for hit-testing drops. */
export interface CanvasBoxes {
  departments: readonly { id: string; box: CanvasBox }[];
  modules: readonly { id: string; departmentId: string; box: CanvasBox }[];
}

export function boxesFromLayout(
  layout: SandboxCanvasLayout,
  structure: {
    departments: readonly { id: string }[];
    modules: readonly { id: string; departmentId: string }[];
  },
): CanvasBoxes {
  return {
    departments: structure.departments.flatMap((department) => {
      const box = layout[department.id];
      return box ? [{ id: department.id, box }] : [];
    }),
    modules: structure.modules.flatMap((sandboxModule) => {
      const box = layout[sandboxModule.id];
      return box
        ? [
            {
              id: sandboxModule.id,
              departmentId: sandboxModule.departmentId,
              box,
            },
          ]
        : [];
    }),
  };
}

/** The department frame under a canvas point, topmost (last drawn) first. */
export function departmentAt(
  boxes: CanvasBoxes,
  point: CanvasPosition,
): string | null {
  for (let index = boxes.departments.length - 1; index >= 0; index -= 1) {
    const department = boxes.departments[index];
    if (department && boxContains(department.box, point)) return department.id;
  }
  return null;
}

export interface DropResolution {
  parentId: string | null;
  targetId: string | null;
  error: string | null;
}

/**
 * Resolve a palette drop against the containment rules. The target id is
 * kept separate from the parent id so a valid drop can highlight the object
 * receiving the new child while the page receives the domain parent.
 */
export function resolveDrop(
  boxes: CanvasBoxes,
  kind: SandboxDropKind,
  point: CanvasPosition,
): DropResolution {
  const sandboxModule = boxes.modules.find((item) =>
    boxContains(item.box, point),
  );
  if (sandboxModule !== undefined) {
    if (kind === "department")
      return { parentId: null, targetId: null, error: null };
    if (kind === "field")
      return {
        parentId: sandboxModule.id,
        targetId: sandboxModule.id,
        error: null,
      };
    return {
      parentId: sandboxModule.departmentId,
      targetId: sandboxModule.departmentId,
      error: null,
    };
  }
  const department = departmentAt(boxes, point);
  if (department !== null) {
    if (kind === "module")
      return { parentId: department, targetId: department, error: null };
    if (kind === "field")
      return {
        parentId: null,
        targetId: department,
        error: "Fields can only be added inside a module.",
      };
  }
  return { parentId: null, targetId: null, error: null };
}
