import { expect, test } from "@playwright/test";
import type { BoardWidget } from "../../../src/components/systems/boards/adapters/board-widgets-api";
import {
  buildBoardWidgetQueryPlan,
  collapseBoardWidgetPie,
} from "../../../src/components/systems/boards/domain/live-widget-query";

const fieldId = "00000000-0000-4000-8000-000000000001";
const dateFieldId = "00000000-0000-4000-8000-000000000002";
const metricId = "00000000-0000-4000-8000-000000000003";
const moduleId = "00000000-0000-4000-8000-000000000004";

function widget(overrides: Partial<BoardWidget> = {}): BoardWidget {
  return {
    id: "00000000-0000-4000-8000-000000000005",
    boardId: "00000000-0000-4000-8000-000000000006",
    name: "Live widget",
    widgetType: "summary",
    moduleId,
    position: 0,
    config: {
      version: 1,
      fields: [{ fieldId, expectedType: "select" }],
      filters: [
        { fieldId, expectedType: "select", operator: "eq", value: "Open" },
      ],
      logic: "and",
      metric: null,
      visualization: "bar",
      size: "half",
      refresh: "manual",
      pinned: false,
    },
    audience: { kind: "everyone", roleId: null, userId: null },
    createdAt: "2026-09-23T00:00:00Z",
    updatedAt: "2026-09-23T00:00:00Z",
    ...overrides,
  };
}

test("summary plans a filtered record total without requesting row fields", () => {
  const plan = buildBoardWidgetQueryPlan(widget());
  expect(plan).toMatchObject({
    kind: "records",
    widgetType: "summary",
    request: {
      moduleId,
      limit: 1,
      offset: 0,
      definition: {
        columns: [],
        filters: [
          { fieldId, expectedType: "select", operator: "eq", value: "Open" },
        ],
        logic: "and",
        sort: [],
        deleted: "exclude",
        search: null,
        searchFields: [],
      },
    },
  });
});

test("records plans a bounded first page with selected fields and deterministic server ordering", () => {
  const plan = buildBoardWidgetQueryPlan(widget({ widgetType: "records" }));
  expect(plan).toMatchObject({
    kind: "records",
    widgetType: "records",
    request: {
      moduleId,
      limit: 5,
      offset: 0,
      definition: {
        columns: [{ fieldId, expectedType: "select" }],
        sort: [],
      },
    },
  });
});

test("workload and bar charts use the first categorical field with bounded grouped aggregates", () => {
  const base = widget({
    widgetType: "workload",
    config: {
      ...widget().config,
      metric: { fieldId: metricId, expectedType: "decimal" },
    },
  });
  expect(buildBoardWidgetQueryPlan(base)).toMatchObject({
    kind: "aggregate",
    widgetType: "workload",
    request: {
      mode: "groups",
      moduleId,
      dimension: { fieldId, expectedType: "select" },
      aggregation: "sum",
      measure: { fieldId: metricId, expectedType: "decimal" },
      limit: 8,
      offset: 0,
    },
  });
  expect(
    buildBoardWidgetQueryPlan(widget({ widgetType: "chart" })),
  ).toMatchObject({
    kind: "aggregate",
    widgetType: "chart",
    visualization: "bar",
    request: {
      mode: "groups",
      dimension: { fieldId, expectedType: "select" },
      aggregation: "count",
      limit: 12,
      offset: 0,
    },
  });
});

test("pie plans a complete aggregate snapshot and rolls every remaining group into Other", () => {
  const plan = buildBoardWidgetQueryPlan(
    widget({
      widgetType: "chart",
      config: { ...widget().config, visualization: "pie" },
    }),
  );
  expect(plan).toMatchObject({
    kind: "snapshot",
    visualization: "pie",
    request: {
      mode: "groups",
      moduleId,
      dimension: { fieldId, expectedType: "select" },
      aggregation: "count",
    },
  });
  const projection = collapseBoardWidgetPie({
    items: Array.from({ length: 10 }, (_, index) => ({
      key: `group-${index}`,
      label: `Group ${index}`,
      value: 10 - index,
      recordCount: 10 - index,
    })),
    pagination: { limit: 10, offset: 0, count: 10, total: 10, hasMore: false },
  });
  expect(projection).toMatchObject({
    kind: "ready",
    totalGroups: 10,
    rolledUpGroups: 2,
    points: [
      {
        key: "group:value:group-0",
        label: "Group 0",
        value: 10,
        recordCount: 10,
      },
      { key: "group:value:group-1" },
      { key: "group:value:group-2" },
      { key: "group:value:group-3" },
      { key: "group:value:group-4" },
      { key: "group:value:group-5" },
      { key: "group:value:group-6" },
      { key: "group:value:group-7" },
      { key: "rollup:other", label: "Other", value: 3, recordCount: 3 },
    ],
  });
});

test("line plans every day in a rolling 30-day workspace calendar window", () => {
  const plan = buildBoardWidgetQueryPlan(
    widget({
      widgetType: "chart",
      config: {
        ...widget().config,
        fields: [{ fieldId: dateFieldId, expectedType: "datetime" }],
        visualization: "line",
      },
    }),
    { workspaceToday: "2024-03-01" },
  );
  expect(plan).toMatchObject({
    kind: "snapshot",
    visualization: "line",
    request: {
      mode: "date_series",
      dateField: { fieldId: dateFieldId, expectedType: "datetime" },
      fromDate: "2024-02-01",
      toDate: "2024-03-01",
      aggregation: "count",
    },
  });
});

test("unsupported dimensions and missing or invalid workspace dates fail closed", () => {
  const numeric = widget({
    widgetType: "workload",
    config: {
      ...widget().config,
      fields: [{ fieldId, expectedType: "number" }],
    },
  });
  expect(buildBoardWidgetQueryPlan(numeric)).toMatchObject({
    kind: "unavailable",
  });
  const line = widget({
    widgetType: "chart",
    config: { ...widget().config, visualization: "line" },
  });
  expect(buildBoardWidgetQueryPlan(line)).toMatchObject({
    kind: "unavailable",
  });
  const dated = widget({
    widgetType: "chart",
    config: {
      ...widget().config,
      fields: [{ fieldId: dateFieldId, expectedType: "date" }],
      visualization: "line",
    },
  });
  expect(
    buildBoardWidgetQueryPlan(dated, { workspaceToday: "2024-02-31" }),
  ).toMatchObject({
    kind: "unavailable",
  });
});

test("pie rejects values that cannot be charted without silently substituting zero", () => {
  const projection = collapseBoardWidgetPie({
    items: [{ key: "huge", label: "Huge", value: "1e999", recordCount: 1 }],
    pagination: { limit: 1, offset: 0, count: 1, total: 1, hasMore: false },
  });
  expect(projection).toEqual({
    kind: "unavailable",
    reason: "unrepresentable-value",
  });
});

test("pie synthetic Other key cannot collide with a real group key", () => {
  const projection = collapseBoardWidgetPie({
    items: [
      { key: "other", label: "Other", value: 9, recordCount: 9 },
      ...Array.from({ length: 8 }, (_, index) => ({
        key: `value-${index}`,
        label: `Value ${index}`,
        value: 8 - index,
        recordCount: 8 - index,
      })),
    ],
    pagination: { limit: 9, offset: 0, count: 9, total: 9, hasMore: false },
  });
  expect(projection.kind).toBe("ready");
  if (projection.kind !== "ready") return;
  expect(new Set(projection.points.map((point) => point.key)).size).toBe(
    projection.points.length,
  );
});
