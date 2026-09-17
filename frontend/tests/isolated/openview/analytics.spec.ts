import { expect, test } from "@playwright/test";
import {
  chartRows,
  serializeExportCsv,
  type ExportRequest,
} from "../../../src/components/systems/openview/components/analytics";
import {
  defaultChartSettings,
  type OpenViewRow,
} from "../../../src/components/systems/openview/domain/model";
import { resolveChartLegendLabel } from "../../../src/components/ui/chart";

function serviceRow(id: string, values: OpenViewRow["values"]): OpenViewRow {
  return { id, moduleId: "service-requests", values };
}

test("chart averages ignore records whose numeric metric is blank", () => {
  const settings = {
    ...defaultChartSettings("service-requests"),
    dimension: "status",
    metric: "progress",
    aggregation: "average" as const,
    dateField: "dueDate",
  };
  const result = chartRows(settings, [
    serviceRow("scheduled", {
      status: "Open",
      progress: 50,
      dueDate: "2026-09-20",
    }),
    serviceRow("unspecified", {
      status: "Open",
      progress: "",
      dueDate: "2026-09-21",
    }),
  ]);

  expect(result.data).toHaveLength(1);
  expect(result.data[0]?.value).toBe(50);
});

test("bounded charts exclude records without a valid selected date", () => {
  const settings = {
    ...defaultChartSettings("service-requests"),
    dimension: "status",
    dateField: "dueDate",
    from: "",
    to: "2026-09-30",
  };
  const result = chartRows(settings, [
    serviceRow("dated", { status: "Open", dueDate: "2026-09-20" }),
    serviceRow("undated", { status: "Open", dueDate: "" }),
    serviceRow("invalid-date", { status: "Open", dueDate: "2026-99-99" }),
  ]);

  expect(result.rows.map((row) => row.id)).toEqual(["dated"]);
});

test("report CSV mirrors visible groups and totals", () => {
  const openRows = [
    serviceRow("open-1", { title: "Inspect pump", status: "Open" }),
    serviceRow("open-2", { title: "=Formula risk", status: "Open" }),
  ];
  const closedRows = [
    serviceRow("closed-1", { title: "Replace seal", status: "Closed" }),
  ];
  const request: ExportRequest = {
    kind: "csv",
    title: "Grouped report",
    source: "Service requests",
    fields: ["title", "status"],
    fieldLabels: { title: "Request", status: "Status" },
    rows: [...openRows, ...closedRows],
    filters: { logic: "and", clauses: [] },
    grouping: "status",
    totals: true,
    groups: [
      { label: "Open", rows: openRows },
      { label: "Closed", rows: closedRows },
    ],
  };

  const csv = serializeExportCsv(request);

  expect(csv).toContain('"Group: Open",""');
  expect(csv).toContain('"Group total: 2",""');
  expect(csv).toContain('"Group: Closed",""');
  expect(csv).toContain('"Grand total: 3",""');
  expect(csv).toContain('"\'=Formula risk","Open"');
});

test("chart legends fall back to the payload label when config keys differ", () => {
  expect(
    resolveChartLegendLabel(undefined, {
      value: "In progress",
      dataKey: "value",
    }),
  ).toBe("In progress");
});
