import { Graph, History, MiniMap, Selection, Snapline } from "@antv/x6";
import { graphOptions } from "@/lib/sandbox/x6-adapter";

export function createSandboxCanvasRuntime(
  container: HTMLElement,
  gridSize: number,
  minimapContainer: HTMLElement | null = null,
) {
  const graph = new Graph({
    container,
    ...graphOptions(gridSize),
  });
  graph.use(new Selection({ enabled: true }));
  graph.use(new Snapline());
  if (minimapContainer)
    graph.use(
      new MiniMap({
        container: minimapContainer,
        width: 176,
        height: 112,
        padding: 8,
      }),
    );
  const history = new History();
  graph.use(history);
  return { graph, history };
}
