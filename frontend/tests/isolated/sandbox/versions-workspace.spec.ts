import { expect, test } from "@playwright/test";
import {
  canonicalVersionChanges,
  versionCompareHint,
} from "../../../src/components/systems/sandbox/components/versions-workspace";
import type { SandboxVersion } from "../../../src/components/systems/sandbox/state/api";
import type { SandboxDocumentV4 } from "../../../src/components/systems/sandbox/domain/document";

function document(): SandboxDocumentV4 {
  return {
    kind: "openslate-sandbox",
    schemaVersion: 4,
    design: { departments: [], modules: [], relationships: [], layout: {} },
    triggers: [
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

test("version comparison includes changes in every canonical trigger condition and action", () => {
  const before = document();
  const after = structuredClone(before);
  after.triggers[0].conditionGroup.conditions.push({
    id: "second",
    field: { moduleId: "requests", fieldId: "priority" },
    operator: ">=",
    value: { kind: "literal", value: 2 },
  });
  after.triggers[0].actions.push({
    id: "task",
    kind: "assign-task",
    assignee: "Operations",
  });

  const changes = canonicalVersionChanges(before, after);
  expect(
    changes.filter((change) => change === "Trigger changed: Notify team"),
  ).toHaveLength(1);
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

test("the compare hint names the chosen pair instead of asking for two versions", () => {
  const versions = [
    { id: "first", label: "Before import", sequence: 2 },
    { id: "second", label: "Published", sequence: 5 },
  ] as SandboxVersion[];

  expect(versionCompareHint(versions.slice(0, 1), "first", "first")).toBe(
    "Save at least two versions to compare them.",
  );
  expect(versionCompareHint(versions, "first", "first")).toBe(
    "Choose two different versions to compare.",
  );
  expect(versionCompareHint(versions, "first", "second")).toBe(
    "Ready to compare Before import (v2) with Published (v5).",
  );
});
