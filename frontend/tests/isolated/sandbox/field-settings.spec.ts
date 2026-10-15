import { expect, test } from "@playwright/test";
import { buildField } from "../../../src/components/systems/sandbox/components/designer-field-settings";
import type { Field } from "../../../src/components/systems/sandbox/domain/model";

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
