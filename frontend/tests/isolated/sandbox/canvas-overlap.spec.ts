import { expect, test } from "@playwright/test";
import {
  canvasBoxes,
  canvasOverlaps,
  deriveFlowNodes,
} from "../../../src/components/sandbox/sandbox-flow-model";
import { projectDesign } from "../../../src/components/systems/sandbox/helpers/bridge";
import { arrangedLayout } from "../../../src/components/systems/sandbox/helpers/designer-layout";
import {
  compactDefaultLayout,
  type Design,
} from "../../../src/components/systems/sandbox/domain/model";
import { projectSandboxDocument } from "../../../src/components/systems/sandbox/domain/document-bridge";
import {
  configuredSandboxDesign,
  overlappingSandboxDesign,
  sandboxDocumentFromDesign,
} from "../../helpers/sandbox-fixtures";

// Phase 3 of the Sandbox follow-up pass (docs/specs/sandbox-followup-pass.md):
// overlapping frames and tables are found, and Auto-arrange never makes one.

/** The overlaps of a design as the canvas draws it after a load. */
function drawnOverlaps(design: Design) {
  const loaded = projectSandboxDocument(sandboxDocumentFromDesign(design));
  return canvasOverlaps(
    canvasBoxes(
      deriveFlowNodes({
        state: projectDesign(loaded, null),
        previous: [],
        layout: loaded.layout ?? compactDefaultLayout,
      }),
    ),
  );
}

const box = (x: number, y: number) => ({ x, y, width: 100, height: 100 });

test("frames and tables that cover each other are found; touching edges are not", () => {
  expect(
    canvasOverlaps({
      departments: [
        { id: "a", box: box(0, 0) },
        { id: "b", box: box(100, 0) },
        { id: "c", box: box(199, 0) },
      ],
      modules: [
        { id: "m1", departmentId: "a", box: box(0, 0) },
        { id: "m2", departmentId: "b", box: box(0, 100) },
        { id: "m3", departmentId: "b", box: box(50, 150) },
      ],
    }),
  ).toEqual({ departments: [["b", "c"]], modules: [["m2", "m3"]] });
});

test("the overlap test draft overlaps, and the default test draft does not", () => {
  expect(drawnOverlaps(overlappingSandboxDesign)).toEqual({
    departments: [["sample-operations", "sample-commercial"]],
    modules: [],
  });
  expect(drawnOverlaps(configuredSandboxDesign)).toEqual({
    departments: [],
    modules: [],
  });
});

test("Auto-arrange spaces rows by the drawn table height", () => {
  const design = structuredClone(configuredSandboxDesign);
  const requests = design.modules[0]!;
  for (let index = 1; index <= 8; index++)
    requests.fields.push({
      ...requests.fields[1]!,
      id: `extra-${index}`,
      name: `Extra ${index}`,
    });
  design.modules.push({
    ...structuredClone(design.modules[1]!),
    id: "sample-parts",
    name: "Parts",
  });
  // Row one holds a 12-field table; row two must start below it.
  const arranged = { ...design, layout: arrangedLayout(design) };
  expect(
    canvasOverlaps(
      canvasBoxes(
        deriveFlowNodes({
          state: projectDesign(arranged, null),
          previous: [],
          layout: arranged.layout,
        }),
      ),
    ),
  ).toEqual({ departments: [], modules: [] });
});
