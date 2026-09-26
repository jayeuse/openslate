"use client";

import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type MutableRefObject,
} from "react";

import type { Graph, History, Node } from "@antv/x6";

import {
  FIELD_TYPE_META,
  type SandboxCanvasLayout,
  type SandboxFieldType,
  type SandboxState,
  type UpdateSandboxFieldPatch,
} from "@/lib/sandbox/model";
import { canConnect } from "@/lib/sandbox/rules";
import {
  MODULE_TABLE,
  SANDBOX_GRID_MAJOR_SIZE,
  SANDBOX_GRID_SIZE,
  SANDBOX_ZOOM,
  snapSandboxPosition,
} from "@/lib/sandbox/x6-adapter";
import type { SandboxCommandResult } from "@/components/systems/sandbox/state/commands";
import {
  dragKindFromTransfer,
  fitDepartmentFrames,
  isFieldType,
  nodeKindOf,
  readLayout,
  resolveDrop,
  rowFieldAt,
  selectNodeOrField,
  type CanvasPosition,
  type SandboxDropKind,
  FIELD_TYPES,
} from "./sandbox-canvas-graph";
import { synchronizeSandboxCanvas } from "./sandbox-canvas-sync";
import { createSandboxCanvasRuntime } from "./sandbox-canvas-runtime";
import { bindSandboxCanvasPortInteractions } from "./sandbox-canvas-ports";
import { bindSandboxCanvasResizeInteractions } from "./sandbox-canvas-resize";
import {
  bindSandboxCanvasTrace,
  type SandboxCanvasTrace,
} from "./sandbox-canvas-trace";

type SandboxCommand =
  | void
  | SandboxCommandResult<unknown>
  | PromiseLike<SandboxCommandResult<unknown> | void>;

function commandFailed(
  result: void | SandboxCommandResult<unknown>,
): result is { ok: false; error: string } {
  return result?.ok === false;
}

export type { SandboxCanvasLayout } from "@/lib/sandbox/model";

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
  /** Fits the design; false when it is larger than the view at the floor. */
  fit: () => boolean;
  /**
   * The opening view: 100% zoom with the design's top-left 24px in, so table
   * and field names are readable. The minimap and Fit show the rest.
   */
  start: () => void;
  center: () => void;
  /** Places a newly-created node, or queues its position until it is rendered. */
  placeNode: (nodeId: string, position: { x: number; y: number }) => void;
}

export type { SandboxDropKind } from "./sandbox-canvas-graph";

export interface SandboxCanvasProps {
  state: SandboxState;
  /** Optional geometry owner; omitted preserves graph-local positioning. */
  layout?: SandboxCanvasLayout;
  /** Emits a full snapshot after a user geometry action settles, never on sync. */
  onLayoutChange?: (layout: SandboxCanvasLayout) => SandboxCommand;
  gridVisible?: boolean;
  snapEnabled?: boolean;
  onViewChange?: (view: SandboxCanvasViewState) => void;
  onSelect: (cellId: string | null) => void;
  onRenameDepartment: (departmentId: string, name: string) => SandboxCommand;
  onRenameModule: (moduleId: string, name: string) => SandboxCommand;
  onUpdateField: (
    fieldId: string,
    patch: UpdateSandboxFieldPatch,
  ) => SandboxCommand;
  onDrop: (
    kind: SandboxDropKind,
    parentId: string | null,
    fieldType?: SandboxFieldType,
    position?: { x: number; y: number },
  ) => SandboxCommand;
  onConnect: (sourceModuleId: string, targetModuleId: string) => void;
  onMove: (nodeId: string, parentId: string | null) => void;
  graphRef?: MutableRefObject<SandboxCanvasApi | null>;
  pending?: boolean;
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

const CANVAS_BACKGROUND =
  "var(--canvas-background, var(--background, #ffffff))";
const CANVAS_GRID = "var(--canvas-grid, #d8dde5)";
const CANVAS_GRID_MAJOR = "var(--canvas-grid-major, #bac3cf)";

interface CanvasEditor {
  target: "department" | "module" | "field";
  property: "name" | "type";
  id: string;
  value: string;
  nodeId: string;
  rowIndex?: number;
  left: number;
  top: number;
  width: number;
}

// The inline editor is a fixed 28px control centred on the text it edits.
const CANVAS_EDITOR_HEIGHT = 28;
const CANVAS_EDITOR_MIN_WIDTH = 160;

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
  pending = false,
}: SandboxCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const minimapRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<SandboxCanvasRuntime | null>(null);
  const pendingPositionsRef = useRef<Map<string, CanvasPosition>>(new Map());
  const freeMoveRef = useRef(false);
  const gridVisibleRef = useRef(gridVisible);
  const snapEnabledRef = useRef(snapEnabled);
  const pendingRef = useRef(pending);
  const syncingRef = useRef(false);
  const appliedLayoutRef = useRef<SandboxCanvasLayout | undefined>(undefined);
  const [editor, setEditor] = useState<CanvasEditor | null>(null);
  const editorRef = useRef<CanvasEditor | null>(null);
  const editorCommitRef = useRef<string | null>(null);
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
  const traceRef = useRef<SandboxCanvasTrace | null>(null);
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
    pendingRef.current = pending;
  }, [pending]);
  useEffect(() => {
    gridVisibleRef.current = gridVisible;
    snapEnabledRef.current = snapEnabled;
    const graph = runtimeRef.current?.graph;
    if (graph === undefined) return;
    graph.setGridSize(snapEnabled ? SANDBOX_GRID_SIZE : 1);
    if (gridRef.current)
      gridRef.current.dataset.snapSize = `${graph.getGridSize()}`;
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
    const { graph, history } = createSandboxCanvasRuntime(
      container,
      snapEnabledRef.current ? SANDBOX_GRID_SIZE : 1,
      minimapRef.current,
    );
    if (gridRef.current)
      gridRef.current.dataset.snapSize = `${graph.getGridSize()}`;
    runtimeRef.current = { graph, history };
    appliedLayoutRef.current = undefined;
    let layoutQueue = Promise.resolve();
    const emitLayout = (): Promise<void> => {
      if (syncingRef.current || !callbacksRef.current.onLayoutChange)
        return Promise.resolve();
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
        return Promise.resolve();
      appliedLayoutRef.current = next;
      layoutQueue = layoutQueue
        .catch(() => undefined)
        .then(async () => {
          await callbacksRef.current.onLayoutChange?.(next);
        });
      return layoutQueue;
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
        `${SANDBOX_GRID_MAJOR_SIZE * scaleX}px ${SANDBOX_GRID_MAJOR_SIZE * scaleY}px`,
      ].join(", ");
      const minorHalf = (SANDBOX_GRID_SIZE * scaleX) / 2;
      const majorHalf = (SANDBOX_GRID_MAJOR_SIZE * scaleX) / 2;
      grid.style.backgroundPosition = [
        `${offsetX - minorHalf}px ${offsetY - minorHalf}px`,
        `${offsetX - majorHalf}px ${offsetY - majorHalf}px`,
      ].join(", ");
      grid.dataset.scale = `${scaleX}`;
      grid.dataset.translate = `${offsetX},${offsetY}`;
    };
    updateGridVisual();
    emitViewState();
    // Keep an open inline editor on its text while the view zooms or pans.
    const reanchorEditor = (): void => {
      const current = editorRef.current;
      if (current === null) return;
      const node = graph.getCellById(current.nodeId);
      if (node === null || !node.isNode()) return;
      const next = {
        ...current,
        ...editorAnchor(node, current.property, current.rowIndex),
      };
      editorRef.current = next;
      setEditor(next);
    };
    const updateScale = (): void => {
      updateGridVisual();
      emitViewState();
      reanchorEditor();
    };
    const updateTranslate = (): void => {
      updateGridVisual();
      reanchorEditor();
    };
    graph.on("scale", updateScale);
    graph.on("translate", updateTranslate);

    const updateDragSnap = (freeMove: boolean): void => {
      if (freeMoveRef.current === freeMove) {
        return;
      }
      freeMoveRef.current = freeMove;
      graph.setGridSize(
        freeMove || !snapEnabledRef.current ? 1 : SANDBOX_GRID_SIZE,
      );
      if (gridRef.current)
        gridRef.current.dataset.snapSize = `${graph.getGridSize()}`;
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
          MODULE_TABLE.rowHeight / 2
        : box.y +
          (nodeKindOf(node) === "department"
            ? 18
            : MODULE_TABLE.headerHeight / 2);
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
        top: Math.max(4, clientPoint.y - bounds.top - CANVAS_EDITOR_HEIGHT / 2),
        width: Math.max(CANVAS_EDITOR_MIN_WIDTH, width * graph.zoom()),
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
      // Pan only when the edited text is out of view (the anchor clamps to
      // the 4px edge), so editing inside a large visible table never jumps.
      let anchor = editorAnchor(node, property, rowIndex);
      const view = container.getBoundingClientRect();
      if (
        anchor.left <= 4 ||
        anchor.top <= 4 ||
        anchor.top + CANVAS_EDITOR_HEIGHT > view.height ||
        anchor.left + CANVAS_EDITOR_MIN_WIDTH / 2 > view.width
      ) {
        graph.centerCell(node);
        anchor = editorAnchor(node, property, rowIndex);
      }
      const nextEditor: CanvasEditor = {
        target,
        property,
        id,
        value,
        nodeId: node.id,
        rowIndex,
        ...anchor,
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
          graph.zoom(0.1, {
            minScale: SANDBOX_ZOOM.min,
            maxScale: SANDBOX_ZOOM.max,
          });
        },
        zoomOut: () => {
          graph.zoom(-0.1, {
            minScale: SANDBOX_ZOOM.min,
            maxScale: SANDBOX_ZOOM.max,
          });
        },
        resetZoom: () => {
          graph.zoom(1, { absolute: true });
        },
        start: () => {
          graph.zoom(1, { absolute: true });
          const departments = graph
            .getNodes()
            .filter((node) => nodeKindOf(node) === "department");
          const modulesOf = (department: Node) =>
            (department.getChildren() ?? []).filter(
              (cell): cell is Node =>
                cell.isNode() && nodeKindOf(cell) === "module",
            );
          // Open on the busiest department, so the first view shows tables
          // and the lines between them rather than one card in a frame.
          const busyness = (department: Node) => {
            const ids = new Set(modulesOf(department).map((item) => item.id));
            const lines = graph
              .getEdges()
              .filter(
                (edge) =>
                  ids.has(edge.getSourceCellId()) ||
                  ids.has(edge.getTargetCellId()),
              ).length;
            return ids.size + lines;
          };
          const anchor = departments.reduce<Node | null>(
            (best, department) =>
              best === null || busyness(department) > busyness(best)
                ? department
                : best,
            null,
          );
          const box = anchor?.getBBox() ?? graph.getCellsBBox(graph.getNodes());
          if (box === null) return;
          if (anchor === null || box.width + 48 <= container.clientWidth) {
            graph.translate(24 - box.x, 24 - box.y);
            return;
          }
          // A narrow canvas cannot hold the department, so show its first
          // table whole, with the department head above it.
          const first = [...modulesOf(anchor)].sort(
            (a, b) =>
              a.getBBox().y - b.getBBox().y || a.getBBox().x - b.getBBox().x,
          )[0];
          const target = first?.getBBox() ?? box;
          graph.translate(16 - target.x, 16 - box.y);
        },
        fit: () => {
          graph.zoomToFit({
            padding: 24,
            minScale: SANDBOX_ZOOM.fitMin,
            maxScale: 1,
          });
          if (graph.zoom() > SANDBOX_ZOOM.fitMin + 0.001) return true;
          // At the floor the design is larger than the view: show its start,
          // 24px in from the top-left, measured from the department frames.
          const departments = graph
            .getNodes()
            .filter((node) => nodeKindOf(node) === "department");
          const box = graph.getCellsBBox(
            departments.length > 0 ? departments : graph.getNodes(),
          );
          if (box !== null) {
            const scale = graph.zoom();
            graph.translate(24 - box.x * scale, 24 - box.y * scale);
          }
          return false;
        },
        center: () => {
          graph.centerContent();
        },
        placeNode: (nodeId, position) => {
          const snappedPosition = position;
          const cell = graph.getCellById(nodeId);
          if (cell !== null && cell.isNode()) {
            cell.setPosition(snappedPosition);
            void emitLayout();
            return;
          }
          pendingPositionsRef.current.set(nodeId, snappedPosition);
        },
      };
    }

    const cleanupPortInteractions = bindSandboxCanvasPortInteractions({
      graph,
      history,
      container,
      state: stateRef,
    });

    const trace = bindSandboxCanvasTrace({ graph, state: stateRef });
    traceRef.current = trace;

    const cleanupResizeInteractions = bindSandboxCanvasResizeInteractions({
      graph,
      history,
      container,
      snapEnabled: snapEnabledRef,
      emitLayout,
    });

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
        void emitLayout();
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
        void emitLayout();
        return;
      }
      // X6 removes a module from its department on a blank drop but emits no
      // `node:embedded` event. Restore the canonical parent without adding a
      // second history entry, preserving the exact dragged coordinates.
      restoreCanonicalParent(node);
      void emitLayout();
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
        void emitLayout();
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
      cleanupResizeInteractions();
      cleanupPortInteractions();
      trace.dispose();
      traceRef.current = null;
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

  // The canvas component remains the sole graph lifecycle owner; this focused
  // sync function reconciles the current graph with the authoritative state.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (runtime === null) return;
    synchronizeSandboxCanvas({
      graph: runtime.graph,
      history: runtime.history,
      state,
      layout,
      movingNodeId,
      dropTargetId,
      pendingPositions: pendingPositionsRef,
      appliedLayout: appliedLayoutRef,
      syncing: syncingRef,
    });
    traceRef.current?.refresh();
  }, [dropTargetId, layout, movingNodeId, state]);

  async function commitEditor(value: string): Promise<void> {
    const activeEditor = editorRef.current;
    if (
      activeEditor === null ||
      pendingRef.current ||
      editorCommitRef.current === activeEditor.id
    ) {
      return;
    }
    const nextValue = value.trim();
    if (nextValue === "") {
      return;
    }
    if (activeEditor.property === "type" && !isFieldType(nextValue)) return;
    editorCommitRef.current = activeEditor.id;
    try {
      let result: void | SandboxCommandResult<unknown>;
      if (activeEditor.property === "type") {
        if (!isFieldType(nextValue)) return;
        result = await callbacksRef.current.onUpdateField(activeEditor.id, {
          type: nextValue,
        });
      } else if (activeEditor.target === "department") {
        result = await callbacksRef.current.onRenameDepartment(
          activeEditor.id,
          nextValue,
        );
      } else if (activeEditor.target === "module") {
        result = await callbacksRef.current.onRenameModule(
          activeEditor.id,
          nextValue,
        );
      } else {
        result = await callbacksRef.current.onUpdateField(activeEditor.id, {
          name: nextValue,
        });
      }
      if (commandFailed(result)) return;
      if (editorRef.current?.id === activeEditor.id) closeEditor();
    } finally {
      if (editorCommitRef.current === activeEditor.id)
        editorCommitRef.current = null;
    }
  }

  async function handleCanvasDrop(
    event: DragEvent<HTMLDivElement>,
  ): Promise<void> {
    event.preventDefault();
    if (pendingRef.current) return;
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
    const result = await callbacksRef.current.onDrop(
      rawKind,
      resolution.parentId,
      fieldType,
      event.altKey || !snapEnabledRef.current
        ? { x: point.x, y: point.y }
        : snapSandboxPosition({ x: point.x, y: point.y }),
    );
    if (commandFailed(result)) setDropError(result.error);
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
          // Dots, not lines: the grid guides placement without competing
          // with the diagram.
          backgroundImage: [
            `radial-gradient(circle, ${CANVAS_GRID} 1px, transparent 1.2px)`,
            `radial-gradient(circle, ${CANVAS_GRID_MAJOR} 1.2px, transparent 1.6px)`,
          ].join(", "),
          backgroundSize: [
            `${SANDBOX_GRID_SIZE}px ${SANDBOX_GRID_SIZE}px`,
            `${SANDBOX_GRID_MAJOR_SIZE}px ${SANDBOX_GRID_MAJOR_SIZE}px`,
          ].join(", "),
          // Shift by half a cell so each dot sits on a snap point.
          backgroundPosition: `${-SANDBOX_GRID_SIZE / 2}px ${-SANDBOX_GRID_SIZE / 2}px, ${-SANDBOX_GRID_MAJOR_SIZE / 2}px ${-SANDBOX_GRID_MAJOR_SIZE / 2}px`,
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
      {/* Pointer navigation aid; Fit and the Structure tab are the keyboard
          equivalents, so the minimap stays out of the accessibility tree. */}
      <div
        ref={minimapRef}
        aria-hidden="true"
        className="sandbox-minimap border-border bg-card pointer-events-auto absolute right-3 bottom-3 z-10 hidden overflow-hidden rounded-md border shadow-sm sm:block"
      />
      {state.modules.length > 0 ? (
        <ul
          aria-label="Canvas key"
          className="border-border bg-card text-muted-foreground pointer-events-none absolute bottom-3 left-3 z-10 hidden grid-cols-2 gap-x-4 gap-y-1 rounded-md border px-2.5 py-2 text-xs shadow-sm sm:grid"
        >
          {(
            [
              ["Relationship", "line", ""],
              ["Handoff to another department", "line", "6 4"],
              ["Required field", "filled", ""],
              ["Optional field", "hollow", ""],
            ] as const
          ).map(([label, sample, dash]) => (
            <li key={label} className="flex items-center gap-2">
              <svg
                aria-hidden="true"
                width="24"
                height="8"
                className="shrink-0"
              >
                {sample === "line" ? (
                  <line
                    x1="0"
                    y1="4"
                    x2="24"
                    y2="4"
                    stroke="var(--canvas-edge)"
                    strokeWidth="1.5"
                    strokeDasharray={dash}
                  />
                ) : (
                  <circle
                    cx="12"
                    cy="4"
                    r="3"
                    fill={
                      sample === "filled" ? "var(--canvas-type-ink)" : "none"
                    }
                    stroke="var(--canvas-type-ink)"
                    strokeWidth="1.25"
                  />
                )}
              </svg>
              <span>{label}</span>
            </li>
          ))}
        </ul>
      ) : null}
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
              disabled={pending}
              className="border-primary bg-card text-foreground ring-ring/30 h-7 w-full rounded border px-1 text-xs shadow-md ring-2 outline-none"
              value={editor.value}
              onChange={(event) => {
                setEditor((current) =>
                  current === null
                    ? current
                    : { ...current, value: event.target.value },
                );
                void commitEditor(event.target.value);
              }}
              onBlur={(event) => void commitEditor(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeEditor();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  void commitEditor(event.currentTarget.value);
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
              disabled={pending}
              className="border-primary bg-card text-foreground ring-ring/30 h-7 w-full rounded border px-2 text-xs shadow-md ring-2 outline-none"
              value={editor.value}
              onChange={(event) =>
                setEditor((current) =>
                  current === null
                    ? current
                    : { ...current, value: event.target.value },
                )
              }
              onBlur={(event) => void commitEditor(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeEditor();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  void commitEditor(event.currentTarget.value);
                }
              }}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
