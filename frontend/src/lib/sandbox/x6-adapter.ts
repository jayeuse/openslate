/**
 * X6 adapter for the sandbox prototype.
 *
 * This is the ONLY sandbox file that may import @antv/x6. Everything here
 * stays pure and testable: plain cell descriptors (never Cell instances in
 * domain state) plus factories for ports and graph options.
 */

import {
  type ComplexAttrs,
  type GraphManual,
  type NodeMetadata,
} from "@antv/x6";
import { FIELD_TYPE_META, type SandboxField, type SandboxState } from "./model";

/** Shared by persisted relationships and the provisional connection preview. */
export function relationshipLineAttrs(selected = false) {
  return {
    "data-sandbox-line": "true",
    stroke: selected
      ? "var(--primary, #3b82f6)"
      : "var(--muted-foreground, #68707d)",
    strokeWidth: 1.25,
    strokeDasharray: "7 5",
    sourceMarker: null,
    targetMarker: null,
  };
}

export const NODE_KINDS = ["department", "module"] as const;

/** The shared canvas unit used by node dragging and the visual world grid. */
export const SANDBOX_GRID_SIZE = 24;

/** Major grid lines repeat every five minor cells. */
export const SANDBOX_GRID_MAJOR_SIZE = SANDBOX_GRID_SIZE * 5;

export interface SandboxCanvasPosition {
  x: number;
  y: number;
}

/** Snap a graph-space point to the canvas unit without changing its origin. */
export function snapSandboxPosition(
  position: SandboxCanvasPosition,
  size = SANDBOX_GRID_SIZE,
): SandboxCanvasPosition {
  return {
    x: Math.round(position.x / size) * size,
    y: Math.round(position.y / size) * size,
  };
}

/**
 * Compact module cards with aligned field names and quiet type labels.
 */
export const MODULE_TABLE = {
  width: 280,
  headerHeight: 40,
  rowHeight: 32,
  splitX: 174,
} as const;

export const MODULE_TABLE_COLORS = {
  headerFill: "var(--muted, #dce1e8)",
  headerText: "var(--foreground, #20242c)",
  bodyFill: "var(--card, #e9edf2)",
  bodyStroke: "var(--sandbox-node-border, #a8b2c1)",
  splitStroke: "var(--border, #b8cbf3)",
  rowStroke: "var(--border, #c8d8f7)",
  stripeFill: "var(--sandbox-field-stripe, #dce2e9)",
  selectedRowFill: "var(--accent, #dce8ff)",
  nameText: "var(--card-foreground, #1f2d4d)",
  typeText: "var(--muted-foreground, #30446d)",
  emptyText: "var(--muted-foreground, #7183a6)",
} as const;

export interface SandboxMarkupUnit {
  tagName: string;
  selector: string;
}

export type SandboxNodeAttrs = Record<string, ComplexAttrs>;

/** Table height: header plus one row per field (one placeholder row when empty). */
export function moduleTableHeight(fieldCount: number): number {
  return (
    MODULE_TABLE.headerHeight + Math.max(fieldCount, 1) * MODULE_TABLE.rowHeight
  );
}

export function truncateModuleTitle(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

/**
 * Dynamic module markup: header, table icon, and accessible field rows.
 */
export function moduleTableMarkup(fieldCount: number): SandboxMarkupUnit[] {
  const rows = Math.max(fieldCount, 1);
  const markup: SandboxMarkupUnit[] = [
    { tagName: "rect", selector: "body" },
    { tagName: "rect", selector: "headerBar" },
    { tagName: "text", selector: "headerTitle" },
    { tagName: "path", selector: "tableIcon" },
  ];
  for (let i = 0; i < rows; i += 1) {
    markup.push({ tagName: "rect", selector: `row${i}` });
    markup.push({ tagName: "line", selector: `sep${i}` });
    markup.push({ tagName: "text", selector: `required${i}` });
    markup.push({ tagName: "text", selector: `name${i}` });
    markup.push({ tagName: "text", selector: `type${i}` });
  }

  return markup;
}

/** Attributes for a module table node built from its fields. */
export function moduleTableAttrs(
  name: string,
  fields: SandboxField[],
  selectedFieldId: string | null = null,
  selectedModule = false,
  feedback: "drop" | "moving" | null = null,
): SandboxNodeAttrs {
  const { width, headerHeight, rowHeight } = MODULE_TABLE;
  const colors = MODULE_TABLE_COLORS;
  const rows = Math.max(fields.length, 1);
  const tableHeight = moduleTableHeight(fields.length);
  const attrs: SandboxNodeAttrs = {
    text: { refX: 0, refY: 0 },
    rect: { stroke: "none", strokeWidth: 0 },
    body: {
      "data-sandbox-body": "true",
      width,
      height: tableHeight,
      rx: 8,
      ry: 8,
      fill:
        feedback === "moving"
          ? "var(--canvas-moving, #fff8eb)"
          : feedback === "drop"
            ? "var(--canvas-drop, #eff6ff)"
            : selectedModule
              ? "var(--accent, #edf4ff)"
              : colors.bodyFill,
      stroke:
        feedback === "moving"
          ? "var(--warning, #f59e0b)"
          : feedback === "drop" || selectedModule
            ? "var(--primary, #2563eb)"
            : colors.bodyStroke,
      strokeWidth: feedback === null && !selectedModule ? 1 : 2,
      "data-selected": selectedModule ? "true" : "false",
      "data-feedback": feedback ?? "",
    },
    headerBar: {
      width,
      height: headerHeight,
      rx: 8,
      ry: 8,
      stroke: "none",
      fill:
        feedback === "moving"
          ? "var(--warning, #d97706)"
          : selectedModule || feedback === "drop"
            ? "var(--accent, #edf3ff)"
            : colors.headerFill,
      "data-selected": selectedModule ? "true" : "false",
    },
    tableIcon: {
      d: "M14 14h14v12H14z M14 18h14 M19 18v8",
      fill: "none",
      stroke: colors.typeText,
      strokeWidth: 1.2,
      pointerEvents: "none",
    },
    headerTitle: {
      x: 38,
      y: headerHeight / 2,
      textAnchor: "start",
      textVerticalAnchor: "middle",
      fontSize: 13,
      fontWeight: "bold",
      fill: colors.headerText,
      text: truncateModuleTitle(name, 28),
    },
  };
  for (let i = 0; i < rows; i += 1) {
    const rowTop = headerHeight + i * rowHeight;
    const rowCenter = rowTop + rowHeight / 2;
    const field = fields[i];
    const selected = field !== undefined && field.id === selectedFieldId;
    attrs[`row${i}`] = {
      x: 1,
      y: rowTop,
      width: width - 2,
      height: rowHeight - (i === rows - 1 ? 1 : 0),
      rx: i === rows - 1 ? 7 : 0,
      fill: selected
        ? colors.selectedRowFill
        : i % 2 === 1
          ? colors.stripeFill
          : colors.bodyFill,
      stroke: selected ? "var(--primary, #2563eb)" : "none",
      strokeWidth: selected ? 1 : 0,
      tabindex: field === undefined ? -1 : 0,
      role: field === undefined ? "presentation" : "button",
      "data-field-id": field?.id ?? "",
      "data-selected": selected ? "true" : "false",
      "aria-selected": selected ? "true" : "false",
      "data-feedback": selected ? "selected" : "",
      "aria-label":
        field === undefined
          ? "No fields yet"
          : `${field.name}, ${FIELD_TYPE_META[field.type].label}, ${field.required ? "required" : "optional"}`,
    };
    {
      attrs[`sep${i}`] = {
        x1: 0,
        y1: rowTop,
        x2: width,
        y2: rowTop,
        stroke: colors.rowStroke,
        strokeWidth: 1,
      };
    }
    attrs[`name${i}`] = {
      pointerEvents: "none",
      x: 26,
      y: rowCenter,
      textAnchor: "start",
      textVerticalAnchor: "middle",
      fontSize: 12,
      fill: field === undefined ? colors.emptyText : colors.nameText,
      fontStyle: field === undefined ? "italic" : "normal",
      text:
        field === undefined
          ? "No fields yet"
          : truncateModuleTitle(field.name, 21),
    };
    attrs[`required${i}`] = {
      x: 13,
      y: rowCenter,
      textAnchor: "middle",
      textVerticalAnchor: "middle",
      fontSize: 12,
      fill: colors.typeText,
      pointerEvents: "none",
      text: field === undefined ? "" : field.required ? "•" : "○",
      "aria-hidden": "true",
    };
    attrs[`type${i}`] = {
      pointerEvents: "none",
      x: width - 10,
      y: rowCenter,
      textAnchor: "end",
      textVerticalAnchor: "middle",
      fontSize: 10,
      fontWeight: 400,
      fontFamily: "ui-monospace, SFMono-Regular, monospace",
      fill: colors.typeText,
      text:
        field === undefined
          ? ""
          : FIELD_TYPE_META[field.type].label.toLowerCase(),
    };
  }
  return attrs;
}

export type SandboxNodeKind = (typeof NODE_KINDS)[number];

export type SandboxCellKind = SandboxNodeKind | "link";

export interface SandboxCellDescriptor {
  id: string;
  kind: SandboxCellKind;
  parentId?: string;
  label: string;
  meta: Record<string, string | number | boolean | null>;
}

export interface SandboxNodeSize {
  width: number;
  height: number | "auto";
  minWidth?: number;
  minHeight?: number;
}

export const NODE_SIZES: Record<SandboxNodeKind, SandboxNodeSize> = {
  department: { width: 360, height: 180, minWidth: 360, minHeight: 180 },
  module: { width: MODULE_TABLE.width, height: "auto" },
};

/**
 * Flatten mock state into plain cell descriptors: one per department,
 * one per module (parented to its department), one per link.
 */
export function toCells(state: SandboxState): SandboxCellDescriptor[] {
  const cells: SandboxCellDescriptor[] = [];

  for (const department of state.departments) {
    cells.push({
      id: department.id,
      kind: "department",
      label: department.name,
      meta: {
        departmentId: department.id,
        moduleCount: department.moduleIds.length,
      },
    });
  }

  for (const sandboxModule of state.modules) {
    cells.push({
      id: sandboxModule.id,
      kind: "module",
      parentId: sandboxModule.departmentId,
      label: sandboxModule.name,
      meta: {
        moduleId: sandboxModule.id,
        departmentId: sandboxModule.departmentId,
        fieldCount: sandboxModule.fieldIds.length,
      },
    });
  }

  for (const link of state.links) {
    cells.push({
      id: link.id,
      kind: "link",
      label: link.label,
      meta: {
        linkId: link.id,
        sourceModuleId: link.sourceModuleId,
        targetModuleId: link.targetModuleId,
        relationshipType: link.relationshipType ?? null,
      },
    });
  }

  return cells;
}

function isSandboxNodeData(value: unknown): value is { kind: string } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("kind" in value)) {
    return false;
  }
  return typeof (value as { kind: unknown }).kind === "string";
}

/**
 * Invisible magnets remain available as gesture targets; reveal on hover or selection.
 */
export function getModulePorts(
  relationshipMode: boolean,
): NonNullable<NodeMetadata["ports"]> {
  const magnet = {
    r: 6,
    magnet: true,
    stroke: "var(--muted-foreground, #68707d)",
    strokeWidth: 2,
    fill: "var(--card, #ffffff)",
    opacity: relationshipMode ? 1 : 0,
  };
  return {
    groups: {
      in: { position: "left", attrs: { circle: magnet } },
      out: { position: "right", attrs: { circle: magnet } },
    },
  };
}

/**
 * Base X6 graph options for the sandbox canvas: a themed surface, panning,
 * zoom-on-modifier mousewheel, department-embeds-module nesting, and
 * orthogonal edge connections without blank drops.
 */
export function graphOptions(): GraphManual {
  return {
    // X6 3.x renders through a job queue flushed on rAF by default. The canvas
    // rebuilds cells on every state change (clear + re-add with the same ids),
    // which lets a queued removal job be replaced by the re-add job, leaving
    // stale DOM behind (duplicated nodes with the same cell id). Synchronous
    // rendering keeps remove/add ordering deterministic.
    async: false,
    background: {
      color: "transparent",
    },
    // The visible mesh is rendered by SandboxCanvas so Alt/Option can switch
    // the drag snap precision without hiding or resizing the world grid.
    grid: { size: SANDBOX_GRID_SIZE, visible: false },
    panning: { enabled: true },
    mousewheel: { enabled: true, modifiers: ["ctrl", "meta"] },
    translating: { autoOffset: false },
    embedding: {
      enabled: true,
      validate: ({ child, parent }) => {
        const childData: unknown = child.getData() as unknown;
        const parentData: unknown = parent.getData() as unknown;
        return (
          isSandboxNodeData(childData) &&
          isSandboxNodeData(parentData) &&
          parentData.kind === "department" &&
          childData.kind === "module"
        );
      },
    },
    connecting: {
      createEdge() {
        return this.createEdge({
          attrs: { line: relationshipLineAttrs() },
        });
      },
      allowBlank: false,
      allowLoop: false,
      router: { name: "orth" },
      connector: { name: "normal" },
      validateConnection: ({ sourceCell, targetCell }) => {
        if (sourceCell === null || sourceCell === undefined) {
          return false;
        }
        if (targetCell === null || targetCell === undefined) {
          return false;
        }
        return sourceCell.id !== targetCell.id;
      },
    },
  };
}
