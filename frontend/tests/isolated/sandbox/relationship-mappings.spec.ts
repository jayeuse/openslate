import { expect, test } from "@playwright/test";
import {
  type Design,
  type Field,
  relationshipFieldTypesAreCompatible,
} from "../../../src/components/systems/sandbox/domain/model";
import { validateSandboxDesign } from "../../../src/components/systems/sandbox/domain/validation";
import { configuredSandboxDesign as initialDesign } from "../../helpers/sandbox-fixtures";

function fixture(): Design {
  return structuredClone(initialDesign);
}

function mappingCodes(
  source: Partial<Field>,
  target: Partial<Field>,
): string[] {
  const design = fixture();
  const sourceField = design.modules[0].fields.find(
    (field) => field.id === "sample-field-Title",
  );
  const targetField = design.modules[1].fields.find(
    (field) => field.id === "sample-field-Name",
  );
  if (!sourceField || !targetField)
    throw new Error("Fixture is missing mapping fields");
  Object.assign(sourceField, source);
  Object.assign(targetField, target);
  design.relationships[0].fieldMappings = [
    {
      sourceFieldId: sourceField.id,
      targetFieldId: targetField.id,
    },
  ];
  return validateSandboxDesign(design).map((issue) => issue.code);
}

test("relationship mappings accept compatible fields and reject duplicate, incompatible, and dangling pairs", () => {
  const design = fixture();
  const relationship = design.relationships[0];

  relationship.fieldMappings = [
    {
      sourceFieldId: "sample-field-Title",
      targetFieldId: "sample-field-Name",
    },
    {
      sourceFieldId: "sample-field-Status",
      targetFieldId: "sample-field-Status",
    },
  ];
  expect(validateSandboxDesign(design)).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: expect.stringMatching(/^relationship\.mapping_/),
      }),
    ]),
  );

  relationship.fieldMappings = [
    {
      sourceFieldId: "sample-field-Title",
      targetFieldId: "sample-field-Name",
    },
    {
      sourceFieldId: "sample-field-Title",
      targetFieldId: "sample-field-Name",
    },
    {
      sourceFieldId: "sample-field-Title",
      targetFieldId: "sample-field-Status",
    },
    {
      sourceFieldId: "missing-source-field",
      targetFieldId: "sample-field-Name",
    },
  ];
  expect(validateSandboxDesign(design).map((item) => item.code)).toEqual(
    expect.arrayContaining([
      "relationship.mapping_duplicate",
      "relationship.mapping_type_incompatible",
      "relationship.mapping_source_missing",
    ]),
  );
});

test("relationship mappings reject Select sources whose options the target cannot accept", () => {
  const design = fixture();
  const targetStatus = design.modules
    .find((module) => module.id === "sample-equipment")
    ?.fields.find((field) => field.id === "sample-field-Status");
  if (!targetStatus)
    throw new Error("Fixture is missing the target status field");
  targetStatus.options = "Open";
  targetStatus.config = undefined;
  design.relationships[0].fieldMappings = [
    {
      sourceFieldId: "sample-field-Status",
      targetFieldId: "sample-field-Status",
    },
  ];

  expect(validateSandboxDesign(design).map((issue) => issue.code)).toContain(
    "relationship.mapping_type_incompatible",
  );
});

test("Select relationship compatibility follows labels across independent option IDs", () => {
  const source = {
    id: "source-status",
    name: "Status",
    type: "Select",
    required: true,
    value: "11111111-1111-4111-8111-111111111111",
    options: "",
    closed: false,
    config: {
      kind: "select",
      defaultValue: "11111111-1111-4111-8111-111111111111",
      options: [
        { id: "11111111-1111-4111-8111-111111111111", label: "Open" },
        { id: "22222222-2222-4222-8222-222222222222", label: "Closed" },
      ],
    },
  } as unknown as Field;
  const target = {
    ...source,
    id: "target-status",
    config: {
      kind: "select",
      defaultValue: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      options: [
        { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", label: "Open" },
        { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", label: "Closed" },
      ],
    },
  } as unknown as Field;

  expect(relationshipFieldTypesAreCompatible(source, target)).toBe(true);

  const missingTargetLabel = {
    ...target,
    config: {
      ...target.config,
      options: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", label: "Open" }],
    },
  } as unknown as Field;
  expect(relationshipFieldTypesAreCompatible(source, missingTargetLabel)).toBe(
    false,
  );
});

test("relationship mappings use safe directional numeric and text contracts", () => {
  expect(
    mappingCodes(
      { type: "Integer", config: { kind: "integer", defaultValue: null } },
      { type: "Number", config: { kind: "number", defaultValue: null } },
    ),
  ).not.toContain("relationship.mapping_type_incompatible");
  expect(
    mappingCodes(
      { type: "Number", config: { kind: "number", defaultValue: null } },
      { type: "Integer", config: { kind: "integer", defaultValue: null } },
    ),
  ).toContain("relationship.mapping_type_incompatible");

  expect(
    mappingCodes(
      {
        type: "Text",
        config: { kind: "text", defaultValue: "", maxLength: 120 },
      },
      {
        type: "Long text",
        config: { kind: "long-text", defaultValue: "", maxLength: 100 },
      },
    ),
  ).toContain("relationship.mapping_type_incompatible");
  expect(
    mappingCodes(
      {
        type: "Text",
        config: { kind: "text", defaultValue: "", maxLength: 120 },
      },
      { type: "Long text", config: { kind: "long-text", defaultValue: "" } },
    ),
  ).not.toContain("relationship.mapping_type_incompatible");

  expect(
    mappingCodes(
      { type: "Text", config: { kind: "text", defaultValue: "" } },
      { type: "Email", config: { kind: "email", defaultValue: "" } },
    ),
  ).toContain("relationship.mapping_type_incompatible");
  expect(
    mappingCodes(
      {
        type: "Email",
        config: { kind: "email", defaultValue: "", maxLength: 100 },
      },
      {
        type: "Text",
        config: { kind: "text", defaultValue: "", maxLength: 100 },
      },
    ),
  ).not.toContain("relationship.mapping_type_incompatible");
  expect(
    mappingCodes(
      { type: "Email", config: { kind: "email", defaultValue: "" } },
      { type: "Email", config: { kind: "email", defaultValue: "" } },
    ),
  ).not.toContain("relationship.mapping_type_incompatible");
  expect(
    mappingCodes(
      { type: "URL", config: { kind: "url", defaultValue: "" } },
      { type: "URL", config: { kind: "url", defaultValue: "" } },
    ),
  ).not.toContain("relationship.mapping_type_incompatible");
});

test("relationship mappings respect requiredness and constrained numeric and date targets", () => {
  expect(mappingCodes({ required: false }, { required: true })).toContain(
    "relationship.mapping_type_incompatible",
  );

  expect(
    mappingCodes(
      {
        type: "Integer",
        config: {
          kind: "integer",
          defaultValue: null,
          min: 0,
          max: 10,
          step: 1,
        },
      },
      {
        type: "Number",
        config: {
          kind: "number",
          defaultValue: null,
          min: 0,
          max: 20,
          step: 1,
        },
      },
    ),
  ).not.toContain("relationship.mapping_type_incompatible");
  expect(
    mappingCodes(
      {
        type: "Number",
        config: {
          kind: "number",
          defaultValue: null,
          min: 0,
          max: 30,
          step: 2,
        },
      },
      {
        type: "Number",
        config: {
          kind: "number",
          defaultValue: null,
          min: 0,
          max: 20,
          step: 2,
        },
      },
    ),
  ).toContain("relationship.mapping_type_incompatible");
  expect(
    mappingCodes(
      {
        type: "Number",
        config: {
          kind: "number",
          defaultValue: null,
          min: 1,
          max: 9,
          step: 2,
        },
      },
      {
        type: "Number",
        config: {
          kind: "number",
          defaultValue: null,
          min: 0,
          max: 10,
          step: 2,
        },
      },
    ),
  ).toContain("relationship.mapping_type_incompatible");
  expect(
    mappingCodes(
      {
        type: "Number",
        config: {
          kind: "number",
          defaultValue: null,
          min: 0,
          max: 9,
          step: 2,
        },
      },
      {
        type: "Number",
        config: {
          kind: "number",
          defaultValue: null,
          min: 0,
          max: 10,
          step: 3,
        },
      },
    ),
  ).toContain("relationship.mapping_type_incompatible");

  expect(
    mappingCodes(
      {
        type: "Date",
        config: {
          kind: "date",
          defaultValue: null,
          earliest: "2025-02-01",
          latest: "2025-02-28",
        },
      },
      {
        type: "Date",
        config: {
          kind: "date",
          defaultValue: null,
          earliest: "2025-01-01",
          latest: "2025-12-31",
        },
      },
    ),
  ).not.toContain("relationship.mapping_type_incompatible");
  expect(
    mappingCodes(
      {
        type: "Date",
        config: {
          kind: "date",
          defaultValue: null,
          earliest: "2024-12-31",
          latest: "2025-02-28",
        },
      },
      {
        type: "Date",
        config: {
          kind: "date",
          defaultValue: null,
          earliest: "2025-01-01",
          latest: "2025-12-31",
        },
      },
    ),
  ).toContain("relationship.mapping_type_incompatible");
  expect(
    mappingCodes(
      {
        type: "Date/Time",
        config: {
          kind: "datetime",
          defaultValue: null,
          earliest: "2025-01-01T01:00:00+02:00",
          latest: "2025-01-01T00:00:00Z",
        },
      },
      {
        type: "Date/Time",
        config: {
          kind: "datetime",
          defaultValue: null,
          earliest: "2024-12-31T22:00:00Z",
          latest: "2025-01-01T00:00:00+00:00",
        },
      },
    ),
  ).not.toContain("relationship.mapping_type_incompatible");
});

test("relationship mappings are capped at one thousand per relationship", () => {
  const design = fixture();
  design.relationships[0].fieldMappings = Array.from({ length: 1_001 }, () => ({
    sourceFieldId: "sample-field-Title",
    targetFieldId: "sample-field-Name",
  }));

  expect(validateSandboxDesign(design).map((issue) => issue.code)).toContain(
    "relationship.mapping_limit",
  );
});
