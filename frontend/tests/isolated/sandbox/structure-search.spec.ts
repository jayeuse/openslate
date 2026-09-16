import { expect, test } from "@playwright/test";
import {
  fieldsForModule,
  searchSandboxStructure,
  type SandboxField,
  type SandboxState,
} from "../../../src/lib/sandbox/model";

const fields: SandboxField[] = [
  {
    id: "field-name",
    moduleId: "module-equipment",
    name: "Name",
    type: "text",
    required: true,
    description: "",
  },
  {
    id: "field-status",
    moduleId: "module-equipment",
    name: "Status",
    type: "select",
    required: false,
    description: "",
  },
  {
    id: "field-owner",
    moduleId: "module-people",
    name: "Owner",
    type: "text",
    required: false,
    description: "",
  },
];

const state: SandboxState = {
  departments: [
    {
      id: "department-operations",
      name: "Operations",
      moduleIds: ["module-equipment", "module-people"],
    },
    {
      id: "department-finance",
      name: "Finance",
      moduleIds: ["module-invoices"],
    },
  ],
  modules: [
    {
      id: "module-equipment",
      departmentId: "department-operations",
      name: "Equipment",
      fieldIds: ["field-name", "missing-field", "field-status"],
    },
    {
      id: "module-people",
      departmentId: "department-operations",
      name: "People",
      fieldIds: ["field-owner"],
    },
    {
      id: "module-invoices",
      departmentId: "department-finance",
      name: "Invoices",
      fieldIds: [],
    },
  ],
  fields,
  links: [],
  selectedCellId: null,
};

test("fieldsForModule preserves declared field order and supports list or map lookup", () => {
  const fieldsById = new Map(fields.map((field) => [field.id, field]));

  expect(
    fieldsForModule("module-equipment", state.modules[0].fieldIds, fields),
  ).toEqual([fields[0], fields[1]]);
  expect(
    fieldsForModule("module-equipment", state.modules[0].fieldIds, fieldsById),
  ).toEqual([fields[0], fields[1]]);
  expect(fieldsForModule("module-equipment", ["field-owner"], fields)).toEqual(
    [],
  );
});

test("searchSandboxStructure shares department, module, and field matches", () => {
  const byField = searchSandboxStructure(state, "status");
  const statusDepartment = byField.departments.get("department-operations");
  expect(statusDepartment?.matches).toBe(true);
  expect(statusDepartment?.modules.map((module) => module.id)).toEqual([
    "module-equipment",
  ]);
  expect(
    statusDepartment?.fieldsByModule
      .get("module-equipment")
      ?.map((field) => field.id),
  ).toEqual(["field-status"]);
  expect(byField.departments.get("department-finance")?.matches).toBe(false);
  expect(byField.hasMatches).toBe(true);

  const byDepartment = searchSandboxStructure(state, "operations");
  expect(
    byDepartment.departments
      .get("department-operations")
      ?.modules.map((module) => module.id),
  ).toEqual(["module-equipment", "module-people"]);
  expect(
    byDepartment.departments
      .get("department-operations")
      ?.fieldsByModule.get("module-equipment")
      ?.map((field) => field.id),
  ).toEqual(["field-name", "field-status"]);

  const missing = searchSandboxStructure(state, "does not exist");
  expect(missing.hasMatches).toBe(false);
  expect(missing.departments.get("department-operations")?.matches).toBe(false);
});
