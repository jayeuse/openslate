import { expect, test } from "@playwright/test";

import {
  matchingTestRun,
  missingTestSetupValues,
  testInputsChanged,
} from "../../../src/components/systems/sandbox/domain/test-setup";
import type { SandboxDocumentField } from "../../../src/components/systems/sandbox/domain/document";
import type {
  SandboxTestEvent,
  SandboxTestRun,
} from "../../../src/components/systems/sandbox/state/api";

function run(
  id: string,
  moduleId: string,
  event: SandboxTestEvent,
): SandboxTestRun {
  return {
    id,
    createdAt: "2026-10-24T09:00:00Z",
    documentRevision: 1,
    input: { moduleId, values: {} },
    event,
    triggerIds: null,
    result: { values: {}, routes: [], triggerTraces: [], issues: [] },
  };
}

// Newest first, as the page keeps them.
const runs = [
  run("orders-status", "orders", {
    kind: "field-changed",
    fieldId: "status",
  }),
  run("orders-added-new", "orders", { kind: "record-created" }),
  run("orders-added-old", "orders", { kind: "record-created" }),
  run("orders-total", "orders", {
    kind: "threshold-crossed",
    fieldId: "total",
    previousValue: 10,
  }),
  run("orders-daily", "orders", {
    kind: "schedule",
    frequency: "daily",
    time: "09:00",
  }),
];

test.describe("the shown result matches the setup's module and event", () => {
  for (const [name, setup, selected, expected] of [
    [
      "a run for another module is not shown",
      { moduleId: "customers", event: { kind: "record-created" } },
      null,
      undefined,
    ],
    [
      "the newest run of the same module and event is shown",
      { moduleId: "orders", event: { kind: "record-created" } },
      null,
      "orders-added-new",
    ],
    [
      "a chosen older run of the same setup is shown",
      { moduleId: "orders", event: { kind: "record-created" } },
      "orders-added-old",
      "orders-added-old",
    ],
    [
      "a chosen run of another event gives way to the matching one",
      { moduleId: "orders", event: { kind: "record-created" } },
      "orders-status",
      "orders-added-new",
    ],
    [
      "a field event for another field is a different test",
      {
        moduleId: "orders",
        event: { kind: "field-changed", fieldId: "priority" },
      },
      null,
      undefined,
    ],
    [
      "another event kind is a different test",
      {
        moduleId: "orders",
        event: { kind: "field-changed", fieldId: "total" },
      },
      null,
      undefined,
    ],
    [
      "another previous value is the same test with changed inputs",
      {
        moduleId: "orders",
        event: {
          kind: "threshold-crossed",
          fieldId: "total",
          previousValue: 99,
        },
      },
      null,
      "orders-total",
    ],
    [
      "another schedule time is the same test with changed inputs",
      {
        moduleId: "orders",
        event: {
          kind: "schedule",
          frequency: "weekly",
          time: "17:30",
          weekday: 2,
        },
      },
      null,
      "orders-daily",
    ],
  ] as const) {
    test(name, () => {
      expect(
        matchingTestRun(
          runs,
          setup as { moduleId: string; event: SandboxTestEvent },
          selected,
        )?.id,
      ).toBe(expected);
    });
  }
});

function field(
  id: string,
  required: boolean,
  kind: "text" | "number" | "checkbox" = "text",
): SandboxDocumentField {
  return {
    id,
    name: id,
    type: kind === "text" ? "Text" : kind === "number" ? "Number" : "Checkbox",
    required,
    closed: false,
    config:
      kind === "text"
        ? { kind, defaultValue: "" }
        : kind === "number"
          ? { kind, defaultValue: null }
          : { kind, defaultValue: false },
  } as SandboxDocumentField;
}

test("Run test needs a value in every required field, in setup order", () => {
  expect(
    missingTestSetupValues({
      fields: [
        field("name", true),
        field("note", false),
        field("count", true, "number"),
        field("zero", true, "number"),
        field("done", true, "checkbox"),
        field("blank", true),
        field("absent", true),
      ],
      values: {
        name: "",
        note: "",
        count: null,
        zero: 0,
        done: false,
        blank: "   ",
      },
      event: { kind: "record-created" },
      previousValue: "",
    }),
  ).toEqual([
    {
      target: { kind: "field", fieldId: "name" },
      message: "Enter a value for this required field.",
    },
    {
      target: { kind: "field", fieldId: "count" },
      message: "Enter a value for this required field.",
    },
    {
      target: { kind: "field", fieldId: "blank" },
      message: "Enter a value for this required field.",
    },
    {
      target: { kind: "field", fieldId: "absent" },
      message: "Enter a value for this required field.",
    },
  ]);
});

test("a threshold test needs its field and previous number before the values", () => {
  expect(
    missingTestSetupValues({
      fields: [field("name", true)],
      values: { name: "" },
      event: { kind: "threshold-crossed", fieldId: "", previousValue: 0 },
      previousValue: "abc",
    }).map((problem) => problem.message),
  ).toEqual([
    "Add a number field before testing a threshold.",
    "Enter the previous number.",
    "Enter a value for this required field.",
  ]);
});

test("a complete setup has nothing missing", () => {
  expect(
    missingTestSetupValues({
      fields: [field("name", true), field("total", false, "number")],
      values: { name: "A-1", total: null },
      event: { kind: "threshold-crossed", fieldId: "total", previousValue: 0 },
      previousValue: "0",
    }),
  ).toEqual([]);
});

test("a field-change test on a module with no fields asks for a field", () => {
  expect(
    missingTestSetupValues({
      fields: [],
      values: {},
      event: { kind: "field-changed", fieldId: "" },
      previousValue: "",
    }).map((problem) => problem.message),
  ).toEqual(["Add a field before testing a field change."]);
});

test.describe("the shown result's inputs differ from the setup", () => {
  const ran: SandboxTestRun = {
    ...run("ran", "orders", {
      kind: "threshold-crossed",
      fieldId: "total",
      previousValue: 10,
    }),
    input: { moduleId: "orders", values: { name: "A-1", total: 12 } },
  };
  const same = {
    values: { name: "A-1", total: 12 },
    event: {
      kind: "threshold-crossed",
      fieldId: "total",
      previousValue: 10,
    } as SandboxTestEvent,
    triggerIds: null,
  };
  for (const [name, setup, expected] of [
    ["the setup it ran with is unchanged", same, false],
    [
      "a field added since the run is not a changed input",
      { ...same, values: { ...same.values, added: "x" } },
      false,
    ],
    [
      "another value is a changed input",
      { ...same, values: { ...same.values, name: "B-2" } },
      true,
    ],
    [
      "another previous value is a changed input",
      {
        ...same,
        event: {
          kind: "threshold-crossed",
          fieldId: "total",
          previousValue: 11,
        },
      },
      true,
    ],
    [
      "chosen triggers instead of all enabled are a changed input",
      { ...same, triggerIds: ["alert"] },
      true,
    ],
  ] as const) {
    test(name, () => {
      expect(
        testInputsChanged(ran, {
          ...setup,
          triggerIds: setup.triggerIds === null ? null : [...setup.triggerIds],
        }),
      ).toBe(expected);
    });
  }

  test("the schedule is part of the inputs; a daily weekday is not", () => {
    const daily = {
      ...run("daily", "orders", {
        kind: "schedule",
        frequency: "daily",
        time: "09:00",
        weekday: null as unknown as undefined,
      }),
    };
    const setup = (event: SandboxTestEvent) => ({
      values: {},
      event,
      triggerIds: null,
    });
    expect(
      testInputsChanged(
        daily,
        setup({ kind: "schedule", frequency: "daily", time: "09:00" }),
      ),
    ).toBe(false);
    expect(
      testInputsChanged(
        daily,
        setup({ kind: "schedule", frequency: "daily", time: "17:30" }),
      ),
    ).toBe(true);
    expect(
      testInputsChanged(
        daily,
        setup({
          kind: "schedule",
          frequency: "weekly",
          time: "09:00",
          weekday: 2,
        }),
      ),
    ).toBe(true);
  });
});
