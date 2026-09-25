import type { Graph, History, Node } from "@antv/x6";
import { SANDBOX_GRID_SIZE } from "@/lib/sandbox/x6-adapter";
import { nodeKindOf, updateDepartmentSizeAttrs } from "./sandbox-canvas-graph";

type MutableCurrent<T> = { current: T };

interface ResizeInteractionOptions {
  graph: Graph;
  history: History;
  container: HTMLElement;
  snapEnabled: MutableCurrent<boolean>;
  emitLayout: () => Promise<void>;
}

export function bindSandboxCanvasResizeInteractions({
  graph,
  history,
  container,
  snapEnabled,
  emitLayout,
}: ResizeInteractionOptions): () => void {
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
    if (!view?.cell.isNode() || nodeKindOf(view.cell) !== "department") return;
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
    void emitLayout();
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
    const step = event.altKey || !snapEnabled.current ? 1 : SANDBOX_GRID_SIZE;
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
    void emitLayout();
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
  return () => {
    container.removeEventListener("pointerdown", resizePointerDown, true);
    window.removeEventListener("pointermove", resizePointerMove, true);
    window.removeEventListener("pointerup", resizePointerEnd, true);
    window.removeEventListener("pointercancel", resizePointerEnd, true);
    container.removeEventListener("keydown", resizeKeyDown, true);
    container.removeEventListener("mousedown", swallowResizeMouse, true);
    container.removeEventListener("click", swallowResizeMouse, true);
    container.removeEventListener("dblclick", swallowResizeMouse, true);
  };
}
