import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../../../src/lib/api";
import type {
  BoardWidget,
  BoardLegacyWidgetConfig,
} from "../../../src/components/systems/boards/adapters/board-widgets-api";
import { ServerBoardWidgetsDisplay } from "../../../src/components/systems/boards/components/server-backed-board-widgets";
import { buildBoardWidgetQueryPlan } from "../../../src/components/systems/boards/domain/live-widget-query";
import {
  emptyLiveWidgetsState,
  classifyLiveWidgetFailure,
  loadLiveWidgetData,
  loadLiveWidgetMetadata,
  transitionLiveWidgetsState,
  type LiveWidgetData,
  type LiveWidgetItem,
  type LiveWidgetsState,
} from "../../../src/components/systems/boards/hooks/use-live-widgets";
import { parsedPagination, wirePagination } from "../../helpers/pagination";
import { wireRecord } from "../../helpers/wire";

const boardId = "00000000-0000-4000-8000-000000000001";
const otherBoardId = "00000000-0000-4000-8000-000000000002";
const moduleId = "00000000-0000-4000-8000-000000000003";
const widgetId = "00000000-0000-4000-8000-000000000004";
const fieldId = "00000000-0000-4000-8000-000000000005";
const recordId = "00000000-0000-4000-8000-000000000006";
const timestamp = "2026-09-23T00:00:00Z";
const key = `${boardId}:2026-09-23`;

const widget: BoardWidget & { config: BoardLegacyWidgetConfig; chartId: null } =
  {
    id: widgetId,
    boardId,
    name: "Live records",
    widgetType: "records",
    moduleId,
    position: 0,
    size: "M",
    pinned: false,
    chartId: null,
    config: {
      version: 1,
      fields: [{ fieldId, expectedType: "text" }],
      filters: [],
      logic: "and",
      metric: null,
      visualization: "bar",
      refresh: "manual",
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
const wireWidget = {
  id: widgetId,
  board_id: boardId,
  name: "Live records",
  widget_type: "records",
  module_id: moduleId,
  position: 0,
  size: "M" as const,
  pinned: false,
  chart_id: null,
  config: {
    version: 1,
    fields: [{ field_id: fieldId, expected_type: "text" }],
    filters: [],
    logic: "and",
    metric: null,
    visualization: "bar",
    refresh: "manual",
  },
  created_at: timestamp,
  updated_at: timestamp,
};

function mockFetch(responder: (path: string) => Response) {
  const original = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = String(input);
    paths.push(path);
    return Promise.resolve(responder(path));
  }) as typeof fetch;
  return {
    paths,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("Board metadata is server-filtered and a partial widget page is not treated as complete", async () => {
  const mock = mockFetch(() =>
    Response.json({
      items: [wireWidget],
      pagination: { limit: 12, offset: 0, count: 1, total: 2, has_more: true },
      board_revision: 1,
    }),
  );
  try {
    await expect(loadLiveWidgetMetadata(boardId)).rejects.toThrow();
    expect(mock.paths).toEqual([
      `/api/boards/${boardId}/widgets?limit=12&offset=0&sort_by=position&sort_order=asc`,
    ]);
  } finally {
    mock.restore();
  }
});

test("summary data uses the OpenView boundary and a records.read denial cannot become widget data", async () => {
  const mock = mockFetch((path) => {
    if (path === "/api/records/query") {
      return Response.json({ detail: "Forbidden" }, { status: 403 });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  try {
    const plan = buildBoardWidgetQueryPlan({
      ...widget,
      widgetType: "summary",
    });
    if (plan.kind === "unavailable") throw new Error("Unexpected plan");
    await expect(loadLiveWidgetData(plan)).rejects.toMatchObject({
      status: 403,
    });
    expect(mock.paths).toEqual(["/api/records/query"]);
  } finally {
    mock.restore();
  }
});

test("records widget resolves only configured fields by ID before querying rows", async () => {
  const mock = mockFetch((path) => {
    if (path === `/api/fields/${fieldId}`)
      return Response.json({
        id: fieldId,
        module_id: moduleId,
        name: "Request title",
        type: "text",
        required: false,
        position: 350,
        config: {},
        is_deleted: false,
      });
    if (path === "/api/records/query")
      return Response.json({
        items: [],
        pagination: wirePagination({ limit: 5, count: 0, total: 0 }),
      });
    throw new Error(`Unexpected request: ${path}`);
  });
  try {
    const plan = buildBoardWidgetQueryPlan(widget);
    if (plan.kind !== "records") throw new Error("Unexpected plan");
    await expect(loadLiveWidgetData(plan)).resolves.toMatchObject({
      kind: "records",
      fieldNames: { [fieldId]: "Request title" },
    });
    expect(mock.paths).toEqual([
      `/api/fields/${fieldId}`,
      "/api/records/query",
    ]);
  } finally {
    mock.restore();
  }
});

test("field denial and wrong-module or deleted fields never request record rows", async () => {
  const plan = buildBoardWidgetQueryPlan(widget);
  if (plan.kind !== "records") throw new Error("Unexpected plan");
  for (const response of [
    Response.json({ detail: "Forbidden" }, { status: 403 }),
    Response.json({
      id: fieldId,
      module_id: otherBoardId,
      name: "Wrong module",
      type: "text",
      required: false,
      position: 0,
      config: {},
      is_deleted: false,
    }),
    Response.json({
      id: fieldId,
      module_id: moduleId,
      name: "Deleted",
      type: "text",
      required: false,
      position: 0,
      config: {},
      is_deleted: true,
    }),
  ]) {
    const mock = mockFetch((path) => {
      if (path === `/api/fields/${fieldId}`) return response;
      throw new Error(`Record query must not run: ${path}`);
    });
    try {
      await expect(loadLiveWidgetData(plan)).rejects.toThrow();
      expect(mock.paths).toEqual([`/api/fields/${fieldId}`]);
    } finally {
      mock.restore();
    }
  }
});

test("authentication, audience, and missing-resource responses all revoke retained widget data", () => {
  for (const status of [401, 403, 404]) {
    expect(classifyLiveWidgetFailure(new ApiError(status, "Unavailable"))).toBe(
      "access-lost",
    );
  }
  expect(classifyLiveWidgetFailure(new ApiError(503, "Unavailable"))).toBe(
    "transient",
  );
  expect(classifyLiveWidgetFailure(new TypeError("Network failed"))).toBe(
    "transient",
  );
  expect(classifyLiveWidgetFailure(new Error("Invalid response"))).toBe("hard");
});

test("widget state clears on Board switch, changed configuration, and revoked access", () => {
  const begin = transitionLiveWidgetsState(emptyLiveWidgetsState, {
    type: "begin",
    key,
    sequence: 1,
  });
  const listed = transitionLiveWidgetsState(begin, {
    type: "metadata",
    key,
    sequence: 1,
    widgets: [widget],
    workspaceToday: "2026-09-23",
  });
  expect(listed.items).toHaveLength(1);
  const signature = listed.items[0].signature;
  const data = {
    kind: "records" as const,
    fieldNames: { [fieldId]: "Request title" },
    result: {
      items: [
        {
          id: recordId,
          moduleId,
          data: { [fieldId]: "Private value" },
          displayValues: {},
          createdAt: timestamp,
          updatedAt: timestamp,
          deletedAt: null,
          isDeleted: false,
          performedBy: null,
        },
      ],
      pagination: { limit: 5, offset: 0, count: 1, total: 1, hasMore: false },
    },
  };
  const ready = transitionLiveWidgetsState(listed, {
    type: "result",
    key,
    sequence: 1,
    widgetId,
    signature,
    data,
  });
  expect(ready.items[0].data).toEqual(data);

  const refreshing = transitionLiveWidgetsState(ready, {
    type: "begin",
    key,
    sequence: 2,
  });
  expect(refreshing.items[0].data).toBeNull();
  expect(renderWidgets(refreshing)).not.toContain("Private value");
  const sameMetadata = transitionLiveWidgetsState(refreshing, {
    type: "metadata",
    key,
    sequence: 2,
    widgets: [widget],
    workspaceToday: "2026-09-23",
  });
  expect(sameMetadata.items[0].data).toBeNull();
  const changed = transitionLiveWidgetsState(refreshing, {
    type: "metadata",
    key,
    sequence: 2,
    widgets: [
      {
        ...widget,
        config: {
          ...widget.config,
          filters: [
            { fieldId, expectedType: "text", operator: "eq", value: "Other" },
          ],
        },
      },
    ],
    workspaceToday: "2026-09-23",
  });
  expect(changed.items[0].data).toBeNull();
  expect(changed.items[0].status).toBe("loading");
  const audienceRemoved = transitionLiveWidgetsState(refreshing, {
    type: "metadata",
    key,
    sequence: 2,
    widgets: [],
  });
  expect(audienceRemoved.items).toEqual([]);
  const stale = transitionLiveWidgetsState(changed, {
    type: "result",
    key,
    sequence: 1,
    widgetId,
    signature,
    data,
  });
  expect(stale).toEqual(changed);

  const revoked = transitionLiveWidgetsState(refreshing, {
    type: "reject",
    key,
    sequence: 2,
    retain: false,
    error: "Widgets unavailable",
  });
  expect(revoked.items).toEqual([]);
  const switched = transitionLiveWidgetsState(ready, {
    type: "begin",
    key: `${otherBoardId}:2026-09-23`,
    sequence: 3,
  });
  expect(switched.items).toEqual([]);
  expect(
    transitionLiveWidgetsState(switched, {
      type: "result",
      key,
      sequence: 1,
      widgetId,
      signature,
      data,
    }),
  ).toEqual(switched);
});

test("same-widget transient query or metadata failure settles last-good without endless loading", () => {
  const summary = { ...widget, widgetType: "summary" as const };
  const listed = transitionLiveWidgetsState(
    transitionLiveWidgetsState(emptyLiveWidgetsState, {
      type: "begin",
      key,
      sequence: 1,
    }),
    { type: "metadata", key, sequence: 1, widgets: [summary] },
  );
  const signature = listed.items[0].signature;
  const data = {
    kind: "records" as const,
    fieldNames: {},
    result: {
      items: [],
      pagination: { limit: 5, offset: 0, count: 0, total: 0, hasMore: false },
    },
  };
  const ready = transitionLiveWidgetsState(listed, {
    type: "result",
    key,
    sequence: 1,
    widgetId,
    signature,
    data,
  });
  const refreshing = transitionLiveWidgetsState(ready, {
    type: "begin",
    key,
    sequence: 2,
  });
  const metadataFailure = transitionLiveWidgetsState(refreshing, {
    type: "reject",
    key,
    sequence: 2,
    retain: true,
    error: "Could not refresh widgets",
  });
  expect(metadataFailure.status).toBe("ready");
  expect(metadataFailure.items[0]).toMatchObject({
    status: "ready",
    data,
  });
  const same = transitionLiveWidgetsState(refreshing, {
    type: "metadata",
    key,
    sequence: 2,
    widgets: [summary],
  });
  const transient = transitionLiveWidgetsState(same, {
    type: "item-error",
    key,
    sequence: 2,
    widgetId,
    signature,
    retain: true,
    error: "Could not refresh",
  });
  expect(transient.items[0].data).toEqual(data);
  const hard = transitionLiveWidgetsState(same, {
    type: "item-error",
    key,
    sequence: 2,
    widgetId,
    signature,
    retain: false,
    error: "Data unavailable",
  });
  expect(hard.items[0].data).toBeNull();
  expect(hard.items[0].status).toBe("error");
});

function renderWidgets(state: LiveWidgetsState): string {
  return renderToStaticMarkup(
    createElement(ServerBoardWidgetsDisplay, { state, onRetry: () => {} }),
  );
}

function renderedText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function widgetItem(
  source: BoardWidget,
  data: LiveWidgetData | null,
  status: LiveWidgetItem["status"] = "ready",
): LiveWidgetItem {
  return {
    widget: source,
    plan: buildBoardWidgetQueryPlan(source, { workspaceToday: "2026-09-23" }),
    signature: source.id,
    status,
    data,
    error: null,
  };
}

function displayState(items: LiveWidgetItem[]): LiveWidgetsState {
  return { key, sequence: 1, status: "ready", items, error: null };
}

test("record widgets show authorized select and person labels instead of stored IDs", async () => {
  const statusFieldId = "00000000-0000-4000-8000-000000000011";
  const assigneeFieldId = "00000000-0000-4000-8000-000000000012";
  const choiceId = "00000000-0000-4000-8000-000000000013";
  const assigneeId = "00000000-0000-4000-8000-000000000014";
  const recordsWidget: BoardWidget & {
    config: BoardLegacyWidgetConfig;
    chartId: null;
  } = {
    ...widget,
    id: otherBoardId,
    name: "Assignment queue",
    config: {
      ...widget.config,
      fields: [
        { fieldId: statusFieldId, expectedType: "select" },
        { fieldId: assigneeFieldId, expectedType: "user" },
      ],
    },
  };
  const mock = mockFetch((path) => {
    if (path === `/api/fields/${statusFieldId}`)
      return Response.json({
        id: statusFieldId,
        module_id: moduleId,
        name: "Status",
        type: "select",
        required: false,
        position: 0,
        config: { options: [{ id: choiceId, label: "In progress" }] },
        is_deleted: false,
      });
    if (path === `/api/fields/${assigneeFieldId}`)
      return Response.json({
        id: assigneeFieldId,
        module_id: moduleId,
        name: "Assignee",
        type: "user",
        required: false,
        position: 1,
        config: {},
        is_deleted: false,
      });
    if (path === "/api/records/query")
      return Response.json({
        items: [
          wireRecord({
            id: recordId,
            module_id: moduleId,
            data: {
              [statusFieldId]: choiceId,
              [assigneeFieldId]: assigneeId,
            },
            display_values: {
              [statusFieldId]: "In progress",
              [assigneeFieldId]: "Alex Reader",
            },
            created_at: timestamp,
            updated_at: timestamp,
          }),
        ],
        pagination: wirePagination({ limit: 5, count: 1, total: 1 }),
      });
    throw new Error(`Unexpected request: ${path}`);
  });

  try {
    const plan = buildBoardWidgetQueryPlan(recordsWidget);
    if (plan.kind !== "records") throw new Error("Expected a records widget");
    const data = await loadLiveWidgetData(plan);
    const html = renderWidgets(displayState([widgetItem(recordsWidget, data)]));

    expect(renderedText(html)).toContain("Status In progress");
    expect(renderedText(html)).toContain("Assignee Alex Reader");
    expect(html).not.toContain(choiceId);
    expect(html).not.toContain(assigneeId);
  } finally {
    mock.restore();
  }
});

test("live Board Overview renders exact summary count and escaped returned record values", () => {
  const summary = {
    ...widget,
    name: "Operations summary",
    widgetType: "summary" as const,
  };
  const records = {
    ...widget,
    id: otherBoardId,
    name: "Open requests",
    widgetType: "records" as const,
  };
  const html = renderWidgets(
    displayState([
      widgetItem(summary, {
        kind: "records",
        fieldNames: {},
        result: {
          items: [],
          pagination: parsedPagination({
            limit: 1,
            count: 0,
            total: 7,
            hasMore: true,
          }),
        },
      }),
      widgetItem(records, {
        kind: "records",
        fieldNames: { [fieldId]: "Request title" },
        result: {
          items: [
            {
              id: recordId,
              moduleId,
              data: { [fieldId]: "Private <script>value</script>" },
              displayValues: {},
              createdAt: timestamp,
              updatedAt: timestamp,
              deletedAt: null,
              isDeleted: false,
              performedBy: null,
            },
          ],
          pagination: parsedPagination({ limit: 5, count: 1, total: 1 }),
        },
      }),
    ]),
  );
  expect(html).toContain("Operations summary");
  expect(renderedText(html)).toContain("7 Matching records");
  expect(html).toContain("Open requests");
  expect(html).toContain("Request title");
  expect(html).not.toContain("Field 1");
  expect(html).toContain("Private &lt;script&gt;value&lt;/script&gt;");
  expect(html).not.toContain("sample-board");
});

test("record summary cards show the exact count of each summary", () => {
  const summary = {
    ...widget,
    name: "Operations summary",
    widgetType: "summary" as const,
    pinned: true,
    config: widget.config,
  };
  const targetedSummary = {
    ...summary,
    id: otherBoardId,
    name: "Targeted summary",
  };
  const privateSummary = {
    ...summary,
    id: "00000000-0000-4000-8000-000000000007",
    name: "Private summary",
  };
  const data = (total: number): LiveWidgetData => ({
    kind: "records",
    fieldNames: {},
    result: {
      items: [],
      pagination: parsedPagination({
        limit: 1,
        count: 0,
        total,
        hasMore: total > 0,
      }),
    },
  });
  const html = renderWidgets(
    displayState([
      widgetItem(summary, data(24)),
      widgetItem(targetedSummary, data(18)),
      widgetItem(privateSummary, data(42)),
    ]),
  );

  expect(html).toContain("Record summaries");
  expect(html).not.toContain("Board overview");
  const text = renderedText(html);
  expect(text).toContain("24 Matching records");
  expect(text).toContain("18 Matching records");
  expect(text).toContain("42 Matching records");
  expect(html).not.toContain(moduleId);
  expect(html).not.toContain("audience");
  expect(html).toContain("Pinned");
});

test("a widget's initial data failure keeps a retry action on that widget", () => {
  const summary = { ...widget, widgetType: "summary" as const };
  const failed = {
    ...widgetItem(summary, null, "error"),
    error: "Could not load summary data. Try again.",
  };

  const html = renderWidgets(displayState([failed]));

  expect(html).toContain("Could not load summary data");
  expect(renderedText(html)).toContain("Retry");
});

test("records card does not show values when a selected field label is missing", () => {
  const records = { ...widget, name: "Open requests" };
  const html = renderWidgets(
    displayState([
      widgetItem(records, {
        kind: "records",
        fieldNames: {},
        result: {
          items: [
            {
              id: recordId,
              moduleId,
              data: { [fieldId]: "Private salary" },
              displayValues: {},
              createdAt: timestamp,
              updatedAt: timestamp,
              deletedAt: null,
              isDeleted: false,
              performedBy: null,
            },
          ],
          pagination: parsedPagination({ limit: 5, count: 1, total: 1 }),
        },
      }),
    ]),
  );
  expect(html).toContain("Field names unavailable");
  expect(html).not.toContain("Private salary");
  expect(html).not.toContain("Field 1");
});

test("live Board Overview makes empty, unavailable, loading, error, and retained refresh states clear", () => {
  const empty = renderWidgets(displayState([]));
  expect(empty).toContain("No widgets yet");
  const loading = renderWidgets({ ...displayState([]), status: "loading" });
  expect(loading).toContain("Loading Board widgets");
  const denied = renderWidgets({
    ...displayState([]),
    status: "error",
    error: "Widgets unavailable. Check your access or try again.",
  });
  expect(denied).toContain("Widgets unavailable");
  expect(denied).toContain("Retry");
  expect(denied).not.toContain("Private value");
  const line = {
    ...widget,
    name: "Daily trend",
    widgetType: "chart" as const,
    config: {
      ...widget.config,
      fields: [{ fieldId, expectedType: "date" as const }],
      visualization: "line" as const,
    },
  };
  const unavailable = widgetItem(line, null, "unavailable");
  unavailable.plan = buildBoardWidgetQueryPlan(line);
  expect(renderWidgets(displayState([unavailable]))).toContain(
    "Workspace date is unavailable",
  );
  const summary = {
    ...widget,
    name: "Operations summary",
    widgetType: "summary" as const,
  };
  const refreshing = widgetItem(
    summary,
    {
      kind: "records",
      fieldNames: {},
      result: {
        items: [],
        pagination: { limit: 1, offset: 0, count: 0, total: 7, hasMore: true },
      },
    },
    "loading",
  );
  const retained = renderWidgets({
    ...displayState([refreshing]),
    status: "loading",
    error: "Could not refresh widgets. Try again.",
  });
  expect(renderedText(retained)).toContain("7 Matching records");
  expect(retained).toContain("Showing the last loaded");
});

test("pie and line previews reject geometry that overflows while preserving exact values", () => {
  const pie = {
    ...widget,
    name: "Large totals",
    widgetType: "chart" as const,
    config: { ...widget.config, visualization: "pie" as const },
  };
  const line = {
    ...pie,
    id: otherBoardId,
    name: "Large daily spread",
    config: {
      ...pie.config,
      visualization: "line" as const,
      fields: [{ fieldId, expectedType: "date" as const }],
    },
  };
  const huge = [
    { key: "a", label: "A", value: "1e308", recordCount: 1 },
    { key: "b", label: "B", value: "1e308", recordCount: 1 },
  ];
  const html = renderWidgets(
    displayState([
      widgetItem(pie, {
        kind: "snapshot",
        result: {
          items: huge,
          pagination: parsedPagination({ limit: 10000, count: 2, total: 2 }),
        },
      }),
      widgetItem(line, {
        kind: "snapshot",
        result: {
          items: [
            { ...huge[0], key: "2026-09-22" },
            { ...huge[1], key: "2026-09-23", value: "-1e308" },
          ],
          pagination: parsedPagination({ limit: 10000, count: 2, total: 2 }),
        },
      }),
    ]),
  );
  expect(html).toContain("Values too large to chart");
  expect(html).toContain("1e308");
  expect(html).not.toContain("Infinity");
  expect(html).not.toContain("NaN");
});

test("negative group values keep exact text without misleading positive bar lengths", () => {
  const workload = {
    ...widget,
    name: "Net change",
    widgetType: "workload" as const,
  };
  const html = renderWidgets(
    displayState([
      widgetItem(workload, {
        kind: "aggregate",
        result: {
          items: [
            { key: "in", label: "In", value: 5, recordCount: 5 },
            { key: "out", label: "Out", value: -5, recordCount: 5 },
          ],
          pagination: parsedPagination({ limit: 8, count: 2, total: 2 }),
        },
      }),
    ]),
  );
  expect(html).toContain("Negative values cannot be shown as bars");
  expect(html).toContain(">5<");
  expect(html).toContain(">-5<");
  expect(html).not.toContain("bg-chart-1 h-full");
});
