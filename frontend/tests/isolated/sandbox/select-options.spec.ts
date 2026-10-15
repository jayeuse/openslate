import { expect, test } from "@playwright/test";

import {
  buildField,
  reconcileSelectOptions,
} from "../../../src/components/systems/sandbox/components/designer-field-settings";
import type {
  Field,
  SelectOption,
} from "../../../src/components/systems/sandbox/domain/model";

// Editing the comma-separated Select choices keeps each saved choice ID: a
// label keeps its ID wherever it moves, a renamed choice keeps the ID of the
// choice it replaces at the same position, and a label that looks like an ID
// is only a label. The default is stored as a choice ID, so removing the
// default choice is refused until the default is cleared or another choice is
// chosen. The http journey "editing select choices preserves IDs, even when a
// label matches the default ID" keeps the saved document across the
// settings form.

const saved: SelectOption[] = [
  { id: "id-open", label: "Open" },
  { id: "id-progress", label: "In progress" },
  { id: "id-complete", label: "Complete" },
];

// The choices saved after an ID-shaped label was added in front (the http
// journey's first save); the next rows replay its later edits exactly.
const withIdShapedLabel: SelectOption[] = [
  { id: "id-inserted", label: "id-open" },
  { id: "id-open", label: "Open" },
  { id: "id-progress", label: "In progress" },
  { id: "id-complete", label: "Complete" },
];
const reordered: SelectOption[] = [
  { id: "id-complete", label: "Complete" },
  { id: "id-inserted", label: "id-open" },
  { id: "id-open", label: "Open" },
  { id: "id-progress", label: "In progress" },
];

const reconcileRows: {
  name: string;
  previous: SelectOption[];
  labels: string[];
  expected: SelectOption[];
}[] = [
  {
    name: "unchanged choices keep their IDs",
    previous: saved,
    labels: ["Open", "In progress", "Complete"],
    expected: saved,
  },
  {
    name: "reordered choices keep their IDs",
    previous: saved,
    labels: ["Complete", "Open", "In progress"],
    expected: [
      { id: "id-complete", label: "Complete" },
      { id: "id-open", label: "Open" },
      { id: "id-progress", label: "In progress" },
    ],
  },
  {
    name: "a rename keeps the ID of the choice at the same position",
    previous: saved,
    labels: ["Active", "In progress", "Complete"],
    expected: [
      { id: "id-open", label: "Active" },
      { id: "id-progress", label: "In progress" },
      { id: "id-complete", label: "Complete" },
    ],
  },
  {
    name: "a label equal to an ID is a new choice and the ID stays with its label",
    previous: saved,
    labels: ["id-open", "Open", "In progress", "Complete"],
    expected: [
      { id: "new:0", label: "id-open" },
      { id: "id-open", label: "Open" },
      { id: "id-progress", label: "In progress" },
      { id: "id-complete", label: "Complete" },
    ],
  },
  {
    name: "a new label at the position of a choice kept elsewhere gets a new ID",
    previous: saved,
    labels: ["In progress", "Done"],
    expected: [
      { id: "id-progress", label: "In progress" },
      { id: "new:1", label: "Done" },
    ],
  },
  {
    name: "a removed choice drops its ID",
    previous: saved,
    labels: ["Open", "Complete"],
    expected: [
      { id: "id-open", label: "Open" },
      { id: "id-complete", label: "Complete" },
    ],
  },
  {
    name: "a choice beyond the saved ones gets a new ID",
    previous: saved,
    labels: ["Open", "In progress", "Complete", "Archived"],
    expected: [...saved, { id: "new:3", label: "Archived" }],
  },
  {
    name: "a reorder keeps the ID-shaped label's own ID",
    previous: withIdShapedLabel,
    labels: ["Complete", "id-open", "Open", "In progress"],
    expected: reordered,
  },
  {
    name: "a rename after a reorder keeps the ID at that position",
    previous: reordered,
    labels: ["Complete", "id-open", "Active", "In progress"],
    expected: [
      { id: "id-complete", label: "Complete" },
      { id: "id-inserted", label: "id-open" },
      { id: "id-open", label: "Active" },
      { id: "id-progress", label: "In progress" },
    ],
  },
  {
    name: "a repeated label never shares an ID",
    previous: [{ id: "id-open", label: "Open" }],
    labels: ["Open", "Open"],
    expected: [
      { id: "id-open", label: "Open" },
      { id: "new:1", label: "Open" },
    ],
  },
  {
    name: "no labels give no choices",
    previous: saved,
    labels: [],
    expected: [],
  },
];

for (const row of reconcileRows)
  test(`select choices: ${row.name}`, () => {
    expect(
      reconcileSelectOptions(
        row.previous,
        row.labels,
        (index) => `new:${index}`,
      ),
    ).toEqual(row.expected);
  });

const field: Field = {
  id: "sample-field-Status",
  name: "Status",
  type: "Select",
  required: false,
  value: "id-open",
  options: "Open, In progress, Complete",
  closed: false,
  config: { kind: "select", defaultValue: "id-open", options: saved },
};

function draft(
  options: string,
  defaultValue: string,
  selectOptions?: SelectOption[],
): Parameters<typeof buildField>[1] {
  return {
    name: "Status",
    description: "",
    type: "Select",
    required: false,
    defaultValue,
    options,
    selectOptions,
    maxLength: "",
    min: "",
    max: "",
    step: "",
    earliest: "",
    latest: "",
    checked: false,
  };
}

function savedField(
  defaultValue: string | null,
  options: SelectOption[],
): Field {
  return {
    ...field,
    description: "",
    value: defaultValue ?? "",
    options: options.map((option) => option.label).join(", "),
    config: { kind: "select", defaultValue, options },
  };
}

test("select default: a kept default choice saves its ID", () => {
  expect(
    buildField(field, draft("Complete, Open, In progress", "id-open")),
  ).toEqual(
    savedField("id-open", [
      { id: "id-complete", label: "Complete" },
      { id: "id-open", label: "Open" },
      { id: "id-progress", label: "In progress" },
    ]),
  );
});

test("select default: a renamed default choice keeps the default", () => {
  expect(
    buildField(field, draft("Active, In progress, Complete", "id-open")),
  ).toEqual(
    savedField("id-open", [
      { id: "id-open", label: "Active" },
      { id: "id-progress", label: "In progress" },
      { id: "id-complete", label: "Complete" },
    ]),
  );
});

test("select default: a renamed default after a four-choice reorder keeps its ID", () => {
  const reorderedField: Field = {
    ...field,
    options: "Complete, id-open, Open, In progress",
    config: { kind: "select", defaultValue: "id-open", options: reordered },
  };
  expect(
    buildField(
      reorderedField,
      draft("Complete, id-open, Active, In progress", "id-open"),
    ),
  ).toEqual({
    id: "sample-field-Status",
    name: "Status",
    description: "",
    type: "Select",
    required: false,
    value: "id-open",
    options: "Complete, id-open, Active, In progress",
    closed: false,
    config: {
      kind: "select",
      defaultValue: "id-open",
      options: [
        { id: "id-complete", label: "Complete" },
        { id: "id-inserted", label: "id-open" },
        { id: "id-open", label: "Active" },
        { id: "id-progress", label: "In progress" },
      ],
    },
  });
});

test("select default: removing the default choice is refused", () => {
  expect(buildField(field, draft("In progress, Complete", "id-open"))).toBe(
    "Default value must match a select option.",
  );
});

test("select default: a cleared default saves no default", () => {
  expect(buildField(field, draft("In progress, Complete", ""))).toEqual(
    savedField(null, [
      { id: "id-progress", label: "In progress" },
      { id: "id-complete", label: "Complete" },
    ]),
  );
});

test("select default: a new choice chosen as default saves its new ID after a reorder", () => {
  const cleared: SelectOption[] = [
    { id: "id-complete", label: "Complete" },
    { id: "id-inserted", label: "id-open" },
    { id: "id-progress", label: "In progress" },
  ];
  const clearedField: Field = {
    ...field,
    value: "",
    options: "Complete, id-open, In progress",
    config: { kind: "select", defaultValue: null, options: cleared },
  };
  const added = reconcileSelectOptions(
    cleared,
    ["Complete", "id-open", "In progress", "Draft choice"],
    (index) => `new:first-${index}`,
  );
  const moved = reconcileSelectOptions(
    added,
    ["Draft choice", "Complete", "id-open", "In progress"],
    (index) => `new:second-${index}`,
  );
  expect(moved[0]).toEqual({ id: "new:first-3", label: "Draft choice" });
  const original = crypto.randomUUID;
  crypto.randomUUID = () => "00000000-0000-4000-8000-0000000000d1";
  try {
    expect(
      buildField(
        clearedField,
        draft(
          "Draft choice, Complete, id-open, In progress",
          "new:first-3",
          moved,
        ),
      ),
    ).toEqual(
      savedField("00000000-0000-4000-8000-0000000000d1", [
        { id: "00000000-0000-4000-8000-0000000000d1", label: "Draft choice" },
        ...cleared,
      ]),
    );
  } finally {
    crypto.randomUUID = original;
  }
});

test("select default: an unsaved default choice that is removed is refused", () => {
  const added = reconcileSelectOptions(
    saved,
    ["Temporary", "Open", "In progress", "Complete"],
    (index) => `new:${index}`,
  );
  const removed = reconcileSelectOptions(
    added,
    ["Open", "In progress", "Complete"],
    (index) => `new:later-${index}`,
  );
  expect(
    buildField(field, draft("Open, In progress, Complete", "new:0", removed)),
  ).toBe("Default value must match a select option.");
});
