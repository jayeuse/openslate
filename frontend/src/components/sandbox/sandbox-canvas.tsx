"use client";

import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type MutableRefObject,
} from "react";

import { Graph, History, Selection, Snapline, type Node } from "@antv/x6";

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
  getModulePorts,
  graphOptions,
  moduleTableAttrs,
  moduleTableHeight,
  moduleTableMarkup,
  toCells,
} from "@/lib/sandbox/x6-adapter";

export interface SandboxCanvasApi {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  center: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  /** Places a newly-created node, or queues its position until it is rendered. */
  placeNode: (nodeId: string, position: { x: number; y: number }) => void;
}

export type SandboxDropKind = "department" | "module" | "field";

export interface SandboxCanvasProps {
  state: SandboxState;
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
      width: DEPARTMENT_WIDTH,
      height,
      fill: moving
        ? "#fff8eb"
        : dropTarget
          ? "#eff6ff"
          : selected
            ? "#f5f9ff"
            : "#ffffff",
      stroke: moving
        ? "#f59e0b"
        : dropTarget || selected
          ? "#3b82f6"
          : "#c8cdd6",
      strokeWidth: moving || dropTarget || selected ? 2 : 1,
      strokeDasharray: moving || dropTarget || selected ? "" : "5 4",
      rx: 0,
      ry: 0,
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
      fill: moving ? "#b45309" : dropTarget || selected ? "#2563eb" : "#68707d",
      text: truncateLabel(name, 30),
    },
    subheading: {
      x: DEPARTMENT_WIDTH - 12,
      y: 18,
      textAnchor: "end",
      textVerticalAnchor: "middle",
      fontSize: 10,
      fill: "#9aa1ac",
      text: `${moduleCount} modules`,
    },
  };
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
 * Resolve the drop parent at a canvas point: a field lands on the module
 * under the cursor, a module lands on the department under the cursor (or
 * the department of the module under the cursor), departments land loose.
 */
function findDropParent(
  graph: Graph,
  kind: SandboxDropKind,
  point: { x: number; y: number },
): string | null {
  const nodes = graph.getNodes();
  for (const node of nodes) {
    if (
      nodeKindOf(node) === "module" &&
      node.getBBox().containsPoint(point.x, point.y)
    ) {
      if (kind === "field") {
        return node.id;
      }
      const parent = node.getParent();
      return parent ? parent.id : null;
    }
  }
  for (const node of nodes) {
    if (
      nodeKindOf(node) === "department" &&
      node.getBBox().containsPoint(point.x, point.y)
    ) {
      return kind === "module" ? node.id : null;
    }
  }
  return null;
}

export function SandboxCanvas({
  state,
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
  const runtimeRef = useRef<SandboxCanvasRuntime | null>(null);
  const pendingPositionsRef = useRef<Map<string, CanvasPosition>>(new Map());
  const syncingRef = useRef(false);
  const [editor, setEditor] = useState<CanvasEditor | null>(null);
  const editorRef = useRef<CanvasEditor | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [paletteDragKind, setPaletteDragKind] =
    useState<SandboxDropKind | null>(null);
  const [movingNodeId, setMovingNodeId] = useState<string | null>(null);
  const callbacksRef = useRef<SandboxCanvasCallbacks>({
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
    if (state.currentStage === "automation" && editorRef.current !== null) {
      closeEditor();
    }
  }, [state.currentStage]);
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

    const reconcileModuleParents = (): void => {
      for (const node of graph.getNodes()) {
        if (nodeKindOf(node) !== "module") {
          continue;
        }
        const sandboxModule = stateRef.current.modules.find(
          (item) => item.id === node.id,
        );
        const actualParent = node.getParent();
        if (
          sandboxModule === undefined ||
          actualParent === null ||
          !actualParent.isNode() ||
          nodeKindOf(actualParent) !== "department" ||
          actualParent.id === sandboxModule.departmentId
        ) {
          continue;
        }
        callbacksRef.current.onMove(node.id, actualParent.id);
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
      if (
        stateRef.current.currentStage === "automation" ||
        editorRef.current !== null
      ) {
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
        zoomIn: () => {
          graph.zoom(0.1);
        },
        zoomOut: () => {
          graph.zoom(-0.1);
        },
        fit: () => {
          graph.zoomToFit({ padding: 24, maxScale: 1 });
        },
        center: () => {
          graph.centerContent();
        },
        undo: () => {
          history.undo();
          reconcileModuleParents();
        },
        redo: () => {
          history.redo();
          reconcileModuleParents();
        },
        canUndo: () => history.canUndo(),
        canRedo: () => history.canRedo(),
        placeNode: (nodeId, position) => {
          const cell = graph.getCellById(nodeId);
          if (cell !== null && cell.isNode()) {
            cell.setPosition(position);
            return;
          }
          pendingPositionsRef.current.set(nodeId, position);
        },
      };
    }

    graph.on("node:click", ({ node, y }) => {
      container.focus({ preventScroll: true });
      selectNodeOrField(node, y, stateRef.current, callbacksRef.current);
    });
    graph.on("node:dblclick", (event) => {
      if (stateRef.current.currentStage === "automation") {
        return;
      }
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
    graph.on("node:moving", ({ node }) => {
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
      setMovingNodeId(null);
      setDropTargetId(null);
      if (syncingRef.current || nodeKindOf(node) !== "module") {
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
        return;
      }
      // X6 removes a module from its department on a blank drop but emits no
      // `node:embedded` event. Restore the canonical parent without adding a
      // second history entry, preserving the exact dragged coordinates.
      restoreCanonicalParent(node);
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

    const observer = new ResizeObserver(() => {
      graph.resize(container.clientWidth, container.clientHeight);
    });
    observer.observe(container);

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "F2") {
        if (
          stateRef.current.currentStage !== "automation" &&
          editorRef.current === null &&
          stateRef.current.selectedCellId !== null
        ) {
          event.preventDefault();
          openEditorForSelection(stateRef.current.selectedCellId);
        }
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
    const relationshipMode = state.currentStage === "relationships";

    syncingRef.current = true;
    history.disable();
    try {
      graph.options.interacting =
        state.currentStage === "automation"
          ? {
              nodeMovable: false,
              magnetConnectable: false,
              edgeMovable: false,
              edgeLabelMovable: false,
              vertexMovable: false,
              vertexAddable: false,
              vertexDeletable: false,
            }
          : { edgeLabelMovable: false };

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
        const height = departmentHeight(moduleHeights);
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
                width: DEPARTMENT_WIDTH,
                height,
                markup: [
                  { tagName: "rect", selector: "body" },
                  { tagName: "text", selector: "heading" },
                  { tagName: "text", selector: "subheading" },
                ],
                attrs: departmentAttrs,
                data: { kind: "department", departmentId: department.id },
              });

        if (existing !== null && !existing.isNode()) {
          existing.remove();
        }
        pendingPositionsRef.current.delete(department.id);
        departmentNode.setSize(DEPARTMENT_WIDTH, height);
        departmentNode.setAttrs(departmentAttrs);
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
                ...getModulePorts(relationshipMode),
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
            moduleNode.setPortProp(
              portId,
              ["attrs", "circle", "magnet"],
              relationshipMode,
            );
            moduleNode.setPortProp(
              portId,
              ["attrs", "circle", "visibility"],
              relationshipMode ? "visible" : "hidden",
            );
          }
          moduleNodes.set(sandboxModule.id, moduleNode);
        }
      }

      const relationshipRouter = {
        name: "manhattan",
        args: {
          padding: 24,
          startDirections: ["right"],
          endDirections: ["left"],
          excludeNodes: state.departments.map((department) => department.id),
        },
      };
      for (const link of state.links) {
        const sourceNode = moduleNodes.get(link.sourceModuleId);
        const targetNode = moduleNodes.get(link.targetModuleId);
        if (sourceNode === undefined || targetNode === undefined) {
          continue;
        }
        const source = {
          cell: link.sourceModuleId,
          port: `${link.sourceModuleId}-out`,
        };
        const target = {
          cell: link.targetModuleId,
          port: `${link.targetModuleId}-in`,
        };
        const linkAttrs = {
          line: {
            stroke: "#9299a5",
            strokeWidth: 1.25,
            targetMarker: { name: "classic", size: 7 },
          },
        };
        const linkLabels = [
          {
            attrs: {
              label: {
                fontSize: 10,
                fill: "#68707d",
                text: link.label,
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
  }, [dropTargetId, movingNodeId, state]);

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
    const runtime = runtimeRef.current;
    if (runtime === null || state.currentStage === "automation") {
      return;
    }
    const rawKind = dragKindFromTransfer(event.dataTransfer);
    if (rawKind === null) {
      return;
    }
    const point = runtime.graph.clientToLocal(event.clientX, event.clientY);
    const parentId = findDropParent(runtime.graph, rawKind, {
      x: point.x,
      y: point.y,
    });
    const rawFieldType = event.dataTransfer.getData(
      "application/x-sandbox-field-type",
    );
    const fieldType = isFieldType(rawFieldType) ? rawFieldType : undefined;
    callbacksRef.current.onDrop(rawKind, parentId, fieldType, {
      x: point.x,
      y: point.y,
    });
  }

  function handleCanvasDragOver(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const rawKind = dragKindFromTransfer(event.dataTransfer);
    if (rawKind === null) {
      return;
    }
    const runtime = runtimeRef.current;
    if (runtime === null || state.currentStage === "automation") {
      return;
    }
    setPaletteDragKind(rawKind);
    const point = runtime.graph.clientToLocal(event.clientX, event.clientY);
    const target = findDropParent(runtime.graph, rawKind, {
      x: point.x,
      y: point.y,
    });
    setDropTargetId(target);
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
  }

  return (
    <div
      data-testid="sandbox-canvas"
      role="application"
      aria-label="Sandbox organization canvas. Select a node to inspect it."
      className="relative h-full w-full overflow-hidden bg-white"
      onDragOver={handleCanvasDragOver}
      onDragLeave={handleCanvasDragLeave}
      onDrop={handleCanvasDrop}
    >
      <div
        ref={containerRef}
        tabIndex={0}
        className="absolute inset-0 outline-none"
      />
      {paletteDragKind !== null ? (
        <div
          aria-live="polite"
          className="pointer-events-none absolute top-3 left-1/2 z-20 -translate-x-1/2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 shadow-sm"
        >
          {dropTargetId === null
            ? `Drop to add ${paletteDragKind}`
            : `Drop ${paletteDragKind} here`}
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
              className="h-7 w-full rounded border border-blue-500 bg-white px-1 text-[10px] font-semibold text-slate-700 uppercase shadow-md ring-2 ring-blue-100 outline-none"
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
              className="h-7 w-full rounded border border-blue-500 bg-white px-2 text-xs text-slate-900 shadow-md ring-2 ring-blue-100 outline-none"
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
