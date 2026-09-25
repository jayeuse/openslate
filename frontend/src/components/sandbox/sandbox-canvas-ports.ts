import type { Graph, History, Node } from "@antv/x6";
import type { SandboxState } from "@/lib/sandbox/model";

type MutableCurrent<T> = { current: T };

interface PortInteractionOptions {
  graph: Graph;
  history: History;
  container: HTMLElement;
  state: MutableCurrent<SandboxState>;
}

export function bindSandboxCanvasPortInteractions({
  graph,
  history,
  container,
  state,
}: PortInteractionOptions): () => void {
  let connectingPorts = false;
  const portSelected = (node: Node): boolean =>
    state.current.selectedCellId === node.id ||
    state.current.fields.some(
      (field) =>
        field.moduleId === node.id && field.id === state.current.selectedCellId,
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
    for (const node of graph.getNodes()) revealPorts(node, portSelected(node));
  };
  container.addEventListener("pointerdown", beginConnection, true);
  window.addEventListener("pointerup", endConnection);
  window.addEventListener("pointercancel", endConnection);
  graph.on("node:mouseenter", ({ node }) => revealPorts(node, true));
  graph.on("node:mouseleave", ({ node }) =>
    revealPorts(node, connectingPorts || portSelected(node)),
  );

  return () => {
    container.removeEventListener("pointerdown", beginConnection, true);
    window.removeEventListener("pointerup", endConnection);
    window.removeEventListener("pointercancel", endConnection);
  };
}
