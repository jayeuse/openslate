import { expect, test } from "@playwright/test";

import {
  addFilterClause,
  normalizeFilterGroup,
  operatorsForField,
  updateFilterClause,
} from "../../../src/components/sample/openview/filter-helpers";
import {
  getModuleDefinition,
  filterRows,
  getOpenViewRows,
  type FilterGroup,
} from "../../../src/components/sample/openview/model";
import { INITIAL_RECORDS } from "../../../src/components/sample/sample-data";

const serviceRequests = getModuleDefinition("service-requests");

function filters(clause: FilterGroup["clauses"][number]): FilterGroup {
  return { logic: "and", clauses: [clause] };
}

test("field-compatible filters reset invalid operators and values together", () => {
  const next = updateFilterClause(
    serviceRequests,
    filters({ field: "title", operator: "starts-with", value: "Pump" }),
    0,
    { field: "dueDate" },
  );

  expect(next.clauses[0]).toEqual({
    field: "dueDate",
    operator: "equals",
    value: "",
  });
});

test("analytics-compatible filters keep all operators while clearing a changed value", () => {
  const next = updateFilterClause(
    serviceRequests,
    filters({ field: "title", operator: "starts-with", value: "Pump" }),
    0,
    { field: "dueDate" },
    { operatorMode: "all", clearValueOnFieldChange: true },
  );

  expect(next.clauses[0]).toEqual({
    field: "dueDate",
    operator: "starts-with",
    value: "",
  });
});

test("adding filters preserves the date default and enforces the eight-clause limit", () => {
  const dateField = serviceRequests.fields.find(
    (field) => field.type === "date",
  );
  if (!dateField) throw new Error("service request fixture needs a date field");
  const dateModule = {
    ...serviceRequests,
    fields: [
      dateField,
      ...serviceRequests.fields.filter((field) => field !== dateField),
    ],
  };
  const added = addFilterClause(dateModule, { logic: "and", clauses: [] });
  expect(added.clauses[0]).toEqual({
    field: dateModule.fields[0]?.id,
    operator: "on-or-after",
    value: "",
  });

  const capped = addFilterClause(serviceRequests, {
    logic: "or",
    clauses: Array.from({ length: 8 }, () => ({
      field: "title",
      operator: "contains" as const,
      value: "",
    })),
  });
  expect(capped.clauses).toHaveLength(8);
});

test("normalization retains valid clauses and drops unknown fields", () => {
  const normalized = normalizeFilterGroup(
    {
      logic: "or",
      clauses: [
        { field: "missing", operator: "equals", value: "stale" },
        { field: "status", operator: "equals", value: "Open" },
        { field: "dueDate", operator: "starts-with", value: "stale" },
      ],
    },
    serviceRequests,
  );

  expect(normalized).toEqual({
    logic: "or",
    clauses: [
      { field: "status", operator: "equals", value: "Open" },
      { field: "dueDate", operator: "equals", value: "" },
    ],
  });
});

test("shared filter updates remain consumable by the flat result evaluator", () => {
  const rows = getOpenViewRows("service-requests", INITIAL_RECORDS);
  const base = filters({ field: "status", operator: "equals", value: "Open" });
  const openRows = filterRows(rows, base);
  const notOpen = updateFilterClause(serviceRequests, base, 0, {
    operator: "not-equals",
  });

  expect(openRows.length).toBeGreaterThan(0);
  expect(openRows.every((row) => row.values.status === "Open")).toBe(true);
  expect(
    filterRows(rows, notOpen).every((row) => row.values.status !== "Open"),
  ).toBe(true);
});

test("field operator options remain type-specific", () => {
  expect(
    operatorsForField({ id: "dueDate", label: "Due date", type: "date" }),
  ).toEqual([
    "equals",
    "not-equals",
    "on-or-after",
    "on-or-before",
    "is-empty",
    "is-not-empty",
  ]);
  expect(
    operatorsForField({ id: "progress", label: "Progress", type: "number" }),
  ).toEqual(["equals", "not-equals", "is-empty", "is-not-empty"]);
});
