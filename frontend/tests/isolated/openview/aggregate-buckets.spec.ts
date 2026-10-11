import { expect, test } from "@playwright/test";
import {
  aggregateBucketKeys,
  validAggregateBucketWindow,
} from "../../../src/components/systems/openview/domain/aggregate-buckets";
import { dashboardWidgetWireConfigSchema } from "../../../src/components/systems/openview/adapters/dashboards-api";
import {
  editorDateWindowValid,
  type ChartEditorDraft,
} from "../../../src/components/systems/openview/domain/chart-query";

const moduleId = "00000000-0000-4000-8000-000000000102";
const amountFieldId = "00000000-0000-4000-8000-000000000107";
const dateFieldId = "00000000-0000-4000-8000-000000000108";

// A month or year series counts calendar buckets, not days: each window is
// longer than 366 days and still holds at most 366 buckets.
const longWindows = [
  {
    source: "Chart editor",
    bucket: "month",
    from: "2025-12-15",
    to: "2027-01-04",
    keys: [
      "2025-12-01",
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
      "2026-06-01",
      "2026-07-01",
      "2026-08-01",
      "2026-09-01",
      "2026-10-01",
      "2026-11-01",
      "2026-12-01",
      "2027-01-01",
    ],
  },
  {
    source: "Chart editor",
    bucket: "year",
    from: "2020-02-10",
    to: "2027-12-31",
    keys: [
      "2020-01-01",
      "2021-01-01",
      "2022-01-01",
      "2023-01-01",
      "2024-01-01",
      "2025-01-01",
      "2026-01-01",
      "2027-01-01",
    ],
  },
  {
    source: "saved Chart",
    bucket: "month",
    from: "2020-01-01",
    to: "2022-12-31",
    keys: [
      "2020-01-01",
      "2020-02-01",
      "2020-03-01",
      "2020-04-01",
      "2020-05-01",
      "2020-06-01",
      "2020-07-01",
      "2020-08-01",
      "2020-09-01",
      "2020-10-01",
      "2020-11-01",
      "2020-12-01",
      "2021-01-01",
      "2021-02-01",
      "2021-03-01",
      "2021-04-01",
      "2021-05-01",
      "2021-06-01",
      "2021-07-01",
      "2021-08-01",
      "2021-09-01",
      "2021-10-01",
      "2021-11-01",
      "2021-12-01",
      "2022-01-01",
      "2022-02-01",
      "2022-03-01",
      "2022-04-01",
      "2022-05-01",
      "2022-06-01",
      "2022-07-01",
      "2022-08-01",
      "2022-09-01",
      "2022-10-01",
      "2022-11-01",
      "2022-12-01",
    ],
  },
  {
    source: "saved Chart",
    bucket: "year",
    from: "2020-01-01",
    to: "2022-12-31",
    keys: ["2020-01-01", "2021-01-01", "2022-01-01"],
  },
] as const;

function seriesDraft(
  bucket: "month" | "year",
  from: string,
  to: string,
): ChartEditorDraft {
  return {
    widgetType: "chart",
    chartType: "line",
    mode: "date_series",
    bucket,
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
    aggregation: "count",
    measure: null,
    dateField: { fieldId: dateFieldId, expectedType: "date" },
    fromDate: from,
    toDate: to,
  };
}

function savedSeries(bucket: "month" | "year", from: string, to: string) {
  return {
    version: 1,
    chart_type: "line",
    query: {
      mode: "date_series",
      module_id: moduleId,
      definition: {
        version: 1,
        columns: [],
        filters: [],
        sort: [],
        logic: "and",
        deleted: "exclude",
        search: null,
        search_fields: [],
      },
      aggregation: "sum",
      measure: { field_id: amountFieldId, expected_type: "decimal" },
      date_field: { field_id: dateFieldId, expected_type: "date" },
      from_date: from,
      to_date: to,
      bucket,
    },
  };
}

for (const window of longWindows) {
  test(`a ${window.source} ${window.bucket} series accepts ${window.from} to ${window.to}`, () => {
    expect(
      validAggregateBucketWindow(window.from, window.to, window.bucket),
    ).toBe(true);
    expect(aggregateBucketKeys(window.from, window.to, window.bucket)).toEqual(
      window.keys,
    );
    expect(
      window.source === "Chart editor"
        ? editorDateWindowValid(
            seriesDraft(window.bucket, window.from, window.to),
          )
        : dashboardWidgetWireConfigSchema.safeParse(
            savedSeries(window.bucket, window.from, window.to),
          ).success,
    ).toBe(true);
  });
}

// The Chart editor refuses these windows before any request: too many monthly
// buckets, a reversed range, and a missing end.
for (const window of [
  { name: "367 monthly buckets", from: "1980-01-01", to: "2010-07-01" },
  { name: "a reversed range", from: "1980-01-01", to: "1979-12-31" },
  { name: "a missing end", from: "1980-01-01", to: "" },
]) {
  test(`a month series refuses ${window.name}`, () => {
    expect(validAggregateBucketWindow(window.from, window.to, "month")).toBe(
      false,
    );
    expect(
      editorDateWindowValid(seriesDraft("month", window.from, window.to)),
    ).toBe(false);
  });
}

test("a saved month series over 366 buckets is refused", () => {
  expect(
    dashboardWidgetWireConfigSchema.safeParse(
      savedSeries("month", "1980-01-01", "2010-07-01"),
    ).success,
  ).toBe(false);
});
