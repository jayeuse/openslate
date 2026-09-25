import { Graph, History, Selection, Snapline } from "@antv/x6";
import { graphOptions } from "@/lib/sandbox/x6-adapter";

export function createSandboxCanvasRuntime(
  container: HTMLElement,
  gridSize: number,
) {
  const graph = new Graph({
    container,
    ...graphOptions(gridSize),
  });
  graph.use(new Selection({ enabled: true }));
  graph.use(new Snapline());
  const history = new History();
  graph.use(history);
  return { graph, history };
}
