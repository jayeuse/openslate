import { expect, test } from "@playwright/test";

import { openingModuleId } from "../../../src/components/systems/sandbox/domain/opening-module";

const moduleOf = (id: string, department: string) => ({
  id,
  department,
  name: id,
  closed: false,
  fields: [],
  x: 0,
  y: 0,
});
const line = (id: string, source: string, target: string) => ({
  id,
  name: id,
  source,
  target,
  cardinality: "one-to-many",
  fieldMappings: [],
});

test("the Build view opens on the first module of the busiest department", () => {
  expect(
    openingModuleId({
      departments: [
        { id: "admin", name: "Admin", closed: false },
        { id: "sales", name: "Sales", closed: false },
      ],
      modules: [
        moduleOf("staff", "admin"),
        moduleOf("orders", "sales"),
        moduleOf("customers", "sales"),
      ],
      relationships: [line("placed", "customers", "orders")],
    }),
  ).toBe("orders");
});

test("an empty design has no opening module", () => {
  expect(
    openingModuleId({ departments: [], modules: [], relationships: [] }),
  ).toBeNull();
});
