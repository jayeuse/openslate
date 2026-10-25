import { expect, type Page, type Route } from "@playwright/test";
import { installOpenViewEventSource } from "./openview-event-source";
import { isEventStream, signedInAs, type SignedInIdentity } from "./test";
import { pageOf, wirePagination } from "../../helpers/pagination";
import {
  wireBucket,
  wireField,
  wireRecord,
  wireWorkspace,
} from "../../helpers/wire";

// A department dashboard backend for the browser journeys of
// docs/specs/openview-dashboard.md: two departments (Field service and the
// linked Finance), their modules and fields, the dashboards of Field service,
// per-module snapshot reads, record pages and saved charts.

export const ids = {
  user: "00000000-0000-4000-8000-000000000101",
  department: "00000000-0000-4000-8000-000000000201",
  finance: "00000000-0000-4000-8000-000000000202",
  equipment: "00000000-0000-4000-8000-000000000301",
  checks: "00000000-0000-4000-8000-000000000302",
  invoices: "00000000-0000-4000-8000-000000000303",
  category: "00000000-0000-4000-8000-000000000401",
  amount: "00000000-0000-4000-8000-000000000402",
  occurred: "00000000-0000-4000-8000-000000000403",
  checkStatus: "00000000-0000-4000-8000-000000000404",
  invoiceStatus: "00000000-0000-4000-8000-000000000405",
  invoiceLink: "00000000-0000-4000-8000-000000000406",
  home: "00000000-0000-4000-8000-000000000501",
  other: "00000000-0000-4000-8000-000000000502",
  archived: "00000000-0000-4000-8000-000000000503",
  chart: "00000000-0000-4000-8000-000000000601",
};
export const timestamp = "2026-10-26T00:00:00Z";

type FieldReference = { field_id: string; expected_type: string };
export type Placement = {
  grid_column: number | null;
  grid_row: number | null;
  column_span: number | null;
  row_span: number | null;
};
export type WidgetWire = Placement & {
  id: string;
  position: number;
  widget_type: "summary" | "workload" | "records" | "chart";
  chart_id: string | null;
  config: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};
export type DashboardWire = {
  id: string;
  department_id: string;
  position: number;
  name: string;
  refresh_cadence: "manual" | "one-minute" | "five-minutes";
  revision: number;
  is_deleted: boolean;
  is_home: boolean;
  created_at: string;
  updated_at: string;
  widgets: WidgetWire[];
};
export type WidgetBody = Omit<
  WidgetWire,
  "id" | "position" | "created_at" | "updated_at"
>;
export type DashboardWrite = {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
};

export const definition = {
  version: 1,
  logic: "and",
  columns: [],
  filters: [],
  sort: [],
  deleted: "exclude",
  search: null,
  search_fields: [],
};
const select = (id: string): FieldReference => ({
  field_id: id,
  expected_type: "select",
});

export function at(
  column: number,
  row: number,
  columns: number,
  rows: number,
): Placement {
  return {
    grid_column: column,
    grid_row: row,
    column_span: columns,
    row_span: rows,
  };
}

export function groupQuery(moduleId: string, dimensionId: string) {
  return {
    mode: "groups",
    module_id: moduleId,
    definition,
    aggregation: "count",
    measure: null,
    dimension: select(dimensionId),
  };
}

let widgetSequence = 700;
export function widget(
  type: WidgetWire["widget_type"],
  placement: Placement,
  config: Record<string, unknown> | null,
  chartId: string | null = null,
): WidgetWire {
  widgetSequence += 1;
  return {
    id: `00000000-0000-4000-8000-${String(widgetSequence).padStart(12, "0")}`,
    position: 0,
    widget_type: type,
    grid_column: placement.grid_column,
    grid_row: placement.grid_row,
    column_span: placement.column_span,
    row_span: placement.row_span,
    chart_id: chartId,
    config,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export const equipmentBar = (placement = at(0, 1, 2, 2)) =>
  widget("chart", placement, {
    version: 1,
    chart_type: "bar",
    query: groupQuery(ids.equipment, ids.category),
  });
export const equipmentNumber = (placement = at(0, 0, 1, 1)) =>
  widget("summary", placement, {
    version: 1,
    query: groupQuery(ids.equipment, ids.category),
  });
export const checksTable = (placement = at(2, 1, 2, 2)) =>
  widget("workload", placement, {
    version: 1,
    query: groupQuery(ids.checks, ids.checkStatus),
  });
export const invoicesNumber = (placement = at(3, 0, 1, 1)) =>
  widget("summary", placement, {
    version: 1,
    query: groupQuery(ids.invoices, ids.invoiceStatus),
  });
export const equipmentRecords = (placement = at(0, 3, 4, 2)) =>
  widget("records", placement, {
    version: 1,
    query: {
      module_id: ids.equipment,
      definition: {
        ...definition,
        columns: [select(ids.category)],
      },
    },
  });

export function dashboardWire(
  overrides: Partial<DashboardWire> = {},
): DashboardWire {
  const value: DashboardWire = {
    id: ids.home,
    department_id: ids.department,
    position: 0,
    name: "Field service dashboard",
    refresh_cadence: "manual",
    revision: 3,
    is_deleted: false,
    is_home: true,
    created_at: timestamp,
    updated_at: timestamp,
    widgets: [equipmentNumber(), equipmentBar(), checksTable()],
    ...overrides,
  };
  return {
    ...value,
    widgets: value.widgets.map((item, position) => ({ ...item, position })),
  };
}

const choices = [
  { id: "00000000-0000-4000-8000-000000000901", label: "Repair" },
  { id: "00000000-0000-4000-8000-000000000902", label: "Inspection" },
];
const fields: Record<string, ReturnType<typeof wireField>[]> = {
  [ids.equipment]: [
    wireField({
      id: ids.category,
      module_id: ids.equipment,
      name: "Category",
      type: "select",
      position: 0,
      config: { options: choices },
    }),
    wireField({
      id: ids.amount,
      module_id: ids.equipment,
      name: "Amount",
      type: "decimal",
      position: 1,
    }),
    wireField({
      id: ids.occurred,
      module_id: ids.equipment,
      name: "Occurred on",
      type: "date",
      position: 2,
    }),
  ],
  [ids.checks]: [
    wireField({
      id: ids.checkStatus,
      module_id: ids.checks,
      name: "Result",
      type: "select",
      position: 0,
      config: { options: choices },
    }),
  ],
  [ids.invoices]: [
    wireField({
      id: ids.invoiceStatus,
      module_id: ids.invoices,
      name: "Status",
      type: "select",
      position: 0,
      config: { options: choices },
    }),
  ],
};
const moduleRows = [
  { id: ids.equipment, name: "Equipment", department_id: ids.department },
  { id: ids.checks, name: "Quality checks", department_id: ids.department },
  { id: ids.invoices, name: "Invoices", department_id: ids.finance },
];

export type ChartWire = {
  id: string;
  department_id: string;
  module_id: string;
  name: string;
  chart_type: string;
  query: Record<string, unknown>;
  revision: number;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
};
export function chartWire(overrides: Partial<ChartWire> = {}): ChartWire {
  return {
    id: ids.chart,
    department_id: ids.department,
    module_id: ids.equipment,
    name: "Equipment by category",
    chart_type: "bar",
    query: groupQuery(ids.equipment, ids.category),
    revision: 2,
    is_deleted: false,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function problem(route: Route, status: number, detail: unknown) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify({ detail }),
  });
}

export async function installDashboardApi(
  page: Page,
  options: {
    dashboards?: DashboardWire[];
    identity?: Omit<SignedInIdentity, "id">;
    /** Modules the viewer cannot read: absent from the catalog, 404 on read. */
    hidden?: string[];
    charts?: ChartWire[];
  } = {},
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
          json: wireWorkspace({
            id: "00000000-0000-4000-8000-000000000102",
            locale: "en-PH",
            timezone: "Asia/Manila",
            currency: "PHP",
            today: "2026-10-26",
            purge_enabled: false,
          }),
        })
      : route.fallback(),
  );
  await signedInAs(page, {
    id: ids.user,
    ...(options.identity ?? { role: "admin", access: [] }),
  });
  await page.route("**/api/auth/refresh", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ json: { authenticated: true, setup_required: false } })
      : route.fallback(),
  );
  let dashboards = [...(options.dashboards ?? [dashboardWire()])];
  let charts = [...(options.charts ?? [])];
  const hidden = new Set(options.hidden ?? []);
  const state = {
    writes: [] as DashboardWrite[],
    batches: [] as { moduleIds: string[]; count: number }[],
    recordReads: [] as { module_id: string; limit: number; offset: number }[],
    chartWrites: [] as DashboardWrite[],
    /** The next layout save answers with this instead (a 422 or a 409). */
    nextSaveFailure: null as { status: number; detail: unknown } | null,
    dashboards: () => dashboards,
  };
  await page.route("**/api/departments**", (route) =>
    route.fulfill({
      json: {
        items: [
          [ids.department, "Field service"],
          [ids.finance, "Finance"],
        ].map(([id, name]) => ({
          id,
          department_name: name,
          created_at: timestamp,
          updated_at: timestamp,
          deleted_at: null,
          is_deleted: false,
          performed_by: null,
        })),
        pagination: wirePagination({ limit: 100, count: 2, total: 2 }),
      },
    }),
  );
  await page.route("**/api/views/data-sources**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/views/data-sources")
      return route.fulfill({
        json: pageOf(
          moduleRows
            .filter((row) => !hidden.has(row.id))
            .map((row) => ({ ...row, title_field_id: null })),
          { limit: 100 },
        ),
      });
    const moduleId = url.pathname.match(
      /^\/api\/views\/data-sources\/([^/]+)\/fields$/,
    )?.[1];
    if (moduleId && fields[moduleId] && !hidden.has(moduleId))
      return route.fulfill({
        json: pageOf(fields[moduleId], { limit: 100 }),
      });
    return problem(route, 404, "Module not found");
  });
  await page.route("**/api/fields?*", (route) =>
    route.fulfill({
      json: pageOf(
        [
          {
            id: ids.invoiceLink,
            module_id: ids.invoices,
            name: "Equipment",
            type: "relationship",
            is_deleted: false,
            position: 1,
            relationship_target_module_id: ids.equipment,
            relationship_multiple_targets: false,
            relationship_multiple_sources: true,
          },
        ],
        { limit: 100 },
      ),
    }),
  );
  await page.route("**/api/dashboards**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname === "/api/dashboards" && method === "GET") {
      const archived = url.searchParams.get("deleted") === "only";
      const department = url.searchParams.get("department_id");
      const items = dashboards.filter(
        (item) =>
          item.is_deleted === archived &&
          (!department || item.department_id === department),
      );
      return route.fulfill({
        json: {
          items,
          pagination: wirePagination({
            limit: 25,
            count: items.length,
            total: items.length,
          }),
        },
      });
    }
    const id = url.pathname.match(/^\/api\/dashboards\/([^/]+)/)?.[1];
    const found = dashboards.find((item) => item.id === id);
    if (method === "GET")
      return found
        ? route.fulfill({ json: found })
        : problem(route, 404, "Dashboard not found");
    const body = (request.postDataJSON() ?? null) as Record<
      string,
      unknown
    > | null;
    state.writes.push({ method, path: url.pathname, body });
    if (state.nextSaveFailure && (method === "PATCH" || method === "POST")) {
      const failure = state.nextSaveFailure;
      state.nextSaveFailure = null;
      return problem(route, failure.status, failure.detail);
    }
    // Moving or resizing a widget replaces it: every saved widget gets a new id.
    const placed = (items: unknown) =>
      ((items as WidgetBody[] | undefined) ?? []).map((item, position) => ({
        ...widget(item.widget_type, item, item.config, item.chart_id),
        position,
      }));
    if (method === "POST" && url.pathname === "/api/dashboards") {
      const created = dashboardWire({
        id: "00000000-0000-4000-8000-000000000599",
        name: String(body?.name),
        revision: 1,
        widgets: placed(body?.widgets),
      });
      dashboards = [...dashboards, created];
      return route.fulfill({ status: 201, json: created });
    }
    if (!found) return problem(route, 404, "Dashboard not found");
    let next: DashboardWire = found;
    if (method === "PATCH")
      next = {
        ...found,
        revision: found.revision + 1,
        name: (body?.name as string | undefined) ?? found.name,
        refresh_cadence:
          (body?.refresh_cadence as DashboardWire["refresh_cadence"]) ??
          found.refresh_cadence,
        widgets: body?.widgets ? placed(body.widgets) : found.widgets,
      };
    if (method === "DELETE")
      next = { ...found, is_deleted: true, revision: found.revision + 1 };
    if (method === "POST" && url.pathname.endsWith("/restore"))
      next = { ...found, is_deleted: false, revision: found.revision + 1 };
    dashboards = dashboards.map((item) => (item.id === found.id ? next : item));
    return method === "DELETE"
      ? route.fulfill({ status: 204, body: "" })
      : route.fulfill({ json: next });
  });
  await page.route("**/api/records/aggregate-snapshot*", (route) => {
    const body = route.request().postDataJSON() as
      | { queries: { module_id: string; mode: string }[] }
      | { module_id: string; mode: string };
    const queries = "queries" in body ? body.queries : [body];
    const moduleIds = [...new Set(queries.map((query) => query.module_id))];
    state.batches.push({ moduleIds, count: queries.length });
    if (moduleIds.some((moduleId) => hidden.has(moduleId)))
      return problem(route, 404, "Module not found");
    const results = queries.map((query) =>
      pageOf(
        query.mode === "date_series"
          ? []
          : [
              wireBucket({
                key: choices[0].id,
                label: "Repair",
                value: 7,
                record_count: 7,
              }),
              wireBucket({
                key: choices[1].id,
                label: "Inspection",
                value: 5,
                record_count: 5,
              }),
            ],
        { limit: 100 },
      ),
    );
    return route.fulfill({
      json: "queries" in body ? { items: results } : results[0],
    });
  });
  await page.route("**/api/records/query", (route) => {
    const request = route.request().postDataJSON() as {
      module_id: string;
      limit: number;
      offset: number;
    };
    state.recordReads.push(request);
    if (hidden.has(request.module_id))
      return problem(route, 404, "Module not found");
    const all = Array.from({ length: 9 }, (_, index) =>
      wireRecord({
        id: `00000000-0000-4000-8000-${String(index + 801).padStart(12, "0")}`,
        module_id: request.module_id,
        data: { [ids.category]: choices[index % 2].id },
        display_values: { [ids.category]: choices[index % 2].label },
        created_at: timestamp,
        updated_at: timestamp,
        performed_by: ids.user,
      }),
    );
    return route.fulfill({
      json: pageOf(all.slice(request.offset, request.offset + request.limit), {
        limit: request.limit,
        offset: request.offset,
        total: all.length,
      }),
    });
  });
  await page.route("**/api/charts**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname === "/api/charts" && method === "GET") {
      const deleted = url.searchParams.get("deleted");
      const items = charts.filter((chart) =>
        deleted === "only" ? chart.is_deleted : !chart.is_deleted,
      );
      return route.fulfill({ json: pageOf(items, { limit: 25 }) });
    }
    const id = url.pathname.match(/^\/api\/charts\/([^/]+)/)?.[1];
    const found = charts.find((chart) => chart.id === id);
    if (url.pathname.endsWith("/usage"))
      return route.fulfill({
        json: {
          ...pageOf(
            dashboards
              .filter((item) =>
                item.widgets.some((entry) => entry.chart_id === id),
              )
              .map((item) => ({
                kind: "dashboard",
                id: item.id,
                name: item.name,
              })),
            { limit: 25 },
          ),
          has_restricted_usage: false,
        },
      });
    if (method === "GET")
      return found
        ? route.fulfill({ json: found })
        : problem(route, 404, "Chart not found");
    const body = (request.postDataJSON() ?? null) as Record<
      string,
      unknown
    > | null;
    state.chartWrites.push({ method, path: url.pathname, body });
    if (method === "POST" && url.pathname === "/api/charts") {
      const created = chartWire({
        id: "00000000-0000-4000-8000-000000000699",
        name: String(body?.name),
        module_id: String(body?.module_id),
        chart_type: String(body?.chart_type),
        query: body?.query as Record<string, unknown>,
        revision: 1,
      });
      charts = [...charts, created];
      return route.fulfill({ status: 201, json: created });
    }
    if (!found) return problem(route, 404, "Chart not found");
    const next =
      method === "DELETE"
        ? { ...found, is_deleted: true, revision: found.revision + 1 }
        : method === "PATCH"
          ? {
              ...found,
              name: String(body?.name),
              query: body?.query as Record<string, unknown>,
              chart_type: String(body?.chart_type),
              revision: found.revision + 1,
            }
          : { ...found, is_deleted: false, revision: found.revision + 1 };
    charts = charts.map((chart) => (chart.id === found.id ? next : chart));
    return method === "DELETE"
      ? route.fulfill({ json: null })
      : route.fulfill({ json: next });
  });
  return state;
}

/** The home dashboard's address, as the sidebar's Dashboard row links it. */
export const homeUrl = `/openview?section=dashboards&department=${ids.department}`;

/** A member who manages Field service and reads the linked Finance. */
export const manager = {
  role: "member" as const,
  access: [
    {
      department_id: ids.department,
      module_id: null,
      level: "manage" as const,
    },
    { department_id: ids.finance, module_id: null, level: "read" as const },
  ],
};
/** A member who reads Field service only. */
export const reader = {
  role: "member" as const,
  access: [
    { department_id: ids.department, module_id: null, level: "read" as const },
  ],
};

export function card(page: Page, title: string) {
  return page.getByRole("article", { name: title, exact: true });
}

export async function editLayout(page: Page) {
  await page.getByRole("button", { name: "Edit layout" }).click();
  await expect(
    page.getByRole("toolbar", { name: "Edit layout" }),
  ).toBeVisible();
}
