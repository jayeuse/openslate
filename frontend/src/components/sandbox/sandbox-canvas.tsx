"use client";

import "@xyflow/react/dist/base.css";

import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent,
} from "react";
import {
  applyNodeChanges,
  ConnectionLineType,
  ConnectionMode,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStoreApi,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type Viewport,
} from "@xyflow/react";

import {
  FIELD_TYPE_META,
  type SandboxCanvasLayout,
  type SandboxFieldType,
  type SandboxState,
  type UpdateSandboxFieldPatch,
} from "@/lib/sandbox/model";
import { canConnect } from "@/lib/sandbox/rules";
import { SANDBOX_SHORTCUTS } from "@/lib/shortcuts";
import {
  departmentAt,
  dragKindFromTransfer,
  FIELD_TYPES,
  isFieldType,
  MODULE_TABLE,
  resizeFrame,
  resolveDrop,
  SANDBOX_GRID_MAJOR_SIZE,
  SANDBOX_GRID_SIZE,
  SANDBOX_ZOOM,
  snapSandboxPosition,
  type CanvasBox,
  type SandboxDropKind,
} from "@/lib/sandbox/canvas-geometry";
import type { SandboxCommandResult } from "@/components/systems/sandbox/state/commands";
import {
  absoluteBoxes,
  canvasBoxes,
  deriveFlowEdges,
  deriveFlowNodes,
  fitFlowFrames,
  placeFlowNode,
  readCanvasLayout,
  reparentFlowNode,
  resizeFlowNode,
  type RelationshipFlowEdge,
  type SandboxFlowNode,
} from "./sandbox-flow-model";
import {
  nodePoint,
  RelationshipMarkers,
  SANDBOX_EDGE_TYPES,
  SANDBOX_NODE_TYPES,
  SandboxCanvasActionsProvider,
  type CanvasEditRequest,
  type SandboxCanvasActions,
} from "./sandbox-canvas-nodes";
import { SandboxCanvasTraceStore } from "./sandbox-canvas-trace";
import {
  LineLabelStops,
  lineFromPath,
  placeLineLabels,
} from "./sandbox-canvas-labels";
import { useStableHandlers } from "@/lib/use-stable-handlers";

type SandboxCommand =
  | void
  | SandboxCommandResult<unknown>
  | PromiseLike<SandboxCommandResult<unknown> | void>;

function commandFailed(
  result: void | SandboxCommandResult<unknown>,
): result is { ok: false; error: string } {
  return result?.ok === false;
}

function sameLayout(a: SandboxCanvasLayout, b: SandboxCanvasLayout): boolean {
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([id, box]) => {
      const other = b[id];
      return (
        other !== undefined &&
        other.x === box.x &&
        other.y === box.y &&
        other.width === box.width &&
        other.height === box.height
      );
    })
  );
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
   * The opening view: 100% zoom on one department, 24px in, so table and
   * field names are readable. The minimap and Fit show the rest. With a
   * focus id, it opens on that module's (or department's) department and
   * keeps the module in view; with `trace`, it also pins the module's
   * connections, for "Show on canvas". Without one, it opens on the
   * busiest department.
   */
  start: (options?: { focusId?: string | null; trace?: boolean }) => void;
  /** Clears a trace pinned by `start({ trace: true })`, and its field marks. */
  clearTrace: () => void;
  /** Marks field rows (canvas field id → "trigger" | "changed") for a Test run. */
  markFields: (marks: Readonly<Record<string, string>> | null) => void;
  center: () => void;
  /** Places a newly-created node, or queues its position until it is rendered. */
  placeNode: (nodeId: string, position: { x: number; y: number }) => void;
}

export type { SandboxDropKind } from "@/lib/sandbox/canvas-geometry";

export interface SandboxCanvasProps {
  state: SandboxState;
  /** Optional geometry owner; omitted preserves canvas-local positioning. */
  layout?: SandboxCanvasLayout;
  /** Emits a full snapshot after a user geometry action settles, never on sync. */
  onLayoutChange?: (layout: SandboxCanvasLayout) => SandboxCommand;
  gridVisible?: boolean;
  snapEnabled?: boolean;
  /** Reports the zoom once at start and on every zoom step. */
  onZoomChange?: (zoom: number) => void;
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
  /** A click on empty canvas cleared a pinned "Show on canvas" trace. */
  onTraceCleared?: () => void;
  graphRef?: MutableRefObject<SandboxCanvasApi | null>;
  pending?: boolean;
  /** Only the owning Build screen's confirmed account preference enables F2. */
  keyboardShortcutsEnabled?: boolean;
}

type SandboxCanvasCallbacks = Pick<
  SandboxCanvasProps,
  | "onLayoutChange"
  | "onZoomChange"
  | "onSelect"
  | "onRenameDepartment"
  | "onRenameModule"
  | "onUpdateField"
  | "onDrop"
  | "onConnect"
  | "onMove"
  | "onTraceCleared"
>;

const CANVAS_BACKGROUND = "var(--canvas-background, var(--background))";
const CANVAS_GRID = "var(--canvas-grid)";
const CANVAS_GRID_MAJOR = "var(--canvas-grid-major)";

interface CanvasEditor extends CanvasEditRequest {
  value: string;
  left: number;
  top: number;
  width: number;
}

// The inline editor is a fixed 28px control centred on the text it edits.
const CANVAS_EDITOR_HEIGHT = 28;
const CANVAS_EDITOR_MIN_WIDTH = 160;
/** One zoom step, added to or taken from the current zoom. */
const ZOOM_STEP = 0.1;

const SNAP_GRID: [number, number] = [SANDBOX_GRID_SIZE, SANDBOX_GRID_SIZE];
const CONNECTION_LINE_STYLE = {
  stroke: "var(--action)",
  strokeWidth: 1.6,
  strokeDasharray: "5 4",
};
const PRO_OPTIONS = { hideAttribution: true };

function canHover(): boolean {
  // A tap on a touch screen fires an emulated mouseenter with no leave,
  // which would leave the canvas faded after a selection.
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

function minimapNodeClass(node: Node): string {
  const tone = (node.data as { tone?: unknown }).tone;
  return `sandbox-minimap-${node.type ?? "node"} sandbox-minimap-tone-${typeof tone === "number" ? tone : 1}`;
}

function boundsOf(boxes: Iterable<CanvasBox>): CanvasBox | null {
  const list = [...boxes];
  if (list.length === 0) return null;
  const x = Math.min(...list.map((box) => box.x));
  const y = Math.min(...list.map((box) => box.y));
  return {
    x,
    y,
    width: Math.max(...list.map((box) => box.x + box.width)) - x,
    height: Math.max(...list.map((box) => box.y + box.height)) - y,
  };
}

export function SandboxCanvas(props: SandboxCanvasProps) {
  return (
    <ReactFlowProvider>
      <SandboxFlowCanvas {...props} />
    </ReactFlowProvider>
  );
}

function SandboxFlowCanvas({
  state,
  layout,
  onLayoutChange,
  gridVisible = true,
  snapEnabled = true,
  onZoomChange,
  onSelect,
  onRenameDepartment,
  onRenameModule,
  onUpdateField,
  onDrop,
  onConnect,
  onMove,
  onTraceCleared,
  graphRef,
  pending = false,
  keyboardShortcutsEnabled = false,
}: SandboxCanvasProps) {
  const flow = useReactFlow<SandboxFlowNode, RelationshipFlowEdge>();
  const flowStore = useStoreApi<SandboxFlowNode, RelationshipFlowEdge>();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const flowRootRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  // The nodes on screen. The ref is the synchronous truth for the view API
  // (the Designer reads getLayout in the frame after a change); the state
  // renders it. Both change only through commitNodes.
  const [nodes, setNodes] = useState<SandboxFlowNode[]>(() =>
    deriveFlowNodes({ state, previous: [], layout }),
  );
  const nodesRef = useRef(nodes);
  const [edges, setEdges] = useState<RelationshipFlowEdge[]>(() =>
    deriveFlowEdges(state, []),
  );
  const edgesRef = useRef(edges);
  const [trace] = useState(() => new SandboxCanvasTraceStore());
  const [labels] = useState(() => new LineLabelStops());

  const pendingPositionsRef = useRef<Map<string, { x: number; y: number }>>(
    new Map(),
  );
  const gridVisibleRef = useRef(gridVisible);
  const snapEnabledRef = useRef(snapEnabled);
  const pendingRef = useRef(pending);
  const keyboardShortcutsRef = useRef(keyboardShortcutsEnabled);
  // The layout the canvas shows: the last one applied or emitted.
  const appliedLayoutRef = useRef<SandboxCanvasLayout | undefined>(layout);
  // The last `layout` prop applied; only a new prop moves nodes.
  const appliedLayoutPropRef = useRef<SandboxCanvasLayout | undefined>(layout);
  // Bumped when the owner refuses an emitted layout, so the next sync shows
  // the owner's layout again.
  const [layoutRestore, setLayoutRestore] = useState(0);
  const layoutQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [editor, setEditor] = useState<CanvasEditor | null>(null);
  const editorRef = useRef<CanvasEditor | null>(null);
  const editorCommitRef = useRef<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const [paletteDragKind, setPaletteDragKind] =
    useState<SandboxDropKind | null>(null);
  const [movingNodeId, setMovingNodeId] = useState<string | null>(null);
  // Alt/Option drags off the grid; the visual grid stays as it is.
  const [freeMove, setFreeMove] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const callbacksRef = useRef<SandboxCanvasCallbacks>({
    onLayoutChange,
    onZoomChange,
    onSelect,
    onRenameDepartment,
    onRenameModule,
    onUpdateField,
    onDrop,
    onConnect,
    onMove,
    onTraceCleared,
  });
  const stateRef = useRef(state);
  const feedbackTimersRef = useRef(
    new Map<Element, ReturnType<typeof setTimeout>>(),
  );

  useEffect(() => {
    callbacksRef.current = {
      onLayoutChange,
      onZoomChange,
      onSelect,
      onRenameDepartment,
      onRenameModule,
      onUpdateField,
      onDrop,
      onConnect,
      onMove,
      onTraceCleared,
    };
    stateRef.current = state;
  });
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);
  useEffect(() => {
    pendingRef.current = pending;
    keyboardShortcutsRef.current = keyboardShortcutsEnabled;
    gridVisibleRef.current = gridVisible;
    snapEnabledRef.current = snapEnabled;
  }, [pending, keyboardShortcutsEnabled, gridVisible, snapEnabled]);

  function commitNodes(next: SandboxFlowNode[]): void {
    if (next === nodesRef.current) return;
    nodesRef.current = next;
    setNodes(next);
  }

  function closeEditor(): void {
    editorRef.current = null;
    setEditor(null);
  }

  /** Emit the shown geometry once a user gesture settles. */
  function emitLayout(next: readonly SandboxFlowNode[]): Promise<void> {
    if (!callbacksRef.current.onLayoutChange) return Promise.resolve();
    const snapshot = readCanvasLayout(next);
    const previous = appliedLayoutRef.current;
    if (previous && sameLayout(snapshot, previous)) return Promise.resolve();
    appliedLayoutRef.current = snapshot;
    layoutQueueRef.current = layoutQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        // A refused or failed layout leaves the owner's layout as it was.
        const restore = () => {
          appliedLayoutPropRef.current = undefined;
          setLayoutRestore((count) => count + 1);
        };
        try {
          const result = await callbacksRef.current.onLayoutChange?.(snapshot);
          if (commandFailed(result)) restore();
        } catch (error) {
          restore();
          throw error;
        }
      });
    return layoutQueueRef.current;
  }

  /** Commit a gesture's geometry: frames grow to fit, then the owner hears. */
  function settleGeometry(next: SandboxFlowNode[]): void {
    const fitted = fitFlowFrames(next);
    commitNodes(fitted);
    void emitLayout(fitted);
  }

  // Reconcile the nodes with the structure. Existing nodes keep their
  // geometry; a new layout prop (undo, redo, arrange, a refused layout, or
  // the server's copy) moves them. After a drag the canvas already shows its
  // new layout while the prop is still the old one; that stale prop must not
  // move a node back before the new one arrives.
  useEffect(() => {
    const apply =
      layout !== undefined && layout !== appliedLayoutPropRef.current
        ? layout
        : undefined;
    const next = deriveFlowNodes({
      state,
      previous: nodesRef.current,
      layout: apply,
      pending: pendingPositionsRef.current,
      movingNodeId,
      dropTargetId,
    });
    if (apply !== undefined) {
      appliedLayoutPropRef.current = apply;
      appliedLayoutRef.current = apply;
    }
    for (const id of [...pendingPositionsRef.current.keys()]) {
      if (next.some((node) => node.id === id))
        pendingPositionsRef.current.delete(id);
    }
    commitNodes(next);
    trace.setState(state);
  }, [state, layout, layoutRestore, movingNodeId, dropTargetId, trace]);

  useEffect(() => {
    const next = deriveFlowEdges(state, edgesRef.current);
    if (next === edgesRef.current) return;
    edgesRef.current = next;
    setEdges(next);
  }, [state]);

  function viewSize(): { width: number; height: number } {
    const container = containerRef.current;
    return {
      width: container?.clientWidth ?? 0,
      height: container?.clientHeight ?? 0,
    };
  }

  function editorAnchor(
    request: CanvasEditRequest,
    viewport: Viewport = flow.getViewport(),
  ): Pick<CanvasEditor, "left" | "top" | "width"> {
    const box = absoluteBoxes(nodesRef.current).get(request.nodeId);
    const node = nodesRef.current.find((item) => item.id === request.nodeId);
    if (box === undefined || node === undefined)
      return { left: 4, top: 4, width: CANVAS_EDITOR_MIN_WIDTH };
    const isField = request.rowIndex !== undefined;
    const isDepartment = node.type === "department";
    const x = isField
      ? box.x + (request.property === "type" ? MODULE_TABLE.splitX + 3 : 5)
      : box.x + 5;
    const y = isField
      ? box.y +
        MODULE_TABLE.headerHeight +
        (request.rowIndex ?? 0) * MODULE_TABLE.rowHeight +
        MODULE_TABLE.rowHeight / 2
      : box.y + (isDepartment ? 18 : MODULE_TABLE.headerHeight / 2);
    const width = isField
      ? request.property === "type"
        ? MODULE_TABLE.width - MODULE_TABLE.splitX - 8
        : MODULE_TABLE.splitX - 10
      : isDepartment
        ? 250
        : MODULE_TABLE.width - 10;
    return {
      left: Math.max(4, x * viewport.zoom + viewport.x),
      top: Math.max(
        4,
        y * viewport.zoom + viewport.y - CANVAS_EDITOR_HEIGHT / 2,
      ),
      width: Math.max(CANVAS_EDITOR_MIN_WIDTH, width * viewport.zoom),
    };
  }

  function openEditor(request: CanvasEditRequest): void {
    if (editorRef.current !== null) return;
    const current = stateRef.current;
    const value =
      request.target === "department"
        ? current.departments.find((item) => item.id === request.id)?.name
        : request.target === "module"
          ? current.modules.find((item) => item.id === request.id)?.name
          : current.fields.find((item) => item.id === request.id)?.[
              request.property
            ];
    if (typeof value !== "string") return;
    callbacksRef.current.onSelect(request.id);
    // Pan only when the editor would not fit in view (the anchor clamps to
    // the 4px edge), so editing inside a large visible table never jumps.
    // The editor's width scales with zoom, so the whole width must fit.
    let anchor = editorAnchor(request);
    const view = viewSize();
    if (
      anchor.left <= 4 ||
      anchor.top <= 4 ||
      anchor.top + CANVAS_EDITOR_HEIGHT > view.height ||
      anchor.left + anchor.width > view.width
    ) {
      const box = absoluteBoxes(nodesRef.current).get(request.nodeId);
      if (box !== undefined) {
        const { zoom } = flow.getViewport();
        const centered = {
          x: view.width / 2 - (box.x + box.width / 2) * zoom,
          y: view.height / 2 - (box.y + box.height / 2) * zoom,
          zoom,
        };
        void flow.setViewport(centered);
        anchor = editorAnchor(request, centered);
      }
    }
    const next: CanvasEditor = { ...request, value, ...anchor };
    editorRef.current = next;
    setEditor(next);
  }

  function openEditorForSelection(cellId: string): void {
    const current = stateRef.current;
    if (current.departments.some((item) => item.id === cellId)) {
      openEditor({
        target: "department",
        property: "name",
        id: cellId,
        nodeId: cellId,
      });
      return;
    }
    if (current.modules.some((item) => item.id === cellId)) {
      openEditor({
        target: "module",
        property: "name",
        id: cellId,
        nodeId: cellId,
      });
      return;
    }
    const field = current.fields.find((item) => item.id === cellId);
    if (field === undefined) return;
    const rowIndex =
      current.modules
        .find((item) => item.id === field.moduleId)
        ?.fieldIds.indexOf(field.id) ?? -1;
    if (rowIndex >= 0)
      openEditor({
        target: "field",
        property: "name",
        id: field.id,
        nodeId: field.moduleId,
        rowIndex,
      });
  }

  // Department resizing from the grip: pointer (snapped unless Alt) and
  // arrow keys (exact steps). Frames never shrink past their modules.
  const resizeGestureRef = useRef<{
    id: string;
    pointerId: number;
    clientX: number;
    clientY: number;
    width: number;
    height: number;
    zoom: number;
  } | null>(null);

  function frameAndModules(
    departmentId: string,
  ): { frame: CanvasBox; modules: CanvasBox[] } | null {
    const boxes = absoluteBoxes(nodesRef.current);
    const frame = boxes.get(departmentId);
    if (frame === undefined) return null;
    const modules = nodesRef.current.flatMap((node) => {
      const box =
        node.parentId === departmentId ? boxes.get(node.id) : undefined;
      return box ? [box] : [];
    });
    return { frame, modules };
  }

  function resizeTo(
    departmentId: string,
    width: number,
    height: number,
    free: boolean,
  ): void {
    const current = frameAndModules(departmentId);
    if (current === null) return;
    commitNodes(
      resizeFlowNode(
        nodesRef.current,
        departmentId,
        resizeFrame(current.frame, current.modules, width, height, free),
      ),
    );
  }

  function startResize(
    departmentId: string,
    event: PointerEvent<SVGElement>,
  ): void {
    const current = frameAndModules(departmentId);
    if (current === null) return;
    event.preventDefault();
    event.stopPropagation();
    resizeGestureRef.current = {
      id: departmentId,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      width: current.frame.width,
      height: current.frame.height,
      zoom: flow.getViewport().zoom,
    };
    // The gesture follows the pointer anywhere on the page, even off the grip.
    event.currentTarget.focus();
    const move = (moveEvent: globalThis.PointerEvent) => {
      const gesture = resizeGestureRef.current;
      if (gesture === null || gesture.pointerId !== moveEvent.pointerId) return;
      moveEvent.preventDefault();
      resizeTo(
        gesture.id,
        gesture.width + (moveEvent.clientX - gesture.clientX) / gesture.zoom,
        gesture.height + (moveEvent.clientY - gesture.clientY) / gesture.zoom,
        moveEvent.altKey,
      );
    };
    const end = (endEvent: globalThis.PointerEvent) => {
      const gesture = resizeGestureRef.current;
      if (gesture === null || gesture.pointerId !== endEvent.pointerId) return;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      resizeGestureRef.current = null;
      if (endEvent.type === "pointercancel") {
        commitNodes(
          resizeFlowNode(nodesRef.current, gesture.id, {
            width: gesture.width,
            height: gesture.height,
          }),
        );
        return;
      }
      void emitLayout(nodesRef.current);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
  }

  function resizeByKey(
    departmentId: string,
    event: KeyboardEvent<SVGElement>,
  ): void {
    const dx =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const dy = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (dx === 0 && dy === 0) return;
    const current = frameAndModules(departmentId);
    if (current === null) return;
    event.preventDefault();
    event.stopPropagation();
    const step =
      event.altKey || !snapEnabledRef.current ? 1 : SANDBOX_GRID_SIZE;
    // Keyboard deltas are exact; only pointer resizing snaps to the grid.
    resizeTo(
      departmentId,
      current.frame.width + dx * step,
      current.frame.height + dy * step,
      true,
    );
    void emitLayout(nodesRef.current);
  }

  // One stable action set for the node views, so they never re-render
  // because a handler changed.
  const nodeActions = useStableHandlers({
    openEditor,
    startResize,
    resizeByKey,
  });
  const [actions] = useState<SandboxCanvasActions>(() => ({
    trace,
    labels,
    ...nodeActions,
  }));

  // The view: the dot grid follows pan and zoom, the zoom is reported, and
  // an open inline editor stays on its text.
  useEffect(() => {
    const updateView = ([x, y, zoom]: readonly [number, number, number]) => {
      const grid = gridRef.current;
      if (grid !== null) {
        grid.style.backgroundSize = [
          `${SANDBOX_GRID_SIZE * zoom}px ${SANDBOX_GRID_SIZE * zoom}px`,
          `${SANDBOX_GRID_MAJOR_SIZE * zoom}px ${SANDBOX_GRID_MAJOR_SIZE * zoom}px`,
        ].join(", ");
        const minorHalf = (SANDBOX_GRID_SIZE * zoom) / 2;
        grid.style.backgroundPosition = [
          `${x - minorHalf}px ${y - minorHalf}px`,
          `${x - minorHalf}px ${y - minorHalf}px`,
        ].join(", ");
        grid.dataset.scale = `${zoom}`;
        grid.dataset.translate = `${x},${y}`;
      }
      const current = editorRef.current;
      if (current !== null) {
        const next = { ...current, ...editorAnchor(current, { x, y, zoom }) };
        editorRef.current = next;
        setEditor(next);
      }
    };
    let shown = flowStore.getState().transform;
    updateView(shown);
    callbacksRef.current.onZoomChange?.(shown[2]);
    return flowStore.subscribe((next) => {
      const transform = next.transform;
      if (transform === shown) return;
      const zoomed = transform[2] !== shown[2];
      shown = transform;
      updateView(transform);
      if (zoomed) callbacksRef.current.onZoomChange?.(transform[2]);
    });
  }, [flowStore]);

  // Line labels move off shared corridors, tables, and each other once the
  // geometry settles; never during a drag (sandbox-canvas-labels.ts).
  useEffect(() => {
    if (movingNodeId !== null) return;
    const timer = setTimeout(() => {
      const container = containerRef.current;
      if (container === null) return;
      const boxes = absoluteBoxes(nodesRef.current);
      const tables = nodesRef.current.flatMap((node) => {
        const box = node.type === "module" ? boxes.get(node.id) : undefined;
        return box ? [box] : [];
      });
      const lines = edgesRef.current.flatMap((edge) => {
        const id = CSS.escape(edge.id);
        const path = container.querySelector<SVGPathElement>(
          `[data-sandbox-edge="${id}"] [data-sandbox-line]`,
        );
        if (path === null) return [];
        const label = edge.data?.label
          ? container.querySelector<HTMLElement>(
              `[data-sandbox-edge-label="${id}"]`,
            )
          : null;
        return [
          lineFromPath(
            edge.id,
            path,
            label
              ? { width: label.offsetWidth, height: label.offsetHeight }
              : null,
          ),
        ];
      });
      labels.set(placeLineLabels(lines, tables));
    }, 60);
    return () => clearTimeout(timer);
  }, [nodes, edges, movingNodeId, labels]);

  // React Flow marks its root role="application", which would switch screen
  // readers out of browse mode; the region above already names the canvas.
  useEffect(() => {
    flowRootRef.current?.removeAttribute("role");
  }, []);

  // Alt/Option opts out of snapping for the drag in progress.
  useEffect(() => {
    const update = (event: globalThis.KeyboardEvent | MouseEvent) =>
      setFreeMove(event.altKey);
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    window.addEventListener("pointerdown", update, true);
    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
      window.removeEventListener("pointerdown", update, true);
    };
  }, []);

  useEffect(() => {
    const timers = feedbackTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  function showPressed(cellId: string): void {
    const element = containerRef.current?.querySelector(
      `[data-sandbox-node="${CSS.escape(cellId)}"], [data-sandbox-edge="${CSS.escape(cellId)}"]`,
    );
    if (!element) return;
    const timers = feedbackTimersRef.current;
    clearTimeout(timers.get(element));
    element.setAttribute("data-sandbox-pressed", "true");
    timers.set(
      element,
      setTimeout(() => {
        element.removeAttribute("data-sandbox-pressed");
        timers.delete(element);
      }, 160),
    );
  }

  function moduleDepartmentAt(nodeId: string): string | null {
    const boxes = canvasBoxes(nodesRef.current);
    const box = boxes.modules.find((item) => item.id === nodeId)?.box;
    if (box === undefined) return null;
    return departmentAt(boxes, {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    });
  }

  useEffect(() => {
    if (!graphRef) return;
    const viewAt = (x: number, y: number, zoom: number) =>
      void flow.setViewport({ x, y, zoom });
    const zoomBy = (delta: number) => {
      const { zoom } = flow.getViewport();
      const next = Math.min(
        SANDBOX_ZOOM.max,
        Math.max(SANDBOX_ZOOM.min, Math.round((zoom + delta) * 100) / 100),
      );
      if (next !== zoom) void flow.zoomTo(next);
    };
    graphRef.current = {
      getLayout: () => readCanvasLayout(nodesRef.current),
      getViewState: () => ({
        zoom: flow.getViewport().zoom,
        gridVisible: gridVisibleRef.current,
        snapEnabled: snapEnabledRef.current,
      }),
      zoomIn: () => zoomBy(ZOOM_STEP),
      zoomOut: () => zoomBy(-ZOOM_STEP),
      resetZoom: () => void flow.zoomTo(1),
      start: (options) => {
        const current = nodesRef.current;
        const boxes = absoluteBoxes(current);
        const view = viewSize();
        const byId = new Map(current.map((node) => [node.id, node]));
        const focus =
          options?.focusId != null ? byId.get(options.focusId) : undefined;
        const focusModule = focus?.type === "module" ? focus : undefined;
        const focusDepartment =
          focusModule?.parentId !== undefined
            ? byId.get(focusModule.parentId)
            : focus?.type === "department"
              ? focus
              : undefined;
        trace.pin(
          options?.trace && focusModule !== undefined ? focusModule.id : null,
        );
        const departments = current.filter(
          (node) => node.type === "department",
        );
        const modulesOf = (departmentId: string) =>
          current.filter((node) => node.parentId === departmentId);
        // Open on the busiest department, so the first view shows tables
        // and the lines between them rather than one card in a frame.
        const busyness = (departmentId: string) => {
          const ids = new Set(modulesOf(departmentId).map((item) => item.id));
          const lines = edgesRef.current.filter(
            (edge) => ids.has(edge.source) || ids.has(edge.target),
          ).length;
          return ids.size + lines;
        };
        const anchor =
          focusDepartment ??
          departments.reduce<SandboxFlowNode | null>(
            (best, department) =>
              best === null || busyness(department.id) > busyness(best.id)
                ? department
                : best,
            null,
          );
        const box =
          (anchor ? boxes.get(anchor.id) : undefined) ??
          boundsOf(boxes.values());
        if (box == null) return;
        if (anchor == null || box.width + 48 <= view.width) {
          // Keep a focused module in view: when it sits below the fold,
          // lift the department so the module's top is 72px down.
          const moduleBox = focusModule ? boxes.get(focusModule.id) : undefined;
          const dy =
            moduleBox &&
            moduleBox.y + moduleBox.height - box.y + 24 > view.height
              ? 72 - moduleBox.y
              : 24 - box.y;
          viewAt(24 - box.x, dy, 1);
          return;
        }
        // A narrow canvas cannot hold the department, so show one table
        // whole (the focused one, or the first), with the department head
        // above it when it fits.
        const first =
          (focusModule ? boxes.get(focusModule.id) : undefined) ??
          modulesOf(anchor.id)
            .flatMap((node) => {
              const item = boxes.get(node.id);
              return item ? [item] : [];
            })
            .sort((a, b) => a.y - b.y || a.x - b.x)[0];
        const target = first ?? box;
        const top =
          target.y + target.height - box.y + 16 > view.height
            ? target.y - 16
            : box.y;
        // Keep the department's left edge (and its name) in view when the
        // table still fits beside it.
        const left =
          target.x + target.width - box.x + 32 <= view.width ? box.x : target.x;
        viewAt(16 - left, 16 - top, 1);
      },
      fit: () => {
        const current = nodesRef.current;
        const boxes = absoluteBoxes(current);
        const bounds = boundsOf(boxes.values());
        if (bounds === null) return true;
        const view = viewSize();
        const padding = 24;
        const zoom = Math.min(
          1,
          Math.max(
            SANDBOX_ZOOM.fitMin,
            Math.min(
              (view.width - padding * 2) / bounds.width,
              (view.height - padding * 2) / bounds.height,
            ),
          ),
        );
        if (zoom > SANDBOX_ZOOM.fitMin + 0.001) {
          viewAt(
            (view.width - bounds.width * zoom) / 2 - bounds.x * zoom,
            (view.height - bounds.height * zoom) / 2 - bounds.y * zoom,
            zoom,
          );
          return true;
        }
        // At the floor the design is larger than the view: show its start,
        // 24px in from the top-left, measured from the department frames.
        const frames =
          boundsOf(
            current.flatMap((node) => {
              const item =
                node.type === "department" ? boxes.get(node.id) : undefined;
              return item ? [item] : [];
            }),
          ) ?? bounds;
        viewAt(24 - frames.x * zoom, 24 - frames.y * zoom, zoom);
        return false;
      },
      center: () => {
        const bounds = boundsOf(absoluteBoxes(nodesRef.current).values());
        if (bounds === null) return;
        const view = viewSize();
        const { zoom } = flow.getViewport();
        viewAt(
          view.width / 2 - (bounds.x + bounds.width / 2) * zoom,
          view.height / 2 - (bounds.y + bounds.height / 2) * zoom,
          zoom,
        );
      },
      clearTrace: () => {
        trace.pin(null);
        trace.markFields(null);
      },
      markFields: (marks) => trace.markFields(marks),
      placeNode: (nodeId, position) => {
        if (nodesRef.current.some((node) => node.id === nodeId)) {
          settleGeometry(placeFlowNode(nodesRef.current, nodeId, position));
          return;
        }
        pendingPositionsRef.current.set(nodeId, position);
      },
    };
    return () => {
      graphRef.current = null;
    };
    // The API reads refs and the stable flow instance only.
  }, [graphRef, flow, trace]);

  function handleConnect(connection: Connection): void {
    const { source, target } = connection;
    if (!source || !target || source === target) return;
    if (!canConnect(source, target, stateRef.current).ok) return;
    callbacksRef.current.onConnect(source, target);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === SANDBOX_SHORTCUTS.rename.key) {
      if (
        keyboardShortcutsRef.current &&
        !pendingRef.current &&
        !event.defaultPrevented &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !(
          event.target instanceof Element &&
          event.target.closest(
            "input, textarea, select, [contenteditable='true']",
          )
        ) &&
        !document.querySelector('[role="dialog"], [role="alertdialog"]') &&
        editorRef.current === null &&
        stateRef.current.selectedCellId !== null
      ) {
        event.preventDefault();
        openEditorForSelection(stateRef.current.selectedCellId);
      }
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (
      ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    ) {
      if (target.closest("[data-field-id], input, select") !== null) return;
      const selectedId = stateRef.current.selectedCellId;
      const box =
        selectedId === null
          ? undefined
          : absoluteBoxes(nodesRef.current).get(selectedId);
      if (selectedId === null || box === undefined) return;
      event.preventDefault();
      const step =
        event.altKey || !snapEnabledRef.current ? 1 : SANDBOX_GRID_SIZE;
      settleGeometry(
        placeFlowNode(nodesRef.current, selectedId, {
          x:
            box.x +
            (event.key === "ArrowRight"
              ? step
              : event.key === "ArrowLeft"
                ? -step
                : 0),
          y:
            box.y +
            (event.key === "ArrowDown"
              ? step
              : event.key === "ArrowUp"
                ? -step
                : 0),
        }),
      );
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    const fieldId = target.getAttribute("data-field-id");
    if (fieldId) {
      event.preventDefault();
      callbacksRef.current.onSelect(fieldId);
      return;
    }
    const nodeId = target
      .closest("[data-sandbox-node]")
      ?.getAttribute("data-sandbox-node");
    if (nodeId) {
      event.preventDefault();
      callbacksRef.current.onSelect(nodeId);
    }
  }

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
    if (nextValue === "") return;
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
    const rawKind = dragKindFromTransfer(event.dataTransfer);
    if (rawKind === null) return;
    const point = flow.screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    });
    const resolution = resolveDrop(
      canvasBoxes(nodesRef.current),
      rawKind,
      point,
    );
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
        ? point
        : snapSandboxPosition(point),
    );
    if (commandFailed(result)) setDropError(result.error);
  }

  function handleCanvasDragOver(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const rawKind = dragKindFromTransfer(event.dataTransfer);
    if (rawKind === null) return;
    setPaletteDragKind(rawKind);
    const resolution = resolveDrop(
      canvasBoxes(nodesRef.current),
      rawKind,
      flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
    );
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

  // React Flow stores its handlers; stable ones keep a drag from updating
  // that store on every frame.
  const flowHandlers = useStableHandlers({
    onNodesChange: (changes: NodeChange<SandboxFlowNode>[]) =>
      commitNodes(applyNodeChanges(changes, nodesRef.current)),
    isValidConnection: (connection: Connection | Edge) =>
      connection.source !== connection.target,
    onConnect: handleConnect,
    onConnectStart: () => setConnecting(true),
    onConnectEnd: () => setConnecting(false),
    onNodeDragStart: (_: unknown, node: SandboxFlowNode) =>
      setMovingNodeId(node.id),
    onNodeDrag: (_: unknown, node: SandboxFlowNode) => {
      if (node.type === "module") setDropTargetId(moduleDepartmentAt(node.id));
    },
    onNodeDragStop: (_: unknown, node: SandboxFlowNode) => {
      setMovingNodeId(null);
      setDropTargetId(null);
      let next = nodesRef.current;
      if (node.type === "module") {
        const target = moduleDepartmentAt(node.id);
        const current = stateRef.current.modules.find(
          (item) => item.id === node.id,
        )?.departmentId;
        // A blank drop keeps the module's department; its frame grows to
        // hold it.
        if (target !== null && current !== undefined && target !== current) {
          next = reparentFlowNode(next, node.id, target);
          callbacksRef.current.onMove(node.id, target);
        }
      }
      settleGeometry(next);
    },
    onNodeClick: (event: ReactMouseEvent, node: SandboxFlowNode) => {
      containerRef.current?.focus({ preventScroll: true });
      showPressed(node.id);
      if (node.type !== "module") {
        callbacksRef.current.onSelect(node.id);
        return;
      }
      const element =
        event.target instanceof Element
          ? event.target.closest("[data-sandbox-node]")
          : null;
      const row =
        element === null
          ? -1
          : Math.floor(
              (nodePoint(
                element,
                event.clientX,
                event.clientY,
                MODULE_TABLE.width,
              ).y -
                MODULE_TABLE.headerHeight) /
                MODULE_TABLE.rowHeight,
            );
      callbacksRef.current.onSelect(
        (row >= 0 ? node.data.rows[row]?.id : undefined) ?? node.id,
      );
    },
    onEdgeClick: (_: unknown, edge: RelationshipFlowEdge) => {
      showPressed(edge.id);
      callbacksRef.current.onSelect(edge.id);
    },
    onPaneClick: () => {
      containerRef.current?.focus({ preventScroll: true });
      callbacksRef.current.onSelect(null);
      if (trace.clear()) callbacksRef.current.onTraceCleared?.();
    },
    onNodeMouseEnter: (_: unknown, node: SandboxFlowNode) => {
      if (canHover()) trace.hover(node.id);
    },
    onNodeMouseLeave: (_: unknown, node: SandboxFlowNode) =>
      trace.leave(node.id),
    onEdgeMouseEnter: (_: unknown, edge: RelationshipFlowEdge) => {
      if (canHover()) trace.hover(edge.id);
    },
    onEdgeMouseLeave: (_: unknown, edge: RelationshipFlowEdge) =>
      trace.leave(edge.id),
  });

  const snapToGrid = snapEnabled && !freeMove;

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
        data-snap-size={snapToGrid ? SANDBOX_GRID_SIZE : 1}
        aria-hidden="true"
        hidden={!gridVisible}
        className="pointer-events-none absolute inset-0"
        style={{
          // Dots, not lines: the grid guides placement without competing
          // with the diagram.
          backgroundImage: [
            `radial-gradient(circle, ${CANVAS_GRID} 1px, transparent 1.3px)`,
            `radial-gradient(circle, ${CANVAS_GRID_MAJOR} 1.3px, transparent 1.6px)`,
          ].join(", "),
          backgroundSize: [
            `${SANDBOX_GRID_SIZE}px ${SANDBOX_GRID_SIZE}px`,
            `${SANDBOX_GRID_MAJOR_SIZE}px ${SANDBOX_GRID_MAJOR_SIZE}px`,
          ].join(", "),
          // Shift both layers by half a minor cell so each dot sits on a
          // snap point and every major dot covers a minor one.
          backgroundPosition: `${-SANDBOX_GRID_SIZE / 2}px ${-SANDBOX_GRID_SIZE / 2}px, ${-SANDBOX_GRID_SIZE / 2}px ${-SANDBOX_GRID_SIZE / 2}px`,
        }}
      />
      <RelationshipMarkers />
      <div
        ref={containerRef}
        role="region"
        aria-label="Organization canvas"
        aria-describedby="sandbox-canvas-keyboard-alternative"
        tabIndex={0}
        data-connecting={connecting ? "true" : undefined}
        className="sandbox-flow focus-visible:ring-ring absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-inset"
        onKeyDown={handleKeyDown}
      >
        <SandboxCanvasActionsProvider value={actions}>
          <ReactFlow<SandboxFlowNode, RelationshipFlowEdge>
            ref={flowRootRef}
            nodes={nodes}
            edges={edges}
            nodeTypes={SANDBOX_NODE_TYPES}
            edgeTypes={SANDBOX_EDGE_TYPES}
            defaultViewport={{ x: 0, y: 0, zoom: 1 }}
            minZoom={SANDBOX_ZOOM.min}
            maxZoom={SANDBOX_ZOOM.max}
            snapToGrid={snapToGrid}
            snapGrid={SNAP_GRID}
            // Selection belongs to the Designer; the canvas draws it.
            elementsSelectable={false}
            selectNodesOnDrag={false}
            nodesFocusable={false}
            edgesFocusable={false}
            disableKeyboardA11y
            deleteKeyCode={null}
            selectionKeyCode={null}
            multiSelectionKeyCode={null}
            panActivationKeyCode={null}
            zoomOnDoubleClick={false}
            // Two-finger scroll pans; pinch or Ctrl/Cmd+scroll zooms.
            zoomOnScroll={false}
            panOnScroll
            zoomOnPinch
            zoomActivationKeyCode={["Meta", "Control"]}
            connectionMode={ConnectionMode.Loose}
            connectionLineType={ConnectionLineType.SmoothStep}
            connectionLineStyle={CONNECTION_LINE_STYLE}
            {...flowHandlers}
            proOptions={PRO_OPTIONS}
          />
        </SandboxCanvasActionsProvider>
      </div>
      {/* Pointer navigation aid; Fit and the Structure tab are the keyboard
          equivalents, so the minimap stays out of the accessibility tree. */}
      <div
        aria-hidden="true"
        className="sandbox-minimap border-border bg-card pointer-events-auto absolute right-3 bottom-3 z-10 hidden overflow-hidden rounded-md border shadow-sm sm:block"
      >
        <MiniMap<SandboxFlowNode>
          pannable
          ariaLabel={null}
          nodeClassName={minimapNodeClass}
          nodeBorderRadius={4}
          bgColor="var(--canvas-background)"
          maskColor="transparent"
          maskStrokeColor="var(--action)"
          maskStrokeWidth={2}
          style={{ width: 176, height: 112, margin: 0, position: "static" }}
        />
      </div>
      {state.modules.length > 0 ? (
        // Closed by default so the key never covers tables; it opens upward.
        <details className="group absolute bottom-3 left-3 z-10">
          <summary className="border-border bg-card text-muted-foreground hover:text-foreground flex min-h-6 cursor-pointer list-none items-center rounded-md border px-2.5 text-xs shadow-sm [&::-webkit-details-marker]:hidden">
            Key
          </summary>
          <ul
            aria-label="Canvas key"
            className="border-border bg-card text-muted-foreground absolute bottom-full left-0 mb-1 grid w-max grid-cols-2 gap-x-4 gap-y-1 rounded-md border px-2.5 py-2 text-xs shadow-sm"
          >
            {(
              [
                ["Relationship", "line", "relationship"],
                ["Handoff to another department", "line", "handoff"],
                ["Required field", "filled", null],
                ["Optional field", "hollow", null],
              ] as const
            ).map(([label, sample, kind]) => (
              <li key={label} className="flex items-center gap-2">
                <svg
                  aria-hidden="true"
                  width="24"
                  height="8"
                  className="shrink-0"
                >
                  {sample === "line" ? (
                    <line
                      // The same hooks as canvas lines, so each theme styles
                      // the sample like the real line; "key" skips the flow
                      // animation.
                      data-sandbox-line="key"
                      data-sandbox-edge-kind={kind ?? undefined}
                      x1="1"
                      y1="4"
                      x2="23"
                      y2="4"
                      stroke={
                        kind === "handoff"
                          ? "var(--canvas-edge)"
                          : "var(--action)"
                      }
                      strokeWidth="1.6"
                      strokeLinecap="round"
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
            <li className="border-border col-span-2 max-w-72 border-t pt-1">
              A module is a list of one kind of record. A line links records in
              two modules.
            </li>
          </ul>
        </details>
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
