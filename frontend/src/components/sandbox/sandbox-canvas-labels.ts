import { useSyncExternalStore } from "react";

import type { CanvasBox } from "@/lib/sandbox/canvas-geometry";

/** Where along its line a label may sit, in order of preference. */
export const LABEL_STOPS = [0.5, 0.35, 0.65, 0.2, 0.8] as const;
/** Canvas units between samples when checking a line against a label. */
const SAMPLE_STEP = 6;

type Point = { x: number; y: number };

/** A labelled line, as drawn: its path and its label's size (canvas units). */
export interface PlacedLine {
  id: string;
  /** Point at a share (0–1) of the line's length. */
  pointAt: (share: number) => Point;
  samples: readonly Point[];
  label: { width: number; height: number } | null;
}

function crossed(box: CanvasBox, samples: readonly Point[]): boolean {
  return samples.some(
    (point) =>
      point.x > box.x &&
      point.x < box.x + box.width &&
      point.y > box.y &&
      point.y < box.y + box.height,
  );
}

function overlaps(a: CanvasBox, b: CanvasBox): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * Line labels default to the middle of their line, where lines often share a
 * corridor and the labels stack or get struck through. Each label takes the
 * first stop along its line that no other line crosses, no table covers, and
 * no placed label overlaps; failing that, the first stop clear of placed
 * labels; failing that, the middle.
 */
export function placeLineLabels(
  lines: readonly PlacedLine[],
  tables: readonly CanvasBox[],
): Map<string, number> {
  const stops = new Map<string, number>();
  const placed: CanvasBox[] = [];
  for (const line of lines) {
    if (line.label === null) continue;
    const { width, height } = line.label;
    const boxAt = (share: number): CanvasBox => {
      const point = line.pointAt(share);
      return {
        x: point.x - width / 2,
        y: point.y - height / 2,
        width,
        height,
      };
    };
    const others = lines.filter((item) => item.id !== line.id);
    const clearOfLabels = (box: CanvasBox) =>
      !placed.some((other) => overlaps(box, other));
    const stop =
      LABEL_STOPS.find((share) => {
        const box = boxAt(share);
        return (
          clearOfLabels(box) &&
          !others.some((other) => crossed(box, other.samples)) &&
          !tables.some((table) => overlaps(box, table))
        );
      }) ??
      LABEL_STOPS.find((share) => clearOfLabels(boxAt(share))) ??
      0.5;
    stops.set(line.id, stop);
    placed.push(boxAt(stop));
  }
  return stops;
}

/** Reads a drawn line's geometry from its SVG path. */
export function lineFromPath(
  id: string,
  path: SVGPathElement,
  label: { width: number; height: number } | null,
): PlacedLine {
  const length = path.getTotalLength();
  const count = Math.max(2, Math.ceil(length / SAMPLE_STEP));
  const samples: Point[] = [];
  for (let index = 0; index <= count; index += 1) {
    const point = path.getPointAtLength((length * index) / count);
    samples.push({ x: point.x, y: point.y });
  }
  return {
    id,
    pointAt: (share) => {
      const point = path.getPointAtLength(length * share);
      return { x: point.x, y: point.y };
    },
    samples,
    label,
  };
}

/** Each line's label stop; a line re-renders only when its own stop moves. */
export class LineLabelStops {
  private listeners = new Set<() => void>();
  private stops = new Map<string, number>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  stopOf(lineId: string): number {
    return this.stops.get(lineId) ?? 0.5;
  }

  set(next: ReadonlyMap<string, number>): void {
    const changed =
      next.size !== this.stops.size ||
      [...next].some(([id, stop]) => this.stops.get(id) !== stop);
    if (!changed) return;
    this.stops = new Map(next);
    for (const listener of this.listeners) listener();
  }
}

export function useLineLabelStop(
  store: LineLabelStops,
  lineId: string,
): number {
  return useSyncExternalStore(
    store.subscribe,
    () => store.stopOf(lineId),
    () => 0.5,
  );
}
