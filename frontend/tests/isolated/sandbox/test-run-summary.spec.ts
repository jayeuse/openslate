import { expect, test } from "@playwright/test";

import { summarizeTestRun } from "../../../src/components/systems/sandbox/domain/test-run-summary";
import type {
  SandboxAutomation,
  SandboxDocumentDesign,
} from "../../../src/components/systems/sandbox/domain/document";
import type { SandboxTestRun } from "../../../src/components/systems/sandbox/state/api";

const design = {
  departments: [],
  relationships: [],
  layout: {},
  modules: [
    {
      id: "orders",
      departmentId: "sales",
      name: "Orders",
      closed: false,
      fields: [{ id: "total", name: "Order total", closed: false }],
    },
  ],
} as unknown as SandboxDocumentDesign;

const automations = [
  { id: "alert", name: "Urgent request alert" },
] as unknown as SandboxAutomation[];

function run(
  overrides: Partial<SandboxTestRun> & {
    issues?: SandboxTestRun["result"]["issues"];
  } = {},
): SandboxTestRun {
  const { issues = [], ...rest } = overrides;
  return {
    id: "run-1",
    createdAt: "2026-09-27T00:00:00Z",
    documentRevision: 4,
    input: { moduleId: "orders", values: {} },
    event: { kind: "record-created" },
    automationIds: null,
    result: { values: {}, routes: [], automationTraces: [], issues },
    ...rest,
  } as SandboxTestRun;
}

test("a run from the current draft is not stale", () => {
  expect(summarizeTestRun(run(), design, automations, 4).stale).toBeNull();
});

test("a run from an older draft says so", () => {
  expect(summarizeTestRun(run(), design, automations, 5).stale).toBe(
    "older-draft",
  );
});

test("a run whose module was removed or closed says so, whatever the revision", () => {
  const removed = { ...design, modules: [] };
  expect(summarizeTestRun(run(), removed, automations, 4).stale).toBe(
    "module-gone",
  );
  const closed = {
    ...design,
    modules: [{ ...design.modules[0]!, closed: true }],
  };
  expect(summarizeTestRun(run(), closed, automations, 5).stale).toBe(
    "module-gone",
  );
});

test("repeated issues collapse into one line with a count", () => {
  const same = {
    code: "automation_invalid",
    message: "A set field action has an invalid value.",
    targetId: "alert",
  };
  const summary = summarizeTestRun(
    run({ issues: [same, same, same] }),
    design,
    automations,
    4,
  );
  expect(summary.issues).toHaveLength(1);
  expect(summary.issues[0]).toMatchObject({ count: 3, message: same.message });
});

test("each issue names what it is about when the target still exists", () => {
  const summary = summarizeTestRun(
    run({
      issues: [
        {
          code: "automation_invalid",
          message: "Needs attention.",
          targetId: "alert",
        },
        {
          code: "value_invalid",
          message: "Enter a number.",
          targetId: "total",
        },
        {
          code: "module_invalid",
          message: "Check the module.",
          targetId: "orders",
        },
        { code: "other", message: "Something else.", targetId: "missing" },
        { code: "none", message: "No target.", targetId: null },
      ],
    }),
    design,
    automations,
    4,
  );
  expect(summary.issues.map((issue) => issue.subject)).toEqual([
    { kind: "automation", id: "alert", name: "Urgent request alert" },
    { kind: "field", id: "total", name: "Order total" },
    { kind: "module", id: "orders", name: "Orders" },
    null,
    null,
  ]);
});

test("issues about targets that no longer exist collapse by message", () => {
  const summary = summarizeTestRun(
    run({
      issues: ["gone-1", "gone-2", "gone-3"].map((targetId) => ({
        code: "value_required",
        message: "Enter a value for this required field.",
        targetId,
      })),
    }),
    design,
    automations,
    4,
  );
  expect(summary.issues).toHaveLength(1);
  expect(summary.issues[0]).toMatchObject({ count: 3, subject: null });
});
