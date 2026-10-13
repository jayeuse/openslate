import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";
import {
  isEventStream,
  signedInAs,
  type SignedInIdentity,
} from "./helpers/test";
import { gate as requestGate, type Gate as RequestGate } from "./helpers/gate";
import { pageOf, wirePagination } from "../helpers/pagination";

const userId = "00000000-0000-4000-8000-000000000101";
// The data sources and Dashboards of these tests belong to one department.
const departmentId = userId;
const moduleId = "00000000-0000-4000-8000-000000000102";
const categoryFieldId = "00000000-0000-4000-8000-000000000103";
const regionFieldId = "00000000-0000-4000-8000-000000000104";
const northChoiceId = "00000000-0000-4000-8000-000000000121";
const southChoiceId = "00000000-0000-4000-8000-000000000122";
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
const timestamp = "2026-09-23T00:00:00Z";
const thirdWidgetId = "00000000-0000-4000-8000-000000000119";
const fourthWidgetId = "00000000-0000-4000-8000-000000000120";
const alternateModuleId = "00000000-0000-4000-8000-000000000684";

function categoryChoice(index: number) {
  return {
    id: `00000000-0000-4000-8000-${String(index + 130).padStart(12, "0")}`,
    label:
      index === 0
        ? "Repair"
        : index === 1
          ? "Inspection"
          : `Record ${index + 1}`,
  };
}

const categoryChoices = Array.from({ length: 30 }, (_, index) =>
  categoryChoice(index),
);

type FieldReference = { field_id: string; expected_type: string };
type Aggregation = "count" | "sum" | "average" | "min" | "max" | "distinct";
type QueryDefinition = {
  version: 1;
  logic: "and";
  columns: FieldReference[];
  filters: (FieldReference & {
    operator: string;
    value?: string | number | boolean | (string | number | boolean)[];
  })[];
  sort: (FieldReference & { direction: "asc" | "desc" })[];
  deleted: "exclude" | "include" | "only";
  search: string | null;
  search_fields: FieldReference[];
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
  bucket?: "day" | "week" | "month" | "quarter" | "year";
};
type ChartConfig = {
  version: 1;
  chart_type: "bar" | "line" | "pie";
  query: GroupQuery | DateSeriesQuery;
};
type InlineWidgetInput =
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
type WidgetInput =
  | (InlineWidgetInput & { size?: "S" | "M" | "L"; chart_id?: null })
  | {
      widget_type: "summary" | "workload" | "records" | "chart";
      size: "S" | "M" | "L";
      chart_id: string;
      config: null;
    };
type WidgetWire = WidgetInput & {
  id: string;
  position: number;
  created_at: string;
  updated_at: string;
};
type DashboardWire = {
  id: string;
  department_id: string;
  position: number;
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
  department_id?: string;
  position?: number;
  name?: string;
  refresh_cadence?: "manual" | "one-minute" | "five-minutes";
  widgets?: WidgetInput[];
};
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

/** Existing singleton fixtures support both preview and cohort transport. */
function snapshotRequest(route: Route): AggregateRequest {
  const body = route.request().postDataJSON() as
    AggregateRequest | { queries: AggregateRequest[] };
  return "queries" in body ? body.queries[0] : body;
}
function fulfillSnapshot(route: Route, response: { json: unknown }) {
  return route.fulfill({
    json: new URL(route.request().url()).pathname.endsWith("snapshots")
      ? { items: [response.json] }
      : response.json,
  });
}

function savedWidget(id: string, position: number, fieldId: string) {
  const expectedType = "select";
  return {
    id,
    position,
    widget_type: "chart" as const,
    size: "M" as const,
    chart_id: null,
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
    size: "M" as const,
    chart_id: null,
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
  const value: DashboardWire = {
    id: dashboardId,
    department_id: departmentId,
    position: 0,
    name: "Operations",
    refresh_cadence: "manual",
    revision: 1,
    is_deleted: false,
    created_at: timestamp,
    updated_at: timestamp,
    widgets,
    ...overrides,
  };
  return {
    ...value,
    widgets: value.widgets.map((widget) =>
      widget.chart_id != null
        ? {
            ...widget,
            size: widget.size ?? "M",
            chart_id: widget.chart_id,
            config: null,
          }
        : { ...widget, size: widget.size ?? "M", chart_id: null },
    ),
  };
}

function persistedWidgets(widgets: WidgetInput[]): WidgetWire[] {
  return widgets.map((widget, index) => {
    const metadata = {
      id: `00000000-0000-4000-8000-${String(index + 201).padStart(12, "0")}`,
      position: index,
      created_at: timestamp,
      updated_at: timestamp,
      size: widget.size ?? "M",
    };
    if (widget.chart_id != null)
      return {
        ...metadata,
        widget_type: widget.widget_type,
        chart_id: widget.chart_id,
        config: null,
      };
    return { ...widget, ...metadata, chart_id: null };
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
    config: { options: categoryChoices },
  };
}

function snapshot(length = 30) {
  const items = Array.from({ length }, (_, index) => ({
    key: `group-${index + 1}`,
    label: `Group ${index + 1}`,
    value: index + 1,
    record_count: index + 1,
  }));
  return pageOf(items, { limit: items.length });
}

function dateSnapshot(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const length = Math.floor((end - start) / 86_400_000) + 1;
  const items = Array.from({ length }, (_, index) => {
    const day = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
    return { key: day, label: day, value: index + 1, record_count: index + 1 };
  });
  return pageOf(items, { limit: items.length });
}

async function installDashboardApi(
  page: Page,
  initial: DashboardWire | null = null,
  identity: Omit<SignedInIdentity, "id"> = { role: "admin", access: [] },
) {
  await installOpenViewEventSource(page);
  await page.route("**/api/**", (route) =>
    isEventStream(route)
      ? route.fallback()
      : route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Not available in this route test" }),
        }),
  );
  await page.route("**/api/workspace", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: {
            id: "00000000-0000-4000-8000-000000000102",
            display_name: "OpenSlate",
            legal_name: null,
            description: null,
            contact_email: null,
            contact_phone: null,
            postal_address: null,
            logo_file_id: null,
            locale: "en-PH",
            timezone: "Asia/Manila",
            mark: "OS",
            currency: "PHP",
            week_start: "monday",
            business_hours: "09:00–18:00",
            theme: "slate",
            revision: 1,
            today: "2026-10-07",
            purge_enabled: false,
          },
        })
      : route.fallback(),
  );
  let current = initial;
  let alternate: DashboardWire | null = null;
  let forceConflict = false;
  let snapshotGate: RequestGate | null = null;
  let snapshotGateStatus: 403 | null = null;
  let snapshotLength = 30;
  let dashboardGetGate: RequestGate | null = null;
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
  const fieldReads: Array<{ moduleId: string; offset: number }> = [];
  const writes: Array<{
    method: string;
    body: DashboardMutation | null;
    dashboardId: string | null;
  }> = [];
  const snapshots: AggregateRequest[] = [];
  const batches: { queries: AggregateRequest[] }[] = [];
  const singleSnapshots: AggregateRequest[] = [];
  const recordQueries: RecordQueryRequest[] = [];
  let nextSnapshotErrorStatus: 401 | 403 | 503 | null = null;
  let snapshotErrorResponsesRemaining = 0;
  let nextRecordQueryErrorStatus: 401 | 403 | null = null;
  let recordQueryErrorResponsesRemaining = 0;
  let recordResultCount = 2;
  let recordFieldId = categoryFieldId;

  await signedInAs(page, { id: userId, ...identity });
  await page.route("**/api/auth/refresh", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          json: { authenticated: true, setup_required: false },
        })
      : route.fallback(),
  );
  await page.route("**/api/departments**", async (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: departmentId,
            department_name: "Field service",
            created_at: timestamp,
            updated_at: timestamp,
            deleted_at: null,
            is_deleted: false,
            performed_by: null,
          },
        ],
        pagination: wirePagination({ limit: 100, count: 1, total: 1 }),
      }),
    }),
  );
  await page.route("**/api/views/data-sources**", async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/views/data-sources") {
      const items = [
        {
          id: moduleId,
          name: "Equipment",
          department_id: departmentId,
          title_field_id: null,
        },
        ...(fieldPages[secondModuleId]
          ? [
              {
                id: secondModuleId,
                name: "Quality checks",
                department_id: departmentId,
                title_field_id: null,
              },
            ]
          : []),
      ];
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(pageOf(items, { limit: 100 })),
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
              config: { options: categoryChoices },
            },
            {
              id: regionFieldId,
              module_id: moduleId,
              name: "Region",
              type: "select",
              required: false,
              position: 1,
              config: {
                options: [
                  { id: northChoiceId, label: "North" },
                  { id: southChoiceId, label: "South" },
                ],
              },
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
          pagination: wirePagination({ limit: 100, count: 7, total: 7 }),
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
            pagination: wirePagination({
              limit: 25,
              offset,
              count: 1,
              total: offset + 1,
            }),
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
        department_id: body.department_id ?? departmentId,
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
    "**/api/records/aggregate-snapshot*",
    async (route: Route) => {
      const batch = new URL(route.request().url()).pathname.endsWith(
        "snapshots",
      );
      const body = route.request().postDataJSON() as
        AggregateRequest | { queries: AggregateRequest[] };
      const requests = "queries" in body ? body.queries : [body];
      if (batch) batches.push({ queries: requests });
      else singleSnapshots.push(requests[0]);
      snapshots.push(...requests);
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
      const results = requests.map((request) =>
        request.mode === "date_series"
          ? dateSnapshot(request.from_date, request.to_date)
          : snapshot(snapshotLength),
      );
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(batch ? { items: results } : results[0]),
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
    const allItems = Array.from({ length: recordResultCount }, (_, index) => {
      const option = categoryChoice(index % categoryChoices.length);
      return {
        id: `00000000-0000-4000-8000-${String(index + 201).padStart(12, "0")}`,
        module_id: moduleId,
        data: { [recordFieldId]: option.id },
        display_values: { [recordFieldId]: option.label },
        created_at: timestamp,
        updated_at: timestamp,
        deleted_at: null,
        is_deleted: false,
        performed_by: userId,
      };
    });
    const items = allItems.slice(
      request.offset,
      request.offset + request.limit,
    );
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        pageOf(items, {
          limit: request.limit,
          offset: request.offset,
          total: allItems.length,
        }),
      ),
    });
  });

  return {
    writes,
    snapshots,
    batches,
    singleSnapshots,
    recordQueries,
    dashboardReads,
    fieldReads,
    changeDashboard(value: DashboardWire) {
      current = value;
    },
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
    setRecordResultCount(count: number) {
      recordResultCount = count;
    },
    setDashboardListHasMore(hasMore: boolean) {
      dashboardListHasMore = hasMore;
    },
    setAlternateDashboard(value: DashboardWire) {
      alternate = value;
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
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(
            document.activeElement?.hasAttribute("data-base-ui-focus-guard"),
          ),
        ),
      )
      .toBe(false);
    if (await target.evaluate((element) => element === document.activeElement))
      return;
  }
  throw new Error(`Could not reach ${await target.toString()} with ${key}.`);
}

async function expectVisibleKeyboardFocus(target: Locator) {
  await expect(target).toBeFocused();
  await expect
    .poll(() =>
      target.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          focused: element === document.activeElement,
          keyboardFocus: element.matches(":focus-visible"),
          outlineHasWidth: Number.parseFloat(style.outlineWidth) > 0,
          outlineIsDrawn: style.outlineStyle !== "none",
          outlineHasColor: style.outlineColor !== "rgba(0, 0, 0, 0)",
        };
      }),
    )
    .toEqual({
      focused: true,
      keyboardFocus: true,
      outlineHasWidth: true,
      outlineIsDrawn: true,
      outlineHasColor: true,
    });
}

async function expectDashboardMainToFit(page: Page) {
  // ResizeObserver updates chart widths after the browser has resized the grid.
  // Wait for the same no-overflow contract, not an arbitrary rendering delay.
  await expect
    .poll(
      () =>
        page
          .getByRole("main")
          .evaluate((main) => main.scrollWidth - main.clientWidth),
      {
        message:
          "Dashboard controls and content should not overflow horizontally at mobile width",
      },
    )
    .toBeLessThanOrEqual(0);
}

async function openNewDashboardDialog(page: Page): Promise<Locator> {
  const dialog = page.getByRole("dialog", { name: "New Dashboard" });
  await page.getByRole("button", { name: "New Dashboard" }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openDashboardSettingsDialog(
  page: Page,
  advanceAnimationFrame = false,
): Promise<Locator> {
  const dialog = page.getByRole("dialog", { name: "Dashboard settings" });
  await page.getByRole("button", { name: "Dashboard options" }).click();
  if (advanceAnimationFrame) await page.clock.fastForward(16);
  await page.getByRole("menuitem", { name: "Dashboard settings" }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openAddWidgetDialog(page: Page): Promise<Locator> {
  const dialog = page.getByRole("dialog", { name: "Add widget" });
  await page.getByRole("button", { name: "Add widget", exact: true }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}

async function finishDashboardDialog(dialog: Locator, pageClock?: Page) {
  await dialog.getByRole("button", { name: /^(Done|Continue)$/ }).click();
  if (pageClock) await pageClock.clock.fastForward(200);
  await expect(dialog).toBeHidden();
}

async function startNewDashboardDraft(page: Page, name: string) {
  const dialog = await openNewDashboardDialog(page);
  await dialog.getByLabel("Dashboard name").fill(name);
  await finishDashboardDialog(dialog);
}

async function addWidgetFromDialog(dialog: Locator) {
  await dialog.getByRole("button", { name: "Add widget", exact: true }).click();
  await expect(dialog).toBeHidden();
}

// TanStack schedules observer notifications; a paused browser clock must
// advance pending notifications without moving an already settled boundary.
async function settleDashboardClock<T>(
  page: Page,
  read: () => Promise<T>,
  expected: T,
) {
  await expect
    .poll(async () => {
      const current = await read();
      if (current === expected) return current;
      await page.clock.runFor(1);
      return read();
    })
    .toBe(expected);
}

async function selectDashboard(page: Page, id: string) {
  await page.getByLabel("Dashboard", { exact: true }).selectOption(id);
}

function gridWidgets(): WidgetWire[] {
  const query = savedWidget(dashboardWidgetId, 0, categoryFieldId).config.query;
  return [
    { ...savedWidget(dashboardWidgetId, 0, categoryFieldId), size: "S" },
    {
      ...savedWidget(secondDashboardWidgetId, 1, regionFieldId),
      widget_type: "workload",
      size: "M",
      config: {
        version: 1,
        query: {
          ...query,
          dimension: { field_id: regionFieldId, expected_type: "select" },
          aggregation: "average",
          measure: { field_id: amountFieldId, expected_type: "decimal" },
        },
      },
    },
    {
      ...savedWidget(thirdWidgetId, 2, categoryFieldId),
      widget_type: "summary",
      size: "S",
      config: { version: 1, query },
    },
    {
      ...savedWidget(fourthWidgetId, 3, categoryFieldId),
      widget_type: "records",
      size: "L",
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
    },
  ];
}

async function editGridWidget(page: Page, title: string) {
  await page
    .getByRole("button", { name: `Widget options: ${title}`, exact: true })
    .click();
  // Target this widget's menu: an earlier widget's menu can still be closing.
  await page
    .getByRole("menu", { name: `Widget options: ${title}`, exact: true })
    .getByRole("menuitem", { name: "Edit widget", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Edit widget", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("renders every widget in one correlated aggregate batch and independent records read", async ({
  page,
}) => {
  const api = await installDashboardApi(
    page,
    dashboard({ widgets: gridWidgets() }),
  );
  await page.route("**/api/records/aggregate-snapshots", async (route) => {
    const body = route.request().postDataJSON() as {
      queries: AggregateRequest[];
    };
    api.batches.push(body);
    await route.fulfill({
      json: {
        items: [
          {
            items: [
              {
                key: "chart",
                label: "Chart cohort",
                value: 7,
                record_count: 7,
              },
            ],
            pagination: wirePagination({ limit: 1, count: 1, total: 1 }),
          },
          {
            items: [
              {
                key: "north",
                label: "Measured cohort",
                value: "123456789012.1234",
                record_count: 128,
              },
              {
                key: "south",
                label: "No measure",
                value: null,
                record_count: 17,
              },
            ],
            pagination: wirePagination({ limit: 2, count: 2, total: 2 }),
          },
          {
            items: [
              {
                key: "summary",
                label: "Summary cohort",
                value: 41,
                record_count: 41,
              },
            ],
            pagination: wirePagination({ limit: 1, count: 1, total: 1 }),
          },
        ],
      },
    });
  });
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  await expect(page.getByRole("article")).toHaveCount(4);
  await expect(
    page
      .getByRole("article", { name: /Count by Category/ })
      .getByRole("cell", { name: "Chart cohort", exact: true }),
  ).toBeVisible();
  const workload = page.getByRole("article", { name: /Workload by Region/ });
  await expect(
    workload.getByRole("cell", { name: "123456789012.1234", exact: true }),
  ).toBeVisible();
  await expect(
    workload.getByRole("cell", { name: "—", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Total records: 41", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("table", { name: "Live records", exact: true })
      .getByRole("cell", { name: "Repair", exact: true }),
  ).toBeVisible();
  expect(api.batches).toEqual([
    {
      queries: [
        {
          mode: "groups",
          module_id: moduleId,
          definition: queryDefinition,
          aggregation: "count",
          dimension: { field_id: categoryFieldId, expected_type: "select" },
        },
        {
          mode: "groups",
          module_id: moduleId,
          definition: queryDefinition,
          aggregation: "average",
          measure: { field_id: amountFieldId, expected_type: "decimal" },
          dimension: { field_id: regionFieldId, expected_type: "select" },
        },
        {
          mode: "groups",
          module_id: moduleId,
          definition: queryDefinition,
          aggregation: "count",
          dimension: { field_id: categoryFieldId, expected_type: "select" },
        },
      ],
    },
  ]);
  expect(api.singleSnapshots).toEqual([]);
  expect(api.recordQueries).toEqual([
    {
      module_id: moduleId,
      definition: {
        ...queryDefinition,
        columns: [{ field_id: categoryFieldId, expected_type: "select" }],
      },
      limit: 25,
      offset: 0,
    },
  ]);
  expect(api.writes).toEqual([]);
});

test("size and stored-order changes retain tile paging and save only with the Dashboard revision", async ({
  page,
}) => {
  const api = await installDashboardApi(
    page,
    dashboard({ widgets: gridWidgets() }),
  );
  api.setRecordResultCount(30);
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  const records = page.getByRole("article", {
    name: /Records showing Category/,
  });
  await expect(
    records.getByRole("table", { name: "Live records" }),
  ).toBeVisible();
  await records
    .getByRole("button", { name: "Go to next page", exact: true })
    .click();
  await expect(
    records.getByRole("cell", { name: "Record 26", exact: true }),
  ).toBeVisible();
  const before = api.batches.length;
  await page
    .getByRole("button", { name: "Widget options: Records showing Category" })
    .click();
  await page
    .getByRole("menuitem", { name: "Move earlier", exact: true })
    .click();
  await expect(
    records.getByRole("cell", { name: "Record 26", exact: true }),
  ).toBeVisible();
  const dialog = await editGridWidget(page, "Count by Category");
  await expect(dialog.getByLabel("Group by", { exact: true })).toHaveValue(
    categoryFieldId,
  );
  await dialog.getByLabel("Widget size", { exact: true }).selectOption("L");
  await dialog
    .getByRole("button", { name: "Apply widget changes", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(api.writes).toEqual([]);
  expect(api.batches).toHaveLength(before);
  await page
    .getByRole("button", { name: "Save Dashboard", exact: true })
    .click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  expect(api.writes.at(-1)?.body).toMatchObject({
    revision: 1,
    widgets: [
      { widget_type: "chart", size: "L" },
      { widget_type: "workload", size: "M" },
      { widget_type: "records", size: "L" },
      { widget_type: "summary", size: "S" },
    ],
  });
  await page.reload();
  await expect(page.getByRole("article")).toHaveCount(4);
  await expect(page.getByRole("article").nth(2)).toContainText(
    "Records showing Category",
  );
});

for (const kind of ["chart", "summary", "workload", "records"] as const) {
  test(`editing ${kind} initializes the complete current definition and retains it through a conflict`, async ({
    page,
  }) => {
    const definition: QueryDefinition = {
      ...queryDefinition,
      columns: [
        { field_id: categoryFieldId, expected_type: "select" },
        { field_id: amountFieldId, expected_type: "decimal" },
      ],
      filters: [
        {
          field_id: amountFieldId,
          expected_type: "decimal",
          operator: "gte",
          value: "12.5000",
        },
      ],
      sort: [
        {
          field_id: amountFieldId,
          expected_type: "decimal",
          direction: "desc",
        },
      ],
      deleted: "include",
      search: "Repair",
      search_fields: [{ field_id: categoryFieldId, expected_type: "select" }],
    };
    const base = savedWidget(dashboardWidgetId, 0, categoryFieldId);
    const widget: WidgetWire =
      kind === "records"
        ? {
            ...base,
            widget_type: kind,
            config: { version: 1, query: { module_id: moduleId, definition } },
          }
        : kind === "chart"
          ? {
              ...base,
              config: {
                ...base.config,
                chart_type: "pie",
                query: {
                  ...base.config.query,
                  definition,
                  aggregation: "min",
                  measure: {
                    field_id: amountFieldId,
                    expected_type: "decimal",
                  },
                },
              },
            }
          : {
              ...base,
              widget_type: kind,
              config: {
                version: 1,
                query: {
                  ...base.config.query,
                  definition,
                  aggregation: "max",
                  measure: {
                    field_id: amountFieldId,
                    expected_type: "decimal",
                  },
                },
              },
            };
    const api = await installDashboardApi(
      page,
      dashboard({ widgets: [widget] }),
    );
    await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
    await expect(page.getByRole("article")).toHaveCount(1);
    await page.getByRole("button", { name: /Widget options:/ }).click();
    await page
      .getByRole("menuitem", { name: "Edit widget", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Edit widget",
      exact: true,
    });
    await expect(dialog.getByLabel("Widget type", { exact: true })).toHaveValue(
      kind,
    );
    await dialog
      .getByRole("button", { name: "Filters (1)", exact: true })
      .click();
    await expect(page.getByLabel("Filter 1 value")).toHaveValue("12.5000");
    await page.keyboard.press("Escape");
    if (kind === "records") {
      await dialog
        .getByRole("button", { name: "Records options", exact: true })
        .click();
      await expect(
        page.getByLabel("Record search", { exact: true }),
      ).toHaveValue("Repair");
      await expect(
        page.getByLabel("Record lifecycle", { exact: true }),
      ).toHaveValue("include");
      await page.keyboard.press("Escape");
    }
    await dialog.getByLabel("Widget size", { exact: true }).selectOption("S");
    await dialog
      .getByRole("button", { name: "Apply widget changes", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    api.setConflict();
    await page
      .getByRole("button", { name: "Save Dashboard", exact: true })
      .click();
    await expect(
      page.getByText("This item changed. Refresh it and try again.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(api.writes.at(-1)?.body?.widgets).toEqual([
      { widget_type: kind, size: "S", chart_id: null, config: widget.config },
    ]);
    expect(api.writes).toHaveLength(1);
    const retained = await editGridWidget(
      page,
      kind === "records"
        ? "Records showing Category"
        : kind === "workload"
          ? "Workload by Category"
          : kind === "summary"
            ? "Maximum by Category"
            : "Minimum of Amount by Category",
    );
    await retained
      .getByRole("button", { name: "Filters (1)", exact: true })
      .click();
    await expect(page.getByLabel("Filter 1 value")).toHaveValue("12.5000");
    await page.keyboard.press("Escape");
    await expect(
      retained.getByLabel("Widget size", { exact: true }),
    ).toHaveValue("S");
  });
}

test("malformed batch clears the protected cohort and retries without single-RPC fallback", async ({
  page,
}) => {
  const api = await installDashboardApi(
    page,
    dashboard({ widgets: gridWidgets().slice(0, 2) }),
  );
  let malformed = false;
  await page.route("**/api/records/aggregate-snapshots", (route) =>
    malformed
      ? route.fulfill({ json: { items: [snapshot(1)] } })
      : route.fallback(),
  );
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  await expect(page.getByRole("article")).toHaveCount(2);
  await expect(page.getByRole("table")).toHaveCount(2);
  malformed = true;
  await page.getByRole("button", { name: "Refresh now", exact: true }).click();
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Retry widgets", exact: true }),
  ).toBeVisible();
  expect(api.singleSnapshots).toEqual([]);
  malformed = false;
  await page
    .getByRole("button", { name: "Retry widgets", exact: true })
    .click();
  await expect(page.getByRole("table")).toHaveCount(2);
  expect(api.writes).toEqual([]);
});

test("edited source fences a held cohort result while other saved tiles remain refreshable", async ({
  page,
}) => {
  const api = await installDashboardApi(
    page,
    dashboard({ widgets: gridWidgets().slice(0, 2) }),
  );
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  await expect(page.getByRole("table")).toHaveCount(2);
  const held = api.holdNextSnapshot();
  await page.getByRole("button", { name: "Refresh now", exact: true }).click();
  await held.started;
  const dialog = await editGridWidget(page, "Count by Category");
  await dialog
    .getByLabel("Group by", { exact: true })
    .selectOption(regionFieldId);
  await dialog
    .getByRole("button", { name: "Apply widget changes", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  held.release();
  await expect(
    page.getByRole("article", { name: /Count by Region/ }),
  ).toContainText("Save this Dashboard to load live data");
  await expect(
    page.getByRole("article", { name: /Count by Region/ }).getByRole("table"),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("article", { name: /Workload by Region/ })
      .getByRole("table"),
  ).toBeVisible();
  expect(api.writes).toEqual([]);
});

test("grid uses thirds halves full rows and full-width phone tiles with keyboard edit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installDashboardApi(
    page,
    dashboard({ widgets: gridWidgets() }),
  );
  api.setSnapshotLength(3);
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  await expect(page.getByRole("article")).toHaveCount(4);
  await expect(page.getByRole("table", { name: "Live records" })).toBeVisible();
  const widths = async () =>
    page
      .getByRole("article")
      .evaluateAll((tiles) =>
        tiles.map((tile) => tile.getBoundingClientRect().width),
      );
  const desktop = await widths();
  expect(desktop[0] / desktop[3]).toBeCloseTo(1 / 3, 1);
  expect(desktop[1] / desktop[3]).toBeCloseTo(1 / 2, 1);
  for (const width of [767, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const mobile = await widths();
    expect(Math.max(...mobile) - Math.min(...mobile)).toBeLessThan(1);
    await expectDashboardMainToFit(page);
  }
  const options = page.getByRole("button", {
    name: "Widget options: Count by Category",
    exact: true,
  });
  await tabTo(page, options);
  await expectVisibleKeyboardFocus(options);
  await page.keyboard.press("Enter");
  await page
    .getByRole("menuitem", { name: "Edit widget", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Edit widget", exact: true });
  await expect(dialog.getByLabel("Group by", { exact: true })).toHaveValue(
    categoryFieldId,
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("edit resolves the current source and referenced fields beyond their first catalog pages", async ({
  page,
}) => {
  const widget = savedWidget(dashboardWidgetId, 0, delayedFieldId);
  widget.config.query.module_id = alternateModuleId;
  const api = await installDashboardApi(page, dashboard({ widgets: [widget] }));
  api.setFieldPages({
    [alternateModuleId]: {
      firstPage: [
        dataSourceField(categoryFieldId, alternateModuleId, "Category", 0),
      ],
      hasMore: true,
      nextPage: [
        dataSourceField(delayedFieldId, alternateModuleId, "Service area", 1),
      ],
      nextPageHasMore: false,
    },
  });
  const detailReads: string[] = [];
  await page.route(`**/api/fields/${delayedFieldId}`, (route) => {
    detailReads.push(route.request().url());
    return route.fulfill({
      json: {
        ...dataSourceField(
          delayedFieldId,
          alternateModuleId,
          "Service area",
          1,
        ),
        is_deleted: false,
      },
    });
  });
  await page.route(`**/api/modules/${alternateModuleId}`, (route) =>
    route.fulfill({
      json: {
        id: alternateModuleId,
        department_id: departmentId,
        module_name: "Off-page equipment",
        title_field_id: null,
        is_deleted: false,
      },
    }),
  );
  await page.route("**/api/views/data-sources?**", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: moduleId,
            name: "Equipment",
            department_id: departmentId,
            title_field_id: null,
          },
        ],
        pagination: wirePagination({
          limit: 100,
          count: 1,
          total: 101,
          has_more: true,
        }),
      },
    }),
  );
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  await expect(
    page.getByRole("article", { name: "Count by Service area", exact: true }),
  ).toBeVisible();
  const before = detailReads.length;
  const dialog = await editGridWidget(page, "Count by Service area");
  await expect(dialog.getByLabel("Data source", { exact: true })).toHaveValue(
    alternateModuleId,
  );
  await expect(dialog.getByLabel("Data source", { exact: true })).toContainText(
    "Off-page equipment",
  );
  await expect(dialog.getByLabel("Group by", { exact: true })).toContainText(
    "Service area",
  );
  await expect(
    dialog.getByRole("button", { name: "Apply widget changes", exact: true }),
  ).toBeEnabled();
  expect(detailReads.length).toBeGreaterThan(before);
  expect(api.writes).toEqual([]);
});

test("Add from saved chart and reference edit keep XOR while current definitions drive all tiles", async ({
  page,
}) => {
  const chartId = "00000000-0000-4000-8000-000000000681";
  const api = await installDashboardApi(
    page,
    dashboard({ widgets: [{ ...gridWidgets()[1], position: 0 }] }),
  );
  let revision = 1;
  let reads = 0;
  const writes: string[] = [];
  const source = () => ({
    id: chartId,
    department_id: departmentId,
    module_id: moduleId,
    name: "Current shared Chart",
    chart_type: "bar",
    query: {
      ...savedWidget(dashboardWidgetId, 0, categoryFieldId).config.query,
      dimension: {
        field_id: revision === 1 ? categoryFieldId : regionFieldId,
        expected_type: "select",
      },
    },
    revision,
    is_deleted: false,
    created_at: timestamp,
    updated_at: timestamp,
  });
  await page.route("**/api/charts**", (route) => {
    if (route.request().method() !== "GET") {
      writes.push(route.request().method());
      return route.fulfill({ status: 405 });
    }
    if (new URL(route.request().url()).pathname === `/api/charts/${chartId}`) {
      reads += 1;
      return route.fulfill({ json: source() });
    }
    return route.fulfill({
      json: {
        items: [source()],
        pagination: wirePagination({ limit: 25, count: 1, total: 1 }),
      },
    });
  });
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  await expect(page.getByRole("table")).toBeVisible();
  await page
    .getByRole("button", { name: "Add from saved chart", exact: true })
    .click();
  const add = page.getByRole("dialog", { name: "Add widget", exact: true });
  await expect(add.getByLabel("Chart source", { exact: true })).toHaveValue(
    "saved",
  );
  await add.getByRole("combobox", { name: "Saved Chart", exact: true }).click();
  await page
    .getByRole("option", { name: "Current shared Chart", exact: true })
    .click();
  await add.getByLabel("Widget size", { exact: true }).selectOption("L");
  await addWidgetFromDialog(add);
  expect(api.writes).toEqual([]);
  await page
    .getByRole("button", { name: "Save Dashboard", exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "Current shared Chart", exact: true }),
  ).toBeVisible();
  const priorReads = reads;
  revision = 2;
  const edit = await editGridWidget(page, "Current shared Chart");
  await expect(
    edit.getByRole("button", { name: "Apply widget changes", exact: true }),
  ).toBeEnabled();
  expect(reads).toBeGreaterThan(priorReads);
  await edit.getByLabel("Widget size", { exact: true }).selectOption("S");
  await edit
    .getByRole("button", { name: "Apply widget changes", exact: true })
    .click();
  await expect(edit).toBeHidden();
  await sendOpenViewEvent(page, "invalidate", {
    entity: "charts",
    module_id: moduleId,
  });
  await expect
    .poll(() => api.batches.at(-1)?.queries.at(-1))
    .toMatchObject({ dimension: { field_id: regionFieldId } });
  await page
    .getByRole("button", { name: "Save Dashboard", exact: true })
    .click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  expect(api.writes.at(-1)?.body?.widgets?.[1]).toEqual({
    widget_type: "chart",
    chart_id: chartId,
    config: null,
    size: "S",
  });
  expect(writes).toEqual([]);
});

test("one refused saved Chart clears its entire aggregate cohort until explicit current-authority retry", async ({
  page,
}) => {
  const chartId = "00000000-0000-4000-8000-000000000682";
  const api = await installDashboardApi(
    page,
    dashboard({
      widgets: [
        savedWidget(dashboardWidgetId, 0, categoryFieldId),
        {
          ...savedWidget(secondDashboardWidgetId, 1, regionFieldId),
          chart_id: chartId,
          config: null,
        },
      ],
    }),
  );
  let denied = false;
  let reads = 0;
  await page.route(`**/api/charts/${chartId}`, (route) => {
    reads += 1;
    return denied
      ? route.fulfill({
          status: 403,
          json: { detail: "Saved Chart is unavailable" },
        })
      : route.fulfill({
          json: {
            id: chartId,
            department_id: departmentId,
            module_id: moduleId,
            name: "Protected source name",
            chart_type: "bar",
            query: savedWidget(dashboardWidgetId, 0, regionFieldId).config
              .query,
            revision: reads,
            is_deleted: false,
            created_at: timestamp,
            updated_at: timestamp,
          },
        });
  });
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  await expect(page.getByRole("table")).toHaveCount(2);
  const batches = api.batches.length;
  denied = true;
  await page.getByRole("button", { name: "Refresh now", exact: true }).click();
  await expect(
    page.getByText("You do not have access to this data.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Protected source name", exact: true }),
  ).toHaveCount(0);
  expect(api.batches).toHaveLength(batches);
  const afterRefusal = reads;
  denied = false;
  await sendOpenViewEvent(page, "invalidate", {
    entity: "charts",
    module_id: moduleId,
  });
  await page.getByRole("button", { name: "Refresh now", exact: true }).click();
  expect(reads).toBe(afterRefusal);
  await page
    .getByRole("button", { name: "Retry widgets", exact: true })
    .click();
  await expect(page.getByRole("table")).toHaveCount(2);
  expect(reads).toBeGreaterThan(afterRefusal);
  expect(api.batches).toHaveLength(batches + 1);
  expect(api.singleSnapshots).toEqual([]);
  expect(api.writes).toEqual([]);
});

test("a held editor source blocks changes and cancellation fences it from the next tile", async ({
  page,
}) => {
  const chartId = "00000000-0000-4000-8000-000000000683";
  await installDashboardApi(
    page,
    dashboard({
      widgets: [
        savedWidget(dashboardWidgetId, 0, categoryFieldId),
        {
          ...savedWidget(secondDashboardWidgetId, 1, regionFieldId),
          chart_id: chartId,
          config: null,
        },
      ],
    }),
  );
  let hold = false;
  const gate = requestGate();
  const source = {
    id: chartId,
    department_id: departmentId,
    module_id: moduleId,
    name: "Held shared Chart",
    chart_type: "bar",
    query: savedWidget(dashboardWidgetId, 0, regionFieldId).config.query,
    revision: 1,
    is_deleted: false,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await page.route("**/api/charts?**", (route) =>
    route.fulfill({
      json: {
        items: [source],
        pagination: wirePagination({ limit: 25, count: 1, total: 1 }),
      },
    }),
  );
  await page.route(`**/api/charts/${chartId}`, async (route) => {
    if (hold) {
      gate.signalStarted();
      await gate.wait;
    }
    await route.fulfill({ json: source });
  });
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  await expect(page.getByRole("table")).toHaveCount(2);
  hold = true;
  const edit = await editGridWidget(page, "Held shared Chart");
  await gate.started;
  await expect(edit.getByLabel("Widget type", { exact: true })).toBeDisabled();
  await expect(edit.getByLabel("Widget size", { exact: true })).toBeDisabled();
  await expect(
    edit.getByRole("button", { name: "Apply widget changes", exact: true }),
  ).toBeDisabled();
  await edit.getByRole("button", { name: "Cancel", exact: true }).click();
  const next = await editGridWidget(page, "Count by Category");
  await expect(next.getByLabel("Group by", { exact: true })).toHaveValue(
    categoryFieldId,
  );
  hold = false;
  gate.release();
  await expect(next.getByLabel("Group by", { exact: true })).toHaveValue(
    categoryFieldId,
  );
  await expect(next.getByLabel("Chart source", { exact: true })).toHaveValue(
    "inline",
  );
});

test("Dashboard previews an unsaved monthly draft and saves the exact inline instructions only on request", async ({
  page,
}) => {
  const api = await installDashboardApi(page);
  const bodies: unknown[] = [];
  await page.route("**/api/records/aggregate-snapshot*", (route) => {
    bodies.push(snapshotRequest(route));
    return fulfillSnapshot(route, {
      json: {
        items: [
          ...[
            "2025-01-01",
            "2025-02-01",
            "2025-03-01",
            "2025-04-01",
            "2025-05-01",
            "2025-06-01",
            "2025-07-01",
            "2025-08-01",
            "2025-09-01",
            "2025-10-01",
            "2025-11-01",
            "2025-12-01",
            "2026-01-01",
          ].map((key, index) => ({
            key,
            label: key,
            value: index === 0 ? 12.5 : null,
            record_count: index === 0 ? 92 : 0,
          })),
        ],
        pagination: wirePagination({ limit: 13, count: 13, total: 13 }),
      },
    });
  });
  await page.goto("/openview?section=dashboards");
  await startNewDashboardDraft(page, "Monthly review");
  const dialog = await openAddWidgetDialog(page);
  await dialog
    .getByLabel("Data source", { exact: true })
    .selectOption(moduleId);
  await dialog.getByLabel("Chart type", { exact: true }).selectOption("line");
  await dialog.getByLabel("Measure", { exact: true }).selectOption("min");
  await dialog
    .getByLabel("Numeric measure", { exact: true })
    .selectOption(amountFieldId);
  await dialog
    .getByLabel("Calendar bucket", { exact: true })
    .selectOption("month");
  await dialog
    .getByRole("button", { name: "Date window", exact: true })
    .click();
  await page.getByLabel("From date", { exact: true }).fill("2025-01-15");
  await page.getByLabel("To date", { exact: true }).fill("2026-01-20");
  await page.keyboard.press("Escape");
  await dialog
    .getByRole("button", { name: "Preview widget", exact: true })
    .click();
  await expect(
    dialog.getByRole("table", { name: "Draft preview values", exact: true }),
  ).toContainText("12.5");
  expect(api.writes).toEqual([]);
  const expected = {
    mode: "date_series",
    module_id: moduleId,
    definition: queryDefinition,
    aggregation: "min",
    measure: { field_id: amountFieldId, expected_type: "decimal" },
    date_field: { field_id: dateFieldId, expected_type: "date" },
    from_date: "2025-01-15",
    to_date: "2026-01-20",
    bucket: "month",
  };
  expect(bodies).toEqual([expected]);
  await addWidgetFromDialog(dialog);
  expect(api.writes).toEqual([]);
  await page
    .getByRole("button", { name: "Save Dashboard", exact: true })
    .click();
  await expect(
    page.getByText("Dashboard saved.", { exact: true }),
  ).toBeVisible();
  expect(api.writes[0]?.body?.widgets).toEqual([
    {
      widget_type: "chart",
      size: "M",
      chart_id: null,
      config: { version: 1, chart_type: "line", query: expected },
    },
  ]);
});

test("Dashboard records editor preserves ordered columns filters search sort and lifecycle grammar", async ({
  page,
}) => {
  const api = await installDashboardApi(page);
  await page.goto("/openview?section=dashboards");
  await startNewDashboardDraft(page, "Filtered records");
  const dialog = await openAddWidgetDialog(page);
  await dialog
    .getByLabel("Data source", { exact: true })
    .selectOption(moduleId);
  await dialog
    .getByLabel("Widget type", { exact: true })
    .selectOption("records");
  await dialog
    .getByRole("button", { name: "Records options", exact: true })
    .click();
  await page.getByLabel("Include Category", { exact: true }).check();
  await page.getByLabel("Include Region", { exact: true }).check();
  await page
    .getByRole("button", { name: "Move Region earlier", exact: true })
    .click();
  await page.getByLabel("Record search", { exact: true }).fill("pump");
  await page.getByLabel("Search Category", { exact: true }).check();
  await page
    .getByLabel("Record lifecycle", { exact: true })
    .selectOption("include");
  await page
    .getByLabel("Sort field", { exact: true })
    .selectOption(amountFieldId);
  await page.getByLabel("Sort direction", { exact: true }).selectOption("desc");
  await page.keyboard.press("Escape");
  await dialog
    .getByRole("button", { name: "Filters (0)", exact: true })
    .click();
  await page.getByRole("button", { name: "Add filter", exact: true }).click();
  await page
    .getByLabel("Filter 1 value", { exact: true })
    .selectOption(categoryChoices[0].id);
  await page.keyboard.press("Escape");
  await dialog
    .getByRole("button", { name: "Preview widget", exact: true })
    .click();
  await expect(
    dialog.getByText("2 matching records", { exact: true }),
  ).toBeVisible();
  const preview = dialog.getByRole("table", {
    name: "Draft preview records",
    exact: true,
  });
  await expect(preview.getByRole("columnheader")).toHaveText([
    "Region",
    "Category",
  ]);
  await expect(preview).toContainText("Repair");
  await expect(preview).toContainText("Inspection");
  expect(api.writes).toEqual([]);
  const expected = {
    version: 1,
    logic: "and",
    columns: [
      { field_id: regionFieldId, expected_type: "select" },
      { field_id: categoryFieldId, expected_type: "select" },
    ],
    filters: [
      {
        field_id: categoryFieldId,
        expected_type: "select",
        operator: "eq",
        value: categoryChoices[0].id,
      },
    ],
    sort: [
      { field_id: amountFieldId, expected_type: "decimal", direction: "desc" },
    ],
    deleted: "include",
    search: "pump",
    search_fields: [{ field_id: categoryFieldId, expected_type: "select" }],
  };
  expect(api.recordQueries).toEqual([
    { module_id: moduleId, definition: expected, limit: 5, offset: 0 },
  ]);
  await addWidgetFromDialog(dialog);
  await page
    .getByRole("button", { name: "Save Dashboard", exact: true })
    .click();
  await expect(
    page.getByText("Dashboard saved.", { exact: true }),
  ).toBeVisible();
  expect(api.writes[0]?.body?.widgets).toEqual([
    {
      widget_type: "records",
      size: "M",
      chart_id: null,
      config: {
        version: 1,
        query: { module_id: moduleId, definition: expected },
      },
    },
  ]);
});

test("Dashboard cancel fences a late preview without saving or adding a widget", async ({
  page,
}) => {
  const api = await installDashboardApi(page);
  await page.goto("/openview?section=dashboards");
  await startNewDashboardDraft(page, "Retained draft");
  const dialog = await openAddWidgetDialog(page);
  await dialog
    .getByLabel("Data source", { exact: true })
    .selectOption(moduleId);
  await dialog
    .getByLabel("Group by", { exact: true })
    .selectOption(categoryFieldId);
  const held = api.holdNextSnapshot();
  await dialog
    .getByRole("button", { name: "Preview widget", exact: true })
    .click();
  await held.started;
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  held.release();
  const reopened = await openAddWidgetDialog(page);
  await expect(
    reopened.getByRole("table", { name: "Draft preview values", exact: true }),
  ).toHaveCount(0);
  await expect(
    reopened.getByText("0 of 12 widgets used.", { exact: true }),
  ).toBeVisible();
  expect(api.writes).toEqual([]);
});

test("Dashboard saved picker preview refuses a changed source and saves reference-only after recovery", async ({
  page,
}) => {
  const api = await installDashboardApi(page);
  const chartId = "00000000-0000-4000-8000-000000000699";
  const chart = {
    id: chartId,
    department_id: departmentId,
    module_id: moduleId,
    name: "Private reusable Chart",
    chart_type: "bar",
    query: {
      mode: "groups",
      module_id: moduleId,
      definition: queryDefinition,
      aggregation: "count",
      measure: null,
      dimension: { field_id: categoryFieldId, expected_type: "select" },
    },
    revision: 1,
    is_deleted: false,
    created_at: timestamp,
    updated_at: timestamp,
  };
  let refused = false;
  await page.route("**/api/charts?*", (route) =>
    route.fulfill({
      json: {
        items: [chart],
        pagination: wirePagination({ limit: 25, count: 1, total: 1 }),
      },
    }),
  );
  await page.route(`**/api/charts/${chartId}`, (route) =>
    refused
      ? route.fulfill({ status: 404, json: { detail: "Private refusal" } })
      : route.fulfill({ json: chart }),
  );
  let resultReads = 0;
  await page.route("**/api/records/aggregate-snapshot", (route) => {
    resultReads += 1;
    return route.fulfill({
      json: {
        items: [
          {
            key: "private",
            label: "Private draft result",
            value: 3,
            record_count: 3,
          },
        ],
        pagination: wirePagination({ limit: 1, count: 1, total: 1 }),
      },
    });
  });
  await page.goto("/openview?section=dashboards");
  await startNewDashboardDraft(page, "Reusable review");
  const dialog = await openAddWidgetDialog(page);
  await dialog
    .getByLabel("Chart source", { exact: true })
    .selectOption("saved");
  await dialog
    .getByRole("combobox", { name: "Saved Chart", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Private reusable Chart", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Preview widget", exact: true })
    .click();
  await expect(
    dialog.getByRole("table", { name: "Draft preview values", exact: true }),
  ).toContainText("Private draft result");
  expect(api.writes).toEqual([]);
  refused = true;
  await dialog
    .getByRole("button", { name: "Preview widget", exact: true })
    .click();
  await expect(
    dialog.getByText("Private reusable Chart", { exact: true }),
  ).toHaveCount(0);
  expect(resultReads).toBe(1);
  refused = false;
  await dialog
    .getByRole("button", { name: "Retry saved Chart", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Preview widget", exact: true })
    .click();
  await expect(
    dialog.getByRole("table", { name: "Draft preview values", exact: true }),
  ).toContainText("Private draft result");
  refused = true;
  await sendOpenViewEvent(page, "invalidate", {
    entity: "charts",
    module_id: moduleId,
  });
  await expect(
    dialog.getByText("Private draft result", { exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByText("Private reusable Chart", { exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByText("Private refusal", { exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Preview widget", exact: true }),
  ).toBeDisabled();
  expect(resultReads).toBe(2);
  refused = false;
  await dialog
    .getByRole("button", { name: "Retry saved Chart", exact: true })
    .click();
  await addWidgetFromDialog(dialog);
  await page
    .getByRole("button", { name: "Save Dashboard", exact: true })
    .click();
  await expect(
    page.getByText("Dashboard saved.", { exact: true }),
  ).toBeVisible();
  expect(api.writes[0]?.body?.widgets).toEqual([
    { widget_type: "chart", size: "M", chart_id: chartId, config: null },
  ]);
});

test("Dashboard preserves a saved Chart reference and L size through settings save and reload", async ({
  page,
}) => {
  const chartId = "00000000-0000-4000-8000-000000000651";
  const reference: WidgetWire = {
    id: dashboardWidgetId,
    position: 0,
    widget_type: "chart",
    size: "L",
    chart_id: chartId,
    config: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const api = await installDashboardApi(
    page,
    dashboard({ widgets: [reference] }),
  );
  let reads = 0;
  const query = savedWidget(dashboardWidgetId, 0, categoryFieldId).config.query;
  await page.route(`**/api/charts/${chartId}`, (route) => {
    reads += 1;
    return route.fulfill({
      json: {
        id: chartId,
        department_id: departmentId,
        module_id: moduleId,
        name: "Retained requests",
        chart_type: "bar",
        query,
        revision: 1,
        is_deleted: false,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
  });
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  await expect(
    page.getByRole("heading", { name: "Operations", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: /Complete data/ }),
  ).toBeVisible();
  expect(reads).toBeGreaterThan(0);
  expect(api.snapshots.at(-1)).toEqual({
    mode: "groups",
    module_id: moduleId,
    definition: queryDefinition,
    aggregation: "count",
    dimension: { field_id: categoryFieldId, expected_type: "select" },
  });
  const dialog = await openDashboardSettingsDialog(page);
  await dialog.getByLabel("Dashboard name").fill("Preserved reference");
  await dialog.getByLabel("Refresh cadence").selectOption("five-minutes");
  await finishDashboardDialog(dialog);
  await page
    .getByRole("button", { name: "Save Dashboard", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Preserved reference", exact: true }),
  ).toBeVisible();
  expect(api.writes.at(-1)?.body?.widgets).toEqual([
    { widget_type: "chart", size: "L", chart_id: chartId, config: null },
  ]);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Preserved reference", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: /Complete data/ }),
  ).toBeVisible();
  expect(api.writes).toHaveLength(1);
});

for (const sourceKind of ["inline", "referenced"] as const) {
  for (const [aggregation, expected] of [
    ["average", 12.5],
    ["min", 1.25],
    ["max", 200.5],
    ["distinct", 4],
  ] as const) {
    test(`${sourceKind} summary shows exact ${aggregation} values and null without record-count substitution`, async ({
      page,
    }) => {
      const chartId = "00000000-0000-4000-8000-000000000652";
      const query = {
        ...savedWidget(dashboardWidgetId, 0, categoryFieldId).config.query,
        aggregation,
        measure: { field_id: amountFieldId, expected_type: "decimal" },
      };
      const common = {
        id: dashboardWidgetId,
        position: 0,
        widget_type: "summary" as const,
        size: "M" as const,
        created_at: timestamp,
        updated_at: timestamp,
      };
      const summary: WidgetWire =
        sourceKind === "referenced"
          ? { ...common, chart_id: chartId, config: null }
          : { ...common, chart_id: null, config: { version: 1, query } };
      const api = await installDashboardApi(
        page,
        dashboard({ widgets: [summary] }),
      );
      await page.route(`**/api/charts/${chartId}`, (route) =>
        route.fulfill({
          json: {
            id: chartId,
            department_id: departmentId,
            module_id: moduleId,
            name: "Retained measures",
            chart_type: "summary",
            query,
            revision: 1,
            is_deleted: false,
            created_at: timestamp,
            updated_at: timestamp,
          },
        }),
      );
      const requests: unknown[] = [];
      await page.route("**/api/records/aggregate-snapshot*", (route) => {
        requests.push(snapshotRequest(route));
        return fulfillSnapshot(route, {
          json: {
            items: [
              {
                key: "north",
                label: "North",
                value: expected,
                record_count: 127,
              },
              { key: "south", label: "South", value: null, record_count: 17 },
            ],
            pagination: wirePagination({ limit: 2, count: 2, total: 2 }),
          },
        });
      });
      await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
      const north = page.getByRole("row").filter({
        has: page.getByRole("cell", { name: "North", exact: true }),
      });
      const south = page.getByRole("row").filter({
        has: page.getByRole("cell", { name: "South", exact: true }),
      });
      await expect(
        north.getByRole("cell", { name: String(expected), exact: true }),
      ).toBeVisible();
      await expect(
        south.getByRole("cell", { name: "—", exact: true }),
      ).toBeVisible();
      expect(requests.at(-1)).toEqual(query);
      expect(api.writes).toEqual([]);
    });
  }
}

for (const fault of [
  "403",
  "404",
  "archived",
  "wrong-id",
  "wrong-module",
  "wrong-family",
  "malformed",
] as const) {
  test(`current Chart ${fault} refuses stale private results and downstream reads`, async ({
    page,
  }, testInfo) => {
    const chartId = "00000000-0000-4000-8000-000000000653";
    const query = savedWidget(dashboardWidgetId, 0, categoryFieldId).config
      .query;
    const api = await installDashboardApi(
      page,
      dashboard({
        widgets: [
          {
            id: dashboardWidgetId,
            position: 0,
            widget_type: "chart",
            size: "S",
            chart_id: chartId,
            config: null,
            created_at: timestamp,
            updated_at: timestamp,
          },
        ],
      }),
    );
    let refused = false;
    let reads = 0;
    const readOrder: Array<{ operation: string; refused: boolean }> = [];
    await page.route("**/api/records/aggregate-snapshot*", (route) => {
      readOrder.push({ operation: "snapshot", refused });
      return route.fallback();
    });
    await page.route(`**/api/charts/${chartId}`, (route) => {
      reads += 1;
      readOrder.push({ operation: "chart", refused });
      if (refused && (fault === "403" || fault === "404"))
        return route.fulfill({
          status: Number(fault),
          json: { detail: "Source unavailable" },
        });
      const source = {
        id: chartId,
        department_id: departmentId,
        module_id: moduleId,
        name: "Private retained source",
        chart_type: "bar",
        query,
        revision: 1,
        is_deleted: false,
        created_at: timestamp,
        updated_at: timestamp,
      };
      if (refused) {
        if (fault === "archived") source.is_deleted = true;
        if (fault === "wrong-id") source.id = secondDashboardWidgetId;
        if (fault === "wrong-module") source.module_id = secondModuleId;
        if (fault === "wrong-family")
          return route.fulfill({
            json: {
              ...source,
              chart_type: "records",
              query: { module_id: moduleId, definition: queryDefinition },
            },
          });
        if (fault === "malformed")
          return route.fulfill({
            json: { ...source, query: { definition: {} } },
          });
      }
      return route.fulfill({ json: source });
    });
    await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
    await expect(
      page.getByRole("table", { name: /Complete data/ }),
    ).toBeVisible();
    await expect.poll(() => api.fieldReads.length).toBeGreaterThan(0);
    const resyncSnapshot = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          "/api/records/aggregate-snapshots" &&
        response.request().method() === "POST",
    );
    await sendOpenViewEvent(page, "resync");
    await resyncSnapshot;
    await expect(
      page.getByRole("button", { name: "Refresh now", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("table", { name: /Complete data/ }),
    ).toBeVisible();
    const downstream = api.snapshots.length;
    const fields = api.fieldReads.length;
    const originalReads = reads;
    refused = true;
    await sendOpenViewEvent(page, "invalidate", {
      entity: "charts",
      module_id: moduleId,
    });
    await expect.poll(() => reads).toBeGreaterThan(originalReads);
    await expect(
      page.getByRole("table", { name: /Complete data/ }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Private retained source", { exact: true }),
    ).toHaveCount(0);
    await testInfo.attach("s26-chart-read-order", {
      body: JSON.stringify({ fault, downstream, fields, readOrder }),
      contentType: "application/json",
    });
    console.info(
      "S26 chart read order",
      JSON.stringify({ fault, downstream, fields, readOrder }),
    );
    if (fault === "403")
      await expect(
        page
          .getByRole("alert")
          .filter({ hasText: "You do not have access to this data." }),
      ).toContainText("You do not have access to this data.");
    expect(api.snapshots).toHaveLength(downstream);
    expect(api.fieldReads).toHaveLength(fields);
    expect(api.writes).toEqual([]);
  });
}

test("Chart invalidation refreshes its current query while preserving a dirty Dashboard draft", async ({
  page,
}) => {
  const chartId = "00000000-0000-4000-8000-000000000654";
  const api = await installDashboardApi(
    page,
    dashboard({
      widgets: [
        {
          id: dashboardWidgetId,
          position: 0,
          widget_type: "chart",
          size: "L",
          chart_id: chartId,
          config: null,
          created_at: timestamp,
          updated_at: timestamp,
        },
      ],
    }),
  );
  let revision = 1;
  let queries = 0;
  const original = savedWidget(dashboardWidgetId, 0, categoryFieldId).config
    .query;
  await page.route(`**/api/charts/${chartId}`, (route) =>
    route.fulfill({
      json: {
        id: chartId,
        department_id: revision === 1 ? departmentId : secondModuleId,
        module_id: moduleId,
        name: "Current source",
        chart_type: "bar",
        revision,
        is_deleted: false,
        query: {
          ...original,
          dimension: {
            field_id: revision === 1 ? categoryFieldId : regionFieldId,
            expected_type: "select",
          },
        },
        created_at: timestamp,
        updated_at: timestamp,
      },
    }),
  );
  await page.route("**/api/records/aggregate-snapshot*", (route) => {
    queries += 1;
    const request = snapshotRequest(route);
    const changed =
      request.mode === "groups" && request.dimension.field_id === regionFieldId;
    return fulfillSnapshot(route, {
      json: {
        items: [
          {
            key: "current",
            label: changed ? "New region data" : "Original category data",
            value: changed ? 9 : 3,
            record_count: changed ? 9 : 3,
          },
        ],
        pagination: wirePagination({ limit: 1, count: 1, total: 1 }),
      },
    });
  });
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  await expect(
    page.getByRole("cell", { name: "Original category data", exact: true }),
  ).toBeVisible();
  const settings = await openDashboardSettingsDialog(page);
  await settings.getByLabel("Dashboard name").fill("Retained typed draft");
  await settings.getByLabel("Refresh cadence").selectOption("five-minutes");
  await finishDashboardDialog(settings);
  revision = 2;
  const before = queries;
  await sendOpenViewEvent(page, "invalidate", {
    entity: "charts",
    module_id: moduleId,
  });
  await expect(
    page.getByRole("cell", { name: "New region data", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Retained typed draft", exact: true }),
  ).toBeVisible();
  expect(queries).toBeGreaterThan(before);
  expect(api.writes).toEqual([]);
  await page
    .getByRole("button", { name: "Save Dashboard", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Retained typed draft", exact: true }),
  ).toBeVisible();
  expect(api.writes.at(-1)?.body).toMatchObject({
    name: "Retained typed draft",
    refresh_cadence: "five-minutes",
    widgets: [
      { widget_type: "chart", size: "L", chart_id: chartId, config: null },
    ],
  });
});

test("paired Board and Dashboard follow one Chart revision without source writes or draft replacement", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  if (!baseURL) throw new Error("The configured HTTP baseURL is required");
  const chartId = "00000000-0000-4000-8000-000000000691";
  const boardId = "00000000-0000-4000-8000-000000000692";
  const boardWidgetId = "00000000-0000-4000-8000-000000000693";
  const referenced: WidgetWire = {
    id: dashboardWidgetId,
    position: 0,
    widget_type: "chart",
    size: "L",
    chart_id: chartId,
    config: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const api = await installDashboardApi(
    page,
    dashboard({ widgets: [referenced] }),
  );
  const boardContext = await browser.newContext({ baseURL, timezoneId: "UTC" });
  const boardPage = await boardContext.newPage();
  const boardWrites: unknown[] = [];
  const chartWrites: string[] = [];
  const reads: Array<{ consumer: string; revision: number }> = [];
  const requests: Array<{ consumer: string; body: unknown }> = [];
  let revision = 1;
  const original = savedWidget(dashboardWidgetId, 0, categoryFieldId).config
    .query;
  const revised = {
    ...original,
    dimension: { field_id: regionFieldId, expected_type: "select" as const },
  };
  try {
    await installDashboardApi(boardPage, dashboard({ widgets: [referenced] }));
    const board = {
      id: boardId,
      scope: "project",
      department_id: null,
      name: "Paired Board",
      description: null,
      status: "active",
      revision: 1,
      level: "manage",
      created_at: timestamp,
      updated_at: timestamp,
    };
    const widget = {
      id: boardWidgetId,
      board_id: boardId,
      name: "Shared Chart on Board",
      widget_type: "chart",
      module_id: moduleId,
      position: 0,
      size: "M",
      pinned: false,
      chart_id: chartId,
      config: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    const list = (items: unknown[], limit = 12) => pageOf(items, { limit });
    await boardPage.route("**/api/boards**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== "GET") {
        boardWrites.push(route.request().postData());
        return route.fulfill({ status: 405 });
      }
      if (path === "/api/boards")
        return route.fulfill({ json: list([board], 25) });
      if (path === `/api/boards/${boardId}`)
        return route.fulfill({ json: board });
      if (path === `/api/boards/${boardId}/my-access`)
        return route.fulfill({
          json: { read: true, write: true, manage: true, level: "manage" },
        });
      if (path === `/api/boards/${boardId}/widgets`)
        return route.fulfill({
          json: { ...list([widget]), board_revision: 1 },
        });
      return route.fulfill({ status: 404 });
    });
    for (const [consumer, target] of [
      ["Dashboard", page],
      ["Board", boardPage],
    ] as const) {
      await installOpenViewEventSource(target);
      await target.route("**/api/users/*/preferences", (route) =>
        route.fulfill({
          json: {
            user_id: userId,
            theme: "light",
            appearance: { motion: "reduce", keyboard_shortcuts: true },
          },
        }),
      );
      await target.route("**/api/workspace/appearance", (route) =>
        route.fulfill({ json: { theme: "slate" } }),
      );
      await target.route("**/api/notifications/unread-count", (route) =>
        route.fulfill({ json: { unread_count: 0 } }),
      );
      await target.route("**/api/workspace", (route) =>
        route.fulfill({
          json: {
            id: departmentId,
            display_name: "OpenSlate",
            legal_name: null,
            description: null,
            contact_email: null,
            contact_phone: null,
            postal_address: null,
            logo_file_id: null,
            locale: "en-US",
            timezone: "UTC",
            mark: "OS",
            currency: "USD",
            week_start: "monday",
            business_hours: "09:00–18:00",
            theme: "slate",
            revision: 1,
            today: "2026-10-09",
            purge_enabled: true,
          },
        }),
      );
      await target.route(`**/api/charts/${chartId}`, (route) => {
        if (route.request().method() !== "GET") {
          chartWrites.push(`${consumer}:${route.request().method()}`);
          return route.fulfill({ status: 405 });
        }
        reads.push({ consumer, revision });
        return route.fulfill({
          json: {
            id: chartId,
            department_id: departmentId,
            module_id: moduleId,
            name: "One controlled Chart",
            chart_type: "bar",
            query: revision === 1 ? original : revised,
            revision,
            is_deleted: false,
            created_at: timestamp,
            updated_at: timestamp,
          },
        });
      });
      await target.route("**/api/records/aggregate-snapshot*", (route) => {
        const body = snapshotRequest(route);
        requests.push({ consumer, body });
        const current =
          body.mode === "groups" && body.dimension.field_id === regionFieldId;
        return fulfillSnapshot(route, {
          json: list(
            [
              {
                key: "shared",
                label: current
                  ? "Revised shared Chart"
                  : "Original shared Chart",
                value: current ? 9 : 3,
                record_count: 127,
              },
            ],
            1,
          ),
        });
      });
    }
    await Promise.all([
      page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`),
      boardPage.goto(`/boards?board=${boardId}`),
    ]);
    await expect(
      page.getByRole("cell", { name: "Original shared Chart", exact: true }),
    ).toBeVisible();
    // The inner value list excludes chart axes in the outer widget list and
    // remains addressable while the management dialog hides background roles.
    const boardValues = boardPage.locator("ol ol");
    await expect(
      boardValues.getByText("Original shared Chart", { exact: true }),
    ).toBeVisible();
    const settings = await openDashboardSettingsDialog(page);
    await settings
      .getByLabel("Dashboard name")
      .fill("Independent Dashboard draft");
    await settings.getByLabel("Refresh cadence").selectOption("five-minutes");
    await finishDashboardDialog(settings);
    await boardPage
      .getByRole("button", { name: "Manage widgets", exact: true })
      .click();
    const manager = boardPage.getByRole("region", {
      name: "Manage Board widgets",
      exact: true,
    });
    await manager
      .getByRole("button", {
        name: "Edit Shared Chart on Board settings",
        exact: true,
      })
      .click();
    const boardSettings = manager.locator("form").filter({
      has: boardPage.getByRole("button", {
        name: "Save settings",
        exact: true,
      }),
    });
    await boardSettings
      .getByLabel("Widget name", { exact: true })
      .fill("Independent Board draft");
    await boardSettings.getByLabel("Size", { exact: true }).selectOption("S");
    await boardSettings.getByLabel("Pin this widget", { exact: true }).check();
    revision = 2;
    await Promise.all([
      sendOpenViewEvent(page, "invalidate", {
        entity: "charts",
        module_id: moduleId,
      }),
      sendOpenViewEvent(boardPage, "invalidate", {
        entity: "charts",
        module_id: moduleId,
      }),
    ]);
    await expect(
      page.getByRole("cell", { name: "Revised shared Chart", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: "9", exact: true }),
    ).toBeVisible();
    await expect(
      boardValues.getByText("Revised shared Chart", { exact: true }),
    ).toBeVisible();
    await expect(boardValues.getByText("9", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Independent Dashboard draft",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      boardSettings.getByLabel("Widget name", { exact: true }),
    ).toHaveValue("Independent Board draft");
    await expect(boardSettings.getByLabel("Size", { exact: true })).toHaveValue(
      "S",
    );
    await expect(
      boardSettings.getByLabel("Pin this widget", { exact: true }),
    ).toBeChecked();
    expect(api.writes).toEqual([]);
    expect(boardWrites).toEqual([]);
    expect(chartWrites).toEqual([]);
    for (const consumer of ["Board", "Dashboard"]) {
      expect(
        reads.some((read) => read.consumer === consumer && read.revision === 2),
      ).toBe(true);
      expect(
        requests.filter((read) => read.consumer === consumer).at(-1)?.body,
      ).toEqual({
        mode: "groups",
        module_id: moduleId,
        aggregation: "count",
        definition: {
          version: 1,
          logic: "and",
          columns: [],
          filters: [],
          sort: [],
          deleted: "exclude",
          search: null,
          search_fields: [],
        },
        dimension: { field_id: regionFieldId, expected_type: "select" },
      });
    }
    // Discarding one consumer's draft cannot discard the other consumer's draft.
    await boardSettings
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await boardPage
      .getByRole("button", { name: "Close widget management", exact: true })
      .click();
    await expect(
      boardPage.getByRole("heading", {
        name: "Shared Chart on Board",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Independent Dashboard draft",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Save Dashboard", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "Dashboard saved." }),
    ).toBeVisible();
    expect(api.writes.at(-1)?.body).toMatchObject({
      name: "Independent Dashboard draft",
      refresh_cadence: "five-minutes",
      widgets: [
        { widget_type: "chart", size: "L", chart_id: chartId, config: null },
      ],
    });
    expect(boardWrites).toEqual([]);
    expect(chartWrites).toEqual([]);
  } finally {
    await testInfo.attach("paired-chart-consumers", {
      body: JSON.stringify({
        revision,
        reads,
        requests,
        boardWrites,
        dashboardWrites: api.writes,
        chartWrites,
      }),
      contentType: "application/json",
    });
    await boardContext.close();
  }
});

test("Dashboard invalidation updates its saved name and widget without reloading", async ({
  page,
}) => {
  const api = await installDashboardApi(page, dashboard());
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  await expect(
    page.getByRole("heading", { name: "Operations", exact: true }),
  ).toBeVisible();
  await sendOpenViewEvent(page, "resync");
  api.changeDashboard(
    dashboard({
      name: "Dispatch overview",
      revision: 2,
      widgets: [savedWidget(dashboardWidgetId, 0, regionFieldId)],
    }),
  );
  await sendOpenViewEvent(page, "invalidate", { entity: "dashboards" });
  await expect(
    page.getByRole("heading", { name: "Dispatch overview", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByLabel("Dashboard", { exact: true })
      .getByRole("option", { name: "Dispatch overview" }),
  ).toBeAttached();
  await expect(
    page.getByRole("table", { name: "Complete data for Count by Region" }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`dashboard=${dashboardId}`));
  expect(api.writes).toHaveLength(0);
});

test("Dashboard invalidation retains a dirty name cadence and widgets until discard", async ({
  page,
}) => {
  const api = await installDashboardApi(page, dashboard());
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  await expect(
    page.getByRole("heading", { name: "Operations", exact: true }),
  ).toBeVisible();
  const settings = await openDashboardSettingsDialog(page);
  await settings.getByLabel("Dashboard name").fill("My local draft");
  await settings.getByLabel("Refresh cadence").selectOption("five-minutes");
  await finishDashboardDialog(settings);
  const add = await openAddWidgetDialog(page);
  await add.getByLabel("Group by", { exact: true }).selectOption(regionFieldId);
  await addWidgetFromDialog(add);
  await expect(
    page.getByText("2 of 12 widgets", { exact: true }),
  ).toBeVisible();
  api.changeDashboard(dashboard({ name: "Remote saved name", revision: 2 }));
  await sendOpenViewEvent(page, "invalidate", { entity: "dashboards" });
  await expect(
    page.getByText("Changed by someone else — review latest", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "My local draft", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("2 of 12 widgets", { exact: true }),
  ).toBeVisible();
  const retained = await openDashboardSettingsDialog(page);
  await expect(retained.getByLabel("Dashboard name")).toHaveValue(
    "My local draft",
  );
  await expect(retained.getByLabel("Refresh cadence")).toHaveValue(
    "five-minutes",
  );
  await finishDashboardDialog(retained);
  await page.getByRole("button", { name: "Dashboard options" }).click();
  await page
    .getByRole("menuitem", { name: "Discard draft and reload" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Remote saved name", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("1 of 12 widgets", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Changed by someone else — review latest", { exact: true }),
  ).toBeHidden();
  expect(api.writes).toHaveLength(0);
});

test("Dashboard record invalidations refresh visible module results once per burst", async ({
  page,
}) => {
  await page.clock.install();
  const api = await installDashboardApi(page, dashboard());
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  const table = page.getByRole("table", {
    name: "Complete data for Count by Category",
  });
  await expect(table.locator("tbody tr")).toHaveCount(25);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const before = api.snapshots.length;
  api.setSnapshotLength(2);
  await sendOpenViewEvent(page, "invalidate", {
    entity: "records",
    module_id: secondModuleId,
  });
  await page.clock.runFor(301);
  expect(api.snapshots).toHaveLength(before);
  await expect(table.locator("tbody tr")).toHaveCount(25);
  for (let count = 0; count < 3; count += 1)
    await sendOpenViewEvent(page, "invalidate", {
      entity: "records",
      module_id: moduleId,
    });
  await page.clock.runFor(299);
  expect(api.snapshots).toHaveLength(before);
  await page.clock.runFor(2);
  await settleDashboardClock(page, () => table.locator("tbody tr").count(), 2);
  await expect(table.locator("tbody tr")).toHaveCount(2);
  expect(api.snapshots).toHaveLength(before + 1);
});

test("department Dashboard supports mobile keyboard-only controls and survives reload", async ({
  page,
}) => {
  const api = await installDashboardApi(page, dashboard({ widgets: [] }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/openview?section=dashboards");

  await expect(
    page.getByRole("heading", { name: "Dashboards", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Session verification" }),
  ).toBeHidden();
  await expectDashboardMainToFit(page);

  const dashboardPicker = page.getByLabel("Dashboard", { exact: true });
  await tabTo(page, dashboardPicker);
  await expectVisibleKeyboardFocus(dashboardPicker);
  await page.keyboard.press("o");
  await expect(dashboardPicker).toHaveValue(dashboardId);
  await expect(page).toHaveURL(new RegExp(`dashboard=${dashboardId}`));
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();

  const newDashboard = page.getByRole("button", { name: "New Dashboard" });
  await tabTo(page, newDashboard, "backward");
  await expectVisibleKeyboardFocus(newDashboard);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/openview?section=dashboards");

  const newDashboardDialog = page.getByRole("dialog", {
    name: "New Dashboard",
  });
  await expect(newDashboardDialog).toBeVisible();
  const dashboardName = newDashboardDialog.getByLabel("Dashboard name");
  await expect(dashboardName).toHaveValue("");
  await tabTo(page, dashboardName);
  for (const character of "Keyboard dashboard")
    await page.keyboard.type(character);
  await expect(dashboardName).toHaveValue("Keyboard dashboard");
  const doneSettings = newDashboardDialog.getByRole("button", {
    name: "Continue",
  });
  await tabTo(page, doneSettings, "backward");
  await expectVisibleKeyboardFocus(doneSettings);
  await page.keyboard.press("Enter");
  await expect(newDashboardDialog).toBeHidden();
  await expect(
    page.getByRole("dialog", {
      name: "New Dashboard",
      includeHidden: true,
    }),
  ).toHaveCount(0);
  await expect(newDashboard).toBeFocused();

  const addWidget = page.getByRole("button", {
    name: "Add widget",
    exact: true,
  });
  await tabTo(page, addWidget);
  await expectVisibleKeyboardFocus(addWidget);
  await page.keyboard.press("Enter");
  const addDialog = page.getByRole("dialog", { name: "Add widget" });
  await expect(addDialog).toBeVisible();
  const moduleSelect = addDialog.getByLabel("Data source");
  await expect(
    addDialog.getByLabel("Widget type", { exact: true }),
  ).toBeFocused();
  await tabTo(page, moduleSelect);
  await expectVisibleKeyboardFocus(moduleSelect);
  await expect(moduleSelect).toContainText("Equipment");
  await page.keyboard.press("e");
  await expect(moduleSelect).toHaveValue(moduleId);

  const dimension = addDialog.getByLabel("Group by", { exact: true });
  await expect(dimension).toHaveValue(categoryFieldId);
  await tabTo(page, dimension);
  await expectVisibleKeyboardFocus(dimension);
  await expect(dimension).toContainText("Category");
  await page.keyboard.press("r");
  await expect(dimension).toHaveValue(regionFieldId);

  const addChart = addDialog.getByRole("button", {
    name: "Add widget",
    exact: true,
  });
  await tabTo(page, addChart);
  await expectVisibleKeyboardFocus(addChart);
  await page.keyboard.press("Enter");
  await expect(addDialog).toBeHidden();
  await expect(page.getByText("1 of 12 widgets")).toBeVisible();
  await expectDashboardMainToFit(page);

  const saveDashboard = page.getByRole("button", { name: "Save Dashboard" });
  await tabTo(page, saveDashboard, "backward");
  await expectVisibleKeyboardFocus(saveDashboard);
  await page.keyboard.press("Enter");

  const table = page.getByRole("table", {
    name: "Complete data for Count by Region",
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
      dimension: { field_id: regionFieldId },
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

test("new Dashboard and widget dialogs keep configuration local until Dashboard save", async ({
  page,
}) => {
  const api = await installDashboardApi(page);
  await page.goto("/openview?section=dashboards");

  await page.getByRole("button", { name: "New Dashboard" }).click();
  const newDashboardDialog = page.getByRole("dialog", {
    name: "New Dashboard",
  });
  await expect(newDashboardDialog).toBeVisible();
  await newDashboardDialog
    .getByLabel("Dashboard name")
    .fill("Equipment overview");
  await newDashboardDialog
    .getByLabel("Refresh cadence")
    .selectOption("five-minutes");
  await newDashboardDialog.getByRole("button", { name: "Continue" }).click();
  await expect(newDashboardDialog).toBeHidden();
  await expect(
    page.getByText("Unsaved changes", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save Dashboard" }),
  ).toBeEnabled();

  await page.getByRole("button", { name: "Add widget", exact: true }).click();
  const addWidgetDialog = page.getByRole("dialog", { name: "Add widget" });
  await expect(addWidgetDialog).toBeVisible();
  await expect(addWidgetDialog.getByLabel("Data source")).toHaveValue(moduleId);
  await expect(
    addWidgetDialog.getByLabel("Group by", { exact: true }),
  ).toHaveValue(categoryFieldId);
  expect(api.snapshots).toHaveLength(0);
  await addWidgetDialog
    .getByRole("button", { name: "Add widget", exact: true })
    .click();
  await expect(addWidgetDialog).toBeHidden();
  await expect(
    page.getByText("Save this Dashboard to load live data for the widget."),
  ).toBeVisible();
  expect(api.snapshots).toHaveLength(0);

  await page.getByRole("button", { name: "Save Dashboard" }).click();
  await expect(
    page.getByRole("table", { name: "Complete data for Count by Category" }),
  ).toBeVisible();
  expect(api.writes[0]).toMatchObject({
    method: "POST",
    body: {
      name: "Equipment overview",
      refresh_cadence: "five-minutes",
      widgets: [
        {
          widget_type: "chart",
          config: {
            chart_type: "bar",
            query: {
              mode: "groups",
              aggregation: "count",
              dimension: { field_id: categoryFieldId },
            },
          },
        },
      ],
    },
  });
  expect(api.snapshots).toHaveLength(1);
});

test("Dashboard settings remain a visible draft until explicitly saved", async ({
  page,
}) => {
  const api = await installDashboardApi(page, dashboard({ widgets: [] }));
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();

  await page.getByRole("button", { name: "Dashboard options" }).click();
  await page.getByRole("menuitem", { name: "Dashboard settings" }).click();
  const settingsDialog = page.getByRole("dialog", {
    name: "Dashboard settings",
  });
  await expect(settingsDialog).toBeVisible();
  await settingsDialog.getByLabel("Dashboard name").fill("Renamed equipment");
  await settingsDialog.getByLabel("Refresh cadence").selectOption("one-minute");
  await settingsDialog.getByRole("button", { name: "Done" }).click();

  await expect(settingsDialog).toBeHidden();
  await expect(
    page.getByText("Unsaved changes", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save Dashboard" }),
  ).toBeEnabled();
  expect(api.writes).toHaveLength(0);

  await page.getByRole("button", { name: "Save Dashboard" }).click();
  await expect(
    page.getByRole("heading", { name: "Renamed equipment" }),
  ).toBeVisible();
  expect(api.writes[0]).toMatchObject({
    method: "PATCH",
    dashboardId,
    body: {
      revision: 1,
      name: "Renamed equipment",
      refresh_cadence: "one-minute",
      widgets: [],
    },
  });
});

test("department Dashboard saves ordered charts and reloads every complete snapshot in one batch", async ({
  page,
}) => {
  const api = await installDashboardApi(page);
  await page.goto("/openview?section=dashboards");

  await expect(
    page.getByRole("heading", { name: "Dashboards", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Each Dashboard belongs to a department", { exact: false }),
  ).toBeVisible();
  const newDialog = await openNewDashboardDialog(page);
  await newDialog.getByLabel("Dashboard name").fill("Equipment overview");
  await finishDashboardDialog(newDialog);

  let addDialog = await openAddWidgetDialog(page);
  await addDialog.getByLabel("Data source").selectOption(moduleId);
  await addDialog
    .getByLabel("Group by", { exact: true })
    .selectOption(categoryFieldId);
  await addWidgetFromDialog(addDialog);
  addDialog = await openAddWidgetDialog(page);
  await addDialog
    .getByLabel("Group by", { exact: true })
    .selectOption(regionFieldId);
  await addWidgetFromDialog(addDialog);
  await expect(
    page.getByText("2 of 12 widgets", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Widget options: Count by Region" })
    .click();
  await page.getByRole("menuitem", { name: "Move earlier" }).click();
  addDialog = await openAddWidgetDialog(page);
  await addDialog
    .getByLabel("Group by", { exact: true })
    .selectOption(categoryFieldId);
  await addWidgetFromDialog(addDialog);
  await expect(page.getByText("3 of 12 widgets")).toBeVisible();
  await page
    .getByRole("button", { name: "Widget options: Count by Category" })
    .last()
    .click();
  await page.getByRole("menuitem", { name: "Remove widget" }).click();
  await expect(
    page.getByText("2 of 12 widgets", { exact: true }),
  ).toBeVisible();
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
      widget.widget_type !== "records" &&
      widget.config !== null &&
      widget.config !== undefined &&
      widget.config.query.mode === "groups"
        ? widget.config.query.dimension.field_id
        : null,
    ),
  ).toEqual([regionFieldId, categoryFieldId]);
  expect(
    api.writes[0]?.body?.widgets?.map((widget) =>
      widget.widget_type === "records" ? null : widget.config?.query.measure,
    ),
  ).toEqual([null, null]);
  expect(api.batches).toHaveLength(1);
  expect(api.snapshots).toHaveLength(2);
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
  expect(api.batches).toHaveLength(2);
  await expect(
    page.getByRole("table", { name: "Complete data for Count by Category" }),
  ).toBeVisible();
  expect(api.snapshots).toHaveLength(4);
  expect(api.snapshots[3]).toMatchObject({
    mode: "groups",
    dimension: { field_id: categoryFieldId },
  });
  const categoryTile = page.getByRole("article", {
    name: "Count by Category",
    exact: true,
  });
  await expect(categoryTile.getByText("Showing 1–25 of 30")).toBeVisible();
  await expect(
    page
      .getByRole("table", { name: "Complete data for Count by Category" })
      .locator("tbody tr"),
  ).toHaveCount(25);
  await expect(
    categoryTile.getByRole("navigation", { name: "Dashboard result pages" }),
  ).toBeVisible();
  await categoryTile.getByRole("button", { name: "Go to next page" }).click();
  await expect(categoryTile.getByText("Showing 26–30 of 30")).toBeVisible();
  await expect(
    page
      .getByRole("table", { name: "Complete data for Count by Category" })
      .getByText("Group 30"),
  ).toBeVisible();
  await categoryTile
    .getByRole("button", { name: "Go to previous page" })
    .click();

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

test("switching Dashboards fences an old cohort's pending refresh", async ({
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
  api.setAlternateDashboard(
    dashboard({
      id: delayedDashboardId,
      name: "Other Dashboard",
      widgets: [savedWidget(thirdWidgetId, 0, categoryFieldId)],
    }),
  );
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  await expect(
    page.getByRole("table", { name: "Complete data for Count by Region" }),
  ).toBeVisible();

  const pending = api.holdNextSnapshot();
  await page.getByRole("button", { name: "Refresh now", exact: true }).click();
  await pending.started;
  await expect(
    page.getByRole("button", { name: "Refreshing…" }),
  ).toBeDisabled();

  try {
    api.setSnapshotLength(2);
    await selectDashboard(page, delayedDashboardId);
    await expect(
      page
        .getByRole("table", { name: "Complete data for Count by Category" })
        .locator("tbody tr"),
    ).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: "Refresh now" }),
    ).toBeEnabled();
  } finally {
    api.setSnapshotLength(4);
    pending.release();
  }
  await expect(page.getByRole("button", { name: "Refresh now" })).toBeEnabled();
  await expect(
    page
      .getByRole("table", { name: "Complete data for Count by Category" })
      .locator("tbody tr"),
  ).toHaveCount(2);
});

test("department Dashboard builder saves Count over time and reloads the complete daily series", async ({
  page,
}) => {
  const api = await installDashboardApi(page);
  await page.goto("/openview?section=dashboards");

  await startNewDashboardDraft(page, "Equipment activity");
  const addDialog = await openAddWidgetDialog(page);
  await addDialog.getByLabel("Data source").selectOption(moduleId);
  await addDialog.getByLabel("Chart type").selectOption("line");
  const addLineChart = addDialog.getByRole("button", {
    name: "Add widget",
    exact: true,
  });
  await expect(addLineChart).toBeDisabled();
  const dateField = addDialog.getByLabel("Group by", { exact: true });
  await expect(dateField).toContainText("Occurred on");
  await expect(dateField).toContainText("Updated at");
  await dateField.selectOption(datetimeFieldId);
  await addDialog
    .getByRole("button", { name: "Date window", exact: true })
    .click();
  await page.getByLabel("From date", { exact: true }).fill("2024-02-28");
  await page.getByLabel("To date", { exact: true }).fill("2024-03-01");
  await page.keyboard.press("Escape");
  await expect(addLineChart).toBeEnabled();
  await addWidgetFromDialog(addDialog);
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
      ? savedWidget.config?.query.measure
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

test("department Dashboard Pie builder saves Sum and reloads its preview and complete table", async ({
  page,
}) => {
  const api = await installDashboardApi(page);
  await page.goto("/openview?section=dashboards");

  await startNewDashboardDraft(page, "Equipment distribution");
  const addDialog = await openAddWidgetDialog(page);
  await expect(addDialog.getByLabel("Data source")).toHaveValue(moduleId);
  await expect(addDialog.getByLabel("Group by", { exact: true })).toHaveValue(
    categoryFieldId,
  );
  await addDialog.getByLabel("Chart type").selectOption("pie");
  await addDialog.getByLabel("Measure", { exact: true }).selectOption("sum");
  const addPieChart = addDialog.getByRole("button", {
    name: "Add widget",
    exact: true,
  });
  await expect(addDialog.getByLabel("Group by", { exact: true })).toBeVisible();
  await expect(addDialog.getByLabel("Date field")).toHaveCount(0);
  await expect(addDialog.getByLabel("Start date")).toHaveCount(0);
  await expect(addPieChart).toBeDisabled();
  await addDialog.getByLabel("Numeric measure").selectOption(amountFieldId);
  await expect(addPieChart).toBeEnabled();
  await addWidgetFromDialog(addDialog);
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
  await expect(page.getByText("Showing 1–25 of 30")).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(25);
  expect(api.writes[0]?.body).toEqual({
    department_id: departmentId,
    position: 0,
    name: "Equipment distribution",
    refresh_cadence: "manual",
    widgets: [
      {
        widget_type: "chart",
        size: "M",
        chart_id: null,
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
  await page.getByRole("button", { name: "Go to next page" }).click();
  await expect(page.getByText("Showing 26–30 of 30")).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(5);
  expect(api.snapshots).toHaveLength(2);
  expect(api.snapshots[1]).toMatchObject({
    mode: "groups",
    aggregation: "sum",
    measure: { field_id: amountFieldId, expected_type: "decimal" },
    dimension: { field_id: categoryFieldId, expected_type: "select" },
  });

  await page.getByLabel("Rows per page").selectOption("50");
  await expect(page.getByText("Showing 1–30 of 30")).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(30);
  expect(api.snapshots).toHaveLength(2);
});

test("line chart builder blocks missing, reversed, and overlong date ranges", async ({
  page,
}) => {
  const api = await installDashboardApi(page);
  await page.goto("/openview?section=dashboards");

  const addDialog = await openAddWidgetDialog(page);
  await addDialog.getByLabel("Data source").selectOption(moduleId);
  await addDialog.getByLabel("Chart type").selectOption("line");
  const addLineChart = addDialog.getByRole("button", {
    name: "Add widget",
    exact: true,
  });
  const dateField = addDialog.getByLabel("Group by", { exact: true });
  await expect(dateField).toContainText("Occurred on");
  await expect(addLineChart).toBeDisabled();

  await dateField.selectOption(dateFieldId);
  await addDialog
    .getByRole("button", { name: "Date window", exact: true })
    .click();
  const startDate = page.getByLabel("From date", { exact: true });
  const endDate = page.getByLabel("To date", { exact: true });
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
  await page.keyboard.press("Escape");
  await dateField.selectOption("");
  await expect(addLineChart).toBeDisabled();
  await expect(
    page.getByText("0 of 12 widgets", { exact: true }),
  ).toBeVisible();
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
  const settingsDialog = await openDashboardSettingsDialog(page);
  await settingsDialog
    .getByLabel("Dashboard name")
    .fill("Unsaved operations draft");
  await finishDashboardDialog(settingsDialog);
  await page.getByRole("button", { name: "Save Dashboard" }).click();

  await expect(
    page.getByText("This item changed. Refresh it and try again."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Unsaved operations draft" }),
  ).toBeVisible();
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
  await page.getByRole("button", { name: "Dashboard options" }).click();
  await page.getByRole("menuitem", { name: "Archive Dashboard" }).click();
  await expect(page.getByText("Dashboard archived.")).toBeVisible();
  expect(api.writes[0]).toMatchObject({ method: "DELETE", dashboardId });

  await page.getByRole("button", { name: "Show archived" }).click();
  await selectDashboard(page, dashboardId);
  await page.getByRole("button", { name: "Dashboard options" }).click();
  await page.getByRole("menuitem", { name: "Restore Dashboard" }).click();
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  expect(api.writes[1]).toMatchObject({
    method: "POST",
    dashboardId,
    body: { revision: 2 },
  });
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
  await page.getByRole("button", { name: "Dashboard options" }).click();
  await page.getByRole("menuitem", { name: "Restore Dashboard" }).click();
  await expect(page.getByText("Dashboard restored.")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`dashboard=${dashboardId}`));

  await page.getByRole("button", { name: "New Dashboard" }).click();
  const newDialog = page.getByRole("dialog", { name: "New Dashboard" });
  await expect(newDialog).toBeVisible();
  await finishDashboardDialog(newDialog);
  const readsBeforeReselection = api.dashboardReads.length;
  await selectDashboard(page, dashboardId);
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  await expect
    .poll(() => api.dashboardReads.length)
    .toBe(readsBeforeReselection + 1);
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
    // The deep link is still pending when the list view changes.
    await expect(page).toHaveURL(new RegExp(`dashboard=${dashboardId}`));
    await page.getByRole("button", { name: "Show archived" }).click();
    const newDialog = await openNewDashboardDialog(page);
    const dashboardName = newDialog.getByLabel("Dashboard name");
    await dashboardName.fill("Draft after changing the list view");
    await finishDashboardDialog(newDialog);
    gate.release();
    await routeResponse;
    await expect(page).toHaveURL("/openview?section=dashboards");
    await expect(
      page.getByRole("heading", {
        name: "Draft after changing the list view",
      }),
    ).toBeVisible();
  } finally {
    gate.release();
  }
  await expect(
    page.getByRole("heading", { name: "Draft after changing the list view" }),
  ).toBeVisible();
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
    // The deep link is still pending when the new Dashboard starts.
    await expect(page).toHaveURL(new RegExp(`dashboard=${dashboardId}`));
    await page.getByRole("button", { name: "New Dashboard" }).click();
    const newDialog = page.getByRole("dialog", { name: "New Dashboard" });
    await expect(newDialog).toBeVisible();
    const dashboardName = newDialog.getByLabel("Dashboard name");
    await dashboardName.fill("Draft after starting a new Dashboard");
    await finishDashboardDialog(newDialog);
    gate.release();
    await routeResponse;
    await expect(page).toHaveURL("/openview?section=dashboards");
    await expect(
      page.getByRole("heading", {
        name: "Draft after starting a new Dashboard",
      }),
    ).toBeVisible();
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
  const restoreButton = page.getByRole("button", {
    name: "Restore Operations",
  });
  await expect(restoreButton).toBeVisible();
  const newDialog = await openNewDashboardDialog(page);
  const nameInput = newDialog.getByLabel("Dashboard name");
  await nameInput.fill("Unsaved Dashboard draft");
  await finishDashboardDialog(newDialog);

  await expect(restoreButton).toBeDisabled();
  await expect(
    page.getByRole("heading", { name: "Unsaved Dashboard draft" }),
  ).toBeVisible();
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
  await page.getByRole("button", { name: "Go to next page" }).click();
  await page.getByRole("button", { name: "Go to next page" }).click();
  await expect(page.getByText("Showing 51–60 of 60")).toBeVisible();

  api.setSnapshotLength(30);
  await page.getByRole("button", { name: "Refresh now" }).click();
  await expect(page.getByText("Showing 26–30 of 30")).toBeVisible();
  await page.getByRole("button", { name: "Go to previous page" }).click();
  await expect(page.getByText("Showing 1–25 of 30")).toBeVisible();
});

test("the categorical Count builder excludes numeric and date fields", async ({
  page,
}) => {
  await installDashboardApi(page);
  await page.goto("/openview?section=dashboards");
  const addDialog = await openAddWidgetDialog(page);
  await addDialog.getByLabel("Data source").selectOption(moduleId);

  const dimension = addDialog.getByLabel("Group by", { exact: true });
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

  await startNewDashboardDraft(page, "Draft kept after cancel");

  const reportsLink = page.getByRole("link", { name: "Reports", exact: true });
  await reportsLink.click();
  const discardDialog = page.getByRole("alertdialog");
  await expect(discardDialog).toBeVisible();
  await expect(page).toHaveURL("/openview?section=dashboards");
  await discardDialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(discardDialog).toBeHidden();
  await expect(page).toHaveURL("/openview?section=dashboards");
  await expect(
    page.getByRole("heading", { name: "Draft kept after cancel" }),
  ).toBeVisible();

  await reportsLink.click();
  await discardDialog
    .getByRole("button", { name: "Discard and continue" })
    .click();
  await expect(page).toHaveURL("/openview?section=reports");
  await expect(
    page.getByRole("heading", { name: "Draft kept after cancel" }),
  ).toHaveCount(0);

  await page.getByRole("link", { name: "Dashboards", exact: true }).click();
  await expect(page).toHaveURL("/openview?section=dashboards");
  await startNewDashboardDraft(page, "Draft before workspace change");
  await page.getByRole("link", { name: "Search workspace" }).click();
  await expect(discardDialog).toBeVisible();
  await discardDialog
    .getByRole("button", { name: "Discard and continue" })
    .click();
  await expect(page).toHaveURL("/platform");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("switching to archived Dashboards cannot restore stale active rows", async ({
  page,
}) => {
  const api = await installDashboardApi(page, dashboard({ widgets: [] }));
  const gate = requestGate();
  await page.route("**/api/dashboards?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("deleted") === "only") {
      gate.signalStarted();
      await gate.wait;
    }
    await route.fallback();
  });
  await page.goto("/openview?section=dashboards");
  await selectDashboard(page, dashboardId);
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  try {
    await page.getByRole("button", { name: "Show archived" }).click();
    await gate.started;
    await expect(
      page.getByRole("button", { name: "Restore Operations" }),
    ).toHaveCount(0);
    expect(api.writes).toHaveLength(0);
    gate.release();
    await expect(page.getByText("No archived Dashboards.")).toBeVisible();
  } finally {
    gate.release();
  }
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
  await selectDashboard(page, dashboardId);
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();

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
      page
        .getByLabel("Dashboard", { exact: true })
        .getByRole("option", { name: /Late active page/ }),
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

  const addDialog = await openAddWidgetDialog(page);
  await addDialog.getByLabel("Data source").selectOption(moduleId);
  const dimension = addDialog.getByLabel("Group by", { exact: true });
  await expect(dimension.getByRole("option", { name: "Category" })).toHaveCount(
    1,
  );
  await addDialog.getByRole("button", { name: "Load more fields" }).click();

  try {
    await gate.started;
    await addDialog.getByLabel("Data source").selectOption(secondModuleId);
    await expect(
      dimension.getByRole("option", { name: "Process" }),
    ).toHaveCount(1);
    gate.release();

    await addDialog.getByRole("button", { name: "Load more fields" }).click();
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

test("department Dashboard saves and reloads all four live widget types", async ({
  page,
}) => {
  const api = await installDashboardApi(page);
  api.setRecordResultCount(30);
  await page.goto("/openview?section=dashboards");

  const newDialog = await openNewDashboardDialog(page);
  await newDialog.getByLabel("Dashboard name").fill("Live operations");
  await newDialog.getByLabel("Refresh cadence").selectOption("one-minute");
  await finishDashboardDialog(newDialog);

  let addDialog = await openAddWidgetDialog(page);
  await addDialog.getByLabel("Data source").selectOption(moduleId);
  await addDialog.getByLabel("Widget type").selectOption("summary");
  await addDialog
    .getByLabel("Group by", { exact: true })
    .selectOption(categoryFieldId);
  await addWidgetFromDialog(addDialog);

  addDialog = await openAddWidgetDialog(page);
  await addDialog.getByLabel("Data source").selectOption(moduleId);
  await addDialog.getByLabel("Widget type").selectOption("workload");
  await addDialog.getByLabel("Measure", { exact: true }).selectOption("sum");
  await addDialog.getByLabel("Numeric measure").selectOption(amountFieldId);
  await addDialog
    .getByLabel("Group by", { exact: true })
    .selectOption(regionFieldId);
  await addWidgetFromDialog(addDialog);

  addDialog = await openAddWidgetDialog(page);
  await addDialog.getByLabel("Data source").selectOption(moduleId);
  await addDialog.getByLabel("Widget type").selectOption("records");
  await addDialog
    .getByRole("button", { name: "Records options", exact: true })
    .click();
  await page.getByLabel("Include Category", { exact: true }).check();
  await page.keyboard.press("Escape");
  await addWidgetFromDialog(addDialog);

  addDialog = await openAddWidgetDialog(page);
  await addDialog.getByLabel("Data source").selectOption(moduleId);
  await addDialog.getByLabel("Widget type").selectOption("chart");
  await addDialog.getByLabel("Measure", { exact: true }).selectOption("count");
  await addDialog
    .getByLabel("Group by", { exact: true })
    .selectOption(categoryFieldId);
  await addWidgetFromDialog(addDialog);
  await expect(
    page.getByText("4 of 12 widgets", { exact: true }),
  ).toBeVisible();
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
  await expect(
    page.getByRole("heading", { name: /Workload by Region/ }),
  ).toBeVisible();
  const workloadTable = page.getByRole("table", { name: "Workload breakdown" });
  const workloadTile = page.getByRole("article", {
    name: "Workload by Region",
    exact: true,
  });
  await expect(workloadTable.locator("tbody tr")).toHaveCount(25);
  const snapshotsBeforeWorkloadPageSize = api.snapshots.length;
  await workloadTile.getByLabel("Rows per page").selectOption("5");
  await expect(workloadTable.locator("tbody tr")).toHaveCount(5);
  await expect(page.getByText("Showing 1–5 of 30")).toBeVisible();
  expect(api.snapshots).toHaveLength(snapshotsBeforeWorkloadPageSize);
  await workloadTile.getByLabel("Rows per page").selectOption("25");
  await expect(workloadTable.locator("tbody tr")).toHaveCount(25);

  const recordsTile = page.getByRole("article", {
    name: "Records showing Category",
    exact: true,
  });
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
  await expect(
    recordsTile.getByRole("navigation", { name: "Dashboard result pages" }),
  ).toBeVisible();
  await recordsTile
    .getByRole("navigation", { name: "Dashboard result pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  await expect.poll(() => api.recordQueries.at(-1)?.offset).toBe(25);
  await expect(
    recordsTable.getByRole("cell", { name: "Record 26" }),
  ).toBeVisible();
  await recordsTile.getByLabel("Rows per page").selectOption("50");
  await expect.poll(() => api.recordQueries.at(-1)?.limit).toBe(50);
  await expect.poll(() => api.recordQueries.at(-1)?.offset).toBe(0);
  await expect(recordsTable.locator("tbody tr")).toHaveCount(30);
  await expect(
    recordsTable.getByRole("cell", { name: "Record 30" }),
  ).toBeVisible();
  expect(api.recordQueries.at(-1)).toMatchObject({ limit: 50, offset: 0 });
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

  await startNewDashboardDraft(page, "Later field records");
  const addDialog = await openAddWidgetDialog(page);
  await addDialog.getByLabel("Data source").selectOption(moduleId);
  await addDialog.getByLabel("Widget type").selectOption("records");
  await addDialog.getByRole("button", { name: "Load more fields" }).click();
  await addDialog
    .getByRole("button", { name: "Records options", exact: true })
    .click();
  await page.getByLabel("Include Later field", { exact: true }).check();
  await page.keyboard.press("Escape");
  await addWidgetFromDialog(addDialog);
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

test("Dashboard cadence counts from fetch completion and resumes overdue reads once", async ({
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
    // Observe the API response body finishing, independently of Query timers.
    // Notification stepping may advance the fake clock after that boundary.
    const responseJson = Response.prototype.json;
    Response.prototype.json = async function () {
      const value: unknown = await responseJson.call(this);
      if (new URL(this.url).pathname === "/api/records/aggregate-snapshots")
        Object.defineProperty(window, "dashboardSnapshotFinishedAt", {
          configurable: true,
          value: Date.now(),
        });
      return value;
    };
  });
  const api = await installDashboardApi(
    page,
    dashboard({ refresh_cadence: "manual" }),
  );
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  const table = page.getByRole("table", {
    name: "Complete data for Count by Category",
  });
  const refresh = page.getByRole("button", { name: "Refresh now" });
  // Count, never wait: while a read runs the button is named "Refreshing…",
  // and a waiting read would block the paused clock that read needs.
  const ready = page.getByRole("button", {
    name: "Refresh now",
    disabled: false,
  });
  const settle = async () => {
    await settleDashboardClock(
      page,
      async () => (await ready.count()) === 1,
      true,
    );
    await expect(refresh).toBeEnabled();
  };
  const setVisibility = async (state: DocumentVisibilityState) => {
    await page.evaluate((next) => {
      const browserWindow = window as unknown as Window & {
        setTestVisibility: (value: DocumentVisibilityState) => void;
      };
      browserWindow.setTestVisibility(next);
    }, state);
    await page.clock.runFor(1);
  };
  const stepToCadence = async (interval: number) => {
    const before = api.snapshots.length;
    const remaining = await page.evaluate((cadence) => {
      const finished = (
        window as unknown as Window & { dashboardSnapshotFinishedAt: number }
      ).dashboardSnapshotFinishedAt;
      return finished + cadence - Date.now();
    }, interval);
    expect(remaining).toBeGreaterThan(1);
    await page.clock.runFor(remaining - 1);
    expect(api.snapshots).toHaveLength(before);
    await page.clock.runFor(1);
    await expect.poll(() => api.snapshots.length).toBe(before + 1);
  };
  await settleDashboardClock(page, () => table.isVisible(), true);
  await expect(table).toBeVisible();
  await settle();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 60_000));
  const manualSnapshotCount = api.snapshots.length;
  await page.clock.runFor(300_000);
  expect(api.snapshots).toHaveLength(manualSnapshotCount);

  const minuteSettings = await openDashboardSettingsDialog(page, true);
  await minuteSettings.getByLabel("Refresh cadence").selectOption("one-minute");
  await finishDashboardDialog(minuteSettings, page);
  await expect(
    page.getByText("Unsaved changes", { exact: true }),
  ).toBeVisible();
  await page.clock.runFor(60_000);
  expect(api.snapshots).toHaveLength(manualSnapshotCount);
  await page.getByRole("button", { name: "Save Dashboard" }).click();
  await settleDashboardClock(
    page,
    async () => api.snapshots.length,
    manualSnapshotCount + 1,
  );
  await settle();
  await expect(
    page.getByText(/Every minute while this page is open/),
  ).toBeVisible();

  // A slow request must finish before the next minute starts counting.
  const slow = api.holdNextSnapshot();
  await stepToCadence(60_000);
  await slow.started;
  const pendingCount = api.snapshots.length;
  await page.clock.runFor(90_000);
  expect(api.snapshots).toHaveLength(pendingCount);
  api.setSnapshotLength(2);
  slow.release();
  await settleDashboardClock(page, () => table.locator("tbody tr").count(), 2);
  await settle();
  await stepToCadence(60_000);
  await settle();

  // A hidden answer cannot replace last-good rows. An overdue return reads now.
  api.setSnapshotLength(4);
  const hidden = api.holdNextSnapshot();
  await stepToCadence(60_000);
  await hidden.started;
  const hiddenCount = api.snapshots.length;
  await setVisibility("hidden");
  hidden.release();
  await page.clock.runFor(1);
  await page.clock.runFor(120_000);
  expect(api.snapshots).toHaveLength(hiddenCount);
  await expect(
    page
      .getByRole("table", {
        name: "Complete data for Count by Category",
        includeHidden: true,
      })
      .locator("tbody tr"),
  ).toHaveCount(2);
  api.setSnapshotLength(6);
  await setVisibility("visible");
  await settleDashboardClock(
    page,
    async () => api.snapshots.length,
    hiddenCount + 1,
  );
  await settleDashboardClock(page, () => table.locator("tbody tr").count(), 6);
  await settle();
  await expect(
    page.getByRole("dialog", { name: "Session verification" }),
  ).toHaveCount(0);

  // A short hidden pause keeps the same completion-based deadline.
  await page.clock.runFor(20_000);
  await setVisibility("hidden");
  const shortPauseCount = api.snapshots.length;
  await page.clock.runFor(10_000);
  await setVisibility("visible");
  expect(api.snapshots).toHaveLength(shortPauseCount);
  await stepToCadence(60_000);
  await settle();

  // Dirty saved widgets pause their saved cadence as well as a new cadence.
  const dirtySettings = await openDashboardSettingsDialog(page, true);
  await dirtySettings.getByLabel("Dashboard name").fill("My cadence draft");
  await finishDashboardDialog(dirtySettings, page);
  const dirtyCount = api.snapshots.length;
  await page.clock.runFor(120_000);
  expect(api.snapshots).toHaveLength(dirtyCount);
  await page.getByRole("button", { name: "Save Dashboard" }).click();
  await settleDashboardClock(
    page,
    async () => api.snapshots.length,
    dirtyCount + 1,
  );
  await settle();

  const fiveMinuteSettings = await openDashboardSettingsDialog(page, true);
  await fiveMinuteSettings
    .getByLabel("Refresh cadence")
    .selectOption("five-minutes");
  await finishDashboardDialog(fiveMinuteSettings, page);
  const fiveMinuteDraftCount = api.snapshots.length;
  await page.clock.runFor(300_000);
  expect(api.snapshots).toHaveLength(fiveMinuteDraftCount);
  await page.getByRole("button", { name: "Save Dashboard" }).click();
  await settleDashboardClock(
    page,
    async () => api.snapshots.length,
    fiveMinuteDraftCount + 1,
  );
  await settle();
  await expect(
    page.getByText(/Every five minutes while this page is open/),
  ).toBeVisible();
  await stepToCadence(300_000);
  await settle();
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
            "/api/records/aggregate-snapshots" && response.status() === 403,
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

test("a refused Dashboard read hides the retained Dashboard and offers Retry", async ({
  page,
}) => {
  const api = await installDashboardApi(page, dashboard());
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  const table = page.getByRole("table", {
    name: "Complete data for Count by Category",
  });
  await expect(table.locator("tbody tr")).toHaveCount(25);

  const pending = api.holdNextSnapshot(403);
  await page.getByRole("button", { name: "Refresh now" }).click();
  await pending.started;
  pending.release();
  await expect(
    page.getByText(
      "OpenView data is unavailable. Sign in or ask for access, then retry.",
    ),
  ).toBeVisible();
  await expect(table).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Operations" })).toHaveCount(
    0,
  );
  // Retry reads the refused widget again, not only the list and catalog.
  await page
    .getByRole("alert")
    .filter({
      hasText:
        "OpenView data is unavailable. Sign in or ask for access, then retry.",
    })
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await expect(table.locator("tbody tr")).toHaveCount(25);
});

test("duplicating a Dashboard creates an independent copy in the same department", async ({
  page,
}) => {
  const source = dashboard({ refresh_cadence: "five-minutes", position: 3 });
  const api = await installDashboardApi(page, source);
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();

  await page.getByRole("button", { name: "Dashboard options" }).click();
  await page.getByRole("menuitem", { name: "Duplicate Dashboard" }).click();
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
      department_id: departmentId,
      position: 3,
      name: "Copy of Operations",
      refresh_cadence: "five-minutes",
      widgets: [{ widget_type: "chart" }],
    },
  });

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Copy of Operations" }),
  ).toBeVisible();
  await selectDashboard(page, dashboardId);
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
});

test("a department reader sees its Dashboards without change controls", async ({
  page,
}) => {
  await installDashboardApi(page, dashboard(), {
    role: "member",
    access: [{ department_id: departmentId, module_id: null, level: "read" }],
  });
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);

  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  await expect(page.getByText("Field service", { exact: true })).toBeVisible();
  await expect(page.getByText(/private|only you/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New Dashboard" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Add widget" })).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Dashboard options" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Reload saved Dashboard" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Widget options:/ }),
  ).toHaveCount(0);
  for (const name of [
    "Dashboard settings",
    "Duplicate Dashboard",
    "Archive Dashboard",
  ])
    await expect(page.getByRole("menuitem", { name })).toHaveCount(0);
});

test("Dashboards opens the first Dashboard by position when none is chosen", async ({
  page,
}) => {
  await installDashboardApi(page, dashboard(), {
    role: "member",
    access: [{ department_id: departmentId, module_id: null, level: "read" }],
  });
  const listed = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return (
      url.pathname === "/api/dashboards" &&
      url.searchParams.get("sort_by") === "position" &&
      url.searchParams.get("sort_order") === "asc"
    );
  });
  await page.goto("/openview?section=dashboards");
  await listed;

  await expect(page).toHaveURL(
    `/openview?section=dashboards&dashboard=${dashboardId}`,
  );
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
});

test("a new Dashboard is created in a managed department", async ({ page }) => {
  const api = await installDashboardApi(page, null, {
    role: "member",
    access: [{ department_id: departmentId, module_id: null, level: "manage" }],
  });
  await page.goto("/openview?section=dashboards");
  await page.getByRole("button", { name: "New Dashboard" }).click();
  const dialog = page.getByRole("dialog", { name: "New Dashboard" });
  await expect(dialog.getByLabel("Department")).toContainText("Field service");
  await dialog.getByLabel("Dashboard name").fill("Weekly review");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Save Dashboard" }).click();

  await expect.poll(() => api.writes.length).toBe(1);
  expect(api.writes[0]?.body).toMatchObject({
    department_id: departmentId,
    name: "Weekly review",
  });
});

test("Cancel discards a new Dashboard draft and returns to the selected Dashboard", async ({
  page,
}) => {
  const api = await installDashboardApi(page, dashboard());
  await page.goto(`/openview?section=dashboards&dashboard=${dashboardId}`);
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  await page.getByRole("button", { name: "New Dashboard" }).click();
  const dialog = page.getByRole("dialog", { name: "New Dashboard" });
  await dialog.getByLabel("Dashboard name").fill("Discard me");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`dashboard=${dashboardId}`));
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  expect(api.writes).toHaveLength(0);
});

test("a Dashboard department picker searches beyond its first page and resolves the saved label", async ({
  page,
}) => {
  const api = await installDashboardApi(page);
  const laterDepartmentId = "50000000-0000-4000-8000-000000000001";
  const queries: string[] = [];
  const department = (id: string, name: string) => ({
    id,
    department_name: name,
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    is_deleted: false,
    performed_by: null,
  });
  await page.route("**/api/departments**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/departments/${laterDepartmentId}`)
      return route.fulfill({ json: department(laterDepartmentId, "Dispatch") });
    const search = url.searchParams.get("search") ?? "";
    queries.push(search);
    const items =
      search === "Dispatch"
        ? [department(laterDepartmentId, "Dispatch")]
        : Array.from({ length: 100 }, (_, index) =>
            department(
              `60000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
              `Early department ${index + 1}`,
            ),
          );
    return route.fulfill({
      json: {
        items,
        pagination: wirePagination({
          limit: 100,
          count: items.length,
          total: search ? 1 : 101,
          has_more: !search,
        }),
      },
    });
  });
  await page.goto("/openview?section=dashboards");
  await page
    .getByRole("button", { name: "New Dashboard", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "New Dashboard",
    exact: true,
  });
  await dialog.getByLabel("Department", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "Search department", exact: true })
    .fill("Dispatch");
  await page.getByRole("option", { name: "Dispatch", exact: true }).click();
  await expect(dialog.getByLabel("Department", { exact: true })).toContainText(
    "Dispatch",
  );
  await dialog
    .getByLabel("Dashboard name", { exact: true })
    .fill("Dispatch dashboard");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("button", { name: "Save Dashboard", exact: true })
    .click();
  await expect.poll(() => api.writes.length).toBe(1);
  expect(api.writes[0]?.body?.department_id).toBe(laterDepartmentId);
  expect(queries).toContain("Dispatch");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Dispatch dashboard", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Dispatch", { exact: true }).first(),
  ).toBeVisible();
});
