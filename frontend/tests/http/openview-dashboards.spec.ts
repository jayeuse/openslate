import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import { captureOpenViewReview } from "./helpers/openview-review-capture";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";

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
  identity: {
    role: "admin" | "member" | "guest";
    access: { department_id: string; module_id: null; level: string }[];
  } = { role: "admin", access: [] },
) {
  await installOpenViewEventSource(page);
  await page.route("**/api/**", (route) =>
    route.fulfill({
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
  const recordQueries: RecordQueryRequest[] = [];
  let nextSnapshotErrorStatus: 401 | 403 | 503 | null = null;
  let snapshotErrorResponsesRemaining = 0;
  let nextRecordQueryErrorStatus: 401 | 403 | null = null;
  let recordQueryErrorResponsesRemaining = 0;
  let recordResultCount = 2;
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
  await page.route("**/api/auth/me", async (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ id: userId, ...identity }),
    }),
  );
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
        pagination: {
          limit: 100,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
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
      body: JSON.stringify({
        items,
        pagination: {
          limit: request.limit,
          offset: request.offset,
          count: items.length,
          total: allItems.length,
          has_more: request.offset + items.length < allItems.length,
        },
      }),
    });
  });

  return {
    writes,
    snapshots,
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
  const dimensions = await page.getByRole("main").evaluate((main) => ({
    clientWidth: main.clientWidth,
    scrollWidth: main.scrollWidth,
  }));
  expect(
    dimensions.scrollWidth,
    "Dashboard controls and content should not overflow horizontally at mobile width",
  ).toBeLessThanOrEqual(dimensions.clientWidth);
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
  await add.getByLabel("Group records by").selectOption(regionFieldId);
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
  ).not.toBeVisible();
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
  await expect(moduleSelect).toBeFocused();
  await tabTo(page, moduleSelect);
  await expectVisibleKeyboardFocus(moduleSelect);
  await expect(moduleSelect).toContainText("Equipment");
  await page.keyboard.press("e");
  await expect(moduleSelect).toHaveValue(moduleId);

  const dimension = addDialog.getByLabel("Group records by");
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
  await addWidgetDialog.getByLabel("Data source").selectOption(moduleId);
  await expect(addWidgetDialog.getByLabel("Group records by")).toHaveValue(
    categoryFieldId,
  );
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

test("department Dashboard saves ordered charts and reloads only the selected complete snapshot", async ({
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
  await addDialog.getByLabel("Group records by").selectOption(categoryFieldId);
  await addWidgetFromDialog(addDialog);
  addDialog = await openAddWidgetDialog(page);
  await addDialog.getByLabel("Group records by").selectOption(regionFieldId);
  await addWidgetFromDialog(addDialog);
  await expect(
    page.getByText("2 of 12 widgets", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Widget options: Count by Region" })
    .click();
  await page.getByRole("menuitem", { name: "Move up" }).click();
  addDialog = await openAddWidgetDialog(page);
  await addDialog.getByLabel("Group records by").selectOption(categoryFieldId);
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
  await expect(page.getByText("Showing 1–25 of 30")).toBeVisible();
  await expect(
    page
      .getByRole("table", { name: "Complete data for Count by Category" })
      .locator("tbody tr"),
  ).toHaveCount(25);
  await expect(
    page.getByRole("navigation", { name: "Dashboard result pages" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Go to next page" }).click();
  await expect(page.getByText("Showing 26–30 of 30")).toBeVisible();
  await expect(
    page
      .getByRole("table", { name: "Complete data for Count by Category" })
      .getByText("Group 30"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Go to previous page" }).click();

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
  const dateField = addDialog.getByLabel("Date field");
  await expect(dateField).toContainText("Occurred on");
  await expect(dateField).toContainText("Updated at");
  await dateField.selectOption(datetimeFieldId);
  await addDialog.getByLabel("Start date").fill("2024-02-28");
  await addDialog.getByLabel("End date").fill("2024-03-01");
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

  await startNewDashboardDraft(page, "Equipment totals");
  const addDialog = await openAddWidgetDialog(page);
  await addDialog.getByLabel("Data source").selectOption(moduleId);
  await addDialog.getByLabel("Aggregation").selectOption("sum");
  const addChart = addDialog.getByRole("button", {
    name: "Add widget",
    exact: true,
  });
  const measure = addDialog.getByLabel("Numeric measure");
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
  await addWidgetFromDialog(addDialog);
  await page.getByRole("button", { name: "Save Dashboard" }).click();

  await expect(page).toHaveURL(new RegExp(`dashboard=${dashboardId}`));
  await expect(
    page.getByRole("table", {
      name: "Complete data for Sum of Amount by Category",
    }),
  ).toBeVisible();
  expect(api.writes[0]?.body).toEqual({
    department_id: departmentId,
    position: 0,
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

test("department Dashboard Pie builder saves Sum and reloads its preview and complete table", async ({
  page,
}) => {
  const api = await installDashboardApi(page);
  await page.goto("/openview?section=dashboards");

  await startNewDashboardDraft(page, "Equipment distribution");
  const addDialog = await openAddWidgetDialog(page);
  await addDialog.getByLabel("Data source").selectOption(moduleId);
  await addDialog.getByLabel("Chart type").selectOption("pie");
  await addDialog.getByLabel("Aggregation").selectOption("sum");
  const addPieChart = addDialog.getByRole("button", {
    name: "Add widget",
    exact: true,
  });
  await expect(addDialog.getByLabel("Group records by")).toBeVisible();
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

test("Dashboard line builder requires and saves a typed numeric measure for Average", async ({
  page,
}) => {
  const api = await installDashboardApi(page);
  await page.goto("/openview?section=dashboards");

  await startNewDashboardDraft(page, "Daily scores");
  const addDialog = await openAddWidgetDialog(page);
  await addDialog.getByLabel("Data source").selectOption(moduleId);
  await addDialog.getByLabel("Chart type").selectOption("line");
  await addDialog.getByLabel("Aggregation").selectOption("average");
  const addLineChart = addDialog.getByRole("button", {
    name: "Add widget",
    exact: true,
  });
  const measure = addDialog.getByLabel("Numeric measure");
  await expect(measure).toHaveValue("");
  await expect(addLineChart).toBeDisabled();
  await measure.selectOption(scoreFieldId);
  await addDialog.getByLabel("Date field").selectOption(dateFieldId);
  await addDialog.getByLabel("Start date").fill("2024-03-01");
  await addDialog.getByLabel("End date").fill("2024-03-02");
  await expect(addLineChart).toBeEnabled();
  await addWidgetFromDialog(addDialog);
  await page.getByRole("button", { name: "Save Dashboard" }).click();

  await expect(page).toHaveURL(new RegExp(`dashboard=${dashboardId}`));
  const table = page.getByRole("table", {
    name: "Complete data for Average of Score over time",
  });
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(2);
  expect(api.writes[0]?.body).toEqual({
    department_id: departmentId,
    position: 0,
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

  const addDialog = await openAddWidgetDialog(page);
  await addDialog.getByLabel("Data source").selectOption(moduleId);
  await addDialog.getByLabel("Chart type").selectOption("line");
  const addLineChart = addDialog.getByRole("button", {
    name: "Add widget",
    exact: true,
  });
  const dateField = addDialog.getByLabel("Date field");
  await expect(dateField).toContainText("Occurred on");
  await expect(addLineChart).toBeDisabled();

  await dateField.selectOption(dateFieldId);
  const startDate = addDialog.getByLabel("Start date");
  const endDate = addDialog.getByLabel("End date");
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
    await page.getByRole("button", { name: "Show archived" }).click();
    expect(page.url()).toContain(`dashboard=${dashboardId}`);
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
    await page.getByRole("button", { name: "New Dashboard" }).click();
    expect(page.url()).toContain(`dashboard=${dashboardId}`);
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

  const dimension = addDialog.getByLabel("Group records by");
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
  const dimension = addDialog.getByLabel("Group records by");
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
  await addDialog.getByLabel("Group records by").selectOption(categoryFieldId);
  await addWidgetFromDialog(addDialog);

  addDialog = await openAddWidgetDialog(page);
  await addDialog.getByLabel("Data source").selectOption(moduleId);
  await addDialog.getByLabel("Widget type").selectOption("workload");
  await addDialog.getByLabel("Aggregation").selectOption("sum");
  await addDialog.getByLabel("Numeric measure").selectOption(amountFieldId);
  await addDialog.getByLabel("Group records by").selectOption(regionFieldId);
  await addWidgetFromDialog(addDialog);

  addDialog = await openAddWidgetDialog(page);
  await addDialog.getByLabel("Data source").selectOption(moduleId);
  await addDialog.getByLabel("Widget type").selectOption("records");
  await addDialog.getByLabel("Display field").selectOption(categoryFieldId);
  await addWidgetFromDialog(addDialog);

  addDialog = await openAddWidgetDialog(page);
  await addDialog.getByLabel("Data source").selectOption(moduleId);
  await addDialog.getByLabel("Widget type").selectOption("chart");
  await addDialog.getByLabel("Aggregation").selectOption("count");
  await addDialog.getByLabel("Group records by").selectOption(categoryFieldId);
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
  await page.getByRole("button", { name: /View workload 2/ }).click();
  await expect(
    page.getByRole("heading", { name: /Workload by Region/ }),
  ).toBeVisible();
  const workloadTable = page.getByRole("table", { name: "Workload breakdown" });
  await expect(workloadTable.locator("tbody tr")).toHaveCount(25);
  const snapshotsBeforeWorkloadPageSize = api.snapshots.length;
  await page.getByLabel("Rows per page").selectOption("5");
  await expect(workloadTable.locator("tbody tr")).toHaveCount(5);
  await expect(page.getByText("Showing 1–5 of 30")).toBeVisible();
  expect(api.snapshots).toHaveLength(snapshotsBeforeWorkloadPageSize);
  await page.getByLabel("Rows per page").selectOption("25");
  await expect(workloadTable.locator("tbody tr")).toHaveCount(25);

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
  await expect(
    page.getByRole("navigation", { name: "Dashboard result pages" }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Dashboard result pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  await expect.poll(() => api.recordQueries.at(-1)?.offset).toBe(25);
  await expect(
    recordsTable.getByRole("cell", { name: "Record 26" }),
  ).toBeVisible();
  await page.getByLabel("Rows per page").selectOption("50");
  await expect.poll(() => api.recordQueries.at(-1)?.limit).toBe(50);
  await expect.poll(() => api.recordQueries.at(-1)?.offset).toBe(0);
  await expect(recordsTable.locator("tbody tr")).toHaveCount(30);
  await expect(
    recordsTable.getByRole("cell", { name: "Record 30" }),
  ).toBeVisible();
  expect(api.recordQueries.at(-1)).toMatchObject({ limit: 50, offset: 0 });
  await page.getByRole("button", { name: /View chart 4/ }).click();
  await expect(
    page.getByRole("table", { name: "Complete data for Count by Category" }),
  ).toBeVisible();
  await captureOpenViewReview(page, "dashboard-manager");
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
  await addDialog.getByLabel("Display field").selectOption(laterFieldId);
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
      if (new URL(this.url).pathname === "/api/records/aggregate-snapshot")
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
  const settle = async () => {
    await settleDashboardClock(page, () => refresh.isEnabled(), true);
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
  await captureOpenViewReview(page, "dashboard-reader");
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

test("S08 a Dashboard department picker searches beyond its first page and resolves the saved label", async ({
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
        pagination: {
          limit: 100,
          offset: 0,
          count: items.length,
          total: search ? 1 : 101,
          has_more: !search,
        },
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
    .getByRole("combobox", { name: "Department", exact: true })
    .and(page.getByPlaceholder("Search…", { exact: true }))
    .fill("Dispatch");
  await page.getByRole("option", { name: "Dispatch", exact: true }).click();
  await expect(dialog.getByLabel("Department", { exact: true })).toContainText(
    "Dispatch",
  );
  await dialog
    .getByLabel("Dashboard name", { exact: true })
    .fill("Dispatch dashboard");
  if (process.env.OPENVIEW_CAPTURE_DIR) {
    const departmentTrigger = dialog.getByLabel("Department", { exact: true });
    await departmentTrigger.focus();
    await departmentTrigger.press("Enter");
    const searchInput = page
      .getByRole("combobox", { name: "Department", exact: true })
      .and(page.getByPlaceholder("Search…", { exact: true }));
    await expect(searchInput).toBeFocused();
    for (const mode of ["light", "dark"] as const) {
      await page.evaluate((theme) => {
        document.documentElement.classList.toggle("dark", theme === "dark");
      }, mode);
      await captureOpenViewReview(page, `s08-dashboard-department-${mode}`, {
        beforeScreenshot: async () => {
          await expect(searchInput).toBeVisible();
          await expect
            .poll(() =>
              page.evaluate(
                () => document.documentElement.scrollWidth <= window.innerWidth,
              ),
            )
            .toBe(true);
        },
      });
    }
    await searchInput.press("Escape");
    await expect(departmentTrigger).toBeFocused();
  }
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
