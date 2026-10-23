import { expect, test } from "@playwright/test";

import { relationshipKind } from "../../../src/components/systems/sandbox/domain/model";

// Plain words for a relationship kind (docs/specs/sandbox-relayout.md, Phase 7
// G1): the stored value stays; only the shown words and hint change.
test("each relationship kind shows plain words and a hint", () => {
  expect(relationshipKind("One-to-one")).toEqual({
    label: "One match each",
    hint: "Each item has one match",
  });
  expect(relationshipKind("One-to-many")).toEqual({
    label: "Many matches",
    hint: "One item can have many matches",
  });
  expect(relationshipKind("Many-to-many")).toEqual({
    label: "Many on both sides",
    hint: "Items can have many matches",
  });
  // A value the page does not know shows as stored, with no hint.
  expect(relationshipKind("Legacy")).toEqual({ label: "Legacy", hint: null });
});
