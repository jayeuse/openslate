import type { Graph, Node } from "@antv/x6";
import {
  FIELD_TYPE_META,
  type SandboxCanvasLayout,
  type SandboxFieldType,
  type SandboxState,
} from "@/lib/sandbox/model";
import { MODULE_TABLE, departmentTone } from "@/lib/sandbox/x6-adapter";

export type SandboxDropKind = "department" | "module" | "field";

const DROP_KINDS: readonly SandboxDropKind[] = [
  "department",
  "module",
  "field",
];

export const FIELD_TYPES = Object.keys(FIELD_TYPE_META) as SandboxFieldType[];

export const DEPARTMENT_WIDTH = 680;
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

export type CanvasFeedback = "drop" | "moving" | null;

export interface DropResolution {
  parentId: string | null;
  targetId: string | null;
  error: string | null;
}

const CANVAS_NODE_BORDER = "var(--canvas-dept-frame, #a8b2c1)";
const CANVAS_NODE_TEXT = "var(--canvas-dept-ink, #555e6c)";
/** Height of the department head band that holds the name. */
export const DEPARTMENT_HEAD_HEIGHT = 36;
const CANVAS_NODE_SELECTED = "var(--accent, #f5f9ff)";
const CANVAS_NODE_ACTIVE = "var(--primary, #3b82f6)";
const CANVAS_NODE_MOVING = "var(--canvas-moving, #fff8eb)";

export function isDropKind(value: string): value is SandboxDropKind {
  return (DROP_KINDS as readonly string[]).includes(value);
}

export function dragKindFromTransfer(
  dataTransfer: DataTransfer,
): SandboxDropKind | null {
  const directKind = dataTransfer.getData("application/x-sandbox-kind");
  if (isDropKind(directKind)) {
    return directKind;
  }
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

export function isFieldType(value: string): value is SandboxFieldType {
  return (FIELD_TYPES as readonly string[]).includes(value);
}

function truncateLabel(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

export function departmentNodeAttrs(
  name: string,
  moduleCount: number,
  height: number,
  selected: boolean,
  feedback: CanvasFeedback,
  departmentIndex = 0,
) {
  const moving = feedback === "moving";
  const dropTarget = feedback === "drop";
  const tone = departmentTone(departmentIndex);
  return {
    text: { refX: 0, refY: 0 },
    rect: { stroke: "none", strokeWidth: 0 },
    body: {
      "data-sandbox-body": "true",
      // Theme skin hook (src/app/themes).
      "data-sandbox-kind": "department",
      width: DEPARTMENT_WIDTH,
      height,
      fill: moving
        ? CANVAS_NODE_MOVING
        : dropTarget
          ? "var(--canvas-drop, #eff6ff)"
          : selected
            ? CANVAS_NODE_SELECTED
            : "var(--canvas-dept-fill, #ffffff)",
      stroke: moving
        ? "var(--warning, #f59e0b)"
        : dropTarget || selected
          ? CANVAS_NODE_ACTIVE
          : CANVAS_NODE_BORDER,
      strokeWidth: moving || dropTarget || selected ? 2 : 1,
      strokeDasharray: "",
      rx: 8,
      ry: 8,
      "data-selected": selected ? "true" : "false",
      "data-feedback": feedback ?? "",
    },
    // The head band and identity mark exist in every theme; each theme
    // colors them through --dept-n-band and --dept-n.
    band: {
      "data-sandbox-part": "band",
      x: 1,
      y: 1,
      width: DEPARTMENT_WIDTH - 2,
      height: DEPARTMENT_HEAD_HEIGHT - 1,
      fill: `var(--dept-${tone}-band, transparent)`,
      stroke: "none",
      pointerEvents: "none",
    },
    mark: {
      "data-sandbox-part": "identity",
      x: 12,
      y: 14,
      width: 8,
      height: 8,
      rx: 2,
      fill: `var(--dept-${tone}, #8e79b8)`,
      stroke: "none",
      pointerEvents: "none",
    },
    heading: {
      x: 26,
      y: 18,
      textAnchor: "start",
      textVerticalAnchor: "middle",
      fontSize: 13,
      fontWeight: 600,
      fill: moving
        ? "var(--warning, #b45309)"
        : dropTarget || selected
          ? CANVAS_NODE_ACTIVE
          : CANVAS_NODE_TEXT,
      text: truncateLabel(name, 30),
    },
    resizeGrip: {
      width: 24,
      height: 24,
      rx: 4,
      fill: "transparent",
      stroke: "none",
      cursor: "nwse-resize",
      tabindex: selected ? 0 : -1,
      visibility: selected ? "visible" : "hidden",
      role: "button",
      "aria-label": "Resize department",
      "data-department-resize": "true",
      style: { touchAction: "none" },
    },
    resizeLines: {
      stroke: CANVAS_NODE_ACTIVE,
      strokeWidth: 2,
      fill: "none",
      pointerEvents: "none",
      visibility: selected ? "visible" : "hidden",
    },
    subheading: {
      x: DEPARTMENT_WIDTH - 12,
      y: 18,
      textAnchor: "end",
      textVerticalAnchor: "middle",
      fontSize: 12,
      fill: CANVAS_NODE_TEXT,
      text: `${moduleCount} ${moduleCount === 1 ? "module" : "modules"}`,
    },
  };
}

/** Grow frames only as needed; never reflow or move their children. */
export function fitDepartmentFrames(graph: Graph): void {
  for (const department of graph.getNodes()) {
    if (nodeKindOf(department) !== "department") continue;
    const boxes = (department.getChildren() ?? []).flatMap((cell) =>
      cell.isNode() && nodeKindOf(cell) === "module" ? [cell.getBBox()] : [],
    );
    const position = department.getPosition();
    const size = department.getSize();
    const x = Math.min(position.x, ...boxes.map((box) => box.x - 24));
    const y = Math.min(position.y, ...boxes.map((box) => box.y - 48));
    const width = Math.max(
      336,
      position.x + size.width - x,
      ...boxes.map((box) => box.right - x + 24),
    );
    const height = Math.max(
      144,
      position.y + size.height - y,
      ...boxes.map((box) => box.bottom - y + 24),
    );
    if (position.x !== x || position.y !== y)
      department.setPosition(x, y, { deep: false });
    if (size.width !== width || size.height !== height)
      department.setSize(width, height);
    updateDepartmentSizeAttrs(department);
  }
}

export function updateDepartmentSizeAttrs(node: Node): void {
  const { width, height } = node.getSize();
  node.setAttrs({
    body: { width, height },
    band: { width: width - 2 },
    subheading: { x: width - 12 },
    resizeGrip: { x: width - 24, y: height - 24 },
    resizeLines: {
      d: `M${width - 17} ${height - 7}l10 -10 M${width - 11} ${height - 7}l4 -4`,
    },
  });
}

export function readLayout(graph: Graph): SandboxCanvasLayout {
  return Object.fromEntries(
    graph
      .getNodes()
      .map((node) => [node.id, { ...node.getPosition(), ...node.getSize() }]),
  );
}

export function nodeKindOf(node: Node): string | null {
  const data = node.getData() as { kind?: unknown };
  return typeof data.kind === "string" ? data.kind : null;
}

export function departmentHeight(moduleHeights: number[]): number {
  const rowHeights: number[] = [];
  for (let index = 0; index < moduleHeights.length; index += MODULE_COLUMNS) {
    rowHeights.push(
      Math.max(moduleHeights[index] ?? 0, moduleHeights[index + 1] ?? 0),
    );
  }
  return Math.max(
    180,
    MODULE_TOP_OFFSET +
      rowHeights.reduce((total, value) => total + value, 0) +
      MODULE_GUTTER * Math.max(rowHeights.length - 1, 0) +
      34,
  );
}

export function departmentPosition(index: number): CanvasPosition {
  return {
    x: DEPARTMENT_ORIGIN + index * DEPARTMENT_COLUMN_WIDTH,
    y: DEPARTMENT_ORIGIN,
  };
}

export function modulePosition(
  department: Node,
  index: number,
  moduleHeights: number[],
): CanvasPosition {
  const departmentPosition = department.getPosition();
  const row = Math.floor(index / MODULE_COLUMNS);
  const column = index % MODULE_COLUMNS;
  const rowHeights: number[] = [];
  for (
    let rowIndex = 0;
    rowIndex < moduleHeights.length;
    rowIndex += MODULE_COLUMNS
  ) {
    rowHeights.push(
      Math.max(moduleHeights[rowIndex] ?? 0, moduleHeights[rowIndex + 1] ?? 0),
    );
  }
  const y =
    departmentPosition.y +
    MODULE_TOP_OFFSET +
    rowHeights
      .slice(0, row)
      .reduce((total, value) => total + value + MODULE_GUTTER, 0);
  return {
    x:
      departmentPosition.x +
      MODULE_SIDE_OFFSET +
      column * (MODULE_TABLE.width + MODULE_COLUMN_GAP),
    y: y + (column === 0 ? 0 : Math.min(moduleHeights[index] / 4, 14)),
  };
}

export function rowFieldAt(
  node: Node,
  y: number,
  state: SandboxState,
): string | null {
  if (nodeKindOf(node) !== "module") {
    return null;
  }
  const moduleId = node.id;
  const sandboxModule = state.modules.find((item) => item.id === moduleId);
  if (sandboxModule === undefined) {
    return null;
  }
  const row = Math.floor(
    (y - node.getBBox().y - MODULE_TABLE.headerHeight) / MODULE_TABLE.rowHeight,
  );
  if (row < 0 || row >= sandboxModule.fieldIds.length) {
    return null;
  }
  return sandboxModule.fieldIds[row] ?? null;
}

export function selectNodeOrField(
  node: Node,
  y: number,
  state: SandboxState,
  callbacks: { onSelect: (cellId: string) => void },
): void {
  callbacks.onSelect(rowFieldAt(node, y, state) ?? node.id);
}

/**
 * Resolve a palette drop against the existing containment rules. The target
 * id is kept separate from the parent id so a valid drop can highlight the
 * object receiving the new child while the page receives the domain parent.
 */
export function resolveDrop(
  graph: Graph,
  kind: SandboxDropKind,
  point: { x: number; y: number },
): DropResolution {
  const nodes = graph.getNodes();
  for (const node of nodes) {
    if (
      nodeKindOf(node) === "module" &&
      node.getBBox().containsPoint(point.x, point.y)
    ) {
      if (kind === "department") {
        return { parentId: null, targetId: null, error: null };
      }
      if (kind === "field") {
        return { parentId: node.id, targetId: node.id, error: null };
      }
      const parent = node.getParent();
      return {
        parentId: parent ? parent.id : null,
        targetId: parent?.id ?? null,
        error:
          kind === "module" && parent === null
            ? "Modules must be added inside a department."
            : null,
      };
    }
  }
  for (const node of nodes) {
    if (
      nodeKindOf(node) === "department" &&
      node.getBBox().containsPoint(point.x, point.y)
    ) {
      if (kind === "module") {
        return { parentId: node.id, targetId: node.id, error: null };
      }
      if (kind === "field") {
        return {
          parentId: null,
          targetId: node.id,
          error: "Fields can only be added inside a module.",
        };
      }
    }
  }
  return { parentId: null, targetId: null, error: null };
}
