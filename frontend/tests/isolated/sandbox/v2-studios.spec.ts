import { expect, test } from "@playwright/test";
import {
  addAutomationAction,
  addAutomationCondition,
  automationRunStatus,
  automationPublicationBlockers,
  fieldReferenceOptionValue,
  scheduleFrequencyChange,
  defaultAutomation,
} from "../../../src/components/systems/sandbox/components/automation-studio";
import type {
  SandboxAutomationTrigger,
  SandboxFieldReference,
} from "../../../src/components/systems/sandbox/domain/document";
import type { SandboxDocumentDesign } from "../../../src/components/systems/sandbox/domain/document";
import { publicationIdempotencyKey } from "../../../src/components/systems/sandbox/components/review-publish-dialog";

const design: SandboxDocumentDesign = {
  departments: [{ id: "operations", name: "Operations", closed: false }],
  modules: [
    {
      id: "requests",
      departmentId: "operations",
      name: "Requests",
      closed: false,
      fields: [
        {
          id: "title",
          name: "Title",
          type: "Text",
          required: true,
          closed: false,
          config: { kind: "text", defaultValue: "" },
        },
        {
          id: "status",
          name: "Status",
          type: "Select",
          required: false,
          closed: false,
          config: {
            kind: "select",
            defaultValue: null,
            options: ["Open", "On hold"],
          },
        },
      ],
    },
  ],
  relationships: [],
  layout: {
    operations: { x: 0, y: 0, width: 500, height: 300 },
    requests: { x: 20, y: 40, width: 280, height: 180 },
  },
};

test("new automations author only same-module Set field actions", () => {
  const automation = defaultAutomation(design);
  const expanded = addAutomationAction(
    addAutomationCondition(automation, design),
    design,
  );

  expect(automation.actions).toEqual([
    expect.objectContaining({
      kind: "set-field",
      target: { moduleId: "requests", fieldId: "title" },
    }),
  ]);
  expect(expanded.actions).toHaveLength(2);
  expect(expanded.actions.every((action) => action.kind === "set-field")).toBe(
    true,
  );
  expect(expanded.conditionGroup.conditions[0]?.field.moduleId).toBe(
    "requests",
  );
});

test("imported unsupported actions block publication until removed", () => {
  const automation = {
    ...defaultAutomation(design),
    actions: [
      { id: "old-action", kind: "notification" as const, message: "Legacy" },
    ],
  };
  expect(automationPublicationBlockers([automation], design)).toEqual([
    "New automation: notification is not supported for publishing.",
  ]);
});

test("scheduled automations require a module before publishing", () => {
  const automation = {
    ...defaultAutomation(design),
    trigger: {
      kind: "schedule" as const,
      frequency: "daily" as const,
      time: "09:00",
    },
  };
  expect(automationPublicationBlockers([automation], design)).toContain(
    "New automation: scheduled automations need a module.",
  );
});

test("a publish retry keeps the same idempotency key after an uncertain result", () => {
  const first = publicationIdempotencyKey("", () => "publish-attempt-1");
  expect(publicationIdempotencyKey(first, () => "publish-attempt-2")).toBe(
    first,
  );
});

test("successful automation activity distinguishes changes from no-op runs", () => {
  const base = {
    id: "run-1",
    createdAt: "2026-09-21T00:00:00Z",
    automationId: "automation-1",
    automationName: "Review order",
    eventKind: "field-changed" as const,
    state: "succeeded" as const,
    attempts: 1,
  };

  expect(
    automationRunStatus({
      ...base,
      details: { recordsMatched: 1, actionsApplied: 0 },
    }),
  ).toBe("No change needed");
  expect(
    automationRunStatus({
      ...base,
      details: { recordsMatched: 1, actionsApplied: 1 },
    }),
  ).toBe("Completed");
  expect(
    automationRunStatus({
      ...base,
      details: {
        recordsMatched: 100,
        actionsApplied: 100,
        budgetExhausted: true,
      },
    }),
  ).toBe("Incomplete — action limit reached");
});

test("switching a schedule to weekly stores the displayed default weekday", () => {
  const daily: SandboxAutomationTrigger = {
    kind: "schedule",
    moduleId: "requests",
    frequency: "daily",
    time: "09:00",
  };

  expect(scheduleFrequencyChange(daily, "weekly")).toEqual({
    ...daily,
    frequency: "weekly",
    weekday: 1,
  });
  expect(
    scheduleFrequencyChange(
      { ...daily, frequency: "weekly", weekday: 5 },
      "daily",
    ),
  ).toEqual({ ...daily, frequency: "daily" });
});

test("field-reference controls encode stored values exactly like their options", () => {
  const reference: SandboxFieldReference = {
    moduleId: "requests",
    fieldId: "status",
  };

  expect(fieldReferenceOptionValue(reference)).toBe("requests|status");
  expect(
    fieldReferenceOptionValue({
      ...reference,
      relationshipId: "request-customer",
    }),
  ).toBe("request-customer|requests|status");
});
