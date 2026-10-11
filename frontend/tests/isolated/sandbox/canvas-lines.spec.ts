import { expect, test } from "@playwright/test";
import { relationshipLineAttrs } from "../../../src/lib/sandbox/x6-adapter";

// A relationship inside one department is a dashed line; a handoff to another
// department is solid. Selection does not change the kind. The http test "a
// line to another department is drawn as a handoff" owns the drawn lines in
// each look and the Canvas key.

for (const row of [
  { selected: false, handoff: false, kind: "relationship", dashed: true },
  { selected: true, handoff: false, kind: "relationship", dashed: true },
  { selected: false, handoff: true, kind: "handoff", dashed: false },
  { selected: true, handoff: true, kind: "handoff", dashed: false },
]) {
  test(`a ${row.selected ? "selected" : "plain"} ${row.kind} line is ${row.dashed ? "dashed" : "solid"}`, () => {
    const line = relationshipLineAttrs(row.selected, row.handoff);
    expect(line["data-sandbox-edge-kind"]).toBe(row.kind);
    expect(line.strokeDasharray !== "").toBe(row.dashed);
  });
}
