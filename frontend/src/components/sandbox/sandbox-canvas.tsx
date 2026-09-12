"use client";

import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type MutableRefObject,
} from "react";

import {
  Graph,
  History,
  Selection,
  Snapline,
  Point,
  routerPresets,
  type Node,
} from "@antv/x6";

import {
  FIELD_TYPE_META,
  type SandboxField,
  type SandboxFieldType,
  type SandboxState,
  type UpdateSandboxFieldPatch,
} from "@/lib/sandbox/model";
import { canConnect } from "@/lib/sandbox/rules";
import {
  MODULE_TABLE,
  SANDBOX_GRID_MAJOR_SIZE,
  SANDBOX_GRID_SIZE,
  getModulePorts,
  graphOptions,
  relationshipLineAttrs,
  moduleTableAttrs,
  moduleTableHeight,
  moduleTableMarkup,
  snapSandboxPosition,
  toCells,
} from "@/lib/sandbox/x6-adapter";

export type SandboxCanvasLayout = Record<
  string,
  { x: number; y: number; width: number; height: number }
>;

export interface SandboxCanvasViewState {
  zoom: number;
  gridVisible: boolean;
  snapEnabled: boolean;
}

export interface SandboxCanvasApi {
  getLayout: () => SandboxCanvasLayout;
  getViewState: () => SandboxCanvasViewState;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  fit: () => void;
  center: () => void;
  /** Places a newly-created node, or queues its position until it is rendered. */
  placeNode: (nodeId: string, position: { x: number; y: number }) => void;
}

export type SandboxDropKind = "department" | "module" | "field";

export interface SandboxCanvasProps {
  state: SandboxState;
  /** Optional geometry owner; omitted preserves graph-local positioning. */
  layout?: SandboxCanvasLayout;
  /** Emits a full snapshot after a user geometry action settles, never on sync. */
  onLayoutChange?: (layout: SandboxCanvasLayout) => void;
  gridVisible?: boolean;
  snapEnabled?: boolean;
  onViewChange?: (view: SandboxCanvasViewState) => void;
  onSelect: (cellId: string | null) => void;
  onRenameDepartment: (departmentId: string, name: string) => void;
  onRenameModule: (moduleId: string, name: string) => void;
  onUpdateField: (fieldId: string, patch: UpdateSandboxFieldPatch) => void;
  onDrop: (
    kind: SandboxDropKind,
    parentId: string | null,
    fieldType?: SandboxFieldType,
    position?: { x: number; y: number },
  ) => void;
  onConnect: (sourceModuleId: string, targetModuleId: string) => void;
  onMove: (nodeId: string, parentId: string | null) => void;
  graphRef?: MutableRefObject<SandboxCanvasApi | null>;
}

interface SandboxCanvasRuntime {
  graph: Graph;
  history: History;
}

interface SandboxCanvasCallbacks {
  onLayoutChange?: SandboxCanvasProps["onLayoutChange"];
  onViewChange?: SandboxCanvasProps["onViewChange"];
  onSelect: (cellId: string | null) => void;
  onRenameDepartment: SandboxCanvasProps["onRenameDepartment"];
  onRenameModule: SandboxCanvasProps["onRenameModule"];
  onUpdateField: SandboxCanvasProps["onUpdateField"];
  onDrop: SandboxCanvasProps["onDrop"];
  onConnect: (sourceModuleId: string, targetModuleId: string) => void;
  onMove: (nodeId: string, parentId: string | null) => void;
}

const DROP_KINDS: readonly SandboxDropKind[] = [
  "department",
  "module",
  "field",
];

const FIELD_TYPES = Object.keys(FIELD_TYPE_META) as SandboxFieldType[];

const DEPARTMENT_WIDTH = 680;
const DEPARTMENT_COLUMN_WIDTH = 760;
const DEPARTMENT_ORIGIN = 48;
const MODULE_GUTTER = 32;
const MODULE_COLUMN_GAP = 80;
const MODULE_TOP_OFFSET = 56;
const MODULE_SIDE_OFFSET = 42;
const MODULE_COLUMNS = 2;

interface CanvasPosition {
  x: number;
  y: number;
}

type CanvasFeedback = "drop" | "moving" | null;

interface DropResolution {
  parentId: string | null;
  targetId: string | null;
  error: string | null;
}

const CANVAS_BACKGROUND =
  "var(--canvas-background, var(--background, #ffffff))";
const CANVAS_GRID = "var(--canvas-grid, #d8dde5)";
const CANVAS_GRID_MAJOR = "var(--canvas-grid-major, #bac3cf)";
const CANVAS_NODE_BORDER = "var(--sandbox-node-border, #a8b2c1)";
const CANVAS_NODE_TEXT = "var(--muted-foreground, #68707d)";
const CANVAS_NODE_SELECTED = "var(--accent, #f5f9ff)";
const CANVAS_NODE_ACTIVE = "var(--primary, #3b82f6)";
const CANVAS_NODE_MOVING = "var(--canvas-moving, #fff8eb)";

interface CanvasEditor {
  target: "department" | "module" | "field";
  property: "name" | "type";
  id: string;
  value: string;
  left: number;
  top: number;
  width: number;
}

function isDropKind(value: string): value is SandboxDropKind {
  return (DROP_KINDS as readonly string[]).includes(value);
}

function dragKindFromTransfer(
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

function isFieldType(value: string): value is SandboxFieldType {
  return (FIELD_TYPES as readonly string[]).includes(value);
}

function truncateLabel(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function departmentNodeAttrs(
  name: string,
  moduleCount: number,
  height: number,
  selected: boolean,
  feedback: CanvasFeedback,
) {
  const moving = feedback === "moving";
  const dropTarget = feedback === "drop";
  return {
    text: { refX: 0, refY: 0 },
    rect: { stroke: "none", strokeWidth: 0 },
    body: {
      "data-sandbox-body": "true",
      width: DEPARTMENT_WIDTH,
      height,
      fill: moving
        ? CANVAS_NODE_MOVING
        : dropTarget
          ? "var(--canvas-drop, #eff6ff)"
          : selected
            ? CANVAS_NODE_SELECTED
            : "var(--card, #e9edf2)",
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
    heading: {
      x: 12,
      y: 18,
      textAnchor: "start",
      textVerticalAnchor: "middle",
      fontSize: 11,
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
      fontSize: 10,
      fill: "var(--muted-foreground, #9aa1ac)",
      text: `${moduleCount} ${moduleCount === 1 ? "module" : "modules"}`,
    },
  };
}

/** Grow frames only as needed; never reflow or move their children. */
function fitDepartmentFrames(graph: Graph): void {
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

function updateDepartmentSizeAttrs(node: Node): void {
  const { width, height } = node.getSize();
  node.setAttrs({
    body: { width, height },
    subheading: { x: width - 12 },
    resizeGrip: { x: width - 24, y: height - 24 },
    resizeLines: {
      d: `M${width - 17} ${height - 7}l10 -10 M${width - 11} ${height - 7}l4 -4`,
    },
  });
}

function readLayout(graph: Graph): SandboxCanvasLayout {
  return Object.fromEntries(
    graph
      .getNodes()
      .map((node) => [node.id, { ...node.getPosition(), ...node.getSize() }]),
  );
}

function nodeKindOf(node: Node): string | null {
  const data = node.getData() as { kind?: unknown };
  return typeof data.kind === "string" ? data.kind : null;
}

function fieldsForModule(
  moduleId: string,
  fieldIds: string[],
  fieldsById: Map<string, SandboxField>,
): SandboxField[] {
  return fieldIds.flatMap((fieldId) => {
    const field = fieldsById.get(fieldId);
    return field !== undefined && field.moduleId === moduleId ? [field] : [];
  });
}

function departmentHeight(moduleHeights: number[]): number {
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

function departmentPosition(index: number): CanvasPosition {
  return {
    x: DEPARTMENT_ORIGIN + index * DEPARTMENT_COLUMN_WIDTH,
    y: DEPARTMENT_ORIGIN,
  };
}

function modulePosition(
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

function rowFieldAt(node: Node, y: number, state: SandboxState): string | null {
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

function selectNodeOrField(
  node: Node,
  y: number,
  state: SandboxState,
  callbacks: SandboxCanvasCallbacks,
): void {
  callbacks.onSelect(rowFieldAt(node, y, state) ?? node.id);
}

/**
 * Resolve a palette drop against the existing containment rules. The target
 * id is kept separate from the parent id so a valid drop can highlight the
 * object receiving the new child while the page receives the domain parent.
 */
function resolveDrop(
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

export function SandboxCanvas({
  state,
  layout,
  onLayoutChange,
  gridVisible = true,
  snapEnabled = true,
  onViewChange,
  onSelect,
  onRenameDepartment,
  onRenameModule,
  onUpdateField,
  onDrop,
  onConnect,
  onMove,
  graphRef,
}: SandboxCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<SandboxCanvasRuntime | null>(null);
  const pendingPositionsRef = useRef<Map<string, CanvasPosition>>(new Map());
  const freeMoveRef = useRef(false);
  const gridVisibleRef = useRef(gridVisible);
  const snapEnabledRef = useRef(snapEnabled);
  const syncingRef = useRef(false);
  const appliedLayoutRef = useRef<SandboxCanvasLayout | undefined>(undefined);
  const [editor, setEditor] = useState<CanvasEditor | null>(null);
  const editorRef = useRef<CanvasEditor | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const [paletteDragKind, setPaletteDragKind] =
    useState<SandboxDropKind | null>(null);
  const [movingNodeId, setMovingNodeId] = useState<string | null>(null);
  const callbacksRef = useRef<SandboxCanvasCallbacks>({
    onLayoutChange,
    onViewChange,
    onSelect,
    onRenameDepartment,
    onRenameModule,
    onUpdateField,
    onDrop,
    onConnect,
    onMove,
  });
  const stateRef = useRef(state);
  function closeEditor(): void {
    editorRef.current = null;
    setEditor(null);
  }

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);
  useEffect(() => {
    callbacksRef.current = {
      onLayoutChange,
      onViewChange,
      onSelect,
      onRenameDepartment,
      onRenameModule,
      onUpdateField,
      onDrop,
      onConnect,
      onMove,
    };
    stateRef.current = state;
  });
  useEffect(() => {
    gridVisibleRef.current = gridVisible;
    snapEnabledRef.current = snapEnabled;
    const graph = runtimeRef.current?.graph;
    if (graph === undefined) return;
    graph.setGridSize(snapEnabled ? SANDBOX_GRID_SIZE : 1);
    callbacksRef.current.onViewChange?.({
      zoom: graph.zoom(),
      gridVisible,
      snapEnabled,
    });
  }, [gridVisible, snapEnabled]);
  // Single Graph owner: create once, dispose on unmount (StrictMode-safe).
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    const graph = new Graph({ container, ...graphOptions() });
    graph.use(new Selection({ enabled: true }));
    graph.use(new Snapline());
    const history = new History();
    graph.use(history);
    runtimeRef.current = { graph, history };
    appliedLayoutRef.current = undefined;
    const emitLayout = (): void => {
      if (syncingRef.current || !callbacksRef.current.onLayoutChange) return;
      const enabled = history.isEnabled();
      history.disable();
      fitDepartmentFrames(graph);
      if (enabled) history.enable();
      const next = readLayout(graph);
      const previous = appliedLayoutRef.current;
      if (
        previous &&
        Object.keys(next).length === Object.keys(previous).length &&
        Object.entries(next).every(([id, box]) => {
          const before = previous[id];
          return (
            before &&
            before.x === box.x &&
            before.y === box.y &&
            before.width === box.width &&
            before.height === box.height
          );
        })
      )
        return;
      appliedLayoutRef.current = next;
      callbacksRef.current.onLayoutChange(next);
    };

    const emitViewState = (): void => {
      callbacksRef.current.onViewChange?.({
        zoom: graph.zoom(),
        gridVisible: gridVisibleRef.current,
        snapEnabled: snapEnabledRef.current,
      });
    };
    const updateGridVisual = (): void => {
      const grid = gridRef.current;
      if (grid === null) {
        return;
      }
      const matrix = graph.matrix();
      const scaleX = Math.abs(matrix.a || 1);
      const scaleY = Math.abs(matrix.d || 1);
      const offsetX = matrix.e || 0;
      const offsetY = matrix.f || 0;
      grid.style.backgroundSize = [
        `${SANDBOX_GRID_SIZE * scaleX}px ${SANDBOX_GRID_SIZE * scaleY}px`,
        `${SANDBOX_GRID_SIZE * scaleX}px ${SANDBOX_GRID_SIZE * scaleY}px`,
        `${SANDBOX_GRID_MAJOR_SIZE * scaleX}px ${SANDBOX_GRID_MAJOR_SIZE * scaleY}px`,
        `${SANDBOX_GRID_MAJOR_SIZE * scaleX}px ${SANDBOX_GRID_MAJOR_SIZE * scaleY}px`,
      ].join(", ");
      grid.style.backgroundPosition = [
        `${offsetX}px ${offsetY}px`,
        `${offsetX}px ${offsetY}px`,
        `${offsetX}px ${offsetY}px`,
        `${offsetX}px ${offsetY}px`,
      ].join(", ");
      grid.dataset.scale = `${scaleX}`;
      grid.dataset.translate = `${offsetX},${offsetY}`;
    };
    updateGridVisual();
    emitViewState();
    const updateScale = (): void => {
      updateGridVisual();
      emitViewState();
    };
    graph.on("scale", updateScale);
    graph.on("translate", updateGridVisual);

    const updateDragSnap = (freeMove: boolean): void => {
      if (freeMoveRef.current === freeMove) {
        return;
      }
      freeMoveRef.current = freeMove;
      graph.setGridSize(
        freeMove || !snapEnabledRef.current ? 1 : SANDBOX_GRID_SIZE,
      );
    };

    // Set precision before X6 normalizes the initial pointer coordinates.
    const preparePointer = (event: MouseEvent): void =>
      updateDragSnap(event.altKey);
    const updateModifier = (event: KeyboardEvent): void =>
      updateDragSnap(event.altKey);
    container.addEventListener("mousedown", preparePointer, true);
    window.addEventListener("keydown", updateModifier);
    window.addEventListener("keyup", updateModifier);

    const restoreCanonicalParent = (node: Node): void => {
      const sandboxModule = stateRef.current.modules.find(
        (item) => item.id === node.id,
      );
      if (sandboxModule === undefined) {
        return;
      }
      const canonicalParent = graph.getCellById(sandboxModule.departmentId);
      if (canonicalParent === null || !canonicalParent.isNode()) {
        return;
      }
      if (node.getParent()?.id === canonicalParent.id) {
        return;
      }
      const historyWasEnabled = history.isEnabled();
      history.disable();
      try {
        const position = node.getPosition();
        canonicalParent.addChild(node, { ui: true });
        node.setPosition(position, { ui: true });
      } finally {
        if (historyWasEnabled) {
          history.enable();
        }
      }
    };

    const editorAnchor = (
      node: Node,
      property: "name" | "type",
      rowIndex?: number,
    ): Pick<CanvasEditor, "left" | "top" | "width"> => {
      const box = node.getBBox();
      const isField = rowIndex !== undefined;
      const x = isField
        ? box.x + (property === "type" ? MODULE_TABLE.splitX + 3 : 5)
        : box.x + 5;
      const y = isField
        ? box.y +
          MODULE_TABLE.headerHeight +
          rowIndex * MODULE_TABLE.rowHeight +
          2
        : box.y + (nodeKindOf(node) === "department" ? 5 : 3);
      const width = isField
        ? property === "type"
          ? MODULE_TABLE.width - MODULE_TABLE.splitX - 8
          : MODULE_TABLE.splitX - 10
        : nodeKindOf(node) === "department"
          ? 250
          : MODULE_TABLE.width - 10;
      const clientPoint = graph.localToClient(x, y);
      const bounds = container.getBoundingClientRect();
      return {
        left: Math.max(4, clientPoint.x - bounds.left),
        top: Math.max(4, clientPoint.y - bounds.top),
        width,
      };
    };

    const openEditorFor = (
      node: Node,
      target: CanvasEditor["target"],
      id: string,
      property: CanvasEditor["property"],
      rowIndex?: number,
    ): void => {
      if (editorRef.current !== null) {
        return;
      }
      const currentState = stateRef.current;
      const value =
        target === "department"
          ? currentState.departments.find((item) => item.id === id)?.name
          : target === "module"
            ? currentState.modules.find((item) => item.id === id)?.name
            : currentState.fields.find((item) => item.id === id)?.[property];
      if (typeof value !== "string") {
        return;
      }
      callbacksRef.current.onSelect(id);
      const nextEditor: CanvasEditor = {
        target,
        property,
        id,
        value,
        ...editorAnchor(node, property, rowIndex),
      };
      editorRef.current = nextEditor;
      setEditor(nextEditor);
    };

    const openEditorForSelection = (cellId: string): void => {
      const currentState = stateRef.current;
      const department = currentState.departments.find(
        (item) => item.id === cellId,
      );
      if (department !== undefined) {
        const node = graph.getCellById(cellId);
        if (node !== null && node.isNode()) {
          openEditorFor(node, "department", cellId, "name");
        }
        return;
      }
      const sandboxModule = currentState.modules.find(
        (item) => item.id === cellId,
      );
      if (sandboxModule !== undefined) {
        const node = graph.getCellById(cellId);
        if (node !== null && node.isNode()) {
          openEditorFor(node, "module", cellId, "name");
        }
        return;
      }
      const field = currentState.fields.find((item) => item.id === cellId);
      if (field === undefined) {
        return;
      }
      const sandboxModuleForField = currentState.modules.find(
        (item) => item.id === field.moduleId,
      );
      const node = graph.getCellById(field.moduleId);
      const rowIndex = sandboxModuleForField?.fieldIds.indexOf(field.id) ?? -1;
      if (node !== null && node.isNode() && rowIndex >= 0) {
        openEditorFor(node, "field", field.id, "name", rowIndex);
      }
    };

    if (graphRef) {
      graphRef.current = {
        getLayout: () => readLayout(graph),
        getViewState: () => ({
          zoom: graph.zoom(),
          gridVisible: gridVisibleRef.current,
          snapEnabled: snapEnabledRef.current,
        }),
        zoomIn: () => {
          graph.zoom(0.1, { minScale: 0.25, maxScale: 2 });
        },
        zoomOut: () => {
          graph.zoom(-0.1, { minScale: 0.25, maxScale: 2 });
        },
        resetZoom: () => {
          graph.zoom(1, { absolute: true });
        },
        fit: () => {
          graph.zoomToFit({ padding: 24, maxScale: 1 });
        },
        center: () => {
          graph.centerContent();
        },
        placeNode: (nodeId, position) => {
          const snappedPosition = position;
          const cell = graph.getCellById(nodeId);
          if (cell !== null && cell.isNode()) {
            cell.setPosition(snappedPosition);
            emitLayout();
            return;
          }
          pendingPositionsRef.current.set(nodeId, snappedPosition);
        },
      };
    }

    let connectingPorts = false;
    const portSelected = (node: Node): boolean =>
      stateRef.current.selectedCellId === node.id ||
      stateRef.current.fields.some(
        (field) =>
          field.moduleId === node.id &&
          field.id === stateRef.current.selectedCellId,
      );
    const revealPorts = (node: Node, visible: boolean): void => {
      const enabled = history.isEnabled();
      history.disable();
      try {
        for (const port of node.getPorts()) {
          if (port.id !== undefined)
            node.setPortProp(
              port.id,
              ["attrs", "circle", "opacity"],
              visible ? 1 : 0,
            );
        }
      } finally {
        if (enabled) history.enable();
      }
    };
    const beginConnection = (event: PointerEvent): void => {
      if (
        !(event.target instanceof Element) ||
        event.target.closest('[magnet="true"]') === null
      )
        return;
      connectingPorts = true;
      for (const node of graph.getNodes()) revealPorts(node, true);
    };
    const endConnection = (): void => {
      if (!connectingPorts) return;
      connectingPorts = false;
      for (const node of graph.getNodes())
        revealPorts(node, portSelected(node));
    };
    container.addEventListener("pointerdown", beginConnection, true);
    window.addEventListener("pointerup", endConnection);
    window.addEventListener("pointercancel", endConnection);
    graph.on("node:mouseenter", ({ node }) => revealPorts(node, true));
    graph.on("node:mouseleave", ({ node }) =>
      revealPorts(node, connectingPorts || portSelected(node)),
    );

    let resizeGesture: {
      node: Node;
      pointerId: number;
      startX: number;
      startY: number;
      width: number;
      height: number;
    } | null = null;
    const resizeDepartment = (
      node: Node,
      width: number,
      height: number,
      free: boolean,
    ): void => {
      const origin = node.getPosition();
      const boxes = (node.getChildren() ?? []).flatMap((child) =>
        child.isNode() ? [child.getBBox()] : [],
      );
      const minimumWidth = Math.max(
        336,
        ...boxes.map((box) => box.right - origin.x + 24),
      );
      const minimumHeight = Math.max(
        144,
        ...boxes.map((box) => box.bottom - origin.y + 24),
      );
      node.setSize(
        Math.max(
          minimumWidth,
          free
            ? width
            : Math.round(width / SANDBOX_GRID_SIZE) * SANDBOX_GRID_SIZE,
        ),
        Math.max(
          minimumHeight,
          free
            ? height
            : Math.round(height / SANDBOX_GRID_SIZE) * SANDBOX_GRID_SIZE,
        ),
      );
    };
    const refreshSize = ({ node }: { node: Node }): void => {
      if (nodeKindOf(node) !== "department") return;
      const enabled = history.isEnabled();
      history.disable();
      updateDepartmentSizeAttrs(node);
      if (enabled) history.enable();
    };
    graph.on("node:change:size", refreshSize);
    const resizePointerDown = (event: PointerEvent): void => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest("[data-department-resize]")
      )
        return;
      const view = graph.findViewByElem(event.target);
      if (!view?.cell.isNode() || nodeKindOf(view.cell) !== "department")
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const point = graph.clientToLocal(event.clientX, event.clientY);
      resizeGesture = {
        node: view.cell,
        pointerId: event.pointerId,
        startX: point.x,
        startY: point.y,
        ...view.cell.getSize(),
      };
      graph.startBatch("department-resize");
      event.target.setPointerCapture(event.pointerId);
      (event.target as SVGElement).focus();
    };
    const resizePointerMove = (event: PointerEvent): void => {
      if (!resizeGesture || resizeGesture.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const point = graph.clientToLocal(event.clientX, event.clientY);
      resizeDepartment(
        resizeGesture.node,
        resizeGesture.width + point.x - resizeGesture.startX,
        resizeGesture.height + point.y - resizeGesture.startY,
        event.altKey,
      );
    };
    const resizePointerEnd = (event: PointerEvent): void => {
      if (!resizeGesture || resizeGesture.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "pointercancel")
        resizeGesture.node.setSize(resizeGesture.width, resizeGesture.height);
      resizeGesture = null;
      graph.stopBatch("department-resize");
      emitLayout();
    };
    const resizeKeyDown = (event: KeyboardEvent): void => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest("[data-department-resize]")
      )
        return;
      if (
        !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      )
        return;
      const view = graph.findViewByElem(event.target);
      if (!view?.cell.isNode()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const size = view.cell.getSize();
      const step =
        event.altKey || !snapEnabledRef.current ? 1 : SANDBOX_GRID_SIZE;
      resizeDepartment(
        view.cell,
        size.width +
          (event.key === "ArrowRight"
            ? step
            : event.key === "ArrowLeft"
              ? -step
              : 0),
        size.height +
          (event.key === "ArrowDown"
            ? step
            : event.key === "ArrowUp"
              ? -step
              : 0),
        // Keyboard deltas are exact; only pointer resizing snaps to the grid.
        true,
      );
      emitLayout();
    };
    const swallowResizeMouse = (event: MouseEvent): void => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-department-resize]")
      ) {
        event.stopImmediatePropagation();
      }
    };
    container.addEventListener("pointerdown", resizePointerDown, true);
    window.addEventListener("pointermove", resizePointerMove, true);
    window.addEventListener("pointerup", resizePointerEnd, true);
    window.addEventListener("pointercancel", resizePointerEnd, true);
    container.addEventListener("keydown", resizeKeyDown, true);
    container.addEventListener("mousedown", swallowResizeMouse, true);
    container.addEventListener("click", swallowResizeMouse, true);
    container.addEventListener("dblclick", swallowResizeMouse, true);
    const feedbackTimers = new Map<Element, ReturnType<typeof setTimeout>>();
    const showPressed = (element: Element): void => {
      clearTimeout(feedbackTimers.get(element));
      element.setAttribute("data-sandbox-pressed", "true");
      feedbackTimers.set(
        element,
        setTimeout(() => {
          element.removeAttribute("data-sandbox-pressed");
          feedbackTimers.delete(element);
        }, 160),
      );
    };
    graph.on("cell:click", ({ view }) => showPressed(view.container));

    graph.on("node:click", ({ node, y }) => {
      container.focus({ preventScroll: true });
      selectNodeOrField(node, y, stateRef.current, callbacksRef.current);
    });
    graph.on("node:dblclick", (event) => {
      const { node, view, x, y } = event;
      const selector =
        event.e.target instanceof Element
          ? view.getSelector(event.e.target)
          : undefined;
      const kind = nodeKindOf(node);
      event.e.preventDefault();
      event.e.stopPropagation();
      if (kind === "department") {
        // X6's view selector is a CSS path (for example `> text:nth-child(2)`)
        // rather than the markup selector name. Use the heading's graph-space
        // band as the stable fallback for SVG text hit-testing.
        if (y - node.getBBox().y <= 36) {
          openEditorFor(node, "department", node.id, "name");
        }
        return;
      }
      if (kind !== "module") {
        return;
      }
      if (
        selector === "headerTitle" ||
        y - node.getBBox().y < MODULE_TABLE.headerHeight
      ) {
        openEditorFor(node, "module", node.id, "name");
        return;
      }
      const fieldId = rowFieldAt(node, y, stateRef.current);
      if (fieldId === null) {
        return;
      }
      const rowIndex = stateRef.current.modules
        .find((item) => item.id === node.id)
        ?.fieldIds.indexOf(fieldId);
      if (rowIndex === undefined || rowIndex < 0) {
        return;
      }
      const isTypeCell =
        selector?.startsWith("type") === true ||
        x - node.getBBox().x >= MODULE_TABLE.splitX;
      openEditorFor(
        node,
        "field",
        fieldId,
        isTypeCell ? "type" : "name",
        rowIndex,
      );
    });
    graph.on("edge:click", ({ edge }) => {
      callbacksRef.current.onSelect(edge.id);
    });
    graph.on("blank:click", () => {
      container.focus({ preventScroll: true });
      callbacksRef.current.onSelect(null);
    });
    graph.on("node:mousedown", ({ e }) => {
      // X6's built-in node translator consults graph.getGridSize() for each
      // pointer move. Temporarily switching it to one lets Alt/Option opt
      // out of snapping while the independent visual grid stays unchanged.
      updateDragSnap(e.altKey);
    });
    graph.on("node:mouseup", () => {
      updateDragSnap(false);
    });
    graph.on("node:moving", ({ node, e }) => {
      if (e.altKey !== freeMoveRef.current) {
        updateDragSnap(e.altKey);
      }
      setMovingNodeId(node.id);
    });
    graph.on("node:embedding", ({ node, candidateParent }) => {
      if (
        nodeKindOf(node) === "module" &&
        candidateParent !== null &&
        nodeKindOf(candidateParent) === "department"
      ) {
        setDropTargetId(candidateParent.id);
      } else {
        setDropTargetId(null);
      }
    });
    graph.on("node:moved", ({ node }) => {
      updateDragSnap(false);
      setMovingNodeId(null);
      setDropTargetId(null);
      if (syncingRef.current) return;
      if (nodeKindOf(node) !== "module") {
        emitLayout();
        return;
      }
      const currentParent = node.getParent();
      const sandboxModule = stateRef.current.modules.find(
        (item) => item.id === node.id,
      );
      if (sandboxModule === undefined) {
        return;
      }
      if (
        currentParent !== null &&
        currentParent.isNode() &&
        nodeKindOf(currentParent) === "department"
      ) {
        if (currentParent.id !== sandboxModule.departmentId) {
          callbacksRef.current.onMove(node.id, currentParent.id);
        }
        emitLayout();
        return;
      }
      // X6 removes a module from its department on a blank drop but emits no
      // `node:embedded` event. Restore the canonical parent without adding a
      // second history entry, preserving the exact dragged coordinates.
      restoreCanonicalParent(node);
      emitLayout();
    });
    graph.on("edge:connected", ({ edge, isNew }) => {
      if (!isNew || syncingRef.current) {
        return;
      }
      const sourceId = edge.getSourceCellId();
      const targetId = edge.getTargetCellId();
      if (sourceId === "" || targetId === "") {
        edge.remove();
        return;
      }
      const verdict = canConnect(sourceId, targetId, stateRef.current);
      if (!verdict.ok) {
        edge.remove();
        return;
      }
      callbacksRef.current.onConnect(sourceId, targetId);
      // The parent re-adds the canonical link edge through state sync.
      edge.remove();
    });

    // X6 writes a fixed pixel size onto its container. Observe the flexible
    // canvas frame, otherwise expanding panels leaves the graph at its old size.
    const canvasFrame = container.parentElement ?? container;
    const observer = new ResizeObserver(() => {
      graph.resize(canvasFrame.clientWidth, canvasFrame.clientHeight);
    });
    observer.observe(canvasFrame);

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "F2") {
        if (
          editorRef.current === null &&
          stateRef.current.selectedCellId !== null
        ) {
          event.preventDefault();
          openEditorForSelection(stateRef.current.selectedCellId);
        }
        return;
      }
      if (
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      ) {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest("[data-field-id]") !== null) return;
        const selectedId = stateRef.current.selectedCellId;
        if (selectedId === null) return;
        const node = graph.getCellById(selectedId);
        if (node === null || !node.isNode()) return;
        const kind = nodeKindOf(node);
        if (kind !== "department" && kind !== "module") return;
        event.preventDefault();
        const step =
          event.altKey || !snapEnabledRef.current ? 1 : SANDBOX_GRID_SIZE;
        node.translate(
          event.key === "ArrowRight"
            ? step
            : event.key === "ArrowLeft"
              ? -step
              : 0,
          event.key === "ArrowDown"
            ? step
            : event.key === "ArrowUp"
              ? -step
              : 0,
          { ui: true },
        );
        emitLayout();
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const view = graph.findViewByElem(target);
      if (!view || !view.cell.isNode()) {
        return;
      }
      event.preventDefault();
      const fieldId = target.getAttribute("data-field-id");
      if (fieldId) {
        callbacksRef.current.onSelect(fieldId);
        return;
      }
      const selector = view.getSelector(target);
      if (typeof selector === "string" && selector.startsWith("row")) {
        const index = Number(selector.slice(3));
        const sandboxModule = stateRef.current.modules.find(
          (item) => item.id === view.cell.id,
        );
        const fieldId = sandboxModule?.fieldIds[index];
        if (fieldId !== undefined) {
          callbacksRef.current.onSelect(fieldId);
          return;
        }
      }
      callbacksRef.current.onSelect(view.cell.id);
    };
    container.addEventListener("keydown", handleKeyDown);

    return () => {
      observer.disconnect();
      for (const timer of feedbackTimers.values()) clearTimeout(timer);
      container.removeEventListener("pointerdown", resizePointerDown, true);
      window.removeEventListener("pointermove", resizePointerMove, true);
      window.removeEventListener("pointerup", resizePointerEnd, true);
      window.removeEventListener("pointercancel", resizePointerEnd, true);
      container.removeEventListener("keydown", resizeKeyDown, true);
      container.removeEventListener("mousedown", swallowResizeMouse, true);
      container.removeEventListener("click", swallowResizeMouse, true);
      container.removeEventListener("dblclick", swallowResizeMouse, true);
      container.removeEventListener("pointerdown", beginConnection, true);
      window.removeEventListener("pointerup", endConnection);
      window.removeEventListener("pointercancel", endConnection);
      container.removeEventListener("mousedown", preparePointer, true);
      window.removeEventListener("keydown", updateModifier);
      window.removeEventListener("keyup", updateModifier);
      container.removeEventListener("keydown", handleKeyDown);
      syncingRef.current = false;
      runtimeRef.current = null;
      if (graphRef) {
        graphRef.current = null;
      }
      graph.dispose();
    };
  }, [graphRef]);

  // Synchronize descriptors by id. Positions live in the X6 graph for this
  // session, so a rename, field update, or selection change never lays nodes
  // out again or clears the movement history.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (runtime === null) {
      return;
    }
    const { graph, history } = runtime;
    const fieldsById = new Map(state.fields.map((field) => [field.id, field]));

    syncingRef.current = true;
    history.disable();
    try {
      graph.options.interacting = { edgeLabelMovable: false };

      const descriptors = toCells(state);
      const descriptorIds = new Set(descriptors.map((cell) => cell.id));
      for (const edge of graph.getEdges()) {
        if (!descriptorIds.has(edge.id)) {
          edge.remove();
        }
      }
      for (const node of graph.getNodes()) {
        if (!descriptorIds.has(node.id)) {
          node.remove();
        }
      }

      const departmentNodes = new Map<string, Node>();
      const moduleNodes = new Map<string, Node>();
      for (const [index, department] of state.departments.entries()) {
        const departmentModules = state.modules.filter(
          (sandboxModule) => sandboxModule.departmentId === department.id,
        );
        const moduleHeights = departmentModules.map((sandboxModule) =>
          moduleTableHeight(sandboxModule.fieldIds.length),
        );
        const height =
          departmentModules.length === 0
            ? 144
            : departmentHeight(moduleHeights);
        const departmentFeedback: CanvasFeedback =
          movingNodeId === department.id
            ? "moving"
            : dropTargetId === department.id
              ? "drop"
              : null;
        const departmentSelected = state.selectedCellId === department.id;
        const departmentAttrs = departmentNodeAttrs(
          department.name,
          department.moduleIds.length,
          height,
          departmentSelected,
          departmentFeedback,
        );
        const existing = graph.getCellById(department.id);
        const departmentNode =
          existing !== null && existing.isNode()
            ? existing
            : graph.addNode({
                id: department.id,
                shape: "rect",
                ...(pendingPositionsRef.current.get(department.id) ??
                  departmentPosition(index)),
                width: departmentModules.length === 0 ? 336 : DEPARTMENT_WIDTH,
                height,
                markup: [
                  { tagName: "rect", selector: "body" },
                  { tagName: "text", selector: "heading" },
                  { tagName: "text", selector: "subheading" },
                  { tagName: "rect", selector: "resizeGrip" },
                  { tagName: "path", selector: "resizeLines" },
                ],
                attrs: departmentAttrs,
                data: { kind: "department", departmentId: department.id },
              });

        if (existing !== null && !existing.isNode()) {
          existing.remove();
        }
        pendingPositionsRef.current.delete(department.id);

        const frameSize = departmentNode.getSize();
        departmentNode.setAttrs({
          ...departmentAttrs,
          body: { ...departmentAttrs.body, ...frameSize },
          subheading: {
            ...departmentAttrs.subheading,
            x: frameSize.width - 12,
          },
        });
        departmentNode.setData({
          kind: "department",
          departmentId: department.id,
        });
        departmentNodes.set(department.id, departmentNode);
      }

      for (const department of state.departments) {
        const departmentNode = departmentNodes.get(department.id);
        if (departmentNode === undefined) {
          continue;
        }
        const departmentModules = state.modules.filter(
          (sandboxModule) => sandboxModule.departmentId === department.id,
        );
        for (const [index, sandboxModule] of departmentModules.entries()) {
          const moduleFields = fieldsForModule(
            sandboxModule.id,
            sandboxModule.fieldIds,
            fieldsById,
          );
          const moduleHeight = moduleTableHeight(moduleFields.length);
          const existing = graph.getCellById(sandboxModule.id);
          let moduleNode: Node;
          if (existing !== null && existing.isNode()) {
            moduleNode = existing;
          } else {
            if (existing !== null) {
              existing.remove();
            }
            const pendingPosition = pendingPositionsRef.current.get(
              sandboxModule.id,
            );
            moduleNode = graph.addNode({
              id: sandboxModule.id,
              shape: "rect",
              ...(pendingPosition ??
                modulePosition(
                  departmentNode,
                  index,
                  departmentModules.map((item) =>
                    moduleTableHeight(item.fieldIds.length),
                  ),
                )),
              width: MODULE_TABLE.width,
              height: moduleHeight,
              markup: moduleTableMarkup(moduleFields.length),
              attrs: moduleTableAttrs(
                sandboxModule.name,
                moduleFields,
                state.selectedCellId,
                state.selectedCellId === sandboxModule.id,
                movingNodeId === sandboxModule.id
                  ? "moving"
                  : dropTargetId === sandboxModule.id
                    ? "drop"
                    : null,
              ),
              ports: {
                ...getModulePorts(state.selectedCellId === sandboxModule.id),
                items: [
                  { id: `${sandboxModule.id}-in`, group: "in" },
                  { id: `${sandboxModule.id}-out`, group: "out" },
                ],
              },
              data: {
                kind: "module",
                moduleId: sandboxModule.id,
                departmentId: sandboxModule.departmentId,
              },
            });
            pendingPositionsRef.current.delete(sandboxModule.id);
          }

          const parent = moduleNode.getParent();
          if (parent?.id !== departmentNode.id) {
            const position = moduleNode.getPosition();
            departmentNode.addChild(moduleNode, { ui: true });
            moduleNode.setPosition(position);
          }
          moduleNode.setSize(MODULE_TABLE.width, moduleHeight);
          moduleNode.setMarkup(moduleTableMarkup(moduleFields.length));
          moduleNode.setAttrs(
            moduleTableAttrs(
              sandboxModule.name,
              moduleFields,
              state.selectedCellId,
              state.selectedCellId === sandboxModule.id,
              movingNodeId === sandboxModule.id
                ? "moving"
                : dropTargetId === sandboxModule.id
                  ? "drop"
                  : null,
            ),
          );
          moduleNode.setData({
            kind: "module",
            moduleId: sandboxModule.id,
            departmentId: sandboxModule.departmentId,
          });
          for (const portId of [
            `${sandboxModule.id}-in`,
            `${sandboxModule.id}-out`,
          ]) {
            if (!moduleNode.hasPort(portId)) {
              moduleNode.addPort({
                id: portId,
                group: portId.endsWith("-in") ? "in" : "out",
              });
            }
            moduleNode.setPortProp(portId, ["attrs", "circle", "magnet"], true);
            moduleNode.setPortProp(
              portId,
              ["attrs", "circle", "opacity"],
              state.selectedCellId === sandboxModule.id ||
                moduleFields.some((field) => field.id === state.selectedCellId)
                ? 1
                : 0,
            );
          }
          moduleNodes.set(sandboxModule.id, moduleNode);
        }
      }

      // Apply external restores once. Selection/rename and in-flight drag
      // feedback must never reset a node to the last persisted coordinates.
      if (layout !== undefined && layout !== appliedLayoutRef.current) {
        for (const [id, box] of Object.entries(layout)) {
          const node = graph.getCellById(id);
          if (!node?.isNode()) continue;
          // Child positions are absolute, so restore frames without translating children.
          node.setPosition(box.x, box.y, { deep: false });
          if (nodeKindOf(node) === "department")
            node.setSize(box.width, box.height);
        }
        appliedLayoutRef.current = layout;
      }
      if (movingNodeId === null) fitDepartmentFrames(graph);

      for (const link of state.links) {
        const sourceNode = moduleNodes.get(link.sourceModuleId);
        const targetNode = moduleNodes.get(link.targetModuleId);
        if (sourceNode === undefined || targetNode === undefined) {
          continue;
        }
        const relationshipRouter = {
          name: "manhattan",
          args: {
            // A 24px halo on both cards closes the compact 48px corridor.
            padding: 12,
            startDirections: ["right"],
            endDirections: ["left"],
            excludeNodes: state.departments.map((department) => department.id),
            // Overlapping cards have no obstacle-free route. X6's route-level
            // fallback handles that normal editing state before its warning.
            fallbackRoute: () => {
              const view = graph.findViewByCell(link.id);
              if (!view?.isEdgeView()) return [];
              return routerPresets.orth
                .call(view, [], { padding: 12 }, view)
                .map((point) => Point.create(point));
            },
          },
        };
        const source = {
          cell: link.sourceModuleId,
          port: `${link.sourceModuleId}-out`,
        };
        const target = {
          cell: link.targetModuleId,
          port: `${link.targetModuleId}-in`,
        };
        const linkAttrs = {
          line: relationshipLineAttrs(state.selectedCellId === link.id),
        };
        const linkLabels =
          link.label.trim() === ""
            ? []
            : [
                {
                  markup: [
                    { tagName: "rect", selector: "body" },
                    { tagName: "text", selector: "label" },
                  ],
                  attrs: {
                    label: {
                      fontSize: 10,
                      fill: "var(--card-foreground, #20242c)",
                      pointerEvents: "none",
                      text: link.label,
                    },
                    body: {
                      ref: "label",
                      fill: "var(--card, #ffffff)",
                      stroke: "var(--border, #e4e7ec)",
                      strokeWidth: 1,
                      rx: 3,
                      ry: 3,
                      refWidth: 10,
                      refHeight: 6,
                      refX: -5,
                      refY: -3,
                    },
                  },
                },
              ];
        const existing = graph.getCellById(link.id);
        const edge =
          existing !== null && existing.isEdge()
            ? existing
            : graph.addEdge({
                id: link.id,
                source,
                target,
                router: relationshipRouter,
                connector: { name: "normal" },
                attrs: linkAttrs,
                labels: linkLabels,
                data: { kind: "link", linkId: link.id },
              });
        if (existing !== null && !existing.isEdge()) {
          existing.remove();
        }
        edge.setSource(source);
        edge.setTarget(target);
        edge.setRouter(relationshipRouter);
        edge.setConnector({ name: "normal" });
        edge.setAttrs(linkAttrs);
        edge.setLabels(linkLabels);
        edge.setData({ kind: "link", linkId: link.id });
      }

      graph.cleanSelection();
      if (state.selectedCellId === null) {
        graph.cleanSelection();
      } else {
        const selectedField = fieldsById.get(state.selectedCellId);
        const selectedId = selectedField?.moduleId ?? state.selectedCellId;
        if (graph.getCellById(selectedId) !== null) {
          graph.select(selectedId);
        }
      }
    } finally {
      history.enable();
      syncingRef.current = false;
    }
  }, [dropTargetId, layout, movingNodeId, state]);

  function commitEditor(value: string): void {
    const activeEditor = editorRef.current;
    if (activeEditor === null) {
      return;
    }
    const nextValue = value.trim();
    if (nextValue === "") {
      return;
    }
    if (activeEditor.property === "type") {
      if (!isFieldType(nextValue)) {
        return;
      }
      callbacksRef.current.onUpdateField(activeEditor.id, {
        type: nextValue,
      });
    } else if (activeEditor.target === "department") {
      callbacksRef.current.onRenameDepartment(activeEditor.id, nextValue);
    } else if (activeEditor.target === "module") {
      callbacksRef.current.onRenameModule(activeEditor.id, nextValue);
    } else {
      callbacksRef.current.onUpdateField(activeEditor.id, { name: nextValue });
    }
    closeEditor();
  }

  function handleCanvasDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setPaletteDragKind(null);
    setDropTargetId(null);
    setDropError(null);
    const runtime = runtimeRef.current;
    if (runtime === null) {
      return;
    }
    const rawKind = dragKindFromTransfer(event.dataTransfer);
    if (rawKind === null) {
      return;
    }
    const point = runtime.graph.clientToLocal(event.clientX, event.clientY);
    const resolution = resolveDrop(runtime.graph, rawKind, {
      x: point.x,
      y: point.y,
    });
    if (resolution.error !== null) {
      setDropError(resolution.error);
      return;
    }
    const rawFieldType = event.dataTransfer.getData(
      "application/x-sandbox-field-type",
    );
    const fieldType = isFieldType(rawFieldType) ? rawFieldType : undefined;
    callbacksRef.current.onDrop(
      rawKind,
      resolution.parentId,
      fieldType,
      event.altKey || !snapEnabledRef.current
        ? { x: point.x, y: point.y }
        : snapSandboxPosition({ x: point.x, y: point.y }),
    );
  }

  function handleCanvasDragOver(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const rawKind = dragKindFromTransfer(event.dataTransfer);
    if (rawKind === null) {
      return;
    }
    const runtime = runtimeRef.current;
    if (runtime === null) {
      return;
    }
    setPaletteDragKind(rawKind);
    const point = runtime.graph.clientToLocal(event.clientX, event.clientY);
    const resolution = resolveDrop(runtime.graph, rawKind, {
      x: point.x,
      y: point.y,
    });
    setDropTargetId(resolution.error === null ? resolution.targetId : null);
    setDropError(resolution.error);
  }

  function handleCanvasDragLeave(event: DragEvent<HTMLDivElement>): void {
    const nextTarget = event.relatedTarget;
    if (
      nextTarget !== null &&
      event.currentTarget.contains(nextTarget as globalThis.Node)
    ) {
      return;
    }
    setPaletteDragKind(null);
    setDropTargetId(null);
    setDropError(null);
  }

  return (
    <div
      data-testid="sandbox-canvas"
      className="relative h-full w-full overflow-hidden"
      style={{ backgroundColor: CANVAS_BACKGROUND }}
      onDragOver={handleCanvasDragOver}
      onDragLeave={handleCanvasDragLeave}
      onDrop={handleCanvasDrop}
    >
      <div
        ref={gridRef}
        data-testid="sandbox-grid"
        data-grid-size={SANDBOX_GRID_SIZE}
        data-grid-major-size={SANDBOX_GRID_MAJOR_SIZE}
        aria-hidden="true"
        hidden={!gridVisible}
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: [
            `linear-gradient(to right, ${CANVAS_GRID} 1px, transparent 1px)`,
            `linear-gradient(to bottom, ${CANVAS_GRID} 1px, transparent 1px)`,
            `linear-gradient(to right, ${CANVAS_GRID_MAJOR} 1px, transparent 1px)`,
            `linear-gradient(to bottom, ${CANVAS_GRID_MAJOR} 1px, transparent 1px)`,
          ].join(", "),
          backgroundSize: [
            `${SANDBOX_GRID_SIZE}px ${SANDBOX_GRID_SIZE}px`,
            `${SANDBOX_GRID_SIZE}px ${SANDBOX_GRID_SIZE}px`,
            `${SANDBOX_GRID_MAJOR_SIZE}px ${SANDBOX_GRID_MAJOR_SIZE}px`,
            `${SANDBOX_GRID_MAJOR_SIZE}px ${SANDBOX_GRID_MAJOR_SIZE}px`,
          ].join(", "),
          backgroundPosition: "0 0, 0 0, 0 0, 0 0",
        }}
      />
      <div
        ref={containerRef}
        role="region"
        aria-label="Organization canvas"
        aria-describedby="sandbox-canvas-keyboard-alternative"
        tabIndex={0}
        className="focus:ring-ring absolute inset-0 outline-none focus:ring-2 focus:ring-inset"
      />
      <p id="sandbox-canvas-keyboard-alternative" className="sr-only">
        Select canvas items with a pointer or their field controls. Use the
        Structure panel for complete keyboard editing.
      </p>
      {paletteDragKind !== null || dropError !== null ? (
        <div
          aria-live="polite"
          className={`pointer-events-none absolute top-3 left-1/2 z-20 -translate-x-1/2 rounded-full border px-3 py-1 text-xs font-medium shadow-sm ${
            dropError === null
              ? "border-primary/30 bg-accent text-accent-foreground"
              : "border-warning/30 bg-card text-warning"
          }`}
        >
          {dropError ??
            (dropTargetId === null
              ? `Drop to add ${paletteDragKind}`
              : `Drop ${paletteDragKind} here`)}
        </div>
      ) : null}
      {editor !== null ? (
        <div
          className="absolute z-30"
          style={{ left: editor.left, top: editor.top, width: editor.width }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {editor.property === "type" ? (
            <select
              aria-label="Canvas field type"
              autoFocus
              className="border-primary bg-card text-foreground ring-ring/30 h-7 w-full rounded border px-1 text-[10px] font-semibold uppercase shadow-md ring-2 outline-none"
              value={editor.value}
              onChange={(event) => {
                setEditor((current) =>
                  current === null
                    ? current
                    : { ...current, value: event.target.value },
                );
                commitEditor(event.target.value);
              }}
              onBlur={(event) => commitEditor(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeEditor();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  commitEditor(event.currentTarget.value);
                }
              }}
            >
              {FIELD_TYPES.map((fieldType) => (
                <option key={fieldType} value={fieldType}>
                  {FIELD_TYPE_META[fieldType].label}
                </option>
              ))}
            </select>
          ) : (
            <input
              aria-label="Canvas name editor"
              autoFocus
              className="border-primary bg-card text-foreground ring-ring/30 h-7 w-full rounded border px-2 text-xs shadow-md ring-2 outline-none"
              value={editor.value}
              onChange={(event) =>
                setEditor((current) =>
                  current === null
                    ? current
                    : { ...current, value: event.target.value },
                )
              }
              onBlur={(event) => commitEditor(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeEditor();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  commitEditor(event.currentTarget.value);
                }
              }}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
