import { expect, test } from "@playwright/test";

import {
  TriggerFlow,
  triggerOperatorOptions,
  weekdayOptions,
} from "../../../src/components/systems/sandbox/components/trigger-flow";
import type {
  SandboxDocumentDesign,
  SandboxTrigger,
} from "../../../src/components/systems/sandbox/domain/document";
import {
  documentSelectField,
  documentTextField,
} from "../../helpers/sandbox-fixtures";
import { staticMarkup } from "./static-markup";

// Trigger copy uses plain words: the flow and summary name a select choice by
// its label (the stored value stays the choice ID), and the schedule and
// operator pickers use the same words as the summary ("Every Monday",
// "is at least") while their stored values stay 1 to 7 and the ASCII symbols.

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
            { id: "0460bb8e-open", label: "Open" },
            { id: "7c1d2f30-hold", label: "On hold" },
          ],
        }),
      ],
    },
  ],
  relationships: [],
  layout: {},
};

function statusTrigger(conditionValue: string): SandboxTrigger {
  return {
    id: "follow-up",
    name: "Follow up",
    enabled: true,
    priority: 1,
    trigger: { kind: "field-changed", moduleId: "requests", fieldId: "title" },
    conditionGroup: {
      operator: "all",
      conditions: [
        {
          id: "condition-1",
          field: { moduleId: "requests", fieldId: "status" },
          operator: "=",
          value: { kind: "literal", value: conditionValue },
        },
      ],
    },
    actions: [
      {
        id: "action-1",
        kind: "set-field",
        target: { moduleId: "requests", fieldId: "status" },
        value: { kind: "literal", value: "7c1d2f30-hold" },
      },
    ],
  };
}

function flowMarkup(recordTrigger: SandboxTrigger): string {
  return staticMarkup(TriggerFlow, {
    trigger: recordTrigger,
    design,
    selectedStep: "trigger",
    onSelect: () => undefined,
  });
}

test("trigger summaries name a select choice by its label", () => {
  const markup = flowMarkup(statusTrigger("0460bb8e-open"));

  expect(markup).toContain("Status is Open");
  expect(markup).toContain("Set Status to On hold");
  expect(markup).not.toContain("0460bb8e-open");
  expect(markup).not.toContain("7c1d2f30-hold");
});

test("trigger summaries keep a select value that matches no choice", () => {
  expect(flowMarkup(statusTrigger("retired-choice"))).toContain(
    "Status is retired-choice",
  );
});

test("weekly schedule choices show weekday names and store 1 to 7", () => {
  expect(weekdayOptions).toEqual([
    { value: "1", label: "Monday" },
    { value: "2", label: "Tuesday" },
    { value: "3", label: "Wednesday" },
    { value: "4", label: "Thursday" },
    { value: "5", label: "Friday" },
    { value: "6", label: "Saturday" },
    { value: "7", label: "Sunday" },
  ]);
});

test("operator choices use the summary words, with is first", () => {
  expect(triggerOperatorOptions).toEqual([
    { value: "=", label: "is" },
    { value: "!=", label: "is not" },
    { value: ">", label: "is more than" },
    { value: ">=", label: "is at least" },
    { value: "<", label: "is less than" },
    { value: "<=", label: "is at most" },
  ]);
});
