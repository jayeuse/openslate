import { useSyncExternalStore } from "react";
import { getSmoothStepPath, Position } from "@xyflow/react";

import type { CanvasBox } from "@/lib/sandbox/canvas-geometry";
import {
  absoluteBoxes,
  PORT_SIZE,
  type RelationshipFlowEdge,
  type SandboxFlowNode,
} from "./sandbox-flow-model";

/** Where along its line a label may sit, in order of preference. */
export const LABEL_STOPS = [0.5, 0.35, 0.65, 0.2, 0.8] as const;
/** Canvas units between samples when checking a line against a label. */
const SAMPLE_STEP = 6;
/** The shape every relationship line takes (React Flow smoothstep). */
export const LINE_PATH = { borderRadius: 8, offset: 24 } as const;

export type Point = { x: number; y: number };

/**
 * The corner points of a smoothstep path. Its bends are short curves around
 * each corner, so the corners themselves trace the line to within a few
 * canvas units, with no DOM reads.
 */
export function pathPoints(d: string): Point[] {
  const numbers = (d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
  const points: Point[] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    const point = { x: numbers[index]!, y: numbers[index + 1]! };
    const last = points.at(-1);
    if (last === undefined || last.x !== point.x || last.y !== point.y)
      points.push(point);
  }
  return points;
}

function segmentLengths(points: readonly Point[]): number[] {
  return points
    .slice(1)
    .map((point, index) =>
      Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y),
    );
}

/** The point at a share (0–1) of the line's length. */
export function pointAlong(points: readonly Point[], share: number): Point {
  const first = points[0];
  if (first === undefined) return { x: 0, y: 0 };
  const lengths = segmentLengths(points);
  let remaining = lengths.reduce((sum, length) => sum + length, 0) * share;
  for (const [index, length] of lengths.entries()) {
    const start = points[index]!;
    const end = points[index + 1]!;
    if (remaining <= length && length > 0) {
      const t = remaining / length;
      return {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
      };
    }
    remaining -= length;
  }
  return points.at(-1) ?? first;
}

function samplesOf(points: readonly Point[]): Point[] {
  const samples: Point[] = [];
  for (const [index, length] of segmentLengths(points).entries()) {
    const start = points[index]!;
    const end = points[index + 1]!;
    const count = Math.max(1, Math.ceil(length / SAMPLE_STEP));
    for (let step = 0; step < count; step += 1) {
      const t = step / count;
      samples.push({
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
      });
    }
  }
  const last = points.at(-1);
  if (last !== undefined) samples.push(last);
  return samples;
}

/** A line and its label's size, in canvas units. */
export interface LabelledLine {
  id: string;
  points: readonly Point[];
  label: { width: number; height: number } | null;
}

/** The label pill's size from its 12px text and 7px/3px padding. */
export function labelSize(text: string): { width: number; height: number } {
  return { width: text.length * 6.6 + 14, height: 21 };
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
  lines: readonly LabelledLine[],
  tables: readonly CanvasBox[],
): Map<string, number> {
  const samples = new Map(
    lines.map((line) => [line.id, samplesOf(line.points)]),
  );
  const stops = new Map<string, number>();
  const placed: CanvasBox[] = [];
  for (const line of lines) {
    if (line.label === null) continue;
    const { width, height } = line.label;
    const boxAt = (share: number): CanvasBox => {
      const point = pointAlong(line.points, share);
      return {
        x: point.x - width / 2,
        y: point.y - height / 2,
        width,
        height,
      };
    };
    const clearOfLabels = (box: CanvasBox) =>
      !placed.some((other) => overlaps(box, other));
    const stop =
      LABEL_STOPS.find((share) => {
        const box = boxAt(share);
        return (
          clearOfLabels(box) &&
          !lines.some(
            (other) =>
              other.id !== line.id && crossed(box, samples.get(other.id) ?? []),
          ) &&
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

/**
 * Each line's label stop for the canvas as it stands: lines are rebuilt from
 * node geometry exactly as React Flow draws them, between the module ports.
 */
export function lineLabelStops(
  nodes: readonly SandboxFlowNode[],
  edges: readonly RelationshipFlowEdge[],
): Map<string, number> {
  const boxes = absoluteBoxes(nodes);
  const tables = nodes.flatMap((node) => {
    const box = node.type === "module" ? boxes.get(node.id) : undefined;
    return box ? [box] : [];
  });
  const lines = edges.flatMap((edge): LabelledLine[] => {
    const source = boxes.get(edge.source);
    const target = boxes.get(edge.target);
    if (source === undefined || target === undefined) return [];
    const [d] = getSmoothStepPath({
      sourceX: source.x + source.width + PORT_SIZE / 2,
      sourceY: source.y + source.height / 2,
      sourcePosition: Position.Right,
      targetX: target.x - PORT_SIZE / 2,
      targetY: target.y + target.height / 2,
      targetPosition: Position.Left,
      ...LINE_PATH,
    });
    const text = edge.data?.label ?? "";
    return [
      {
        id: edge.id,
        points: pathPoints(d),
        label: text === "" ? null : labelSize(text),
      },
    ];
  });
  return placeLineLabels(lines, tables);
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
