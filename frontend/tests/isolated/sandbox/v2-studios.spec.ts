import { expect, test } from "@playwright/test";
import {
  addTriggerAction,
  addTriggerCondition,
  triggerRunStatus,
  triggerPublicationBlockers,
  fieldReferenceOptionValue,
  scheduleFrequencyChange,
  defaultTrigger,
  sandboxFieldsAreDirectionallyCompatible,
  validateFieldLiteral,
} from "../../../src/components/systems/sandbox/components/trigger-studio";
import type {
  SandboxTriggerEvent,
  SandboxFieldReference,
} from "../../../src/components/systems/sandbox/domain/document";
import type { SandboxDocumentDesign } from "../../../src/components/systems/sandbox/domain/document";
import { publicationIdempotencyKey } from "../../../src/components/systems/sandbox/components/review-publish-dialog";
import {
  documentSelectField,
  documentTextField,
} from "../../helpers/sandbox-fixtures";

const design: SandboxDocumentDesign = {
  departments: [{ id: "operations", name: "Operations", closed: false }],
  modules: [
    {
      id: "requests",
      departmentId: "operations",
      name: "Requests",
      closed: false,
      titleFieldId: null,
      fields: [
        documentTextField({ id: "title", name: "Title", required: true }),
        documentSelectField({
          id: "status",
          name: "Status",
          defaultValue: null,
          options: [
            { id: "open", label: "Open" },
            { id: "on-hold", label: "On hold" },
          ],
        }),
      ],
    },
  ],
  relationships: [],
  layout: {
    operations: { x: 0, y: 0, width: 500, height: 300 },
    requests: { x: 20, y: 40, width: 280, height: 180 },
  },
};

test("new triggers author only same-module Set field actions", () => {
  const recordTrigger = defaultTrigger(design);
  const expanded = addTriggerAction(
    addTriggerCondition(recordTrigger, design),
    design,
  );

  expect(recordTrigger.actions).toEqual([
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
  const recordTrigger = {
    ...defaultTrigger(design),
    actions: [
      { id: "old-action", kind: "notification" as const, message: "Legacy" },
    ],
  };
  expect(triggerPublicationBlockers([recordTrigger], design)).toEqual([
    "New trigger: notification is not supported for publishing.",
  ]);
});

test("scheduled triggers require a module before publishing", () => {
  const recordTrigger = {
    ...defaultTrigger(design),
    trigger: {
      kind: "schedule" as const,
      frequency: "daily" as const,
      time: "09:00",
    },
  };
  expect(triggerPublicationBlockers([recordTrigger], design)).toContain(
    "New trigger: scheduled triggers need a module.",
  );
});

test("a publish retry keeps the same idempotency key after an uncertain result", () => {
  const first = publicationIdempotencyKey("", () => "publish-attempt-1");
  expect(publicationIdempotencyKey(first, () => "publish-attempt-2")).toBe(
    first,
  );
});

test("successful trigger activity distinguishes changes from no-op runs", () => {
  const base = {
    id: "run-1",
    createdAt: "2026-09-21T00:00:00Z",
    triggerId: "trigger-1",
    triggerName: "Review order",
    eventKind: "field-changed" as const,
    state: "succeeded" as const,
    attempts: 1,
  };

  expect(
    triggerRunStatus({
      ...base,
      details: { recordsMatched: 1, actionsApplied: 0 },
    }),
  ).toBe("No change needed");
  expect(
    triggerRunStatus({
      ...base,
      details: { recordsMatched: 1, actionsApplied: 1 },
    }),
  ).toBe("Completed");
  expect(
    triggerRunStatus({
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
  const daily: SandboxTriggerEvent = {
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

test("trigger Date/Time constraints compare offset values as instants", () => {
  const source = {
    id: "source-time",
    name: "Source time",
    type: "Date/Time" as const,
    required: false,
    closed: false,
    config: {
      kind: "datetime" as const,
      defaultValue: null,
      earliest: "2025-01-01T01:00:00+02:00",
      latest: "2025-01-01T00:00:00Z",
    },
  };
  const target = {
    ...source,
    id: "target-time",
    name: "Target time",
    config: {
      ...source.config,
      earliest: "2024-12-31T22:00:00Z",
      latest: "2025-01-01T00:00:00+00:00",
    },
  };

  expect(sandboxFieldsAreDirectionallyCompatible(source, target)).toBe(true);
  expect(validateFieldLiteral("2024-12-31T23:30:00Z", source)).toBeNull();
});
