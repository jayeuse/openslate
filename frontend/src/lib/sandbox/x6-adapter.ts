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

/**
 * A relationship line. A relationship is dashed in the action color; a
 * handoff connects modules in different departments and is a solid neutral
 * line, so the key can name both. Both end in an arrowhead at the target
 * module. Shared by persisted relationships and the provisional connection
 * preview.
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
    strokeLinecap: "round",
    sourceMarker: null,
    // X6 fills the arrowhead with the line's stroke color.
    targetMarker: {
      name: "block",
      width: 8,
      height: 7,
      strokeDasharray: "none",
    },
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

export const NODE_KINDS = ["department", "module"] as const;

/** The shared canvas unit used by node dragging and the visual world grid. */
export const SANDBOX_GRID_SIZE = 24;

/** Major grid dots repeat every four minor cells (96px), as on the website. */
export const SANDBOX_GRID_MAJOR_SIZE = SANDBOX_GRID_SIZE * 4;

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
  width: 232,
  headerHeight: 34,
  rowHeight: 26,
  splitX: 144,
} as const;

// Canvas skin tokens (globals.css and src/app/themes). Each theme sets them
// for light and dark.
export const MODULE_TABLE_COLORS = {
  headerText: "var(--canvas-module-ink)",
  bodyFill: "var(--canvas-module-fill)",
  bodyStroke: "var(--canvas-module-frame)",
  rowStroke: "var(--canvas-row-rule)",
  selectedRowFill: "var(--accent)",
  nameText: "var(--canvas-field-ink)",
  typeText: "var(--canvas-type-ink)",
  emptyText: "var(--canvas-type-ink)",
} as const;

/** The table glyph beside a module name (16px box, as on the website). */
function tableGlyphPath(x: number, y: number): string {
  return (
    `M${x + 4} ${y + 2.5}h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z` +
    `M${x + 2} ${y + 6.5}h12M${x + 6.5} ${y + 6.5}v7`
  );
}

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
    { tagName: "path", selector: "glyph" },
    { tagName: "text", selector: "headerTitle" },
  ];
  for (let i = 0; i < rows; i += 1) {
    markup.push({ tagName: "rect", selector: `row${i}` });
    markup.push({ tagName: "line", selector: `sep${i}` });
    markup.push({ tagName: "circle", selector: `marker${i}` });
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
  departmentIndex = 0,
): SandboxNodeAttrs {
  const tone = departmentTone(departmentIndex);
  const { width, headerHeight, rowHeight } = MODULE_TABLE;
  const colors = MODULE_TABLE_COLORS;
  const rows = Math.max(fields.length, 1);
  const tableHeight = moduleTableHeight(fields.length);
  const attrs: SandboxNodeAttrs = {
    text: { refX: 0, refY: 0 },
    rect: { stroke: "none", strokeWidth: 0 },
    body: {
      "data-sandbox-body": "true",
      // Theme skin hook (src/app/themes).
      "data-sandbox-kind": "module",
      width,
      height: tableHeight,
      // Corners come from the look's --radius in CSS (globals.css); these
      // are the Slate values for a missing stylesheet.
      rx: 10,
      ry: 10,
      fill:
        feedback === "moving"
          ? "var(--canvas-moving)"
          : feedback === "drop"
            ? "var(--canvas-drop)"
            : selectedModule
              ? "var(--accent)"
              : `var(--dept-${tone}-module)`,
      stroke:
        feedback === "moving"
          ? "var(--warning)"
          : feedback === "drop" || selectedModule
            ? "var(--primary)"
            : colors.bodyStroke,
      strokeWidth: feedback === null && !selectedModule ? 1 : 2,
      "data-selected": selectedModule ? "true" : "false",
      "data-feedback": feedback ?? "",
    },
    headerBar: {
      // Theme skin hook: the header follows the body's corner shape.
      "data-sandbox-part": "header",
      width,
      height: headerHeight,
      rx: 10,
      ry: 10,
      stroke: "none",
      fill:
        feedback === "moving"
          ? "var(--warning)"
          : selectedModule || feedback === "drop"
            ? "var(--accent)"
            : `var(--dept-${tone}-card)`,
      "data-selected": selectedModule ? "true" : "false",
    },
    glyph: {
      "data-sandbox-part": "glyph",
      d: tableGlyphPath(10, headerHeight / 2 - 8),
      fill: "none",
      stroke: colors.typeText,
      strokeWidth: 1.4,
      pointerEvents: "none",
      "aria-hidden": "true",
    },
    headerTitle: {
      // The header bar under it takes the pointer, so the whole header is one
      // target.
      pointerEvents: "none",
      x: 32,
      y: headerHeight / 2,
      textAnchor: "start",
      textVerticalAnchor: "middle",
      fontSize: 13,
      fontWeight: 600,
      fill: colors.headerText,
      text: truncateModuleTitle(name, 24),
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
      rx: i === rows - 1 ? 9 : 0,
      fill: selected
        ? colors.selectedRowFill
        : i % 2 === 1
          ? `var(--dept-${tone}-stripe)`
          : `var(--dept-${tone}-module)`,
      stroke: selected ? "var(--primary)" : "none",
      strokeWidth: selected ? 1 : 0,
      tabindex: field === undefined ? -1 : 0,
      role: field === undefined ? "presentation" : "button",
      "data-field-id": field?.id ?? "",
      "data-selected": selected ? "true" : "false",
      "aria-pressed":
        field === undefined ? undefined : selected ? "true" : "false",
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
      "data-sandbox-part": "field-name",
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
          : truncateModuleTitle(field.name, 18),
    };
    // Required fields have a filled marker, optional fields a hollow one;
    // the canvas key names both.
    attrs[`marker${i}`] = {
      cx: 14,
      cy: rowCenter,
      r: field === undefined ? 0 : 3,
      fill: field?.required ? colors.typeText : "none",
      stroke: colors.typeText,
      strokeWidth: 1.25,
      pointerEvents: "none",
      "aria-hidden": "true",
    };
    attrs[`type${i}`] = {
      // Field types are data, set in the look's code face (globals.css).
      "data-sandbox-part": "field-type",
      pointerEvents: "none",
      x: width - 10,
      y: rowCenter,
      textAnchor: "end",
      textVerticalAnchor: "middle",
      fontSize: 12,
      fontWeight: 400,
      fill: colors.typeText,
      // The same words the Properties panel uses.
      text: field === undefined ? "" : FIELD_TYPE_META[field.type].label,
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
    stroke: "var(--muted-foreground)",
    strokeWidth: 2,
    fill: "var(--card)",
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
 * Zoom range for the canvas. The whole diagram scales uniformly (like an ERD)
 * and the 50% floor keeps field text readable; the minimap shows the rest.
 */
export const SANDBOX_ZOOM = { min: 0.5, max: 1.5, fitMin: 0.5 } as const;

/**
 * Base X6 graph options for the sandbox canvas: a themed surface, panning,
 * zoom-on-modifier mousewheel, department-embeds-module nesting, and
 * orthogonal edge connections without blank drops.
 */
export function graphOptions(
  gridSize: number = SANDBOX_GRID_SIZE,
): GraphManual {
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
    grid: { size: gridSize, visible: false },
    panning: { enabled: true },
    mousewheel: {
      enabled: true,
      modifiers: ["ctrl", "meta"],
      minScale: SANDBOX_ZOOM.min,
      maxScale: SANDBOX_ZOOM.max,
    },
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
      connector: { name: "rounded", args: { radius: 8 } },
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
