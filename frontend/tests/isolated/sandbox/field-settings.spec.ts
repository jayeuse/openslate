import { expect, test } from "@playwright/test";
import {
  buildField,
  FieldSettings,
} from "../../../src/components/systems/sandbox/components/designer-field-settings";
import type { Field } from "../../../src/components/systems/sandbox/domain/model";
import { staticMarkup } from "./static-markup";

// Each field type renders its own settings branch. A branch that throws at
// render crashes the whole Sandbox designer when such a field is selected or
// its type is changed: the User note once used a Field part outside a Field
// root. Each row renders one branch and checks the controls only it offers.
for (const row of [
  {
    type: "Checkbox",
    shown: ["Status default checked"],
    hidden: ["Status default value"],
  },
  {
    type: "User",
    shown: [
      "User values are assigned on individual records, so this field has no shared default user.",
    ],
    hidden: ["Status default value"],
  },
  {
    type: "Select",
    shown: ["Status default value", "Status options"],
    hidden: ["Status maximum length"],
  },
  {
    type: "Text",
    shown: ["Status default value", "Status maximum length"],
    hidden: ["Status minimum"],
  },
  {
    type: "Number",
    shown: ["Status minimum", "Status maximum", "Status step"],
    hidden: ["Status maximum length"],
  },
  {
    type: "Date",
    shown: ["Status earliest", "Status latest"],
    hidden: ["Status minimum"],
  },
]) {
  test(`${row.type} field settings render their own controls`, () => {
    const markup = staticMarkup(FieldSettings, {
      field: {
        id: "sample-field-Status",
        name: "Status",
        type: row.type,
        required: false,
        value: "",
        options: row.type === "Select" ? "Open\nClosed" : "",
        closed: false,
      },
      index: 0,
      count: 1,
      onSave: async () => ({ ok: true, value: undefined }),
      onMove: async () => ({ ok: true, value: undefined }),
      onLifecycle: async () => ({ ok: true, value: undefined }),
      titleFieldId: null,
      draftId: `field-settings-${row.type}`,
      onDraftStateChange: () => {},
    });
    for (const text of row.shown) expect(markup).toContain(text);
    for (const text of row.hidden) expect(markup).not.toContain(text);
  });
}

// Field settings save Date/Time bounds by instant, not by text: a bound
// written with +02:00 can come before a later-looking bound written in UTC.

const field: Field = {
  id: "sample-field-Request number",
  name: "Request number",
  type: "Date/Time",
  required: true,
  value: "",
  options: "",
  closed: false,
};

function draft(bounds: {
  defaultValue: string;
  earliest: string;
  latest: string;
}): Parameters<typeof buildField>[1] {
  return {
    name: "Request number",
    description: "",
    type: "Date/Time",
    required: true,
    options: "",
    maxLength: "",
    min: "",
    max: "",
    step: "",
    checked: false,
    ...bounds,
  };
}

for (const row of [
  {
    name: "an earliest bound at +02:00 before a UTC latest bound saves",
    bounds: {
      defaultValue: "2025-01-01T01:00:00+02:00",
      earliest: "2025-01-01T01:00:00+02:00",
      latest: "2025-01-01T00:00:00Z",
    },
    expected: {
      ...field,
      description: "",
      value: "2025-01-01T01:00:00+02:00",
      config: {
        kind: "datetime",
        defaultValue: "2025-01-01T01:00:00+02:00",
        earliest: "2025-01-01T01:00:00+02:00",
        latest: "2025-01-01T00:00:00Z",
      },
    },
  },
  {
    name: "an earliest bound after the latest bound as an instant is refused",
    bounds: {
      defaultValue: "",
      earliest: "2025-01-01T00:00:00Z",
      latest: "2025-01-01T01:00:00+02:00",
    },
    expected: "Earliest value cannot be after latest value.",
  },
  {
    name: "a default value after the latest bound is refused",
    bounds: {
      defaultValue: "2025-01-01T03:00:00+02:00",
      earliest: "2025-01-01T01:00:00+02:00",
      latest: "2025-01-01T00:00:00Z",
    },
    expected: "Default value must be within the earliest and latest limits.",
  },
]) {
  test(`Date/Time field settings: ${row.name}`, () => {
    expect(buildField(field, draft(row.bounds))).toEqual(row.expected);
  });
}
