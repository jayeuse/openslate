/**
 * X6 adapter for the sandbox prototype.
 *
 * This is the ONLY sandbox file that may import @antv/x6. Everything here
 * stays pure and testable: plain cell descriptors (never Cell instances in
 * domain state) plus factories for ports and graph options.
 */

import type { ComplexAttrs, GraphManual, NodeMetadata } from "@antv/x6";
import { FIELD_TYPE_META, type SandboxField, type SandboxState } from "./model";

export const NODE_KINDS = ["department", "module"] as const;

/**
 * ER-table visual constants for module nodes (matching the reference entity
 * diagram: a solid blue header, pale rows, and a wider field-name column).
 */
export const MODULE_TABLE = {
  width: 240,
  headerHeight: 30,
  rowHeight: 28,
  splitX: 154,
} as const;

export const MODULE_TABLE_COLORS = {
  headerFill: "#6093fa",
  headerText: "#ffffff",
  bodyFill: "#f0f4ff",
  bodyStroke: "#83a9f3",
  splitStroke: "#b8cbf3",
  rowStroke: "#c8d8f7",
  selectedRowFill: "#dce8ff",
  nameText: "#1f2d4d",
  typeText: "#30446d",
  emptyText: "#7183a6",
} as const;

export interface SandboxMarkupUnit {
  tagName: string;
  selector: string;
}

export type SandboxNodeAttrs = Record<string, ComplexAttrs>;

/** Table height: blue header plus one row per field (one placeholder row when empty). */
export function moduleTableHeight(fieldCount: number): number {
  return (
    MODULE_TABLE.headerHeight + Math.max(fieldCount, 1) * MODULE_TABLE.rowHeight
  );
}

export function truncateModuleTitle(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

/**
 * Dynamic markup for a module table node: header bar + title, a vertical
 * column split, and one name/type text row per field.
 */
export function moduleTableMarkup(fieldCount: number): SandboxMarkupUnit[] {
  const rows = Math.max(fieldCount, 1);
  const markup: SandboxMarkupUnit[] = [
    { tagName: "rect", selector: "body" },
    { tagName: "rect", selector: "headerBar" },
    { tagName: "text", selector: "headerTitle" },
  ];
  for (let i = 0; i < rows; i += 1) {
    markup.push({ tagName: "rect", selector: `row${i}` });
    if (i > 0) {
      markup.push({ tagName: "line", selector: `sep${i}` });
    }
    markup.push({ tagName: "text", selector: `name${i}` });
    markup.push({ tagName: "text", selector: `type${i}` });
  }
  markup.push({ tagName: "line", selector: "split" });
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
  const { width, headerHeight, rowHeight, splitX } = MODULE_TABLE;
  const colors = MODULE_TABLE_COLORS;
  const rows = Math.max(fields.length, 1);
  const tableHeight = moduleTableHeight(fields.length);
  const attrs: SandboxNodeAttrs = {
    text: { refX: 0, refY: 0 },
    rect: { stroke: "none", strokeWidth: 0 },
    body: {
      width,
      height: tableHeight,
      rx: 0,
      ry: 0,
      fill:
        feedback === "moving"
          ? "#fff8eb"
          : feedback === "drop"
            ? "#eff6ff"
            : selectedModule
              ? "#edf4ff"
              : colors.bodyFill,
      stroke:
        feedback === "moving"
          ? "#f59e0b"
          : feedback === "drop" || selectedModule
            ? colors.headerFill
            : colors.bodyStroke,
      strokeWidth: feedback === null && !selectedModule ? 1 : 2,
      "data-selected": selectedModule ? "true" : "false",
      "data-feedback": feedback ?? "",
    },
    headerBar: {
      width,
      height: headerHeight,
      rx: 0,
      ry: 0,
      stroke: "none",
      fill:
        feedback === "moving"
          ? "#d97706"
          : selectedModule || feedback === "drop"
            ? "#3f7ff0"
            : colors.headerFill,
      "data-selected": selectedModule ? "true" : "false",
    },
    headerTitle: {
      x: width / 2,
      y: headerHeight / 2,
      textAnchor: "middle",
      textVerticalAnchor: "middle",
      fontSize: 13,
      fontWeight: "bold",
      fill: colors.headerText,
      text: truncateModuleTitle(name, 26),
    },
  };
  for (let i = 0; i < rows; i += 1) {
    const rowTop = headerHeight + i * rowHeight;
    const rowCenter = rowTop + rowHeight / 2;
    const field = fields[i];
    const selected = field !== undefined && field.id === selectedFieldId;
    attrs[`row${i}`] = {
      x: 0,
      y: rowTop,
      width,
      height: rowHeight,
      fill: selected ? colors.selectedRowFill : colors.bodyFill,
      stroke: selected ? colors.headerFill : "none",
      strokeWidth: selected ? 1 : 0,
      tabindex: field === undefined ? -1 : 0,
      role: field === undefined ? "presentation" : "button",
      "data-field-id": field?.id ?? "",
      "data-selected": selected ? "true" : "false",
      "aria-selected": selected ? "true" : "false",
      "data-feedback": selected ? "selected" : "",
      "aria-label": field === undefined ? "No fields yet" : field.name,
    };
    if (i > 0) {
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
      x: 10,
      y: rowCenter,
      textAnchor: "start",
      textVerticalAnchor: "middle",
      fontSize: 12,
      fill: field === undefined ? colors.emptyText : colors.nameText,
      fontStyle: field === undefined ? "italic" : "normal",
      text:
        field === undefined
          ? "No fields yet"
          : truncateModuleTitle(field.name, 22),
    };
    attrs[`type${i}`] = {
      pointerEvents: "none",
      x: width - 10,
      y: rowCenter,
      textAnchor: "end",
      textVerticalAnchor: "middle",
      fontSize: 10,
      fontWeight: 600,
      fill: colors.typeText,
      text:
        field === undefined
          ? ""
          : FIELD_TYPE_META[field.type].label.toUpperCase(),
    };
  }
  attrs.split = {
    pointerEvents: "none",
    x1: splitX,
    y1: headerHeight,
    x2: splitX,
    y2: tableHeight,
    stroke: colors.splitStroke,
    strokeWidth: 1,
  };
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
 * Port groups for module nodes. Ports act as connection magnets only in
 * relationship mode; otherwise they stay hidden and non-magnetic.
 */
export function getModulePorts(
  relationshipMode: boolean,
): NonNullable<NodeMetadata["ports"]> {
  const magnet = {
    r: 6,
    magnet: relationshipMode,
    stroke: MODULE_TABLE_COLORS.headerFill,
    strokeWidth: 2,
    fill: "#ffffff",
    visibility: relationshipMode ? "visible" : "hidden",
  };
  return {
    groups: {
      in: { position: "left", attrs: { circle: magnet } },
      out: { position: "right", attrs: { circle: magnet } },
    },
  };
}

/**
 * Base X6 graph options for the sandbox canvas: a white surface, panning,
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
    background: { color: "#ffffff" },
    grid: false,
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
