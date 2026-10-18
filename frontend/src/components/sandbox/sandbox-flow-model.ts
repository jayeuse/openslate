import { Position, type Edge, type Node, type NodeHandle } from "@xyflow/react";

import {
  fieldsForModule,
  type SandboxCanvasLayout,
  type SandboxFieldType,
  type SandboxState,
} from "@/lib/sandbox/model";
import {
  departmentPosition,
  departmentSize,
  departmentTone,
  fitFrame,
  MODULE_TABLE,
  modulePosition,
  moduleTableHeight,
  type CanvasBox,
  type CanvasBoxes,
  type CanvasFeedback,
  type CanvasPosition,
} from "@/lib/sandbox/canvas-geometry";

/**
 * React Flow nodes for the Sandbox canvas. Departments are parent nodes and
 * modules their children, so a module's `position` is relative to its frame;
 * everything that leaves this module (the owner's layout, drop tests, the
 * view API) is absolute. Unchanged nodes keep their object identity, so
 * React Flow and the memoized node views skip them.
 */

export interface CanvasRow {
  id: string;
  name: string;
  type: SandboxFieldType;
  required: boolean;
}

export interface DepartmentNodeData extends Record<string, unknown> {
  name: string;
  moduleCount: number;
  tone: number;
  selected: boolean;
  feedback: CanvasFeedback;
}

export interface ModuleNodeData extends Record<string, unknown> {
  name: string;
  rows: readonly CanvasRow[];
  tone: number;
  selected: boolean;
  /** The selected field when it belongs to this module. */
  selectedFieldId: string | null;
  feedback: CanvasFeedback;
}

export type DepartmentFlowNode = Node<DepartmentNodeData, "department">;
export type ModuleFlowNode = Node<ModuleNodeData, "module">;
export type SandboxFlowNode = DepartmentFlowNode | ModuleFlowNode;

export interface RelationshipEdgeData extends Record<string, unknown> {
  label: string;
  handoff: boolean;
  selected: boolean;
}

export type RelationshipFlowEdge = Edge<RelationshipEdgeData, "relationship">;

function nodeSize(node: SandboxFlowNode): { width: number; height: number } {
  return { width: node.width ?? 0, height: node.height ?? 0 };
}

/** The connection points' size; they sit centered on the module's sides. */
export const PORT_SIZE = 12;

/**
 * Size and handle bounds stated up front, so React Flow draws lines on the
 * first frame without measuring, and a replaced node never loses its
 * handles. They equal what React Flow would measure from the DOM.
 */
function sized<T extends SandboxFlowNode>(
  node: T,
  width: number,
  height: number,
): T {
  return {
    ...node,
    width,
    height,
    measured: { width, height },
    ...(node.type === "module"
      ? { handles: moduleHandles(width, height) }
      : {}),
  };
}

function moduleHandles(width: number, height: number): NodeHandle[] {
  const y = height / 2 - PORT_SIZE / 2;
  return [
    {
      id: "in",
      type: "target",
      position: Position.Left,
      x: -PORT_SIZE / 2,
      y,
      width: PORT_SIZE,
      height: PORT_SIZE,
    },
    {
      id: "out",
      type: "source",
      position: Position.Right,
      x: width - PORT_SIZE / 2,
      y,
      width: PORT_SIZE,
      height: PORT_SIZE,
    },
  ];
}

/** Absolute boxes by node id. Parents come before children in the list. */
export function absoluteBoxes(
  nodes: readonly SandboxFlowNode[],
): Map<string, CanvasBox> {
  const boxes = new Map<string, CanvasBox>();
  for (const node of nodes) {
    const parent =
      node.parentId === undefined ? undefined : boxes.get(node.parentId);
    boxes.set(node.id, {
      x: node.position.x + (parent?.x ?? 0),
      y: node.position.y + (parent?.y ?? 0),
      ...nodeSize(node),
    });
  }
  return boxes;
}

/** The owner's layout form: every node's absolute box. */
export function readCanvasLayout(
  nodes: readonly SandboxFlowNode[],
): SandboxCanvasLayout {
  return Object.fromEntries(absoluteBoxes(nodes));
}

export function canvasBoxes(nodes: readonly SandboxFlowNode[]): CanvasBoxes {
  const boxes = absoluteBoxes(nodes);
  const departments: { id: string; box: CanvasBox }[] = [];
  const modules: { id: string; departmentId: string; box: CanvasBox }[] = [];
  for (const node of nodes) {
    const box = boxes.get(node.id);
    if (box === undefined) continue;
    if (node.type === "department") departments.push({ id: node.id, box });
    else if (node.parentId !== undefined)
      modules.push({ id: node.id, departmentId: node.parentId, box });
  }
  return { departments, modules };
}

function sameRows(a: readonly CanvasRow[], b: readonly CanvasRow[]): boolean {
  return (
    a.length === b.length &&
    a.every((row, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        row.id === other.id &&
        row.name === other.name &&
        row.type === other.type &&
        row.required === other.required
      );
    })
  );
}

function sameData(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) =>
      key === "rows"
        ? sameRows(a.rows as CanvasRow[], b.rows as CanvasRow[])
        : Object.is(a[key], b[key]),
    )
  );
}

/** The previous node when nothing about it changed, else the new one. */
function reuse<T extends SandboxFlowNode>(
  previous: SandboxFlowNode | undefined,
  next: T,
): T {
  if (
    previous !== undefined &&
    previous.type === next.type &&
    previous.parentId === next.parentId &&
    previous.position.x === next.position.x &&
    previous.position.y === next.position.y &&
    previous.width === next.width &&
    previous.height === next.height &&
    sameData(previous.data, next.data)
  ) {
    return previous as T;
  }
  return next;
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

// React Flow announces every node as a "node"; name them in the product's
// words. Shared objects keep unchanged nodes identical between renders.
const DEPARTMENT_ROLE = { "aria-roledescription": "department" } as const;
const MODULE_ROLE = { "aria-roledescription": "module" } as const;

export interface DeriveNodesInput {
  state: SandboxState;
  /** The nodes on screen now: the geometry truth for existing nodes. */
  previous: readonly SandboxFlowNode[];
  /** An owner layout to apply now (a new prop), else undefined. */
  layout?: SandboxCanvasLayout;
  /** Absolute positions queued for nodes that do not exist yet. */
  pending?: ReadonlyMap<string, CanvasPosition>;
  movingNodeId?: string | null;
  dropTargetId?: string | null;
}

/**
 * Reconcile the nodes with the structure. Existing nodes keep their geometry
 * unless `layout` is given; new nodes take a queued position or the default
 * one. While nothing moves, frames grow to hold their modules. Returns
 * `previous` itself when nothing changed.
 */
export function deriveFlowNodes({
  state,
  previous,
  layout,
  pending,
  movingNodeId = null,
  dropTargetId = null,
}: DeriveNodesInput): SandboxFlowNode[] {
  const shown = absoluteBoxes(previous);
  const previousById = new Map(previous.map((node) => [node.id, node]));
  const fieldsById = new Map(state.fields.map((field) => [field.id, field]));
  const selectedField =
    state.selectedCellId === null
      ? undefined
      : fieldsById.get(state.selectedCellId);
  const feedbackOf = (id: string): CanvasFeedback =>
    movingNodeId === id ? "moving" : dropTargetId === id ? "drop" : null;

  const frames = new Map<string, CanvasBox>();
  const members = new Map<string, { id: string; box: CanvasBox }[]>();
  const moduleNodes: {
    id: string;
    departmentId: string;
    data: ModuleNodeData;
  }[] = [];

  for (const [index, department] of state.departments.entries()) {
    const departmentModules = state.modules.filter(
      (sandboxModule) => sandboxModule.departmentId === department.id,
    );
    const heights = departmentModules.map((sandboxModule) =>
      moduleTableHeight(sandboxModule.fieldIds.length),
    );
    const known = layout?.[department.id] ?? shown.get(department.id);
    const frame: CanvasBox = known
      ? { x: known.x, y: known.y, width: known.width, height: known.height }
      : {
          ...(pending?.get(department.id) ?? departmentPosition(index)),
          ...departmentSize(heights),
        };
    frames.set(department.id, frame);
    const boxes: { id: string; box: CanvasBox }[] = [];
    for (const [moduleIndex, sandboxModule] of departmentModules.entries()) {
      const rows = fieldsForModule(
        sandboxModule.id,
        sandboxModule.fieldIds,
        fieldsById,
      ).map(({ id, name, type, required }) => ({ id, name, type, required }));
      const at =
        layout?.[sandboxModule.id] ??
        shown.get(sandboxModule.id) ??
        pending?.get(sandboxModule.id) ??
        modulePosition(frame, moduleIndex, heights);
      boxes.push({
        id: sandboxModule.id,
        box: {
          x: at.x,
          y: at.y,
          width: MODULE_TABLE.width,
          height: moduleTableHeight(rows.length),
        },
      });
      moduleNodes.push({
        id: sandboxModule.id,
        departmentId: department.id,
        data: {
          name: sandboxModule.name,
          rows,
          tone: departmentTone(index),
          selected: state.selectedCellId === sandboxModule.id,
          selectedFieldId:
            selectedField?.moduleId === sandboxModule.id
              ? selectedField.id
              : null,
          feedback: feedbackOf(sandboxModule.id),
        },
      });
    }
    members.set(department.id, boxes);
  }

  if (movingNodeId === null) {
    for (const [id, frame] of frames) {
      frames.set(
        id,
        fitFrame(
          frame,
          (members.get(id) ?? []).map((item) => item.box),
        ),
      );
    }
  }

  const next: SandboxFlowNode[] = [];
  for (const [index, department] of state.departments.entries()) {
    const frame = frames.get(department.id);
    if (frame === undefined) continue;
    next.push(
      reuse(
        previousById.get(department.id),
        sized(
          {
            id: department.id,
            type: "department",
            // A named group for assistive technology, not a focus stop.
            ariaRole: "group",
            ariaLabel: department.name,
            domAttributes: DEPARTMENT_ROLE,
            position: { x: frame.x, y: frame.y },
            data: {
              name: department.name,
              moduleCount: department.moduleIds.length,
              tone: departmentTone(index),
              selected: state.selectedCellId === department.id,
              feedback: feedbackOf(department.id),
            },
          } satisfies DepartmentFlowNode,
          frame.width,
          frame.height,
        ),
      ),
    );
  }
  for (const item of moduleNodes) {
    const frame = frames.get(item.departmentId);
    const box = members
      .get(item.departmentId)
      ?.find((member) => member.id === item.id)?.box;
    if (frame === undefined || box === undefined) continue;
    next.push(
      reuse(
        previousById.get(item.id),
        sized(
          {
            id: item.id,
            type: "module",
            ariaRole: "group",
            ariaLabel: item.data.name,
            domAttributes: MODULE_ROLE,
            parentId: item.departmentId,
            position: { x: box.x - frame.x, y: box.y - frame.y },
            data: item.data,
          } satisfies ModuleFlowNode,
          box.width,
          box.height,
        ),
      ),
    );
  }
  return sameList(next, previous) ? (previous as SandboxFlowNode[]) : next;
}

/**
 * Grow frames to hold their modules after a gesture. A frame that grows left
 * or up moves its origin; its modules' relative positions shift back by the
 * same amount, so no module moves on screen.
 */
export function fitFlowFrames(
  nodes: readonly SandboxFlowNode[],
): SandboxFlowNode[] {
  const boxes = absoluteBoxes(nodes);
  const shift = new Map<string, CanvasPosition>();
  const result = nodes.map((node) => {
    if (node.type !== "department") return node;
    const frame = boxes.get(node.id);
    if (frame === undefined) return node;
    const children = nodes.flatMap((child) => {
      const box = child.parentId === node.id ? boxes.get(child.id) : undefined;
      return box ? [box] : [];
    });
    const fitted = fitFrame(frame, children);
    if (
      fitted.x === frame.x &&
      fitted.y === frame.y &&
      fitted.width === frame.width &&
      fitted.height === frame.height
    )
      return node;
    shift.set(node.id, { x: frame.x - fitted.x, y: frame.y - fitted.y });
    return sized(
      { ...node, position: { x: fitted.x, y: fitted.y } },
      fitted.width,
      fitted.height,
    );
  });
  if (shift.size === 0)
    return result.some((node, index) => node !== nodes[index])
      ? result
      : (nodes as SandboxFlowNode[]);
  return result.map((node) => {
    const delta =
      node.parentId === undefined ? undefined : shift.get(node.parentId);
    if (delta === undefined || (delta.x === 0 && delta.y === 0)) return node;
    return {
      ...node,
      position: { x: node.position.x + delta.x, y: node.position.y + delta.y },
    };
  });
}

/** Move a module into another department without moving it on screen. */
export function reparentFlowNode(
  nodes: readonly SandboxFlowNode[],
  nodeId: string,
  parentId: string,
): SandboxFlowNode[] {
  const boxes = absoluteBoxes(nodes);
  const box = boxes.get(nodeId);
  const parent = boxes.get(parentId);
  if (box === undefined || parent === undefined) return [...nodes];
  return nodes.map((node) =>
    node.id === nodeId && node.type === "module"
      ? {
          ...node,
          parentId,
          position: { x: box.x - parent.x, y: box.y - parent.y },
        }
      : node,
  );
}

/** Place a node at an absolute position. */
export function placeFlowNode(
  nodes: readonly SandboxFlowNode[],
  nodeId: string,
  position: CanvasPosition,
): SandboxFlowNode[] {
  const boxes = absoluteBoxes(nodes);
  return nodes.map((node) => {
    if (node.id !== nodeId) return node;
    const parent =
      node.parentId === undefined ? undefined : boxes.get(node.parentId);
    return {
      ...node,
      position: {
        x: position.x - (parent?.x ?? 0),
        y: position.y - (parent?.y ?? 0),
      },
    };
  });
}

export function resizeFlowNode(
  nodes: readonly SandboxFlowNode[],
  nodeId: string,
  size: { width: number; height: number },
): SandboxFlowNode[] {
  return nodes.map((node) =>
    node.id === nodeId &&
    (node.width !== size.width || node.height !== size.height)
      ? sized(node, size.width, size.height)
      : node,
  );
}

const HIDDEN_FROM_ASSISTIVE_TECHNOLOGY = { "aria-hidden": "true" } as const;

/** The relationship lines, reusing unchanged edges. */
export function deriveFlowEdges(
  state: SandboxState,
  previous: readonly RelationshipFlowEdge[],
): RelationshipFlowEdge[] {
  const previousById = new Map(previous.map((edge) => [edge.id, edge]));
  const departmentOf = new Map(
    state.modules.map((item) => [item.id, item.departmentId]),
  );
  const next = state.links.flatMap((link): RelationshipFlowEdge[] => {
    if (
      !departmentOf.has(link.sourceModuleId) ||
      !departmentOf.has(link.targetModuleId)
    )
      return [];
    const data: RelationshipEdgeData = {
      label: link.label.trim(),
      handoff:
        departmentOf.get(link.sourceModuleId) !==
        departmentOf.get(link.targetModuleId),
      selected: state.selectedCellId === link.id,
    };
    const old = previousById.get(link.id);
    if (
      old !== undefined &&
      old.source === link.sourceModuleId &&
      old.target === link.targetModuleId &&
      old.data !== undefined &&
      sameData(old.data, data)
    )
      return [old];
    return [
      {
        id: link.id,
        type: "relationship",
        source: link.sourceModuleId,
        target: link.targetModuleId,
        sourceHandle: "out",
        targetHandle: "in",
        // Lines are a pointer aid; the Structure panel lists relationships.
        domAttributes: HIDDEN_FROM_ASSISTIVE_TECHNOLOGY,
        data,
      },
    ];
  });
  return sameList(next, previous) ? (previous as RelationshipFlowEdge[]) : next;
}
