import { expect, test } from "@playwright/test";
import {
  FIELD_TYPES,
  initialDesign,
  normalizeField,
  type Design,
} from "../../../src/components/systems/sandbox/domain/model";
import { configuredSandboxDesign } from "../../helpers/sandbox-fixtures";
import { validateSandboxDesign } from "../../../src/components/systems/sandbox/domain/validation";
import {
  canvasFieldId,
  updateProjectedField,
} from "../../../src/components/systems/sandbox/helpers/bridge";

function fixture(): Design {
  return structuredClone(configuredSandboxDesign);
}

test("new Sandbox workspaces start without placeholder entities", () => {
  expect(initialDesign).toEqual({
    departments: [],
    modules: [],
    relationships: [],
    rules: [],
    layout: {},
  });
});

test("sandbox field configuration includes User and assigns stable IDs to legacy select choices", () => {
  expect(FIELD_TYPES.map((type) => type.name)).toEqual([
    "Text",
    "Long text",
    "Number",
    "Integer",
    "Date",
    "Date/Time",
    "Checkbox",
    "Select",
    "User",
    "Email",
    "URL",
  ]);
  const normalized = normalizeField({
    id: "status",
    name: "Status",
    type: "Select",
    required: false,
    value: "Open",
    options: " Open, Closed, Open ",
    closed: false,
  });
  expect(normalized.config.kind).toBe("select");
  if (normalized.config.kind !== "select")
    throw new Error("Status must remain a select field");
  expect(normalized.config.options.map((option) => option.label)).toEqual([
    "Open",
    "Closed",
  ]);
  const selected = normalized.config.options.find(
    (option) => option.label === "Open",
  );
  expect(normalized.config.defaultValue).toBe(selected?.id);
  expect(selected?.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
});

test("canvas field type changes replace incompatible saved configuration", () => {
  const design = fixture();
  const sandboxModule = design.modules[0];
  sandboxModule.fields[2] = normalizeField(sandboxModule.fields[2]);

  const updated = updateProjectedField(
    design,
    canvasFieldId(sandboxModule.id, sandboxModule.fields[2].id),
    { type: "decimal" },
  );
  const field = updated.modules[0].fields[2];

  expect(field.type).toBe("Number");
  expect(field.config).toEqual({ kind: "number", defaultValue: null });
  expect(
    validateSandboxDesign(updated).some(
      (issue) => issue.code === "field.config_type_mismatch",
    ),
  ).toBe(false);
});

test("derived validation reports broken references, duplicate relationships, and mismatched defaults", () => {
  const invalid = fixture();
  invalid.modules.push({
    id: "orphan",
    department: "missing-department",
    name: "Orphan",
    closed: false,
    fields: [
      {
        id: "bad-number",
        name: "Amount",
        type: "Number",
        required: false,
        value: "not-a-number",
        options: "",
        closed: false,
      },
    ],
    x: 0,
    y: 0,
  });
  invalid.relationships.push({
    ...invalid.relationships[0],
    id: "duplicate-link",
  });
  invalid.relationships.push({
    id: "broken-link",
    name: "Broken",
    source: "missing-module",
    target: "sample-requests",
    cardinality: "One-to-one",
    fieldMappings: [],
  });
  invalid.relationships.push({
    id: "cross-department-link",
    name: "Customer request",
    source: "sample-requests",
    target: "sample-customers",
    cardinality: "One-to-many",
    fieldMappings: [],
  });

  const validation = validateSandboxDesign(invalid);
  const codes = validation.map((issue) => issue.code);
  expect(codes).toContain("module.department_missing");
  expect(codes).toContain("relationship.duplicate");
  expect(codes).toContain("relationship.source_missing");
  expect(codes).toContain("field.default_type_mismatch");
  expect(validation).toContainEqual(
    expect.objectContaining({
      code: "relationship.cross_department",
      severity: "warning",
      targetId: "cross-department-link",
    }),
  );
});

test("field validation issues retain module-scoped identity when field IDs repeat", () => {
  const invalid = fixture();
  invalid.modules[0].fields.find(
    (field) => field.id === "sample-field-Status",
  )!.type = "Unsupported";
  invalid.modules[1].fields.find(
    (field) => field.id === "sample-field-Status",
  )!.type = "Unsupported";

  expect(
    validateSandboxDesign(invalid).filter(
      (issue) => issue.code === "field.type_unsupported",
    ),
  ).toEqual([
    expect.objectContaining({
      targetId: "sample-field-Status",
      moduleId: "sample-requests",
    }),
    expect.objectContaining({
      targetId: "sample-field-Status",
      moduleId: "sample-equipment",
    }),
  ]);
});
