import { expect, test } from "@playwright/test";

import {
  defaultTestTrigger,
  describeTrigger,
  summarizeTestRun,
  testTraceSteps,
} from "../../../src/components/systems/sandbox/domain/test-run-summary";
import type {
  SandboxTrigger,
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

const triggers = [
  { id: "alert", name: "Urgent request alert" },
] as unknown as SandboxTrigger[];

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
    triggerIds: null,
    result: { values: {}, routes: [], triggerTraces: [], issues },
    ...rest,
  } as SandboxTestRun;
}

test("a run from the current draft is not stale", () => {
  expect(summarizeTestRun(run(), design, triggers, 4).stale).toBeNull();
});

test("a run from an older draft says so", () => {
  expect(summarizeTestRun(run(), design, triggers, 5).stale).toBe(
    "older-draft",
  );
});

test("a run whose module was removed or closed says so, whatever the revision", () => {
  const removed = { ...design, modules: [] };
  expect(summarizeTestRun(run(), removed, triggers, 4).stale).toBe(
    "module-gone",
  );
  const closed = {
    ...design,
    modules: [{ ...design.modules[0]!, closed: true }],
  };
  expect(summarizeTestRun(run(), closed, triggers, 5).stale).toBe(
    "module-gone",
  );
});

test("repeated issues collapse into one line with a count", () => {
  const same = {
    code: "trigger_invalid",
    message: "A set field action has an invalid value.",
    targetId: "alert",
  };
  const summary = summarizeTestRun(
    run({ issues: [same, same, same] }),
    design,
    triggers,
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
          code: "trigger_invalid",
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
    triggers,
    4,
  );
  expect(summary.issues.map((issue) => issue.subject)).toEqual([
    { kind: "trigger", id: "alert", name: "Urgent request alert" },
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
    triggers,
    4,
  );
  expect(summary.issues).toHaveLength(1);
  expect(summary.issues[0]).toMatchObject({ count: 3, subject: null });
});

test("an empty required field reports one issue, not two", () => {
  const summary = summarizeTestRun(
    run({
      issues: [
        {
          code: "value_invalid",
          message: "A temporary value does not match its field settings.",
          targetId: "total",
        },
        {
          code: "value_required",
          message: "Enter a value for this required field.",
          targetId: "total",
        },
      ],
    }),
    design,
    triggers,
    4,
  );
  expect(summary.issues).toHaveLength(1);
  expect(summary.issues[0]).toMatchObject({
    code: "value_required",
    subject: { kind: "field", id: "total" },
  });
});

test("a trigger reads as the event that runs it", () => {
  expect(
    describeTrigger({ kind: "record-created", moduleId: "orders" }, design),
  ).toBe("Runs when an item is added to Orders.");
  expect(
    describeTrigger(
      { kind: "field-changed", moduleId: "orders", fieldId: "total" },
      design,
    ),
  ).toBe("Runs when Order total changes.");
  expect(
    describeTrigger(
      {
        kind: "schedule",
        moduleId: "orders",
        frequency: "daily",
        time: "09:00",
      },
      design,
    ),
  ).toBe("Runs on a daily schedule at 09:00.");
});

test("the default test trigger is the first enabled trigger's for the module", () => {
  const list = [
    {
      id: "off",
      name: "Off",
      enabled: false,
      trigger: { kind: "record-created", moduleId: "orders" },
    },
    {
      id: "on",
      name: "On",
      enabled: true,
      trigger: { kind: "field-changed", moduleId: "orders", fieldId: "total" },
    },
  ] as unknown as SandboxTrigger[];
  expect(defaultTestTrigger(list, "orders")).toEqual({
    kind: "field-changed",
    moduleId: "orders",
    fieldId: "total",
  });
  expect(defaultTestTrigger(list, "customers")).toBeNull();
});

test("a run becomes three canvas steps that keep earlier marks", () => {
  const steps = testTraceSteps(
    run({
      event: { kind: "field-changed", fieldId: "total" },
      input: { moduleId: "orders", values: { total: 1, paid: false } },
      result: {
        values: { total: 1, paid: true },
        routes: [],
        triggerTraces: [
          {
            triggerId: "alert",
            label: "Urgent request alert",
            outcome: "Applied",
          },
        ],
        issues: [],
      },
    }),
    design,
  );
  expect(steps.map((step) => step.title)).toEqual([
    "What happened",
    "Triggers",
    "Result",
  ]);
  expect(steps[0]?.marks).toEqual({ total: "trigger" });
  expect(steps[1]?.lines).toEqual(["Urgent request alert: applied"]);
  expect(steps[2]?.marks).toEqual({ total: "trigger", paid: "changed" });
  expect(steps[2]?.lines).toEqual(["Unavailable field: No → Yes"]);
});

test("a trigger on another module names that module", () => {
  const withCustomers = {
    ...design,
    modules: [
      ...design.modules,
      {
        id: "customers",
        departmentId: "sales",
        name: "Customers",
        closed: false,
        fields: [{ id: "status", name: "Status", closed: false }],
      },
    ],
  } as unknown as SandboxDocumentDesign;
  expect(
    describeTrigger(
      { kind: "field-changed", moduleId: "customers", fieldId: "status" },
      withCustomers,
      "orders",
    ),
  ).toBe("Runs when Status changes in Customers.");
});

test("the canvas steps repeat the result's caveats and keep both marks", () => {
  const stale = run({
    event: { kind: "field-changed", fieldId: "total" },
    input: { moduleId: "orders", values: { total: 1 } },
    issues: [
      { code: "value_required", message: "Enter a value.", targetId: "total" },
    ],
    result: {
      values: { total: 2 },
      routes: [],
      triggerTraces: [],
      issues: [
        {
          code: "value_required",
          message: "Enter a value.",
          targetId: "total",
        },
      ],
    },
  });
  const steps = testTraceSteps(
    stale,
    design,
    summarizeTestRun(stale, design, triggers, 5),
  );
  expect(steps[0]?.lines.slice(0, 2)).toEqual([
    "From an older draft.",
    "This test needs attention: 1 issue. Go back to the result to fix it.",
  ]);
  expect(steps[2]?.marks).toEqual({ total: "trigger changed" });
});
