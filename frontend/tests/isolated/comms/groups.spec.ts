import { expect, test } from "@playwright/test";
import { visibleToLabel } from "../../../src/components/systems/comms/domain/groups";

test("a channel open to groups whose names are not loaded is not labelled private", () => {
  // Group names load only for managers with an editor open; a reload has none.
  expect(visibleToLabel({ everyone: "none", "group-1": "post" }, [])).toBe(
    "Visible to selected groups",
  );
  expect(visibleToLabel({ everyone: "none", "group-1": "none" }, [])).toBe(
    "Private conversation",
  );
});
