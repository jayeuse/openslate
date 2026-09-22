import { expect, test } from "@playwright/test";
import {
  canonicalVersionChanges,
  validVersionSelection,
} from "../../../src/components/systems/sandbox/components/versions-workspace";
import type { SandboxVersion } from "../../../src/components/systems/sandbox/state/api";
import type { SandboxDocumentV2 } from "../../../src/components/systems/sandbox/domain/document";

function document(): SandboxDocumentV2 {
  return {
    kind: "openslate-sandbox",
    schemaVersion: 2,
    design: { departments: [], modules: [], relationships: [], layout: {} },
    automations: [
      {
        id: "notify",
        name: "Notify team",
        enabled: true,
        priority: 0,
        trigger: { kind: "schedule", frequency: "daily", time: "09:00" },
        conditionGroup: {
          operator: "all",
          conditions: [
            {
              id: "first",
              field: { moduleId: "requests", fieldId: "status" },
              operator: "=",
              value: { kind: "literal", value: "Open" },
            },
          ],
        },
        actions: [{ id: "message", kind: "notification", message: "Open" }],
      },
    ],
    scenarios: [],
  };
}

test("version comparison includes changes in every canonical automation condition and action", () => {
  const before = document();
  const after = structuredClone(before);
  after.automations[0].conditionGroup.conditions.push({
    id: "second",
    field: { moduleId: "requests", fieldId: "priority" },
    operator: ">=",
    value: { kind: "literal", value: 2 },
  });
  after.automations[0].actions.push({
    id: "task",
    kind: "assign-task",
    assignee: "Operations",
  });

  expect(canonicalVersionChanges(before, after)).toContain(
    "Automation changed: Notify team",
  );
});

test("version comparison includes canonical scenario changes", () => {
  const before = document();
  before.scenarios = [
    { id: "baseline", name: "Baseline", records: [], links: [] },
  ];
  const after = structuredClone(before);
  after.scenarios[0].name = "Updated baseline";

  expect(canonicalVersionChanges(before, after)).toContain(
    "Scenario changed: Updated baseline",
  );
});

test("version selections recover when history is added or a selection disappears", () => {
  const versions = [{ id: "first" }, { id: "second" }] as SandboxVersion[];

  expect(validVersionSelection([], "", "first")).toBe("");
  expect(validVersionSelection(versions, "", "first")).toBe("first");
  expect(validVersionSelection(versions, "deleted", "last")).toBe("second");
  expect(validVersionSelection(versions, "first", "last")).toBe("first");
});
