import { expect, test } from "@playwright/test";

import {
  attentionCountLabel,
  buildAttentionItems,
  fieldAdvancedSummary,
  propertiesAdvancedSummary,
} from "../../../src/components/systems/sandbox/domain/build-summary";
import type { Design } from "../../../src/components/systems/sandbox/domain/model";

// Build with nothing selected summarizes the whole design: what needs
// attention, each with one action, in a fixed order (docs/specs/
// sandbox-relayout.md S12). Properties' closed Advanced blocks name what they
// hold instead of a set count.

function module(id: string, fieldCount: number): Design["modules"][number] {
  return {
    id,
    department: "d1",
    name: id,
    closed: false,
    x: 0,
    y: 0,
    fields: Array.from({ length: fieldCount }, (_, index) => ({
      id: `${id}-f${index}`,
      name: `Field ${index}`,
      type: "Text",
      required: false,
      value: "",
      options: "",
      closed: false,
    })),
  };
}

function rule(id: string, enabled: boolean): Design["rules"][number] {
  return {
    id,
    name: id,
    trigger: "New record",
    condition: "",
    action: "",
    enabled,
  };
}

test("every attention row appears in order with its count and action", () => {
  const items = buildAttentionItems({
    design: {
      modules: [module("full", 2), module("empty-a", 0), module("empty-b", 0)],
      rules: [rule("on", true), rule("off-a", false), rule("off-b", false)],
    },
    unpublished: true,
    overlapping: true,
    issues: [
      {
        key: "rule.action_value_required:r1",
        message: "Urgent alert: add a message.",
        verb: "Open trigger",
        issue: {
          code: "rule.action_value_required",
          severity: "error",
          message: "Urgent alert: add a message.",
          targetId: "r1",
        },
      },
    ],
  });
  expect(
    items.map(({ kind, count, text, verb, tone, target }) => ({
      kind,
      count,
      text,
      verb,
      tone,
      target,
    })),
  ).toEqual([
    {
      kind: "unpublished",
      count: null,
      text: "Unpublished changes",
      verb: "Review",
      tone: "info",
      target: null,
    },
    {
      kind: "triggersOff",
      count: 2,
      text: "triggers are off",
      verb: "Show",
      tone: "info",
      target: "off-a",
    },
    {
      kind: "emptyModules",
      count: 2,
      text: "modules have no fields",
      verb: "Show",
      tone: "warn",
      target: "empty-a",
    },
    {
      kind: "overlaps",
      count: null,
      text: "Departments or modules overlap",
      verb: "Auto-arrange",
      tone: "info",
      target: null,
    },
    {
      kind: "issue",
      count: null,
      text: "Urgent alert: add a message.",
      verb: "Open trigger",
      tone: "warn",
      target: null,
    },
  ]);
  // The issue row carries the blocker itself, which its action opens.
  expect(items.at(-1)?.issue?.targetId).toBe("r1");
});

test("a single trigger or module reads in the singular", () => {
  const items = buildAttentionItems({
    design: {
      modules: [module("empty", 0)],
      rules: [rule("off", false)],
    },
    unpublished: false,
    overlapping: false,
    issues: [],
  });
  expect(items.map((item) => `${item.count} ${item.text}`)).toEqual([
    "1 trigger is off",
    "1 module has no fields",
  ]);
});

test("a design with nothing to attend to has no rows", () => {
  expect(
    buildAttentionItems({
      design: { modules: [module("full", 1)], rules: [rule("on", true)] },
      unpublished: false,
      overlapping: false,
      issues: [],
    }),
  ).toEqual([]);
});

// The header's one attention control (S18) counts what needs attention in
// a few words; with nothing to attend to it is absent.
test("the header attention count agrees with its number", () => {
  expect(attentionCountLabel(0)).toBeNull();
  expect(attentionCountLabel(1)).toBe("1 needs attention");
  expect(attentionCountLabel(2)).toBe("2 need attention");
  expect(attentionCountLabel(12)).toBe("12 need attention");
});

test("Advanced names what it holds, with the lifecycle verb that applies", () => {
  for (const [kind, lifecycle, expected] of [
    [
      "module",
      { closed: false, canPurge: false },
      "Department, Title field, Close, Delete",
    ],
    [
      "module",
      { closed: true, canPurge: true },
      "Department, Title field, Reopen, Delete, Delete forever",
    ],
    ["department", { closed: false, canPurge: false }, "Close, Delete"],
    [
      "department",
      { closed: true, canPurge: true },
      "Reopen, Delete, Delete forever",
    ],
  ] as const)
    expect(propertiesAdvancedSummary(kind, lifecycle), `${kind}`).toBe(
      expected,
    );
});

test("a field's Advanced names the settings its type has", () => {
  const open = { closed: false, canPurge: false };
  for (const [type, lifecycle, expected] of [
    ["Text", open, "Description, Default, Limits, Close, Delete"],
    ["Number", open, "Description, Default, Limits, Close, Delete"],
    ["Date", open, "Description, Default, Limits, Close, Delete"],
    ["Select", open, "Description, Default, Close, Delete"],
    ["Checkbox", open, "Description, Default, Close, Delete"],
    ["User", open, "Description, Close, Delete"],
    [
      "User",
      { closed: true, canPurge: true },
      "Description, Reopen, Delete, Delete forever",
    ],
  ] as const)
    expect(fieldAdvancedSummary(type, lifecycle), type).toBe(expected);
});

test("Advanced marks each setting that holds a value, never an action", () => {
  expect(
    propertiesAdvancedSummary(
      "module",
      { closed: true, canPurge: false },
      { titleField: true },
    ),
  ).toBe("Department, Title field (set), Reopen, Delete");
  expect(
    fieldAdvancedSummary(
      "Text",
      { closed: false, canPurge: false },
      { description: true, defaultValue: false, limits: true },
    ),
  ).toBe("Description (set), Default, Limits (set), Close, Delete");
  expect(
    fieldAdvancedSummary(
      "Checkbox",
      { closed: false, canPurge: false },
      { description: false, defaultValue: true, limits: false },
    ),
  ).toBe("Description, Default (set), Close, Delete");
});
