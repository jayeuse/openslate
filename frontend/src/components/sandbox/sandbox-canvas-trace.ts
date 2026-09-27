import type { Cell, Graph } from "@antv/x6";
import type { SandboxState } from "@/lib/sandbox/model";

/**
 * The cells tied to a hovered module or relationship: the module, the
 * relationships that touch it, and the modules at their other ends. Returns
 * null for anything else, such as a department frame.
 */
export function tracedCellIds(
  state: SandboxState,
  cellId: string,
): Set<string> | null {
  const link = state.links.find((item) => item.id === cellId);
  if (link) return new Set([link.id, link.sourceModuleId, link.targetModuleId]);
  if (!state.modules.some((item) => item.id === cellId)) return null;
  const traced = new Set([cellId]);
  for (const item of state.links) {
    if (item.sourceModuleId !== cellId && item.targetModuleId !== cellId)
      continue;
    traced.add(item.id);
    traced.add(item.sourceModuleId);
    traced.add(item.targetModuleId);
  }
  return traced;
}

export type SandboxCanvasTrace = {
  /** Reapply the marks after a sync, which can re-render cell views. */
  refresh: () => void;
  /**
   * Trace a cell while nothing is hovered, for "Show on canvas" from another
   * view. A blank click clears it. Null clears it too.
   */
  pin: (cellId: string | null) => void;
  /**
   * Marks field rows (by canvas field id) for a Test run: "trigger" or
   * "changed". Null clears the marks. Marks survive re-renders.
   */
  markFields: (marks: Readonly<Record<string, string>> | null) => void;
  dispose: () => void;
};

/**
 * Hovering a module or relationship marks its connections `data-trace="on"`
 * and fades other modules and relationships (`data-trace="dim"`). Department
 * frames stay as context. The page CSS animates opacity only. A pinned cell
 * traces the same way whenever nothing is hovered.
 */
export function bindSandboxCanvasTrace({
  graph,
  state,
  onPinCleared,
}: {
  graph: Graph;
  state: { readonly current: SandboxState };
  /** A click on empty canvas cleared a pinned trace. */
  onPinCleared?: () => void;
}): SandboxCanvasTrace {
  let hovered: string | null = null;
  let pinned: string | null = null;
  let fieldMarks: Readonly<Record<string, string>> | null = null;
  const departmentIds = () =>
    new Set(state.current.departments.map((item) => item.id));

  const refresh = () => {
    const target = hovered ?? pinned;
    const traced =
      target === null ? null : tracedCellIds(state.current, target);
    const departments = departmentIds();
    for (const cell of graph.getCells()) {
      const container = graph.findViewByCell(cell)?.container;
      if (!container) continue;
      for (const row of container.querySelectorAll("[data-field-id]")) {
        const mark = fieldMarks?.[row.getAttribute("data-field-id") ?? ""];
        if (mark) {
          row.setAttribute("data-test-mark", mark);
          // Say the mark too, not only show it.
          row.setAttribute(
            "aria-description",
            [
              mark.includes("trigger") ? "started the test" : "",
              mark.includes("changed") ? "changed in the test" : "",
            ]
              .filter(Boolean)
              .join(", "),
          );
        } else {
          row.removeAttribute("data-test-mark");
          row.removeAttribute("aria-description");
        }
      }
      if (traced === null || departments.has(cell.id))
        container.removeAttribute("data-trace");
      else
        container.setAttribute(
          "data-trace",
          traced.has(cell.id) ? "on" : "dim",
        );
    }
  };
  // A tap on a touch screen fires an emulated mouseenter with no leave, which
  // would leave the canvas faded after a selection, so only a hovering
  // pointer traces.
  const canHover = () =>
    window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const enter = ({ cell }: { cell: Cell }) => {
    if (!canHover()) return;
    hovered = cell.id;
    refresh();
  };
  const clear = () => {
    if (hovered === null && pinned === null) return;
    const wasPinned = pinned !== null;
    hovered = null;
    pinned = null;
    fieldMarks = null;
    refresh();
    if (wasPinned) onPinCleared?.();
  };
  // Moving from a department frame onto a module inside it can fire the
  // frame's leave after the module's enter, so only the hovered cell clears.
  const leave = ({ cell }: { cell: Cell }) => {
    if (hovered !== cell.id) return;
    hovered = null;
    refresh();
  };

  graph.on("cell:mouseenter", enter);
  graph.on("cell:mouseleave", leave);
  graph.on("blank:click", clear);
  return {
    refresh,
    pin: (cellId) => {
      pinned = cellId;
      refresh();
    },
    markFields: (marks) => {
      fieldMarks = marks;
      refresh();
    },
    dispose: () => {
      graph.off("cell:mouseenter", enter);
      graph.off("cell:mouseleave", leave);
      graph.off("blank:click", clear);
    },
  };
}
