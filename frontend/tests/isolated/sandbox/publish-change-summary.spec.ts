import { expect, test } from "@playwright/test";

import { publicationChangeSummary } from "../../../src/components/systems/sandbox/components/publish-change-groups";

const change = (kind: "department" | "module", action: "create" | "update") =>
  ({ kind, action, sandboxId: `${kind}-${action}`, label: kind }) as const;

test("a review summary names each kind and, when shared, the one action", () => {
  expect(
    publicationChangeSummary([
      change("department", "create"),
      change("module", "create"),
      { ...change("module", "create"), sandboxId: "second" },
    ]),
  ).toBe("3 changes, all new: 1 department, 2 modules");
  expect(
    publicationChangeSummary([
      change("department", "create"),
      change("module", "update"),
    ]),
  ).toBe("2 changes: 1 department, 1 module");
});
