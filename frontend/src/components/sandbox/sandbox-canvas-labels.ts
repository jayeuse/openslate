import type { Edge, EdgeView, Graph } from "@antv/x6";

/** Where along its line a label may sit, in order of preference. */
const LABEL_STOPS = [0.5, 0.35, 0.65, 0.2, 0.8] as const;
/** Canvas units between samples when checking a line against a label. */
const SAMPLE_STEP = 6;

type Box = { x: number; y: number; width: number; height: number };
type Sample = { x: number; y: number };

function pathSamples(view: EdgeView): Sample[] {
  const path = view.getConnection();
  if (!path) return [];
  const length = path.length();
  const count = Math.max(2, Math.ceil(length / SAMPLE_STEP));
  const samples: Sample[] = [];
  for (let i = 0; i <= count; i += 1) {
    const point = path.pointAtLength((length * i) / count) as Sample | null;
    if (point) samples.push(point);
  }
  return samples;
}

function crossed(box: Box, samples: readonly Sample[]): boolean {
  return samples.some(
    (point) =>
      point.x > box.x &&
      point.x < box.x + box.width &&
      point.y > box.y &&
      point.y < box.y + box.height,
  );
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * Line labels default to the middle of their line, where other lines often
 * cross in a shared corridor and strike the text through. Each labelled line
 * moves its label to the first stop along the line that no other line
 * crosses and no module covers, and keeps the middle when every stop is
 * blocked. Runs inside the
 * canvas sync, with history disabled, so it adds no undo step.
 */
export function placeEdgeLabels(graph: Graph): void {
  const edges = graph.getEdges();
  const modules: Box[] = graph
    .getNodes()
    .filter((node) => !node.getChildren()?.length && node.getParent() !== null)
    .map((node) => node.getBBox());
  const samples = new Map<string, Sample[]>();
  const views = new Map<string, EdgeView>();
  for (const edge of edges) {
    const view = graph.findViewByCell(edge) as EdgeView | null;
    if (!view) continue;
    views.set(edge.id, view);
    samples.set(edge.id, pathSamples(view));
  }
  for (const edge of edges) {
    const label = edge.getLabelAt(0);
    const view = views.get(edge.id);
    if (!label || !view) continue;
    const text = String(
      (label.attrs?.label as { text?: unknown } | undefined)?.text ?? "",
    );
    // Approximate the label box from its 12px text and its 5px/3px padding.
    const width = text.length * 6.6 + 10;
    const height = 20;
    const path = view.getConnection();
    if (!path) continue;
    const others = edges
      .filter((item: Edge) => item.id !== edge.id)
      .map((item) => samples.get(item.id) ?? []);
    const stop =
      LABEL_STOPS.find((ratio) => {
        const point = path.pointAt(ratio) as Sample | null;
        if (!point) return false;
        const box = {
          x: point.x - width / 2,
          y: point.y - height / 2,
          width,
          height,
        };
        return (
          !others.some((line) => crossed(box, line)) &&
          !modules.some((module) => overlaps(box, module))
        );
      }) ?? 0.5;
    const current = (label.position as { distance?: number } | undefined)
      ?.distance;
    if (current === stop || (current === undefined && stop === 0.5)) continue;
    edge.setLabelAt(0, { ...label, position: { distance: stop } });
  }
}
