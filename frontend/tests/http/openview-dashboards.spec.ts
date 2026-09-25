import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";

const userId = "00000000-0000-4000-8000-000000000101";
const moduleId = "00000000-0000-4000-8000-000000000102";
const categoryFieldId = "00000000-0000-4000-8000-000000000103";
const regionFieldId = "00000000-0000-4000-8000-000000000104";
const dashboardId = "00000000-0000-4000-8000-000000000105";
const dashboardWidgetId = "00000000-0000-4000-8000-000000000106";
const secondDashboardWidgetId = "00000000-0000-4000-8000-000000000118";
const amountFieldId = "00000000-0000-4000-8000-000000000107";
const dateFieldId = "00000000-0000-4000-8000-000000000108";
const datetimeFieldId = "00000000-0000-4000-8000-000000000109";
const unitsFieldId = "00000000-0000-4000-8000-000000000110";
const scoreFieldId = "00000000-0000-4000-8000-000000000111";
const secondModuleId = "00000000-0000-4000-8000-000000000112";
const delayedFieldId = "00000000-0000-4000-8000-000000000113";
const secondModuleFieldId = "00000000-0000-4000-8000-000000000114";
const secondModuleNextFieldId = "00000000-0000-4000-8000-000000000115";
const delayedDashboardId = "00000000-0000-4000-8000-000000000116";
const alternateDashboardId = "00000000-0000-4000-8000-000000000117";
const timestamp = "2026-09-23T00:00:00Z";

type FieldReference = { field_id: string; expected_type: string };
type Aggregation = "count" | "sum" | "average";
type QueryDefinition = {
  version: 1;
  logic: "and";
  columns: FieldReference[];
  filters: [];
  sort: [];
  deleted: "exclude";
  search: null;
  search_fields: [];
};
type GroupQuery = {
  mode: "groups";
  module_id: string;
  definition: QueryDefinition;
  aggregation: Aggregation;
  measure: FieldReference | null;
  dimension: FieldReference;
};
type DateSeriesQuery = {
  mode: "date_series";
  module_id: string;
  definition: QueryDefinition;
  aggregation: Aggregation;
  measure: FieldReference | null;
  date_field: FieldReference;
  from_date: string;
  to_date: string;
};
type ChartConfig = {
  version: 1;
  chart_type: "bar" | "line" | "pie";
  query: GroupQuery | DateSeriesQuery;
};
type WidgetInput =
  | { widget_type: "chart"; config: ChartConfig }
  | {
      widget_type: "summary" | "workload";
      config: { version: 1; query: GroupQuery };
    }
  | {
      widget_type: "records";
      config: {
        version: 1;
        query: { module_id: string; definition: QueryDefinition };
      };
    };
type WidgetWire = WidgetInput & {
  id: string;
  position: number;
  created_at: string;
  updated_at: string;
};
type DashboardWire = {
  id: string;
  owner_id: string;
  name: string;
  refresh_cadence: "manual" | "one-minute" | "five-minutes";
  revision: number;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
  widgets: WidgetWire[];
};
type DashboardMutation = {
  revision?: number;
  name?: string;
  refresh_cadence?: "manual" | "one-minute" | "five-minutes";
  widgets?: WidgetInput[];
};
type DashboardDefaultMutation = { dashboard_id: string | null };
type FieldWire = {
  id: string;
  module_id: string;
  name: string;
  type: string;
  required: boolean;
  position: number;
  config: Record<string, unknown>;
};
type FieldPageFixture = {
  firstPage: FieldWire[];
  hasMore: boolean;
  nextPage: FieldWire[];
  nextPageHasMore: boolean;
};
type AggregateRequest =
  | {
      mode: "groups";
      module_id: string;
      aggregation: Aggregation;
      measure?: FieldReference;
      dimension: FieldReference;
    }
  | {
      mode: "date_series";
      module_id: string;
      aggregation: Aggregation;
      measure?: FieldReference;
      date_field: FieldReference;
      from_date: string;
      to_date: string;
    };
type RecordQueryRequest = {
  module_id: string;
  definition: QueryDefinition;
  limit: number;
  offset: number;
};
type RequestGate = {
  started: Promise<void>;
  wait: Promise<void>;
  signalStarted: () => void;
  release: () => void;
};

function requestGate(): RequestGate {
  let signalStarted = () => {};
  let release = () => {};
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    wait,
    signalStarted: () => signalStarted(),
    release: () => release(),
  };
}

const queryDefinition: QueryDefinition = {
  version: 1,
  logic: "and",
  columns: [],
  filters: [],
  sort: [],
  deleted: "exclude",
  search: null,
  search_fields: [],
};

function savedWidget(id: string, position: number, fieldId: string) {
  const expectedType = "select";
  return {
    id,
    position,
    widget_type: "chart" as const,
    config: {
      version: 1 as const,
      chart_type: "bar" as const,
      query: {
        mode: "groups" as const,
        module_id: moduleId,
        definition: queryDefinition,
        aggregation: "count" as const,
        measure: null,
        dimension: { field_id: fieldId, expected_type: expectedType },
      },
    },
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function savedDateWidget(id: string, position: number) {
  return {
    id,
    position,
    widget_type: "chart" as const,
    config: {
      version: 1 as const,
      chart_type: "line" as const,
      query: {
        mode: "date_series" as const,
        module_id: moduleId,
        definition: queryDefinition,
        aggregation: "count" as const,
        measure: null,
        date_field: { field_id: dateFieldId, expected_type: "date" },
        from_date: "2024-01-01",
        to_date: "2024-12-31",
      },
    },
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function dashboard(overrides: Partial<DashboardWire> = {}): DashboardWire {
  const widgets = [savedWidget(dashboardWidgetId, 0, categoryFieldId)];
  return {
    id: dashboardId,
    owner_id: userId,
    name: "Operations",
    refresh_cadence: "manual",
    revision: 1,
    is_deleted: false,
    created_at: timestamp,
    updated_at: timestamp,
    widgets,
    ...overrides,
  };
}

function persistedWidgets(widgets: WidgetInput[]): WidgetWire[] {
  return widgets.map((widget, index) => {
    const metadata = {
      id: `00000000-0000-4000-8000-${String(index + 201).padStart(12, "0")}`,
      position: index,
      created_at: timestamp,
      updated_at: timestamp,
    };
    switch (widget.widget_type) {
      case "chart":
        return { ...metadata, widget_type: "chart", config: widget.config };
      case "summary":
      case "workload":
        return {
          ...metadata,
          widget_type: widget.widget_type,
          config: widget.config,
        };
      case "records":
        return { ...metadata, widget_type: "records", config: widget.config };
    }
  });
}

function dataSourceField(
  id: string,
  moduleId: string,
  name: string,
  position: number,
): FieldWire {
  return {
    id,
    module_id: moduleId,
    name,
    type: "select",
    required: false,
    position,
    config: {},
  };
}

function snapshot(length = 30) {
  const items = Array.from({ length }, (_, index) => ({
    key: `group-${index + 1}`,
    label: `Group ${index + 1}`,
    value: index + 1,
    record_count: index + 1,
  }));
  return {
    items,
    pagination: {
      limit: items.length,
      offset: 0,
      count: items.length,
      total: items.length,
      has_more: false,
    },
  };
}

function dateSnapshot(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const length = Math.floor((end - start) / 86_400_000) + 1;
  const items = Array.from({ length }, (_, index) => {
    const day = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
    return { key: day, label: day, value: index + 1, record_count: index + 1 };
  });
  return {
    items,
    pagination: {
      limit: items.length,
      offset: 0,
      count: items.length,
      total: items.length,
      has_more: false,
    },
  };
}

async function installDashboardApi(
  page: Page,
  initial: DashboardWire | null = null,
) {
  let current = initial;
  let alternate: DashboardWire | null = null;
  let dashboardDefaultId: string | null = null;
  let failDashboardDefaultReads = false;
  let forceConflict = false;
  let snapshotGate: RequestGate | null = null;
  let snapshotGateStatus: 403 | null = null;
  let snapshotLength = 30;
  let dashboardGetGate: RequestGate | null = null;
  let dashboardDefaultGetGate: RequestGate | null = null;
  let restoreGate: RequestGate | null = null;
  let dashboardListHasMore = false;
  let dashboardListPageGate: {
    gate: RequestGate;
    item: DashboardWire;
  } | null = null;
  const createdDashboards: DashboardWire[] = [];
  let fieldPages: Record<string, FieldPageFixture> = {};
  let fieldPageGate: {
    moduleId: string;
    offset: number;
    gate: RequestGate;
  } | null = null;
  const dashboardReads: string[] = [];
  const dashboardDefaultReads: number[] = [];
  const dashboardDefaultWrites: DashboardDefaultMutation[] = [];
  const fieldReads: Array<{ moduleId: string; offset: number }> = [];
  const writes: Array<{
    method: string;
    body: DashboardMutation | null;
    dashboardId: string | null;
  }> = [];
  const snapshots: AggregateRequest[] = [];
  const recordQueries: RecordQueryRequest[] = [];
  let nextSnapshotErrorStatus: 401 | 403 | 503 | null = null;
  let snapshotErrorResponsesRemaining = 0;
  let nextRecordQueryErrorStatus: 401 | 403 | null = null;
  let recordQueryErrorResponsesRemaining = 0;
  let recordFieldId = categoryFieldId;

  await page.route("**/api/auth/session", async (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user_id: userId,
        setup_required: false,
      }),
    }),
  );
  await page.route("**/api/views/data-sources**", async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/views/data-sources") {
      const items = [
        { id: moduleId, name: "Equipment", department_id: userId },
        ...(fieldPages[secondModuleId]
          ? [
              {
                id: secondModuleId,
                name: "Quality checks",
                department_id: userId,
              },
            ]
          : []),
      ];
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items,
          pagination: {
            limit: 100,
            offset: 0,
            count: items.length,
            total: items.length,
            has_more: false,
          },
        }),
      });
    }
    const requestedFieldModuleId = url.pathname.match(
      /^\/api\/views\/data-sources\/([^/]+)\/fields$/,
    )?.[1];
    if (requestedFieldModuleId) {
      const offset = Number(url.searchParams.get("offset") ?? "0");
      fieldReads.push({ moduleId: requestedFieldModuleId, offset });
      if (
        fieldPageGate?.moduleId === requestedFieldModuleId &&
        fieldPageGate.offset === offset
      ) {
        const pending = fieldPageGate;
        fieldPageGate = null;
        pending.gate.signalStarted();
        await pending.gate.wait;
      }
      const configuredPage = fieldPages[requestedFieldModuleId];
      if (configuredPage) {
        const isFirstPage = offset === 0;
        const isNextPage = offset === configuredPage.firstPage.length;
        const items = isFirstPage
          ? configuredPage.firstPage
          : isNextPage
            ? configuredPage.nextPage
            : [];
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            items,
            pagination: {
              limit: 100,
              offset,
              count: items.length,
              total:
                configuredPage.firstPage.length +
                configuredPage.nextPage.length +
                (configuredPage.nextPageHasMore ? 1 : 0),
              has_more: isFirstPage
                ? configuredPage.hasMore
                : isNextPage && configuredPage.nextPageHasMore,
            },
          }),
        });
      }
      if (requestedFieldModuleId !== moduleId)
        return route.fulfill({ status: 404, body: "{}" });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              id: categoryFieldId,
              module_id: moduleId,
              name: "Category",
              type: "select",
              required: false,
              position: 0,
              config: { options: ["Service", "Inspection"] },
            },
            {
              id: regionFieldId,
              module_id: moduleId,
              name: "Region",
              type: "select",
              required: false,
              position: 1,
              config: { options: ["North", "South"] },
            },
            {
              id: amountFieldId,
              module_id: moduleId,
              name: "Amount",
              type: "decimal",
              required: false,
              position: 2,
              config: {},
            },
            {
              id: dateFieldId,
              module_id: moduleId,
              name: "Occurred on",
              type: "date",
              required: false,
              position: 3,
              config: {},
            },
            {
              id: datetimeFieldId,
              module_id: moduleId,
              name: "Updated at",
              type: "datetime",
              required: false,
              position: 4,
              config: {},
            },
            {
              id: unitsFieldId,
              module_id: moduleId,
              name: "Units",
              type: "int",
              required: false,
              position: 5,
              config: {},
            },
            {
              id: scoreFieldId,
              module_id: moduleId,
              name: "Score",
              type: "number",
              required: false,
              position: 6,
              config: {},
            },
          ],
          pagination: {
            limit: 100,
            offset: 0,
            count: 7,
            total: 7,
            has_more: false,
          },
        }),
      });
    }
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: "{}",
    });
  });
  await page.route("**/api/dashboards**", async (route: Route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/dashboards/default" && method === "GET") {
      dashboardDefaultReads.push(dashboardDefaultReads.length + 1);
      if (failDashboardDefaultReads) {
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Default temporarily unavailable" }),
        });
      }
      if (dashboardDefaultGetGate) {
        const gate = dashboardDefaultGetGate;
        gate.signalStarted();
        await gate.wait;
      }
      const selected =
        [current, alternate].find((item) => item?.id === dashboardDefaultId) ??
        createdDashboards.find((item) => item.id === dashboardDefaultId);
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          dashboard_id: selected?.is_deleted ? null : dashboardDefaultId,
        }),
      });
    }
    if (url.pathname === "/api/dashboards/default" && method === "PUT") {
      const body = route.request().postDataJSON() as DashboardDefaultMutation;
      dashboardDefaultWrites.push(body);
      dashboardDefaultId = body.dashboard_id;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ dashboard_id: dashboardDefaultId }),
      });
    }
    if (url.pathname === "/api/dashboards" && method === "GET") {
      const offset = Number(url.searchParams.get("offset") ?? "0");
      if (offset > 0 && dashboardListPageGate) {
        const pending = dashboardListPageGate;
        dashboardListPageGate = null;
        pending.gate.signalStarted();
        await pending.gate.wait;
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            items: [pending.item],
            pagination: {
              limit: 25,
              offset,
              count: 1,
              total: offset + 1,
              has_more: false,
            },
          }),
        });
      }
      const archivedOnly = url.searchParams.get("deleted") === "only";
      const visible = [current, alternate, ...createdDashboards].filter(
        (item): item is DashboardWire =>
          item !== null && item.is_deleted === archivedOnly,
      );
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items: visible,
          pagination: {
            limit: 25,
            offset,
            count: visible.length,
            total:
              visible.length + (offset === 0 && dashboardListHasMore ? 1 : 0),
            has_more: offset === 0 && dashboardListHasMore,
          },
        }),
      });
    }
    const requestedDashboardId = url.pathname.match(
      /^\/api\/dashboards\/([^/]+)$/,
    )?.[1];
    if (requestedDashboardId && method === "GET") {
      dashboardReads.push(url.pathname);
      if (dashboardGetGate) {
        const gate = dashboardGetGate;
        gate.signalStarted();
        await gate.wait;
      }
      const selected = [current, alternate, ...createdDashboards].find(
        (item) => item?.id === requestedDashboardId,
      );
      return selected
        ? route.fulfill({
            contentType: "application/json",
            body: JSON.stringify(selected),
          })
        : route.fulfill({
            status: 404,
            contentType: "application/json",
            body: "{}",
          });
    }
    if (url.pathname === "/api/dashboards" && method === "POST") {
      const body = route.request().postDataJSON() as DashboardMutation;
      writes.push({ method, body, dashboardId: null });
      const created = dashboard({
        id:
          current || alternate || createdDashboards.length
            ? `00000000-0000-4000-8000-${String(1000 + createdDashboards.length).padStart(12, "0")}`
            : dashboardId,
        name: body.name ?? "",
        refresh_cadence: body.refresh_cadence ?? "manual",
        revision: 1,
        widgets: persistedWidgets(body.widgets ?? []),
      });
      if (current || alternate || createdDashboards.length)
        createdDashboards.push(created);
      else current = created;
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(created),
      });
    }
    if (
      url.pathname === `/api/dashboards/${dashboardId}` &&
      method === "PATCH"
    ) {
      const body = route.request().postDataJSON() as DashboardMutation;
      writes.push({ method, body, dashboardId });
      if (forceConflict) {
        forceConflict = false;
        return route.fulfill({
          status: 409,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "about:blank",
            title: "Conflict",
            status: 409,
            detail: "This Dashboard changed since you opened it.",
            code: "stale_revision",
            current_revision: (current?.revision ?? 1) + 1,
          }),
        });
      }
      if (!current) return route.fulfill({ status: 404, body: "{}" });
      current = {
        ...current,
        name: body.name ?? current.name,
        refresh_cadence: body.refresh_cadence ?? current.refresh_cadence,
        revision: current.revision + 1,
        updated_at: timestamp,
        widgets: body.widgets
          ? persistedWidgets(body.widgets)
          : current.widgets,
      };
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(current),
      });
    }
    if (
      url.pathname === `/api/dashboards/${dashboardId}` &&
      method === "DELETE"
    ) {
      writes.push({ method, body: null, dashboardId });
      if (current)
        current = {
          ...current,
          is_deleted: true,
          revision: current.revision + 1,
        };
      return route.fulfill({ status: 204, body: "" });
    }
    if (
      url.pathname === `/api/dashboards/${dashboardId}/restore` &&
      method === "POST"
    ) {
      const body = route.request().postDataJSON() as DashboardMutation;
      writes.push({ method, body, dashboardId });
      if (restoreGate) {
        const gate = restoreGate;
        restoreGate = null;
        gate.signalStarted();
        await gate.wait;
      }
      if (current)
        current = {
          ...current,
          is_deleted: false,
          revision: current.revision + 1,
        };
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(current),
      });
    }
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: "{}",
    });
  });
  await page.route(
    "**/api/records/aggregate-snapshot",
    async (route: Route) => {
      const request = route.request().postDataJSON() as AggregateRequest;
      snapshots.push(request);
      let delayedStatus: 403 | null = null;
      if (snapshotGate) {
        const gate = snapshotGate;
        snapshotGate = null;
        delayedStatus = snapshotGateStatus;
        snapshotGateStatus = null;
        gate.signalStarted();
        await gate.wait;
      }
      const status = delayedStatus ?? nextSnapshotErrorStatus;
      if (status !== null) {
        if (delayedStatus === null) {
          snapshotErrorResponsesRemaining -= 1;
          if (snapshotErrorResponsesRemaining === 0)
            nextSnapshotErrorStatus = null;
        }
        return route.fulfill({
          status,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "about:blank",
            title:
              status === 401
                ? "Unauthorized"
                : status === 403
                  ? "Forbidden"
                  : "Unavailable",
            status,
            detail:
              status === 503
                ? "The aggregate snapshot is temporarily unavailable."
                : "The current session cannot read this data.",
          }),
        });
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          request.mode === "date_series"
            ? dateSnapshot(request.from_date, request.to_date)
            : snapshot(snapshotLength),
        ),
      });
    },
  );
  await page.route("**/api/records/query", async (route: Route) => {
    const request = route.request().postDataJSON() as RecordQueryRequest;
    recordQueries.push(request);
    if (nextRecordQueryErrorStatus !== null) {
      const status = nextRecordQueryErrorStatus;
      recordQueryErrorResponsesRemaining -= 1;
      if (recordQueryErrorResponsesRemaining === 0)
        nextRecordQueryErrorStatus = null;
      return route.fulfill({
        status,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "about:blank",
          title: status === 401 ? "Unauthorized" : "Forbidden",
          status,
          detail: "The current session cannot read these records.",
        }),
      });
    }
    const items = [
      {
        id: "00000000-0000-4000-8000-000000000201",
        module_id: moduleId,
        data: { [recordFieldId]: "Repair" },
        created_at: timestamp,
        updated_at: timestamp,
        deleted_at: null,
        is_deleted: false,
        performed_by: userId,
      },
      {
        id: "00000000-0000-4000-8000-000000000202",
        module_id: moduleId,
        data: { [recordFieldId]: "Inspection" },
        created_at: timestamp,
        updated_at: timestamp,
        deleted_at: null,
        is_deleted: false,
        performed_by: userId,
      },
    ];
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items,
        pagination: {
          limit: request.limit,
          offset: request.offset,
          count: items.length,
          total: items.length,
          has_more: false,
        },
      }),
    });
  });

  return {
    writes,
    snapshots,
    recordQueries,
    dashboardReads,
    dashboardDefaultReads,
    dashboardDefaultWrites,
    fieldReads,
    setConflict() {
      forceConflict = true;
    },
    failNextSnapshot() {
      nextSnapshotErrorStatus = 503;
      snapshotErrorResponsesRemaining = 1;
    },
    failNextSnapshotWithStatus(status: 401 | 403) {
      nextSnapshotErrorStatus = status;
      snapshotErrorResponsesRemaining = status === 401 ? 2 : 1;
    },
    failNextRecordsWithStatus(status: 401 | 403) {
      nextRecordQueryErrorStatus = status;
      recordQueryErrorResponsesRemaining = status === 401 ? 2 : 1;
    },
    holdNextSnapshot(status: 403 | null = null) {
      const gate = requestGate();
      snapshotGate = gate;
      snapshotGateStatus = status;
      return { started: gate.started, release: gate.release };
    },
    setSnapshotLength(length: number) {
      snapshotLength = length;
    },
    setRecordFieldId(id: string) {
      recordFieldId = id;
    },
    setDashboardListHasMore(hasMore: boolean) {
      dashboardListHasMore = hasMore;
    },
    setAlternateDashboard(value: DashboardWire) {
      alternate = value;
    },
    setDashboardDefault(id: string | null) {
      dashboardDefaultId = id;
    },
    get dashboardDefaultId() {
      return dashboardDefaultId;
    },
    failDashboardDefaultReads() {
      failDashboardDefaultReads = true;
    },
    recoverDashboardDefaultReads() {
      failDashboardDefaultReads = false;
    },
    holdNextDashboardListPage(item: DashboardWire) {
      const gate = requestGate();
      dashboardListPageGate = { gate, item };
      return { started: gate.started, release: gate.release };
    },
    setFieldPages(pages: Record<string, FieldPageFixture>) {
      fieldPages = pages;
    },
    holdNextFieldPage(moduleId: string, offset: number) {
      const gate = requestGate();
      fieldPageGate = { moduleId, offset, gate };
      return { started: gate.started, release: gate.release };
    },
    holdNextDashboardGet() {
      const gate = requestGate();
      dashboardGetGate = gate;
      return {
        started: gate.started,
        release() {
          gate.release();
          if (dashboardGetGate === gate) dashboardGetGate = null;
        },
      };
    },
    holdNextDashboardDefaultGet() {
      const gate = requestGate();
      dashboardDefaultGetGate = gate;
      return {
        started: gate.started,
        release() {
          gate.release();
          if (dashboardDefaultGetGate === gate) dashboardDefaultGetGate = null;
        },
      };
    },
    holdNextRestore() {
      const gate = requestGate();
      restoreGate = gate;
      return { started: gate.started, release: gate.release };
    },
  };
}

async function tabTo(
  page: Page,
  target: Locator,
  direction: "forward" | "backward" = "forward",
) {
  const allControlsKey =
    page.context().browser()?.browserType().name() === "webkit" ? "Alt+" : "";
  const key = `${allControlsKey}${direction === "forward" ? "Tab" : "Shift+Tab"}`;
  for (let step = 0; step < 100; step += 1) {
    await page.keyboard.press(key);
    if (await target.evaluate((element) => element === document.activeElement))
      return;
  }
  throw new Error(`Could not reach ${await target.toString()} with ${key}.`);
}

async function expectVisibleKeyboardFocus(target: Locator) {
  await expect(target).toBeFocused();
  const focusStyle = await target.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      keyboardFocus: element.matches(":focus-visible"),
      outlineWidth: Number.parseFloat(style.outlineWidth),
      outlineStyle: style.outlineStyle,
      outlineColor: style.outlineColor,
    };
  });
  expect(focusStyle.keyboardFocus).toBe(true);
  expect(focusStyle.outlineWidth).toBeGreaterThan(0);
  expect(focusStyle.outlineStyle).not.toBe("none");
  expect(focusStyle.outlineColor).not.toBe("rgba(0, 0, 0, 0)");
}

async function expectDashboardMainToFit(page: Page) {
  const dimensions = await page.getByRole("main").evaluate((main) => ({
    clientWidth: main.clientWidth,
    scrollWidth: main.scrollWidth,
  }));
  expect(
    dimensions.scrollWidth,
    "Dashboard controls and content should not overflow horizontally at mobile width",
  ).toBeLessThanOrEqual(dimensions.clientWidth);
}

test("private Dashboard supports mobile keyboard-only controls and survives reload", async ({
  page,
}) => {
  const api = await installDashboardApi(page, dashboard({ widgets: [] }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/openview?section=dashboards");

  await expect(
    page.getByRole("heading", { name: "Private dashboards" }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Session verification" }),
  ).not.toBeVisible();
  await expectDashboardMainToFit(page);

  const savedDashboard = page.getByRole("button", { name: "Operations" });
  await tabTo(page, savedDashboard);
  await expectVisibleKeyboardFocus(savedDashboard);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`dashboard=${dashboardId}`));
  await expect(page.getByLabel("Dashboard name")).toHaveValue("Operations");

  const newDashboard = page.getByRole("button", { name: "New Dashboard" });
  await tabTo(page, newDashboard, "backward");
  await expectVisibleKeyboardFocus(newDashboard);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/openview?section=dashboards");

  const dashboardName = page.getByLabel("Dashboard name");
  await expect(dashboardName).toHaveValue("");
  await tabTo(page, dashboardName);
  await page.keyboard.type("Keyboard dashboard");
  await expect(dashboardName).toHaveValue("Keyboard dashboard");

  const moduleSelect = page.getByLabel("Module");
  await tabTo(page, moduleSelect);
  await expectVisibleKeyboardFocus(moduleSelect);
  await expect(moduleSelect).toContainText("Equipment");
  await page.keyboard.press("e");
  await expect(moduleSelect).toHaveValue(moduleId);

  const dimension = page.getByLabel("Group records by");
  await tabTo(page, dimension);
  await expect(dimension).toContainText("Category");
  await page.keyboard.press("c");
  await page.keyboard.press("a");
  await expect(dimension).toHaveValue(categoryFieldId);

  const addChart = page.getByRole("button", { name: "Add chart widget" });
  await tabTo(page, addChart);
  await expectVisibleKeyboardFocus(addChart);
  await page.keyboard.press("Enter");
  await expect(page.getByText("1 of 12 widgets")).toBeVisible();
  await expectDashboardMainToFit(page);

  const saveDashboard = page.getByRole("button", { name: "Save Dashboard" });
  await tabTo(page, saveDashboard, "backward");
  await expectVisibleKeyboardFocus(saveDashboard);
  await page.keyboard.press("Enter");

  const table = page.getByRole("table", {
    name: "Complete data for Count by Category",
  });
  await expect
    .poll(() => new URL(page.url()).searchParams.get("dashboard"))
    .toBeTruthy();
  const savedDashboardId = new URL(page.url()).searchParams.get("dashboard");
  expect(savedDashboardId).toBeTruthy();
  expect(savedDashboardId).not.toBe(dashboardId);
  await expect(
    page.getByRole("heading", { name: "Keyboard dashboard" }),
  ).toBeVisible();
  await expect(table).toBeVisible();
  expect(api.writes[0]?.method).toBe("POST");
  expect(api.writes[0]?.body?.name).toBe("Keyboard dashboard");
  expect(api.writes[0]?.body?.widgets?.[0]?.config).toMatchObject({
    chart_type: "bar",
    query: {
      mode: "groups",
      aggregation: "count",
      dimension: { field_id: categoryFieldId },
    },
  });
  await expectDashboardMainToFit(page);

  const readsBeforeReload = api.dashboardReads.length;
  const snapshotsBeforeReload = api.snapshots.length;
  await page.reload();
  await expect
    .poll(() => api.dashboardReads.length)
    .toBeGreaterThan(readsBeforeReload);
  await expect
    .poll(() => api.snapshots.length)
    .toBeGreaterThan(snapshotsBeforeReload);
  await expect(page).toHaveURL(new RegExp(`dashboard=${savedDashboardId}`));
  await expect(
    page.getByRole("heading", { name: "Keyboard dashboard" }),
  ).toBeVisible();
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(25);
  await expectDashboardMainToFit(page);
});

test("private Dashboard saves ordered charts and reloads only the selected complete snapshot", async ({
  page,
}) => {
  const api = await installDashboardApi(page);
  await page.goto("/openview?section=dashboards");

  await expect(
    page.getByRole("heading", { name: "Private dashboards" }),
  ).toBeVisible();
  await expect(
    page.getByText("Only you can view these Dashboards."),
  ).toBeVisible();
  await page.getByLabel("Dashboard name").fill("Equipment overview");
  await page.getByLabel("Module").selectOption(moduleId);
  await page.getByLabel("Group records by").selectOption(categoryFieldId);
  await page.getByRole("button", { name: "Add chart widget" }).click();
  await page.getByLabel("Group records by").selectOption(regionFieldId);
  await page.getByRole("button", { name: "Add chart widget" }).click();
  await expect(page.getByText("2 of 12 widgets")).toBeVisible();
  await page.getByRole("button", { name: "Move chart 2 up" }).click();
  await page.getByLabel("Group records by").selectOption(categoryFieldId);
  await page.getByRole("button", { name: "Add chart widget" }).click();
  await expect(page.getByText("3 of 12 widgets")).toBeVisible();
  await page.getByRole("button", { name: "Remove chart 3" }).click();
  await expect(page.getByText("2 of 12 widgets")).toBeVisible();
  await page.getByRole("button", { name: "Save Dashboard" }).click();

  await expect(
    page.getByRole("heading", { name: "Equipment overview" }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Complete data for Count by Region" }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`dashboard=${dashboardId}`));
  expect(api.writes[0]?.method).toBe("POST");
  expect(
    api.writes[0]?.body?.widgets?.map((widget) =>
      widget.widget_type !== "records" && widget.config.query.mode === "groups"
        ? widget.config.query.dimension.field_id
        : null,
    ),
  ).toEqual([regionFieldId, categoryFieldId]);
  expect(
    api.writes[0]?.body?.widgets?.map((widget) =>
      widget.widget_type === "records" ? null : widget.config.query.measure,
    ),
  ).toEqual([null, null]);
  expect(api.snapshots).toHaveLength(1);
  expect(api.snapshots[0]).toMatchObject({
    mode: "groups",
    dimension: { field_id: regionFieldId },
  });
  expect(api.snapshots[0]).not.toHaveProperty("measure");

  await page.reload();
  await expect(page).toHaveURL(new RegExp(`dashboard=${dashboardId}`));
  await expect(
    page.getByRole("heading", { name: "Equipment overview" }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Complete data for Count by Region" }),
  ).toBeVisible();
  expect(api.snapshots).toHaveLength(2);
  await page.getByRole("button", { name: "View chart 2" }).click();
  await expect(
    page.getByRole("table", { name: "Complete data for Count by Category" }),
  ).toBeVisible();
  expect(api.snapshots).toHaveLength(3);
  expect(api.snapshots[2]).toMatchObject({
    mode: "groups",
    dimension: { field_id: categoryFieldId },
  });
  await expect(page.getByText("1–25 of 30 aggregate groups")).toBeVisible();
  await expect(
    page
      .getByRole("table", { name: "Complete data for Count by Category" })
      .locator("tbody tr"),
  ).toHaveCount(25);
  await page.getByRole("button", { name: "Next data page" }).click();
  await expect(page.getByText("26–30 of 30 aggregate groups")).toBeVisible();
  await expect(
    page
      .getByRole("table", { name: "Complete data for Count by Category" })
      .getByText("Group 30"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Previous data page" }).click();

  api.failNextSnapshot();
  await page.getByRole("button", { name: "Refresh now" }).click();
  await expect(
    page.getByText(/last successful data remains visible/),
  ).toBeVisible();
  await expect(
    page
      .getByRole("table", { name: "Complete data for Count by Category" })
      .getByRole("cell", { name: "Group 1", exact: true }),
  ).toBeVisible();
});

test("returning to a cached Dashboard chart clears a different chart's pending refresh", async ({
  page,
}) => {
  const api = await installDashboardApi(
    page,
    dashboard({
      widgets: [
        savedWidget(dashboardWidgetId, 0, regionFieldId),
        savedWidget(secondDashboardWidgetId, 1, categoryFieldId),
      ],
    }),
  );
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  await expect(
    page.getByRole("table", { name: "Complete data for Count by Region" }),
  ).toBeVisible();

  const pending = api.holdNextSnapshot();
  await page.getByRole("button", { name: "View chart 2" }).click();
  await pending.started;
  await expect(
    page.getByRole("button", { name: "Refreshing…" }),
  ).toBeDisabled();

  try {
    await page.getByRole("button", { name: "View chart 1" }).click();
    await expect(
      page.getByRole("table", { name: "Complete data for Count by Region" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Refresh now" }),
    ).toBeEnabled();
  } finally {
    pending.release();
  }
  await expect(page.getByRole("button", { name: "Refresh now" })).toBeEnabled();
});

test("private Dashboard builder saves Count over time and reloads the complete daily series", async ({
  page,
}) => {
  const api = await installDashboardApi(page);
  await page.goto("/openview?section=dashboards");

  await page.getByLabel("Dashboard name").fill("Equipment activity");
  await page.getByLabel("Module").selectOption(moduleId);
  await page.getByLabel("Chart type").selectOption("line");
  const addLineChart = page.getByRole("button", {
    name: "Add line chart widget",
  });
  await expect(addLineChart).toBeDisabled();
  const dateField = page.getByLabel("Date field");
  await expect(dateField).toContainText("Occurred on");
  await expect(dateField).toContainText("Updated at");
  await dateField.selectOption(datetimeFieldId);
  await page.getByLabel("Start date").fill("2024-02-28");
  await page.getByLabel("End date").fill("2024-03-01");
  await expect(addLineChart).toBeEnabled();
  await addLineChart.click();
  await expect(page.getByText("1 of 12 widgets")).toBeVisible();
  await page.getByRole("button", { name: "Save Dashboard" }).click();

  await expect(page).toHaveURL(new RegExp(`dashboard=${dashboardId}`));
  const table = page.getByRole("table", {
    name: "Complete data for Count over time",
  });
  await expect(table).toBeVisible();
  await expect(
    page.getByText("Showing all 3 days in chronological order."),
  ).toBeVisible();
  const rows = table.locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).getByRole("cell").first()).toHaveText("2024-02-28");
  await expect(rows.nth(1).getByRole("cell").first()).toHaveText("2024-02-29");
  await expect(rows.nth(2).getByRole("cell").first()).toHaveText("2024-03-01");
  expect(api.writes[0]?.method).toBe("POST");
  expect(api.writes[0]?.body?.widgets?.[0]?.config).toMatchObject({
    version: 1,
    chart_type: "line",
    query: {
      mode: "date_series",
      module_id: moduleId,
      aggregation: "count",
      date_field: {
        field_id: datetimeFieldId,
        expected_type: "datetime",
      },
      from_date: "2024-02-28",
      to_date: "2024-03-01",
    },
  });
  const savedWidget = api.writes[0]?.body?.widgets?.[0];
  expect(
    savedWidget && savedWidget.widget_type !== "records"
      ? savedWidget.config.query.measure
      : undefined,
  ).toBeNull();
  expect(api.snapshots[0]).toMatchObject({
    mode: "date_series",
    module_id: moduleId,
    aggregation: "count",
    date_field: {
      field_id: datetimeFieldId,
      expected_type: "datetime",
    },
    from_date: "2024-02-28",
    to_date: "2024-03-01",
  });
  expect(api.snapshots[0]).not.toHaveProperty("measure");

  await page.reload();
  await expect(table).toBeVisible();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).getByRole("cell").first()).toHaveText("2024-02-28");
  await expect(rows.nth(1).getByRole("cell").first()).toHaveText("2024-02-29");
  await expect(rows.nth(2).getByRole("cell").first()).toHaveText("2024-03-01");
  expect(api.snapshots).toHaveLength(2);
  expect(api.snapshots[1]).toMatchObject({
    mode: "date_series",
    date_field: { field_id: datetimeFieldId, expected_type: "datetime" },
    from_date: "2024-02-28",
    to_date: "2024-03-01",
  });
});

test("Dashboard bar builder requires and saves a typed numeric measure for Sum", async ({
  page,
}) => {
  const api = await installDashboardApi(page);
  await page.goto("/openview?section=dashboards");

  await page.getByLabel("Dashboard name").fill("Equipment totals");
  await page.getByLabel("Module").selectOption(moduleId);
  await page.getByLabel("Aggregation").selectOption("sum");
  const addChart = page.getByRole("button", { name: "Add chart widget" });
  const measure = page.getByLabel("Numeric measure");
  await expect(measure).toHaveValue("");
  await expect(addChart).toBeDisabled();
  await expect(
    measure.getByRole("option", { name: "Amount", exact: true }),
  ).toHaveCount(1);
  await expect(
    measure.getByRole("option", { name: "Units", exact: true }),
  ).toHaveCount(1);
  await expect(
    measure.getByRole("option", { name: "Score", exact: true }),
  ).toHaveCount(1);

  await measure.selectOption(amountFieldId);
  await expect(addChart).toBeEnabled();
  await addChart.click();
  await page.getByRole("button", { name: "Save Dashboard" }).click();

  await expect(page).toHaveURL(new RegExp(`dashboard=${dashboardId}`));
  await expect(
    page.getByRole("table", {
      name: "Complete data for Sum of Amount by Category",
    }),
  ).toBeVisible();
  expect(api.writes[0]?.body).toEqual({
    name: "Equipment totals",
    refresh_cadence: "manual",
    widgets: [
      {
        widget_type: "chart",
        config: {
          version: 1,
          chart_type: "bar",
          query: {
            mode: "groups",
            module_id: moduleId,
            definition: queryDefinition,
            aggregation: "sum",
            measure: {
              field_id: amountFieldId,
              expected_type: "decimal",
            },
            dimension: {
              field_id: categoryFieldId,
              expected_type: "select",
            },
          },
        },
      },
    ],
  });
  expect(api.snapshots[0]).toMatchObject({
    mode: "groups",
    aggregation: "sum",
    measure: { field_id: amountFieldId, expected_type: "decimal" },
  });
});

test("private Dashboard Pie builder saves Sum and reloads its preview and complete table", async ({
  page,
}) => {
  const api = await installDashboardApi(page);
  await page.goto("/openview?section=dashboards");

  await page.getByLabel("Dashboard name").fill("Equipment distribution");
  await page.getByLabel("Module").selectOption(moduleId);
  await page.getByLabel("Chart type").selectOption("pie");
  await page.getByLabel("Aggregation").selectOption("sum");
  const addPieChart = page.getByRole("button", {
    name: "Add pie chart widget",
  });
  await expect(page.getByLabel("Group records by")).toBeVisible();
  await expect(page.getByLabel("Date field")).toHaveCount(0);
  await expect(page.getByLabel("Start date")).toHaveCount(0);
  await expect(addPieChart).toBeDisabled();
  await page.getByLabel("Numeric measure").selectOption(amountFieldId);
  await expect(addPieChart).toBeEnabled();
  await addPieChart.click();
  await page.getByRole("button", { name: "Save Dashboard" }).click();

  await expect(page).toHaveURL(new RegExp(`dashboard=${dashboardId}`));
  const table = page.getByRole("table", {
    name: "Complete data for Sum of Amount by Category",
  });
  const preview = page.getByRole("group", {
    name: "Sum of Amount by Category chart preview, 12 categories",
  });
  await expect(preview).toBeVisible();
  await expect(preview.locator(".recharts-pie")).toBeVisible();
  await expect(table).toBeVisible();
  await expect(page.getByText("1–25 of 30 aggregate groups")).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(25);
  expect(api.writes[0]?.body).toEqual({
    name: "Equipment distribution",
    refresh_cadence: "manual",
    widgets: [
      {
        widget_type: "chart",
        config: {
          version: 1,
          chart_type: "pie",
          query: {
            mode: "groups",
            module_id: moduleId,
            definition: queryDefinition,
            aggregation: "sum",
            measure: {
              field_id: amountFieldId,
              expected_type: "decimal",
            },
            dimension: {
              field_id: categoryFieldId,
              expected_type: "select",
            },
          },
        },
      },
    ],
  });

  await page.reload();
  await expect(preview).toBeVisible();
  await expect(preview.locator(".recharts-pie")).toBeVisible();
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(25);
  await page.getByRole("button", { name: "Next data page" }).click();
  await expect(page.getByText("26–30 of 30 aggregate groups")).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(5);
  expect(api.snapshots).toHaveLength(2);
  expect(api.snapshots[1]).toMatchObject({
    mode: "groups",
    aggregation: "sum",
    measure: { field_id: amountFieldId, expected_type: "decimal" },
    dimension: { field_id: categoryFieldId, expected_type: "select" },
  });
});

test("Dashboard line builder requires and saves a typed numeric measure for Average", async ({
  page,
}) => {
  const api = await installDashboardApi(page);
  await page.goto("/openview?section=dashboards");

  await page.getByLabel("Dashboard name").fill("Daily scores");
  await page.getByLabel("Module").selectOption(moduleId);
  await page.getByLabel("Chart type").selectOption("line");
  await page.getByLabel("Aggregation").selectOption("average");
  const addLineChart = page.getByRole("button", {
    name: "Add line chart widget",
  });
  const measure = page.getByLabel("Numeric measure");
  await expect(measure).toHaveValue("");
  await expect(addLineChart).toBeDisabled();
  await measure.selectOption(scoreFieldId);
  await page.getByLabel("Date field").selectOption(dateFieldId);
  await page.getByLabel("Start date").fill("2024-03-01");
  await page.getByLabel("End date").fill("2024-03-02");
  await expect(addLineChart).toBeEnabled();
  await addLineChart.click();
  await page.getByRole("button", { name: "Save Dashboard" }).click();

  await expect(page).toHaveURL(new RegExp(`dashboard=${dashboardId}`));
  const table = page.getByRole("table", {
    name: "Complete data for Average of Score over time",
  });
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(2);
  expect(api.writes[0]?.body).toEqual({
    name: "Daily scores",
    refresh_cadence: "manual",
    widgets: [
      {
        widget_type: "chart",
        config: {
          version: 1,
          chart_type: "line",
          query: {
            mode: "date_series",
            module_id: moduleId,
            definition: queryDefinition,
            aggregation: "average",
            measure: { field_id: scoreFieldId, expected_type: "number" },
            date_field: { field_id: dateFieldId, expected_type: "date" },
            from_date: "2024-03-01",
            to_date: "2024-03-02",
          },
        },
      },
    ],
  });
  expect(api.snapshots[0]).toMatchObject({
    mode: "date_series",
    aggregation: "average",
    measure: { field_id: scoreFieldId, expected_type: "number" },
    date_field: { field_id: dateFieldId, expected_type: "date" },
  });

  await page.reload();
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(2);
  expect(api.snapshots).toHaveLength(2);
  expect(api.snapshots[1]).toMatchObject({
    mode: "date_series",
    aggregation: "average",
    measure: { field_id: scoreFieldId, expected_type: "number" },
  });
});

test("line chart builder blocks missing, reversed, and overlong date ranges", async ({
  page,
}) => {
  const api = await installDashboardApi(page);
  await page.goto("/openview?section=dashboards");

  await page.getByLabel("Module").selectOption(moduleId);
  await page.getByLabel("Chart type").selectOption("line");
  const addLineChart = page.getByRole("button", {
    name: "Add line chart widget",
  });
  const dateField = page.getByLabel("Date field");
  await expect(dateField).toContainText("Occurred on");
  await expect(addLineChart).toBeDisabled();

  await dateField.selectOption(dateFieldId);
  const startDate = page.getByLabel("Start date");
  const endDate = page.getByLabel("End date");
  await startDate.fill("2024-02-29");
  await expect(addLineChart).toBeDisabled();
  await endDate.fill("2024-02-29");
  await expect(addLineChart).toBeEnabled();
  await endDate.fill("2024-02-28");
  await expect(addLineChart).toBeDisabled();
  await endDate.fill("2025-02-28");
  await expect(addLineChart).toBeEnabled();
  await endDate.fill("2025-03-01");
  await expect(addLineChart).toBeDisabled();
  await dateField.selectOption("");
  await expect(addLineChart).toBeDisabled();
  await expect(page.getByText("0 of 12 widgets")).toBeVisible();
  expect(api.writes).toHaveLength(0);
});

test("stale Dashboard save keeps the name and ordered widget draft available", async ({
  page,
}) => {
  const initial = dashboard({
    widgets: [savedWidget(dashboardWidgetId, 0, categoryFieldId)],
  });
  const api = await installDashboardApi(page, initial);
  api.setConflict();
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);

  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  await page.getByLabel("Dashboard name").fill("Unsaved operations draft");
  await page.getByRole("button", { name: "Save Dashboard" }).click();

  await expect(
    page.getByText("This Dashboard changed since you opened it."),
  ).toBeVisible();
  await expect(page.getByLabel("Dashboard name")).toHaveValue(
    "Unsaved operations draft",
  );
  await expect(page.getByText("1 of 12 widgets")).toBeVisible();
  expect(api.writes).toHaveLength(1);
  expect(api.writes[0]?.method).toBe("PATCH");
});

test("archiving and restoring a Dashboard uses the saved revision", async ({
  page,
}) => {
  const api = await installDashboardApi(page, dashboard({ widgets: [] }));
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);

  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  await page.getByRole("button", { name: "Archive Dashboard" }).click();
  await expect(page.getByText("Dashboard archived.")).toBeVisible();
  expect(api.writes[0]).toMatchObject({ method: "DELETE", dashboardId });

  await page.getByRole("button", { name: "Show archived" }).click();
  await page.getByRole("button", { name: "Restore Operations" }).click();
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  expect(api.writes[1]).toMatchObject({
    method: "POST",
    dashboardId,
    body: { revision: 2 },
  });
});

test("a saved Dashboard can be made default, restored on a clean URL, and unset", async ({
  page,
}) => {
  const api = await installDashboardApi(page, dashboard({ widgets: [] }));
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);

  await expect(page.getByLabel("Dashboard name")).toHaveValue("Operations");
  await page.getByRole("button", { name: "Set as default" }).click();
  await expect(
    page.getByRole("button", { name: "Clear default" }),
  ).toBeVisible();
  expect(api.dashboardDefaultWrites).toEqual([{ dashboard_id: dashboardId }]);

  await page.goto("/openview?section=dashboards");
  await expect(page.getByLabel("Dashboard name")).toHaveValue("Operations");
  await expect(page).toHaveURL(new RegExp(`dashboard=${dashboardId}(?:$|&)`));
  await expect(
    page.getByRole("button", { name: "Clear default" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Clear default" }).click();
  await expect(
    page.getByRole("button", { name: "Set as default" }),
  ).toBeVisible();
  expect(api.dashboardDefaultWrites).toEqual([
    { dashboard_id: dashboardId },
    { dashboard_id: null },
  ]);
});

test("retrying an initial default error opens the saved Dashboard without losing the URL", async ({
  page,
}) => {
  const api = await installDashboardApi(page, dashboard({ widgets: [] }));
  api.setDashboardDefault(dashboardId);
  api.failDashboardDefaultReads();
  await page.goto("/openview?section=dashboards");

  await expect(
    page.getByRole("button", { name: "Retry default Dashboard" }),
  ).toBeVisible();
  await expect(page.getByLabel("Dashboard name")).toHaveValue("");
  const readsBeforeRetry = api.dashboardDefaultReads.length;
  api.recoverDashboardDefaultReads();
  await page.getByRole("button", { name: "Retry default Dashboard" }).click();
  await expect(page.getByLabel("Dashboard name")).toHaveValue("Operations");
  await expect(page).toHaveURL(new RegExp(`dashboard=${dashboardId}(?:$|&)`));
  expect(api.dashboardDefaultReads.length).toBeGreaterThan(readsBeforeRetry);
});

test("an explicit Dashboard URL outranks a different personal default", async ({
  page,
}) => {
  const api = await installDashboardApi(page, dashboard({ widgets: [] }));
  api.setAlternateDashboard(
    dashboard({
      id: alternateDashboardId,
      name: "Quality checks",
      widgets: [],
    }),
  );
  api.setDashboardDefault(alternateDashboardId);
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);

  await expect(page.getByLabel("Dashboard name")).toHaveValue("Operations");
  await expect(page).toHaveURL(new RegExp(`dashboard=${dashboardId}(?:$|&)`));
  await expect(page.getByText("Default", { exact: true })).toBeVisible();
  expect(api.dashboardReads).toContain(`/api/dashboards/${dashboardId}`);
  expect(api.dashboardReads).not.toContain(
    `/api/dashboards/${alternateDashboardId}`,
  );
});

test("a delayed default cannot override a Dashboard explicitly chosen from the list", async ({
  page,
}) => {
  const api = await installDashboardApi(page, dashboard({ widgets: [] }));
  api.setAlternateDashboard(
    dashboard({
      id: alternateDashboardId,
      name: "Quality checks",
      widgets: [],
    }),
  );
  api.setDashboardDefault(alternateDashboardId);
  const gate = api.holdNextDashboardDefaultGet();
  const defaultResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/dashboards/default" &&
      response.request().method() === "GET"
    );
  });
  await page.goto("/openview?section=dashboards");

  try {
    await gate.started;
    await expect(
      page.getByRole("button", { name: "Operations" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Quality checks" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Operations" }).click();
    gate.release();
    await defaultResponse;
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(new RegExp(`dashboard=${dashboardId}(?:$|&)`));
    await expect(page.getByLabel("Dashboard name")).toHaveValue("Operations");
    expect(api.dashboardReads).toContain(`/api/dashboards/${dashboardId}`);
    expect(api.dashboardReads).not.toContain(
      `/api/dashboards/${alternateDashboardId}`,
    );
  } finally {
    gate.release();
  }
});

test("changing to the archived list prevents a late active default selection", async ({
  page,
}) => {
  const api = await installDashboardApi(page, dashboard({ widgets: [] }));
  api.setDashboardDefault(dashboardId);
  const gate = api.holdNextDashboardDefaultGet();
  const defaultResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/dashboards/default" &&
      response.request().method() === "GET"
    );
  });
  await page.goto("/openview?section=dashboards");

  try {
    await gate.started;
    await expect(
      page.getByRole("button", { name: "Operations" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Show archived" }).click();
    await expect(
      page.getByRole("heading", { name: "Archived dashboards" }),
    ).toBeVisible();
    await expect(page.getByText("No archived Dashboards.")).toBeVisible();

    gate.release();
    await defaultResponse;
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL("/openview?section=dashboards");
    await expect(page.getByLabel("Dashboard name")).toHaveValue("");
    expect(api.dashboardReads).not.toContain(`/api/dashboards/${dashboardId}`);
  } finally {
    gate.release();
  }
});

test("a late personal default response cannot replace a Dashboard draft", async ({
  page,
}) => {
  const api = await installDashboardApi(page, dashboard({ widgets: [] }));
  api.setDashboardDefault(dashboardId);
  const gate = api.holdNextDashboardDefaultGet();
  const defaultResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/dashboards/default" &&
      response.request().method() === "GET"
    );
  });
  await page.goto("/openview?section=dashboards");

  try {
    await gate.started;
    const dashboardName = page.getByLabel("Dashboard name");
    await dashboardName.fill("Draft entered before the default arrived");
    gate.release();
    await defaultResponse;
    await page.waitForLoadState("networkidle");

    await expect(dashboardName).toHaveValue(
      "Draft entered before the default arrived",
    );
    await expect(page).toHaveURL("/openview?section=dashboards");
    expect(api.dashboardReads).not.toContain(`/api/dashboards/${dashboardId}`);
  } finally {
    gate.release();
  }
});

test("an archived default stays hidden and is available again after restore", async ({
  page,
}) => {
  const api = await installDashboardApi(
    page,
    dashboard({ is_deleted: true, widgets: [] }),
  );
  api.setDashboardDefault(dashboardId);
  await page.goto("/openview?section=dashboards");

  await expect(
    page.getByText("No Dashboards yet. Create one to get started."),
  ).toBeVisible();
  await expect.poll(() => api.dashboardDefaultReads.length).toBeGreaterThan(0);
  const readsBeforeRestore = api.dashboardDefaultReads.length;
  await page.getByRole("button", { name: "Show archived" }).click();
  await expect(page.getByText("Default", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Restore Operations" }).click();

  await expect(page.getByLabel("Dashboard name")).toHaveValue("Operations");
  await expect(
    page.getByRole("button", { name: "Clear default" }),
  ).toBeVisible();
  await expect(page.getByText("Default", { exact: true })).toBeVisible();
  await expect
    .poll(() => api.dashboardDefaultReads.length)
    .toBeGreaterThan(readsBeforeRestore);
  expect(api.dashboardDefaultWrites).toHaveLength(0);
});

test("restoring at the current URL does not suppress a later Dashboard re-selection", async ({
  page,
}) => {
  const api = await installDashboardApi(
    page,
    dashboard({ is_deleted: true, widgets: [] }),
  );
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);

  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  await page.getByRole("button", { name: "Restore Dashboard" }).click();
  await expect(page.getByText("Dashboard restored.")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`dashboard=${dashboardId}`));

  await page.getByRole("button", { name: "New Dashboard" }).click();
  await expect(page.getByRole("button", { name: "Operations" })).toBeVisible();
  const readsBeforeReselection = api.dashboardReads.length;
  await page.getByRole("button", { name: "Operations" }).click();
  await expect(page.getByLabel("Dashboard name")).toHaveValue("Operations");
  expect(api.dashboardReads).toHaveLength(readsBeforeReselection + 1);
});

test("a pending Dashboard deep link is cleared when switching to archived list", async ({
  page,
}) => {
  const api = await installDashboardApi(page, dashboard({ widgets: [] }));
  const gate = api.holdNextDashboardGet();
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  try {
    await gate.started;
    const routeResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === `/api/dashboards/${dashboardId}` &&
        response.request().method() === "GET"
      );
    });
    await page.getByRole("button", { name: "Show archived" }).click();
    expect(page.url()).toContain(`dashboard=${dashboardId}`);
    const dashboardName = page.getByLabel("Dashboard name");
    await dashboardName.fill("Draft after changing the list view");
    gate.release();
    await routeResponse;
    await expect(page).toHaveURL("/openview?section=dashboards");
    await expect(dashboardName).toHaveValue(
      "Draft after changing the list view",
    );
  } finally {
    gate.release();
  }
  await expect(page.getByLabel("Dashboard name")).toHaveValue(
    "Draft after changing the list view",
  );
  expect(api.dashboardReads.length).toBeGreaterThan(0);
});

test("a pending Dashboard deep link cannot overwrite a new Dashboard draft", async ({
  page,
}) => {
  const api = await installDashboardApi(page, dashboard({ widgets: [] }));
  const gate = api.holdNextDashboardGet();
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  try {
    await gate.started;
    const routeResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === `/api/dashboards/${dashboardId}` &&
        response.request().method() === "GET"
      );
    });
    await page.getByRole("button", { name: "New Dashboard" }).click();
    expect(page.url()).toContain(`dashboard=${dashboardId}`);
    const dashboardName = page.getByLabel("Dashboard name");
    await dashboardName.fill("Draft after starting a new Dashboard");
    gate.release();
    await routeResponse;
    await expect(page).toHaveURL("/openview?section=dashboards");
    await expect(dashboardName).toHaveValue(
      "Draft after starting a new Dashboard",
    );
  } finally {
    gate.release();
  }
  expect(api.dashboardReads.length).toBeGreaterThan(0);
});

test("restoring from the archived list does not overwrite a new Dashboard draft", async ({
  page,
}) => {
  const api = await installDashboardApi(
    page,
    dashboard({ is_deleted: true, widgets: [] }),
  );
  await page.goto("/openview?section=dashboards");
  await page.getByRole("button", { name: "Show archived" }).click();
  const nameInput = page.getByLabel("Dashboard name");
  await nameInput.fill("Unsaved Dashboard draft");

  const restoreButton = page.getByRole("button", {
    name: "Restore Operations",
  });
  await expect(restoreButton).toBeDisabled();
  await expect(nameInput).toHaveValue("Unsaved Dashboard draft");
  expect(api.writes).toHaveLength(0);
});

test("a repeated restore is disabled while the revision-checked restore is pending", async ({
  page,
}) => {
  const api = await installDashboardApi(
    page,
    dashboard({ is_deleted: true, widgets: [] }),
  );
  await page.goto("/openview?section=dashboards");
  await page.getByRole("button", { name: "Show archived" }).click();
  const restoreButton = page.getByRole("button", {
    name: "Restore Operations",
  });
  const gate = api.holdNextRestore();
  await restoreButton.click();
  try {
    await gate.started;
    await expect(restoreButton).toBeDisabled();
    expect(api.writes.filter((write) => write.method === "POST")).toHaveLength(
      1,
    );
  } finally {
    gate.release();
  }
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
});

test("date-line Dashboard previews retain the complete chronological window", async ({
  page,
}) => {
  const api = await installDashboardApi(
    page,
    dashboard({ widgets: [savedDateWidget(dashboardWidgetId, 0)] }),
  );
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);

  await expect(
    page.getByRole("group", {
      name: /366 daily points; point labels and dots are suppressed/,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Complete data for Count over time" }),
  ).toBeVisible();
  await expect(
    page.getByText("Showing all 366 days in chronological order."),
  ).toBeVisible();
  expect(api.snapshots[0]).toMatchObject({
    mode: "date_series",
    from_date: "2024-01-01",
    to_date: "2024-12-31",
  });
});

test("a shorter refreshed snapshot clamps the data page before Previous is used", async ({
  page,
}) => {
  const api = await installDashboardApi(page, dashboard());
  api.setSnapshotLength(60);
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  await expect(
    page.getByRole("table", { name: "Complete data for Count by Category" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next data page" }).click();
  await page.getByRole("button", { name: "Next data page" }).click();
  await expect(page.getByText("51–60 of 60 aggregate groups")).toBeVisible();

  api.setSnapshotLength(30);
  await page.getByRole("button", { name: "Refresh now" }).click();
  await expect(page.getByText("26–30 of 30 aggregate groups")).toBeVisible();
  await page.getByRole("button", { name: "Previous data page" }).click();
  await expect(page.getByText("1–25 of 30 aggregate groups")).toBeVisible();
});

test("the categorical Count builder excludes numeric and date fields", async ({
  page,
}) => {
  await installDashboardApi(page);
  await page.goto("/openview?section=dashboards");
  await page.getByLabel("Module").selectOption(moduleId);

  const dimension = page.getByLabel("Group records by");
  await expect(dimension.getByRole("option", { name: "Category" })).toHaveCount(
    1,
  );
  await expect(dimension.getByRole("option", { name: "Region" })).toHaveCount(
    1,
  );
  await expect(dimension.getByRole("option", { name: "Amount" })).toHaveCount(
    0,
  );
  await expect(dimension.getByRole("option", { name: "Units" })).toHaveCount(0);
  await expect(dimension.getByRole("option", { name: "Score" })).toHaveCount(0);
  await expect(
    dimension.getByRole("option", { name: "Occurred on" }),
  ).toHaveCount(0);
});

test("unsaved Dashboard drafts require an explicit keep or discard before navigation", async ({
  page,
}) => {
  await installDashboardApi(page);
  await page.goto("/openview?section=dashboards");

  const dashboardName = page.getByLabel("Dashboard name");
  await dashboardName.fill("Draft kept after cancel");

  const reportsLink = page.getByRole("link", { name: "Reports", exact: true });
  await reportsLink.click();
  const discardDialog = page.getByRole("alertdialog");
  await expect(discardDialog).toBeVisible();
  await expect(page).toHaveURL("/openview?section=dashboards");
  await discardDialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(discardDialog).toBeHidden();
  await expect(page).toHaveURL("/openview?section=dashboards");
  await expect(dashboardName).toHaveValue("Draft kept after cancel");

  await reportsLink.click();
  await discardDialog
    .getByRole("button", { name: "Discard and continue" })
    .click();
  await expect(page).toHaveURL("/openview?section=reports");
  await expect(dashboardName).toHaveCount(0);

  await page.getByRole("link", { name: "Dashboards", exact: true }).click();
  await expect(page).toHaveURL("/openview?section=dashboards");
  await page.getByLabel("Dashboard name").fill("Draft before workspace change");
  await page.getByRole("link", { name: "Search workspace" }).click();
  await expect(discardDialog).toBeVisible();
  await discardDialog
    .getByRole("button", { name: "Discard and continue" })
    .click();
  await expect(page).toHaveURL("/platform");
  await expect(page.getByLabel("Dashboard name")).toHaveCount(0);
});

test("a delayed active Dashboard page cannot enter the archived list", async ({
  page,
}) => {
  const api = await installDashboardApi(page, dashboard({ widgets: [] }));
  api.setDashboardListHasMore(true);
  const gate = api.holdNextDashboardListPage(
    dashboard({
      id: delayedDashboardId,
      name: "Late active page",
      widgets: [],
    }),
  );
  await page.goto("/openview?section=dashboards");
  await expect(page.getByRole("button", { name: "Operations" })).toBeVisible();

  try {
    await page.getByRole("button", { name: "Load more Dashboards" }).click();
    await gate.started;
    await page.getByRole("button", { name: "Show archived" }).click();
    await expect(
      page.getByRole("heading", { name: "Archived dashboards" }),
    ).toBeVisible();
    await expect(page.getByText("No archived Dashboards.")).toBeVisible();

    gate.release();
    await expect(page.getByText("No archived Dashboards.")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Late active page" }),
    ).toHaveCount(0);
  } finally {
    gate.release();
  }
});

test("a delayed field page cannot corrupt pagination after switching modules", async ({
  page,
}) => {
  const api = await installDashboardApi(page);
  api.setFieldPages({
    [moduleId]: {
      firstPage: [dataSourceField(categoryFieldId, moduleId, "Category", 0)],
      hasMore: true,
      nextPage: [dataSourceField(delayedFieldId, moduleId, "Late field", 1)],
      nextPageHasMore: true,
    },
    [secondModuleId]: {
      firstPage: [
        dataSourceField(secondModuleFieldId, secondModuleId, "Process", 0),
      ],
      hasMore: true,
      nextPage: [
        dataSourceField(
          secondModuleNextFieldId,
          secondModuleId,
          "Follow-up process",
          1,
        ),
      ],
      nextPageHasMore: false,
    },
  });
  const gate = api.holdNextFieldPage(moduleId, 1);
  await page.goto("/openview?section=dashboards");

  await page.getByLabel("Module").selectOption(moduleId);
  const dimension = page.getByLabel("Group records by");
  await expect(dimension.getByRole("option", { name: "Category" })).toHaveCount(
    1,
  );
  await page.getByRole("button", { name: "Load more fields" }).click();

  try {
    await gate.started;
    await page.getByLabel("Module").selectOption(secondModuleId);
    await expect(
      dimension.getByRole("option", { name: "Process" }),
    ).toHaveCount(1);
    gate.release();

    await page.getByRole("button", { name: "Load more fields" }).click();
    await expect
      .poll(
        () =>
          [...api.fieldReads]
            .reverse()
            .find((read) => read.moduleId === secondModuleId && read.offset > 0)
            ?.offset,
      )
      .toBe(1);
    await expect(
      dimension.getByRole("option", { name: "Follow-up process" }),
    ).toHaveCount(1);
    await expect(
      dimension.getByRole("option", { name: "Late field" }),
    ).toHaveCount(0);
  } finally {
    gate.release();
  }
});

test("private Dashboard saves and reloads all four live widget types", async ({
  page,
}) => {
  const api = await installDashboardApi(page);
  await page.goto("/openview?section=dashboards");

  await page.getByLabel("Dashboard name").fill("Live operations");
  await page.getByLabel("Module").selectOption(moduleId);
  await page.getByLabel("Refresh cadence").selectOption("one-minute");

  await page.getByLabel("Widget type").selectOption("summary");
  await page.getByRole("button", { name: "Add summary widget" }).click();
  await page.getByLabel("Widget type").selectOption("workload");
  await page.getByLabel("Aggregation").selectOption("sum");
  await page.getByLabel("Numeric measure").selectOption(amountFieldId);
  await page.getByLabel("Group records by").selectOption(regionFieldId);
  await page.getByRole("button", { name: "Add workload widget" }).click();
  await page.getByLabel("Widget type").selectOption("records");
  await page.getByLabel("Display field").selectOption(categoryFieldId);
  await page.getByRole("button", { name: "Add records widget" }).click();
  await page.getByLabel("Widget type").selectOption("chart");
  await page.getByLabel("Aggregation").selectOption("count");
  await page.getByLabel("Group records by").selectOption(categoryFieldId);
  await page.getByRole("button", { name: "Add chart widget" }).click();
  await expect(page.getByText("4 of 12 widgets")).toBeVisible();
  await page.getByRole("button", { name: "Save Dashboard" }).click();

  await expect(page).toHaveURL(new RegExp(`dashboard=${dashboardId}`));
  expect(api.writes[0]?.body).toMatchObject({
    name: "Live operations",
    refresh_cadence: "one-minute",
    widgets: [
      { widget_type: "summary" },
      { widget_type: "workload" },
      { widget_type: "records" },
      { widget_type: "chart" },
    ],
  });
  await expect(page.getByText("Total records: 465")).toBeVisible();
  expect(api.snapshots[0]).toMatchObject({
    mode: "groups",
    aggregation: "count",
    dimension: { field_id: categoryFieldId },
  });

  await page.reload();
  await expect(page.getByText("Total records: 465")).toBeVisible();
  await page.getByRole("button", { name: /View workload 2/ }).click();
  await expect(
    page.getByRole("heading", { name: /Workload by Region/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /View records 3/ }).click();
  const recordsTable = page.getByRole("table", { name: "Live records" });
  await expect(recordsTable.getByText("Repair")).toBeVisible();
  await expect(recordsTable.getByText("Inspection")).toBeVisible();
  expect(api.recordQueries.at(-1)).toMatchObject({
    module_id: moduleId,
    definition: {
      columns: [{ field_id: categoryFieldId, expected_type: "select" }],
    },
    limit: 25,
    offset: 0,
  });
  await page.getByRole("button", { name: /View chart 4/ }).click();
  await expect(
    page.getByRole("table", { name: "Complete data for Count by Category" }),
  ).toBeVisible();
});

test("saved Record widget shows values for a field beyond the first catalog page after reload", async ({
  page,
}) => {
  const api = await installDashboardApi(page);
  const laterFieldId = delayedFieldId;
  api.setFieldPages({
    [moduleId]: {
      firstPage: [
        dataSourceField(categoryFieldId, moduleId, "Category", 0),
        ...Array.from({ length: 99 }, (_, index) =>
          dataSourceField(
            `00000000-0000-4000-8000-${String(index + 301).padStart(12, "0")}`,
            moduleId,
            `Field ${index + 2}`,
            index + 1,
          ),
        ),
      ],
      hasMore: true,
      nextPage: [dataSourceField(laterFieldId, moduleId, "Later field", 100)],
      nextPageHasMore: false,
    },
  });
  api.setRecordFieldId(laterFieldId);
  await page.goto("/openview?section=dashboards");

  await page.getByLabel("Dashboard name").fill("Later field records");
  await page.getByLabel("Module").selectOption(moduleId);
  await page.getByLabel("Widget type").selectOption("records");
  await page.getByRole("button", { name: "Load more fields" }).click();
  await page.getByLabel("Display field").selectOption(laterFieldId);
  await page.getByRole("button", { name: "Add records widget" }).click();
  await page.getByRole("button", { name: "Save Dashboard" }).click();
  await expect(page).toHaveURL(new RegExp(`dashboard=${dashboardId}`));
  expect(api.writes[0]?.body?.widgets?.[0]).toMatchObject({
    widget_type: "records",
    config: {
      query: {
        definition: {
          columns: [{ field_id: laterFieldId, expected_type: "select" }],
        },
      },
    },
  });

  await page.reload();
  const recordsTable = page.getByRole("table", { name: "Live records" });
  await expect(recordsTable).toBeVisible();
  await expect(recordsTable.getByRole("columnheader")).toHaveCount(1);
  await expect(
    recordsTable.getByRole("cell", { name: "Repair" }),
  ).toBeVisible();
  await expect(
    recordsTable.getByRole("cell", { name: "Inspection" }),
  ).toBeVisible();
});

for (const status of [401, 403] as const) {
  test(`clears a cached Dashboard chart after a ${status} refresh denial`, async ({
    page,
  }) => {
    const api = await installDashboardApi(page, dashboard());
    await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
    const table = page.getByRole("table", {
      name: "Complete data for Count by Category",
    });
    await expect(table).toBeVisible();
    api.failNextSnapshotWithStatus(status);
    await page.getByRole("button", { name: "Refresh now" }).click();
    await expect(table).toHaveCount(0);
    await expect(
      page.getByText(/last successful data remains visible/),
    ).toHaveCount(0);
  });
}

test("clears cached Dashboard record rows after a 401 refresh denial", async ({
  page,
}) => {
  const recordWidget: DashboardWire["widgets"][number] = {
    id: dashboardWidgetId,
    position: 0,
    widget_type: "records",
    config: {
      version: 1,
      query: {
        module_id: moduleId,
        definition: {
          ...queryDefinition,
          columns: [{ field_id: categoryFieldId, expected_type: "select" }],
        },
      },
    },
    created_at: timestamp,
    updated_at: timestamp,
  };
  const api = await installDashboardApi(
    page,
    dashboard({ widgets: [recordWidget] }),
  );
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  const table = page.getByRole("table", { name: "Live records" });
  await expect(table.getByText("Repair")).toBeVisible();
  api.failNextRecordsWithStatus(401);
  await page.getByRole("button", { name: "Refresh now" }).click();
  await expect(table).toHaveCount(0);
});

test("Dashboard cadence polls only while visible and ignores a hidden in-flight result", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.addInitScript(() => {
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    Object.defineProperty(window, "setTestVisibility", {
      value: (next: DocumentVisibilityState) => {
        visibility = next;
        document.dispatchEvent(new Event("visibilitychange"));
      },
    });
  });
  const api = await installDashboardApi(
    page,
    dashboard({ refresh_cadence: "manual" }),
  );
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  const table = page.getByRole("table", {
    name: "Complete data for Count by Category",
  });
  await expect(table).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh now" })).toBeEnabled();
  const stableClockTime = await page.evaluate(() => Date.now() + 60_000);
  await page.clock.pauseAt(stableClockTime);
  const manualSnapshotCount = api.snapshots.length;
  await page.clock.fastForward(300_000);
  expect(api.snapshots).toHaveLength(manualSnapshotCount);

  await page.getByLabel("Refresh cadence").selectOption("one-minute");
  await page.getByRole("button", { name: "Save Dashboard" }).click();
  await expect(table).toBeVisible();
  await expect(page.getByLabel("Refresh cadence")).toHaveValue("one-minute");
  await expect(page.getByRole("button", { name: "Refresh now" })).toBeEnabled();
  await expect
    .poll(() => api.snapshots.length)
    .toBeGreaterThan(manualSnapshotCount);
  const initialSnapshotCount = api.snapshots.length;
  expect(initialSnapshotCount).toBeGreaterThanOrEqual(1);

  await page.clock.fastForward(59_999);
  expect(api.snapshots).toHaveLength(initialSnapshotCount);
  await page.clock.fastForward(1);
  await expect.poll(() => api.snapshots.length).toBe(initialSnapshotCount + 1);
  await expect(page.getByRole("button", { name: "Refresh now" })).toBeEnabled();
  api.setSnapshotLength(2);
  await page.clock.fastForward(59_999);
  await page.clock.fastForward(1);
  await expect.poll(() => api.snapshots.length).toBe(initialSnapshotCount + 2);
  await expect(table.locator("tbody tr")).toHaveCount(2);

  api.setSnapshotLength(4);
  const pending = api.holdNextSnapshot();
  await page.clock.fastForward(60_000);
  await pending.started;
  await page.evaluate(() => {
    const browserWindow = window as unknown as Window & {
      setTestVisibility: (state: DocumentVisibilityState) => void;
    };
    browserWindow.setTestVisibility("hidden");
  });
  pending.release();
  await page.clock.runFor(0);
  await page.clock.fastForward(120_000);
  expect(api.snapshots).toHaveLength(initialSnapshotCount + 3);

  await page.evaluate(() => {
    const browserWindow = window as unknown as Window & {
      setTestVisibility: (state: DocumentVisibilityState) => void;
    };
    browserWindow.setTestVisibility("visible");
  });
  await expect(
    page.getByRole("dialog", { name: "Session verification" }),
  ).toHaveCount(0);
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await page.clock.fastForward(59_999);
  expect(api.snapshots).toHaveLength(initialSnapshotCount + 3);
  await page.clock.fastForward(1);
  await expect.poll(() => api.snapshots.length).toBe(initialSnapshotCount + 4);
  await expect(table.locator("tbody tr")).toHaveCount(4);

  await page.getByLabel("Refresh cadence").selectOption("five-minutes");
  await page.getByRole("button", { name: "Save Dashboard" }).click();
  await expect(table).toBeVisible();
  await expect(page.getByLabel("Refresh cadence")).toHaveValue("five-minutes");
  await expect(page.getByRole("button", { name: "Refresh now" })).toBeEnabled();
  const fiveMinuteSnapshotCount = api.snapshots.length;
  await page.clock.fastForward(299_999);
  expect(api.snapshots).toHaveLength(fiveMinuteSnapshotCount);
  await page.clock.fastForward(1);
  await expect
    .poll(() => api.snapshots.length)
    .toBe(fiveMinuteSnapshotCount + 1);
});

test("a hidden pending Dashboard refresh cannot block a new visible refresh", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    Object.defineProperty(window, "setTestVisibility", {
      value: (next: DocumentVisibilityState) => {
        visibility = next;
        document.dispatchEvent(new Event("visibilitychange"));
      },
    });
  });
  const api = await installDashboardApi(page, dashboard());
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  const table = page.getByRole("table", {
    name: "Complete data for Count by Category",
  });
  await expect(table.locator("tbody tr")).toHaveCount(25);
  const previousCount = api.snapshots.length;
  const pending = api.holdNextSnapshot();

  try {
    await page.getByRole("button", { name: "Refresh now" }).click();
    await pending.started;
    await page.evaluate(() => {
      const browserWindow = window as unknown as Window & {
        setTestVisibility: (state: DocumentVisibilityState) => void;
      };
      browserWindow.setTestVisibility("hidden");
      browserWindow.setTestVisibility("visible");
    });
    await expect(
      page.getByRole("button", { name: "Refresh now" }),
    ).toBeEnabled();
    api.setSnapshotLength(2);
    await page.getByRole("button", { name: "Refresh now" }).click();
    await expect.poll(() => api.snapshots.length).toBe(previousCount + 2);
    await expect(table.locator("tbody tr")).toHaveCount(2);

    api.setSnapshotLength(4);
    pending.release();
    await expect(table.locator("tbody tr")).toHaveCount(2);
  } finally {
    pending.release();
  }
});

for (const requestPath of ["initial load", "manual refresh"] as const) {
  test(`a stale ${requestPath} denial cannot clear a newer Dashboard snapshot`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      let visibility: DocumentVisibilityState = "visible";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibility,
      });
      Object.defineProperty(window, "setTestVisibility", {
        value: (next: DocumentVisibilityState) => {
          visibility = next;
          document.dispatchEvent(new Event("visibilitychange"));
        },
      });
    });
    const api = await installDashboardApi(page, dashboard());
    let pending =
      requestPath === "initial load" ? api.holdNextSnapshot(403) : null;
    await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
    const table = page.getByRole("table", {
      name: "Complete data for Count by Category",
    });

    if (requestPath === "manual refresh") {
      await expect(table.locator("tbody tr")).toHaveCount(25);
      pending = api.holdNextSnapshot(403);
      await page.getByRole("button", { name: "Refresh now" }).click();
    }
    if (!pending) throw new Error("A stale request gate was not installed.");

    try {
      await pending.started;
      await page.evaluate(() => {
        const browserWindow = window as unknown as Window & {
          setTestVisibility: (state: DocumentVisibilityState) => void;
        };
        browserWindow.setTestVisibility("hidden");
        browserWindow.setTestVisibility("visible");
      });
      await expect(
        page.getByRole("button", { name: "Refresh now" }),
      ).toBeEnabled();
      api.setSnapshotLength(2);
      await page.getByRole("button", { name: "Refresh now" }).click();
      await expect(table.locator("tbody tr")).toHaveCount(2);

      const deniedResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            "/api/records/aggregate-snapshot" && response.status() === 403,
      );
      pending.release();
      await deniedResponse;
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      await expect(table.locator("tbody tr")).toHaveCount(2);
      await expect(
        page.getByText("The current session cannot read this data."),
      ).toHaveCount(0);
    } finally {
      pending.release();
    }
  });
}

test("duplicating a Dashboard creates an independent copy and keeps the source default", async ({
  page,
}) => {
  const source = dashboard({ refresh_cadence: "five-minutes" });
  const api = await installDashboardApi(page, source);
  api.setDashboardDefault(dashboardId);
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();

  await page.getByRole("button", { name: "Duplicate Dashboard" }).click();
  await expect(
    page.getByRole("heading", { name: "Copy of Operations" }),
  ).toBeVisible();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("dashboard"))
    .not.toBe(dashboardId);
  const duplicateId = new URL(page.url()).searchParams.get("dashboard");
  expect(duplicateId).toBeTruthy();
  expect(duplicateId).not.toBe(dashboardId);
  expect(api.writes).toHaveLength(1);
  expect(api.writes[0]).toMatchObject({
    method: "POST",
    dashboardId: null,
    body: {
      name: "Copy of Operations",
      refresh_cadence: "five-minutes",
      widgets: [{ widget_type: "chart" }],
    },
  });
  expect(api.dashboardDefaultId).toBe(dashboardId);
  await expect(page.getByText("Default", { exact: true })).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Copy of Operations" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /Operations/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  expect(api.dashboardDefaultId).toBe(dashboardId);
});
