import { expect, test } from "@playwright/test";
import type { OpenViewDataSourceField } from "../../../src/components/systems/openview/adapters/views-api";
import {
  compileChartEditorDraft,
  isNumericField,
  newChartEditorDraft,
  type ChartEditorDraft,
} from "../../../src/components/systems/openview/domain/chart-query";

const moduleId = "00000000-0000-4000-8000-000000000102";
const categoryFieldId = "00000000-0000-4000-8000-000000000103";
const amountFieldId = "00000000-0000-4000-8000-000000000107";
const dateFieldId = "00000000-0000-4000-8000-000000000108";
const unitsFieldId = "00000000-0000-4000-8000-000000000110";
const scoreFieldId = "00000000-0000-4000-8000-000000000111";

function field(
  id: string,
  name: string,
  type: OpenViewDataSourceField["type"],
  position: number,
): OpenViewDataSourceField {
  return { id, moduleId, name, type, required: false, position, config: {} };
}

// The Dashboard builder's data source: one category, three numeric measures.
const fields = [
  field(categoryFieldId, "Category", "select", 0),
  field(amountFieldId, "Amount", "decimal", 2),
  field(dateFieldId, "Occurred on", "date", 3),
  field(unitsFieldId, "Units", "int", 5),
  field(scoreFieldId, "Score", "number", 6),
];
const definition = {
  version: 1,
  logic: "and",
  columns: [],
  filters: [],
  sort: [],
  deleted: "exclude",
  search: null,
  searchFields: [],
};
const amount = { fieldId: amountFieldId, expectedType: "decimal" } as const;
const category = { fieldId: categoryFieldId, expectedType: "select" } as const;
const score = { fieldId: scoreFieldId, expectedType: "number" } as const;

type AggregateDraft = Exclude<ChartEditorDraft, { mode: "records" }>;

function grouped(chartType: "bar" | "pie"): AggregateDraft {
  const draft = newChartEditorDraft(moduleId, fields);
  if (draft.mode !== "groups" || draft.widgetType !== "chart")
    throw new Error("A new chart is a grouped chart");
  return { ...draft, chartType, aggregation: "sum" };
}
const averageOverTime: AggregateDraft = {
  widgetType: "chart",
  chartType: "line",
  mode: "date_series",
  bucket: "day",
  moduleId,
  definition: {
    version: 1,
    logic: "and",
    columns: [],
    sort: [],
    deleted: "exclude",
    search: null,
    searchFields: [],
  },
  filters: [],
  nextFilterId: 0,
  aggregation: "average",
  measure: null,
  dateField: { fieldId: dateFieldId, expectedType: "date" },
  fromDate: "2024-03-01",
  toDate: "2024-03-02",
};

test("only numeric fields are offered as a measure", () => {
  expect(
    fields.filter(isNumericField).map((candidate) => candidate.name),
  ).toEqual(["Amount", "Units", "Score"]);
});

for (const current of [
  {
    name: "bar Sum",
    draft: grouped("bar"),
    measure: amount,
    config: {
      version: 1,
      chartType: "bar",
      query: {
        moduleId,
        definition,
        aggregation: "sum",
        measure: amount,
        mode: "groups",
        dimension: category,
      },
    },
  },
  {
    name: "pie Sum",
    draft: grouped("pie"),
    measure: amount,
    config: {
      version: 1,
      chartType: "pie",
      query: {
        moduleId,
        definition,
        aggregation: "sum",
        measure: amount,
        mode: "groups",
        dimension: category,
      },
    },
  },
  {
    name: "line Average",
    draft: averageOverTime,
    measure: score,
    config: {
      version: 1,
      chartType: "line",
      query: {
        moduleId,
        definition,
        aggregation: "average",
        measure: score,
        dateField: { fieldId: dateFieldId, expectedType: "date" },
        fromDate: "2024-03-01",
        toDate: "2024-03-02",
        mode: "date_series",
        bucket: "day",
      },
    },
  },
] as const) {
  test(`a ${current.name} chart compiles only with a typed numeric measure`, () => {
    expect(
      compileChartEditorDraft({ ...current.draft, measure: null }, fields),
    ).toBeNull();
    expect(
      compileChartEditorDraft({ ...current.draft, measure: category }, fields),
    ).toBeNull();
    expect(
      compileChartEditorDraft(
        { ...current.draft, measure: current.measure },
        fields,
      ),
    ).toEqual({ widgetType: "chart", config: current.config });
  });
}
