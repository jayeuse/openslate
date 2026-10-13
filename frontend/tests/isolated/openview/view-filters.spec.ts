import { expect, test } from "@playwright/test";
import type { OpenViewQueryDefinition } from "../../../src/components/systems/openview/adapters/views-api";
import { serializeOpenViewQueryDefinition } from "../../../src/components/systems/openview/adapters/views-serialization";
import {
  filterValueForType,
  hasUnsafeIntegerFilter,
  isFilterReady,
} from "../../../src/components/systems/openview/domain/server-view-draft";
import { emptyQuery } from "../../helpers/query-definitions";

const fieldId = "00000000-0000-4000-8000-000000000301";

type Filter = OpenViewQueryDefinition["filters"][number];

function equalsFilter(
  expectedType: Filter["expectedType"],
  value: Filter["value"],
): Filter {
  return { fieldId, expectedType, operator: "eq", value };
}

function definitionWith(filter: Filter): OpenViewQueryDefinition {
  return emptyQuery({ filters: [filter] });
}

// Each typed value reaches the query unchanged: decimal text keeps its
// precision, a number filter sends a number.
for (const current of [
  { type: "decimal", input: "1.25", value: "1.25" },
  { type: "decimal", input: "9007199254740993", value: "9007199254740993" },
  { type: "number", input: "12.5", value: 12.5 },
] as const) {
  test(`a ${current.type} View filter sends ${JSON.stringify(current.input)} as a ${typeof current.value}`, () => {
    const value = filterValueForType(current.type, current.input);
    expect(value).toBe(current.value);
    const filter = equalsFilter(current.type, value);
    expect(isFilterReady(filter)).toBe(true);
    expect(
      serializeOpenViewQueryDefinition(definitionWith(filter)).filters,
    ).toEqual([
      {
        field_id: fieldId,
        expected_type: current.type,
        operator: "eq",
        value: current.value,
      },
    ]);
  });
}

// An integer that a number cannot hold stays text and blocks the query, and a
// cleared number stays blank instead of becoming zero.
for (const current of [
  {
    title: "an integer View filter keeps an unsafe integer as text",
    type: "int",
    input: "9007199254740993",
    value: "9007199254740993",
    unsafe: true,
  },
  {
    title: "an integer View filter keeps a fraction as text",
    type: "int",
    input: "1.0000000000000001",
    value: "1.0000000000000001",
    unsafe: true,
  },
  {
    title: "a cleared number View filter stays blank instead of zero",
    type: "number",
    input: "",
    value: "",
    unsafe: false,
    ready: false,
  },
] as const) {
  test(current.title, () => {
    const value = filterValueForType(current.type, current.input);
    expect(value).toBe(current.value);
    const filter = equalsFilter(current.type, value);
    expect(hasUnsafeIntegerFilter(filter)).toBe(current.unsafe);
    if ("ready" in current) expect(isFilterReady(filter)).toBe(current.ready);
  });
}
