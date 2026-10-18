import { expect, test } from "@playwright/test";

import {
  labelSize,
  pathPoints,
  placeLineLabels,
  pointAlong,
  type LabelledLine,
} from "../../../src/components/sandbox/sandbox-canvas-labels";

// Line labels move off shared corridors, tables, and each other, as X6's
// placement did. The canvas rebuilds each line from node geometry, so these
// rules run without a DOM.

test("a smoothstep path reads back as its corner points", () => {
  const d = "M10 20L42 20Q50 20 50 28L50 92Q50 100 58 100L90 100";
  expect(pathPoints(d)).toEqual([
    { x: 10, y: 20 },
    { x: 42, y: 20 },
    { x: 50, y: 20 },
    { x: 50, y: 28 },
    { x: 50, y: 92 },
    { x: 50, y: 100 },
    { x: 58, y: 100 },
    { x: 90, y: 100 },
  ]);
});

test("a share of a line is measured along its length", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ];
  expect(pointAlong(points, 0.25)).toEqual({ x: 50, y: 0 });
  expect(pointAlong(points, 0.75)).toEqual({ x: 100, y: 50 });
  expect(pointAlong(points, 1)).toEqual({ x: 100, y: 100 });
});

function straight(id: string, y: number, label: string | null): LabelledLine {
  return {
    id,
    points: [
      { x: 0, y },
      { x: 400, y },
    ],
    label: label === null ? null : labelSize(label),
  };
}

test("a lone label keeps the middle of its line", () => {
  const stops = placeLineLabels([straight("a", 0, "places")], []);
  expect(stops.get("a")).toBe(0.5);
});

test("two labels on one corridor never sit on top of each other", () => {
  const stops = placeLineLabels(
    [straight("a", 0, "Stock counts"), straight("b", 4, "Stock counts")],
    [],
  );
  expect(stops.get("a")).toBe(0.5);
  expect(stops.get("b")).not.toBe(0.5);
});

test("a label moves off a table that covers the middle of its line", () => {
  const table = { x: 195, y: -20, width: 10, height: 40 };
  const stops = placeLineLabels([straight("a", 0, "Goods receipt")], [table]);
  expect(stops.get("a")).toBe(0.35);
});

test("a label moves off another line that crosses its middle", () => {
  const crossing: LabelledLine = {
    id: "cross",
    points: [
      { x: 200, y: -100 },
      { x: 200, y: 100 },
    ],
    label: null,
  };
  const stops = placeLineLabels([straight("a", 0, "Product"), crossing], []);
  expect(stops.get("a")).toBe(0.35);
  expect(stops.has("cross")).toBe(false);
});
