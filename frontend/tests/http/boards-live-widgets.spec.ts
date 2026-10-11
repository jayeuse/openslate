import { expect, test, type Page } from "./helpers/test";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyAppearancePreferences } from "../../src/lib/appearance-preferences";
import { captureOpenViewReview } from "./helpers/openview-review-capture";
import { ApiError } from "../../src/lib/api";
import type {
  BoardWidget,
  BoardLegacyWidgetConfig,
} from "../../src/components/systems/boards/adapters/board-widgets-api";
import { ServerBoardWidgetsDisplay } from "../../src/components/systems/boards/components/server-backed-board-widgets";
import { buildBoardWidgetQueryPlan } from "../../src/components/systems/boards/domain/live-widget-query";
import {
  aggregateBucketKeys,
  type AggregateBucket,
} from "../../src/components/systems/openview/domain/aggregate-buckets";
import {
  emptyLiveWidgetsState,
  classifyLiveWidgetFailure,
  loadLiveWidgetData,
  loadLiveWidgetMetadata,
  transitionLiveWidgetsState,
  type LiveWidgetData,
  type LiveWidgetItem,
  type LiveWidgetsState,
} from "../../src/components/systems/boards/hooks/use-live-widgets";
import { hideDevOverlay } from "./helpers/test-styles";

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

async function installS26WidgetApi(page: Page, widgets: unknown[]) {
  await installOpenViewEventSource(page);
  const actor = "00000000-0000-4000-8000-000000000661";
  const board = {
    id: boardId,
    scope: "project",
    department_id: null,
    name: "Query overview",
    description: null,
    status: "active",
    revision: 1,
    level: "manage",
    created_at: timestamp,
    updated_at: timestamp,
  };
  const pageOf = (items: unknown[], limit = 25) => ({
    items,
    pagination: {
      limit,
      offset: 0,
      count: items.length,
      total: items.length,
      has_more: false,
    },
  });
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const reply = (json: unknown) => route.fulfill({ json });
    if (url.pathname === "/api/auth/session")
      return reply({
        authenticated: true,
        user_id: actor,
        setup_required: false,
      });
    if (url.pathname === "/api/auth/me")
      return reply({ id: actor, role: "admin", access: [] });
    if (url.pathname === `/api/users/${actor}/preferences`)
      return reply({
        user_id: actor,
        theme: process.env.S26_CAPTURE_THEME === "dark" ? "dark" : "light",
        appearance: { motion: "reduce", keyboard_shortcuts: true },
      });
    if (url.pathname === "/api/workspace")
      return reply({
        id: otherBoardId,
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
        today: "2026-10-07",
        purge_enabled: true,
      });
    if (url.pathname === "/api/boards") return reply(pageOf([board]));
    if (url.pathname === `/api/boards/${boardId}`) return reply(board);
    if (url.pathname === `/api/boards/${boardId}/my-access`)
      return reply({ read: true, write: true, manage: true, level: "manage" });
    if (url.pathname === `/api/boards/${boardId}/widgets`)
      return reply({
        ...pageOf(widgets, Number(url.searchParams.get("limit") ?? 12)),
        board_revision: 1,
      });
    if (url.pathname === "/api/views/data-sources")
      return reply(
        pageOf([
          {
            id: moduleId,
            name: "Requests",
            department_id: otherBoardId,
            title_field_id: null,
          },
        ]),
      );
    return route.fulfill({ status: 404, json: { detail: "No route fixture" } });
  });
}

for (const sourceKind of ["inline", "reference"] as const) {
  for (const visualization of ["pie", "bar", "line"] as const) {
    test(`S26 Board ${sourceKind} ${visualization} keeps all average groups exact with no additive Other`, async ({
      page,
    }) => {
      if (process.env.OPENVIEW_CAPTURE_DIR)
        await page.emulateMedia({
          colorScheme:
            process.env.S26_CAPTURE_THEME === "dark" ? "dark" : "light",
          reducedMotion: "reduce",
        });
      const chartId = "00000000-0000-4000-8000-000000000662";
      const measureId = "00000000-0000-4000-8000-000000000663";
      const query = {
        mode: "groups",
        module_id: moduleId,
        aggregation: "average",
        measure: { field_id: measureId, expected_type: "decimal" },
        dimension: { field_id: fieldId, expected_type: "text" },
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
      };
      const nativeQuery =
        visualization === "line"
          ? {
              mode: "date_series",
              module_id: moduleId,
              aggregation: "average",
              measure: { field_id: measureId, expected_type: "decimal" },
              date_field: { field_id: fieldId, expected_type: "date" },
              from_date: "2025-01-01",
              to_date: "2025-10-31",
              bucket: "month",
              definition: query.definition,
            }
          : query;
      const native = {
        version: 1,
        chart_type: visualization,
        query: nativeQuery,
      };
      await installS26WidgetApi(page, [
        {
          ...wireWidget,
          name: "Average workload",
          widget_type: "chart",
          size: "L",
          pinned: true,
          chart_id: sourceKind === "reference" ? chartId : null,
          config: sourceKind === "reference" ? null : native,
        },
      ]);
      let chartReads = 0;
      await page.route(`**/api/charts/${chartId}`, (route) => {
        chartReads += 1;
        return route.fulfill({
          json: {
            id: chartId,
            department_id: otherBoardId,
            module_id: moduleId,
            name: "Source average",
            chart_type: visualization,
            query: nativeQuery,
            revision: 1,
            is_deleted: false,
            created_at: timestamp,
            updated_at: timestamp,
          },
        });
      });
      const requests: unknown[] = [];
      await page.route("**/api/records/aggregate-snapshot", (route) => {
        requests.push(route.request().postDataJSON());
        return route.fulfill({
          json: {
            items: Array.from({ length: 10 }, (_, index) => ({
              key:
                visualization === "line"
                  ? `2025-${String(index + 1).padStart(2, "0")}-01`
                  : `group-${index + 1}`,
              label:
                visualization === "line"
                  ? `2025-${String(index + 1).padStart(2, "0")}-01`
                  : `Work group ${index + 1}`,
              value: index + 0.5,
              record_count: index + 100,
            })),
            pagination: {
              limit: 10,
              offset: 0,
              count: 10,
              total: 10,
              has_more: false,
            },
          },
        });
      });
      await page.goto(`/boards?board=${boardId}`);
      await expect(
        page.getByRole("heading", { name: "Average workload", exact: true }),
      ).toBeVisible();
      await expect(
        page
          .getByText(
            visualization === "line" ? "2025-10-01" : "Work group 10",
            { exact: true },
          )
          .and(page.locator("span")),
      ).toBeVisible();
      await expect(page.getByText("9.5", { exact: true })).toBeVisible();
      await expect(page.getByText("Other", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Pinned", { exact: true })).toBeVisible();
      expect(requests.at(-1)).toEqual(nativeQuery);
      if (visualization === "bar") {
        await expect(
          page.getByText(
            "10 groups. Exact values are listed below; bar lengths are approximate.",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(page.getByText(/days shown/)).toHaveCount(0);
      }
      if (visualization === "line") {
        await expect(
          page.getByText(
            "10 months shown. Exact values are listed below; the line is approximate.",
            { exact: true },
          ),
        ).toBeVisible();
      }
      if (sourceKind === "reference" && visualization === "pie")
        await captureOpenViewReview(
          page,
          `s26-board-native-reference-${process.env.S26_CAPTURE_THEME === "dark" ? "dark" : "light"}`,
          {
            beforeScreenshot: async (capture) => {
              await hideDevOverlay(capture);
              await expect(capture.locator("html")).toHaveClass(
                process.env.S26_CAPTURE_THEME === "dark"
                  ? /dark/
                  : /^(?!.*dark)/,
              );
              await capture.evaluate(async () => {
                await document.fonts.ready;
                await new Promise<void>((resolve) =>
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() => resolve()),
                  ),
                );
              });
            },
          },
        );
      // Workspace-date readiness can start a second batch; each reference still requires a current read.
      if (sourceKind === "reference") expect(chartReads).toBeGreaterThan(0);
      else expect(chartReads).toBe(0);
    });
  }
}

// Evidence completion for the unchanged first S26-E submission. These browser
// journeys exercise the existing implementation; they are not retroactive TDD.
const evidenceChartId = "00000000-0000-4000-8000-000000000681";
const evidenceCopyId = "00000000-0000-4000-8000-000000000682";
const evidenceMeasureId = "00000000-0000-4000-8000-000000000683";
const evidenceDefinition = {
  version: 1,
  logic: "or",
  columns: [{ field_id: fieldId, expected_type: "text" }],
  filters: [
    {
      field_id: fieldId,
      expected_type: "text",
      operator: "contains",
      value: "priority",
    },
  ],
  sort: [{ field_id: fieldId, expected_type: "text", direction: "desc" }],
  deleted: "include",
  search: "retained search",
  search_fields: [{ field_id: fieldId, expected_type: "text" }],
};
const evidenceQuery = {
  mode: "groups",
  module_id: moduleId,
  aggregation: "average",
  measure: { field_id: evidenceMeasureId, expected_type: "decimal" },
  dimension: { field_id: fieldId, expected_type: "text" },
  definition: evidenceDefinition,
};
type EvidenceWidgetWire = Omit<
  typeof wireWidget,
  "config" | "size" | "chart_id"
> & {
  config: unknown;
  size: "S" | "M" | "L";
  chart_id: string | null;
};
function evidenceWidget(source: "inline" | "reference"): EvidenceWidgetWire {
  return {
    ...wireWidget,
    name: "Retained Board query",
    widget_type: "chart",
    size: "M",
    chart_id: source === "reference" ? evidenceChartId : null,
    config:
      source === "reference"
        ? null
        : { version: 1, chart_type: "bar", query: evidenceQuery },
  };
}
function evidenceChart(overrides: Record<string, unknown> = {}) {
  return {
    id: evidenceChartId,
    department_id: otherBoardId,
    module_id: moduleId,
    name: "Private source name",
    chart_type: "bar",
    query: evidenceQuery,
    revision: 1,
    is_deleted: false,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}
function evidencePage(items: unknown[], limit = 12) {
  return {
    items,
    pagination: {
      limit,
      offset: 0,
      count: items.length,
      total: items.length,
      has_more: false,
    },
  };
}
function evidenceBarrier() {
  let release!: () => void;
  let signalStarted!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  return { wait, started, release, signalStarted };
}
async function installEvidenceBoardApi(
  page: Page,
  initial: EvidenceWidgetWire | null,
) {
  await installS26WidgetApi(page, initial ? [initial] : []);
  const state = {
    widgets: initial ? [initial] : ([] as EvidenceWidgetWire[]),
    revision: 1,
  };
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  let saveGate: ReturnType<typeof evidenceBarrier> | null = null;
  await page.route("**/api/boards/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith(`/api/boards/${boardId}/widgets`))
      return route.fallback();
    const method = route.request().method();
    if (method === "GET")
      return route.fulfill({
        json: {
          ...evidencePage(state.widgets),
          board_revision: state.revision,
        },
      });
    const body: unknown = route.request().postDataJSON();
    writes.push({ method, path, body });
    const command = body as {
      revision: number;
      widget?: Partial<EvidenceWidgetWire>;
      widget_ids?: string[];
    };
    if (command.revision !== state.revision)
      return route.fulfill({ status: 409, json: { code: "stale_revision" } });
    if (method === "POST" && path === `/api/boards/${boardId}/widgets`) {
      const created = {
        ...wireWidget,
        ...command.widget,
        id: widgetId,
        position: state.widgets.length,
      };
      if (
        created.config &&
        typeof created.config === "object" &&
        "fields" in created.config
      )
        created.config = { ...created.config, refresh: "manual" };
      state.widgets.push(created);
      state.revision += 1;
      return route.fulfill({
        status: 201,
        json: { widget: created, board_revision: state.revision },
      });
    }
    if (
      method === "PATCH" &&
      path === `/api/boards/${boardId}/widgets/${widgetId}`
    ) {
      if (saveGate) {
        const gate = saveGate;
        saveGate = null;
        gate.signalStarted();
        await gate.wait;
      }
      state.widgets[0] = {
        ...state.widgets[0],
        ...command.widget,
      };
      const config = state.widgets[0].config;
      if (config && typeof config === "object" && "fields" in config)
        state.widgets[0].config = { ...config, refresh: "manual" };
      state.revision += 1;
      return route.fulfill({
        json: { widget: state.widgets[0], board_revision: state.revision },
      });
    }
    if (method === "POST" && path.endsWith("/duplicate")) {
      const copied = {
        ...state.widgets[0],
        id: evidenceCopyId,
        name: `${state.widgets[0].name} copy`,
        position: state.widgets.length,
      };
      state.widgets.push(copied);
      state.revision += 1;
      return route.fulfill({
        status: 201,
        json: { widget: copied, board_revision: state.revision },
      });
    }
    if (method === "PUT" && path.endsWith("/order")) {
      const { widget_ids } = body as { widget_ids: string[] };
      state.widgets = widget_ids.map((id, position) => ({
        ...state.widgets.find((item) => item.id === id)!,
        position,
      }));
      state.revision += 1;
      return route.fulfill({
        json: { items: state.widgets, board_revision: state.revision },
      });
    }
    return route.fulfill({
      status: 405,
      json: { detail: "Unexpected Board write" },
    });
  });
  return {
    state,
    writes,
    holdSave() {
      saveGate = evidenceBarrier();
      return saveGate;
    },
  };
}
async function installEvidenceSnapshot(page: Page) {
  const requests: unknown[] = [];
  await page.route("**/api/records/aggregate-snapshot", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      json: evidencePage(
        [
          {
            key: "private",
            label: "Private Board group",
            value: 12.5,
            record_count: 127,
          },
        ],
        1,
      ),
    });
  });
  return requests;
}
async function openEvidenceSettings(page: Page, name: string) {
  await page
    .getByRole("button", { name: "Manage widgets", exact: true })
    .click();
  const manager = page.getByRole("region", {
    name: "Manage Board widgets",
    exact: true,
  });
  await manager
    .getByRole("button", { name: `Edit ${name} settings`, exact: true })
    .click();
  // Two forms expose Widget name; the settings form alone owns Save settings.
  return manager.locator("form").filter({
    has: page.getByRole("button", { name: "Save settings", exact: true }),
  });
}

async function installS27BoardFields(page: Page) {
  await page.route(`**/api/views/data-sources/${moduleId}/fields?*`, (route) =>
    route.fulfill({
      json: evidencePage(
        [
          {
            id: fieldId,
            module_id: moduleId,
            name: "Category",
            type: "text",
            required: false,
            config: {},
            position: 0,
          },
          {
            id: evidenceMeasureId,
            module_id: moduleId,
            name: "Amount",
            type: "decimal",
            required: false,
            config: {},
            position: 1,
          },
        ],
        100,
      ),
    }),
  );
}

const s30DateFieldId = "00000000-0000-4000-8000-000000000690";
const s30Definition = {
  version: 1,
  logic: "and",
  columns: [],
  filters: [],
  sort: [],
  deleted: "exclude",
  search: null,
  search_fields: [],
};

/** Only the HTTP boundaries used by the real Board editor and live tiles. */
async function installS30WidgetData(page: Page) {
  const fields = [
    { id: fieldId, name: "Category", type: "text" },
    { id: evidenceMeasureId, name: "Amount", type: "decimal" },
    { id: s30DateFieldId, name: "Occurred on", type: "date" },
  ].map((field, position) => ({
    ...field,
    module_id: moduleId,
    position,
    required: false,
    config: {},
  }));
  await page.route(`**/api/views/data-sources/${moduleId}/fields?*`, (route) =>
    route.fulfill({ json: evidencePage(fields, 100) }),
  );
  for (const field of fields)
    await page.route(`**/api/fields/${field.id}`, (route) =>
      route.fulfill({ json: { ...field, is_deleted: false } }),
    );
  const aggregates: Array<Record<string, unknown>> = [];
  const records: Array<Record<string, unknown>> = [];
  for (const path of ["aggregate-query", "aggregate-snapshot"])
    await page.route(`**/api/records/${path}`, (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      aggregates.push(body);
      const dates =
        body.mode === "date_series"
          ? aggregateBucketKeys(
              String(body.from_date),
              String(body.to_date),
              body.bucket as AggregateBucket,
              "monday",
            )
          : null;
      return route.fulfill({
        json: evidencePage(
          dates
            ? dates.map((key, index) => ({
                key,
                label: key,
                value:
                  index === 0
                    ? body.aggregation === "count"
                      ? 7
                      : "123456789012.1234"
                    : null,
                record_count: index === 0 ? 7 : 0,
              }))
            : [
                {
                  key: "measured",
                  label: "S30 measured group",
                  value: body.aggregation === "count" ? 7 : "123456789012.1234",
                  record_count: 7,
                },
                {
                  key: "missing",
                  label: "No measure",
                  value: body.aggregation === "count" ? 2 : null,
                  record_count: 2,
                },
              ],
          dates
            ? dates.length
            : path === "aggregate-query"
              ? Number(body.limit)
              : 2,
        ),
      });
    });
  await page.route("**/api/records/query", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    records.push(body);
    return route.fulfill({
      json: {
        items: [
          {
            id: recordId,
            module_id: moduleId,
            data: {
              [fieldId]: "S30 priority row",
              [evidenceMeasureId]: "12.5000",
            },
            display_values: {},
            created_at: timestamp,
            updated_at: timestamp,
            deleted_at: null,
            is_deleted: false,
            performed_by: null,
          },
        ],
        pagination: {
          limit: body.limit,
          offset: 0,
          count: 1,
          total: 127,
          has_more: true,
        },
      },
    });
  });
  return { aggregates, records };
}

for (const kind of ["summary", "workload", "records", "chart"] as const) {
  test(`S30 ${kind} create edit and reload round trips the shared query and presentation`, async ({
    page,
  }) => {
    const api = await installEvidenceBoardApi(page, null);
    const data = await installS30WidgetData(page);
    await page.goto(`/boards?board=${boardId}`);
    await page
      .getByRole("button", { name: "Manage widgets", exact: true })
      .click();
    const manager = page.getByRole("region", {
      name: "Manage Board widgets",
      exact: true,
    });
    const create = manager.locator("form").filter({
      has: page.getByRole("button", { name: "Add widget", exact: true }),
    });
    await expect(
      create.getByLabel("Widget type", { exact: true }),
    ).toBeVisible();
    await create.getByLabel("Widget name", { exact: true }).fill(`S30 ${kind}`);
    await create.getByLabel("Widget type", { exact: true }).selectOption(kind);
    await create
      .getByLabel("Data source", { exact: true })
      .selectOption(moduleId);
    if (kind === "records") {
      await create
        .getByRole("button", { name: "Records options", exact: true })
        .click();
      await page.getByLabel("Include Category", { exact: true }).check();
      await page.getByLabel("Include Amount", { exact: true }).check();
      await page.getByLabel("Record search", { exact: true }).fill("priority");
      await page.getByLabel("Search Category", { exact: true }).check();
      await page.keyboard.press("Escape");
    } else {
      if (kind === "chart")
        await create
          .getByLabel("Chart type", { exact: true })
          .selectOption("pie");
      await create
        .getByLabel("Group by", { exact: true })
        .selectOption(fieldId);
      await create.getByLabel("Measure", { exact: true }).selectOption("sum");
      await expect(
        create.getByRole("button", { name: "Add widget", exact: true }),
      ).toBeDisabled();
      expect(api.writes).toEqual([]);
      await create
        .getByLabel("Numeric measure", { exact: true })
        .selectOption(evidenceMeasureId);
    }
    await create.getByLabel("Size", { exact: true }).selectOption("S");
    await create.getByLabel("Pin this widget", { exact: true }).check();
    await create
      .getByRole("button", { name: "Add widget", exact: true })
      .click();
    await expect(
      manager.getByRole("button", {
        name: `Edit S30 ${kind} settings`,
        exact: true,
      }),
    ).toBeEnabled();

    const definition =
      kind === "records"
        ? {
            ...s30Definition,
            columns: [
              { field_id: fieldId, expected_type: "text" },
              { field_id: evidenceMeasureId, expected_type: "decimal" },
            ],
            search: "priority",
            search_fields: [{ field_id: fieldId, expected_type: "text" }],
          }
        : s30Definition;
    const createdQuery =
      kind === "records"
        ? { module_id: moduleId, definition }
        : {
            module_id: moduleId,
            definition,
            mode: "groups",
            dimension: { field_id: fieldId, expected_type: "text" },
            aggregation: "sum",
            measure: { field_id: evidenceMeasureId, expected_type: "decimal" },
          };
    expect(api.writes[0]).toEqual({
      method: "POST",
      path: `/api/boards/${boardId}/widgets`,
      body: {
        revision: 1,
        widget: {
          name: `S30 ${kind}`,
          widget_type: kind,
          module_id: moduleId,
          size: "S",
          pinned: true,
          chart_id: null,
          config: {
            version: 1,
            ...(kind === "chart" ? { chart_type: "pie" } : {}),
            query: createdQuery,
          },
        },
      },
    });
    await page.reload();
    const overview = page.getByRole("region", {
      name: "Record summaries",
      exact: true,
    });
    await expect(
      overview.getByRole("heading", { name: `S30 ${kind}`, exact: true }),
    ).toBeVisible();
    await expect(overview.getByText("Pinned", { exact: true })).toBeVisible();
    await expect(
      overview.getByText(
        kind === "records" ? "S30 priority row" : "123456789012.1234",
        { exact: true },
      ),
    ).toBeVisible();
    const settings = await openEvidenceSettings(page, `S30 ${kind}`);
    await expect(
      settings.getByLabel("Widget type", { exact: true }),
    ).toHaveValue(kind);
    if (kind === "records") {
      await settings
        .getByRole("button", { name: "Records options", exact: true })
        .click();
      await expect(
        page.getByLabel("Include Category", { exact: true }),
      ).toBeChecked();
      await expect(
        page.getByLabel("Record search", { exact: true }),
      ).toHaveValue("priority");
      await page
        .getByRole("button", { name: "Move Amount earlier", exact: true })
        .click();
      await page
        .getByLabel("Record search", { exact: true })
        .fill("edited priority");
      await page.keyboard.press("Escape");
    } else {
      await expect(settings.getByLabel("Measure", { exact: true })).toHaveValue(
        "sum",
      );
      await expect(
        settings.getByLabel("Numeric measure", { exact: true }),
      ).toHaveValue(evidenceMeasureId);
      await settings
        .getByLabel("Measure", { exact: true })
        .selectOption(kind === "workload" ? "distinct" : "min");
      if (kind === "workload")
        await settings
          .getByLabel("Measure field", { exact: true })
          .selectOption(fieldId);
      if (kind === "chart") {
        await settings
          .getByLabel("Chart type", { exact: true })
          .selectOption("line");
        await settings
          .getByLabel("Group by", { exact: true })
          .selectOption(s30DateFieldId);
        await settings
          .getByLabel("Calendar bucket", { exact: true })
          .selectOption("month");
        await settings
          .getByRole("button", { name: "Date window", exact: true })
          .click();
        await page.getByLabel("From date", { exact: true }).fill("2025-01-15");
        await page.getByLabel("To date", { exact: true }).fill("2026-01-20");
        await page.keyboard.press("Escape");
      }
    }
    await settings
      .getByLabel("Widget name", { exact: true })
      .fill(`Edited S30 ${kind}`);
    await settings.getByLabel("Size", { exact: true }).selectOption("L");
    await settings.getByLabel("Pin this widget", { exact: true }).uncheck();
    await settings
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await expect(settings).toBeHidden();
    const editedQuery =
      kind === "records"
        ? {
            module_id: moduleId,
            definition: {
              ...definition,
              columns: [
                { field_id: evidenceMeasureId, expected_type: "decimal" },
                { field_id: fieldId, expected_type: "text" },
              ],
              search: "edited priority",
            },
          }
        : kind === "chart"
          ? {
              module_id: moduleId,
              definition,
              mode: "date_series",
              aggregation: "min",
              measure: {
                field_id: evidenceMeasureId,
                expected_type: "decimal",
              },
              date_field: { field_id: s30DateFieldId, expected_type: "date" },
              from_date: "2025-01-15",
              to_date: "2026-01-20",
              bucket: "month",
            }
          : {
              ...createdQuery,
              aggregation: kind === "workload" ? "distinct" : "min",
              measure: {
                field_id: kind === "workload" ? fieldId : evidenceMeasureId,
                expected_type: kind === "workload" ? "text" : "decimal",
              },
            };
    expect(api.writes.at(-1)?.body).toEqual({
      revision: 2,
      widget: {
        name: `Edited S30 ${kind}`,
        widget_type: kind,
        module_id: moduleId,
        size: "L",
        pinned: false,
        chart_id: null,
        config: {
          version: 1,
          ...(kind === "chart" ? { chart_type: "line" } : {}),
          query: editedQuery,
        },
      },
    });
    await page.reload();
    await expect(
      overview.getByRole("heading", {
        name: `Edited S30 ${kind}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(overview.getByText("Pinned", { exact: true })).toHaveCount(0);
    await expect
      .poll(() => (kind === "records" ? data.records : data.aggregates).at(-1))
      .toMatchObject(editedQuery);
    if (kind === "records")
      expect(data.records.at(-1)).toMatchObject({ limit: 5, offset: 0 });
    const reopened = await openEvidenceSettings(page, `Edited S30 ${kind}`);
    await expect(reopened.getByLabel("Size", { exact: true })).toHaveValue("L");
    if (kind === "chart") {
      await expect(
        reopened.getByLabel("Chart type", { exact: true }),
      ).toHaveValue("line");
      await expect(
        reopened.getByLabel("Calendar bucket", { exact: true }),
      ).toHaveValue("month");
    }
  });
}

for (const kind of ["workload", "records", "chart"] as const) {
  test(`S30 legacy ${kind} opens complete instructions and saves an explicitly chosen query`, async ({
    page,
  }) => {
    const initial: EvidenceWidgetWire = {
      ...wireWidget,
      name: `Legacy ${kind}`,
      widget_type: kind,
      config: {
        version: 1,
        fields: [{ field_id: fieldId, expected_type: "text" }],
        filters: [
          {
            field_id: fieldId,
            expected_type: "text",
            operator: "contains",
            value: "priority",
          },
        ],
        logic: "or",
        metric:
          kind === "chart"
            ? { field_id: evidenceMeasureId, expected_type: "decimal" }
            : null,
        visualization: "bar",
        refresh: "manual",
      },
    };
    const api = await installEvidenceBoardApi(page, initial);
    const data = await installS30WidgetData(page);
    await page.goto(`/boards?board=${boardId}`);
    const settings = await openEvidenceSettings(page, `Legacy ${kind}`);
    await expect(
      settings.getByLabel("Chart source", { exact: true }),
    ).toHaveValue("inline");
    if (kind !== "records") {
      await expect(
        settings.getByLabel("Group by", { exact: true }),
      ).toHaveValue(fieldId);
      await expect(settings.getByLabel("Measure", { exact: true })).toHaveValue(
        kind === "chart" ? "sum" : "count",
      );
      await settings
        .getByLabel("Measure", { exact: true })
        .selectOption("average");
      await settings
        .getByLabel("Numeric measure", { exact: true })
        .selectOption(evidenceMeasureId);
    }
    await settings
      .getByRole("button", { name: "Filters (1)", exact: true })
      .click();
    await expect(
      page.getByLabel("Filter 1 value", { exact: true }),
    ).toHaveValue("priority");
    await page
      .getByLabel("Filter 1 value", { exact: true })
      .fill("edited priority");
    await page.keyboard.press("Escape");
    await settings
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await expect(settings).toBeHidden();
    expect(api.state.widgets[0].config).toMatchObject({
      version: 1,
      ...(kind === "chart" ? { chart_type: "bar" } : {}),
      query: {
        module_id: moduleId,
        definition: {
          ...s30Definition,
          logic: "or",
          columns:
            kind === "records"
              ? [{ field_id: fieldId, expected_type: "text" }]
              : [],
          filters: [
            {
              field_id: fieldId,
              expected_type: "text",
              operator: "contains",
              value: "edited priority",
            },
          ],
        },
        ...(kind === "records"
          ? {}
          : {
              mode: "groups",
              aggregation: "average",
              measure: {
                field_id: evidenceMeasureId,
                expected_type: "decimal",
              },
              dimension: { field_id: fieldId, expected_type: "text" },
            }),
      },
    });
    await page.reload();
    await expect(
      page.getByText(
        kind === "records" ? "S30 priority row" : "123456789012.1234",
        { exact: true },
      ),
    ).toBeVisible();
    expect(
      kind === "records" ? data.records.at(-1) : data.aggregates.at(-1),
    ).toMatchObject({
      definition: { filters: [{ value: "edited priority" }] },
    });
  });
}

test("S30 legacy count-all summary filters remain one bounded records read after shared editing", async ({
  page,
}) => {
  const api = await installEvidenceBoardApi(page, {
    ...wireWidget,
    name: "Legacy count all",
    widget_type: "summary",
    config: {
      ...wireWidget.config,
      filters: [
        {
          field_id: fieldId,
          expected_type: "text",
          operator: "contains",
          value: "priority",
        },
      ],
    },
  });
  const data = await installS30WidgetData(page);
  await page.goto(`/boards?board=${boardId}`);
  const overview = page.getByRole("region", {
    name: "Record summaries",
    exact: true,
  });
  await expect(overview.getByText("127", { exact: true })).toBeVisible();
  const settings = await openEvidenceSettings(page, "Legacy count all");
  await expect(
    settings.getByLabel("Chart source", { exact: true }),
  ).toHaveValue("inline");
  await settings
    .getByRole("button", { name: "Filters (1)", exact: true })
    .click();
  await page
    .getByLabel("Filter 1 value", { exact: true })
    .fill("edited priority");
  await page.keyboard.press("Escape");
  await settings
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(settings).toBeHidden();
  expect(api.writes.at(-1)?.body).toMatchObject({
    revision: 1,
    widget: {
      widget_type: "summary",
      module_id: moduleId,
      chart_id: null,
      config: {
        aggregation: "count",
        metric: null,
        filters: [
          {
            field_id: fieldId,
            expected_type: "text",
            operator: "contains",
            value: "edited priority",
          },
        ],
      },
    },
  });
  await page.reload();
  await expect(overview.getByText("127", { exact: true })).toBeVisible();
  expect(data.records.at(-1)).toMatchObject({
    module_id: moduleId,
    limit: 1,
    offset: 0,
    definition: { columns: [], filters: [{ value: "edited priority" }] },
  });
  expect(data.aggregates).toEqual([]);
});

test("S30 explicit legacy aggregation survives presentation save instead of metric inference", async ({
  page,
}) => {
  const initial: EvidenceWidgetWire = {
    ...wireWidget,
    name: "Explicit average",
    widget_type: "chart",
    config: {
      ...wireWidget.config,
      fields: [{ field_id: fieldId, expected_type: "text" }],
      aggregation: "average",
      metric: { field_id: evidenceMeasureId, expected_type: "decimal" },
    },
  };
  const api = await installEvidenceBoardApi(page, initial);
  const data = await installS30WidgetData(page);
  await page.goto(`/boards?board=${boardId}`);
  await expect(
    page.getByText("123456789012.1234", { exact: true }),
  ).toBeVisible();
  expect(data.aggregates.at(-1)).toMatchObject({ aggregation: "average" });
  const settings = await openEvidenceSettings(page, "Explicit average");
  await expect(settings.getByLabel("Measure", { exact: true })).toHaveValue(
    "average",
  );
  await settings.getByLabel("Size", { exact: true }).selectOption("L");
  await settings
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(settings).toBeHidden();
  expect(api.writes.at(-1)?.body).toMatchObject({
    widget: { config: { aggregation: "average" } },
  });
});

test("S30 legacy line opens its workspace window and a late date read cannot restore removed settings", async ({
  page,
}) => {
  const api = await installEvidenceBoardApi(page, {
    ...wireWidget,
    name: "Legacy daily",
    widget_type: "chart",
    config: {
      ...wireWidget.config,
      fields: [{ field_id: s30DateFieldId, expected_type: "date" }],
      visualization: "line",
    },
  });
  await installS30WidgetData(page);
  const [workspace] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/workspace" &&
        response.status() === 200,
    ),
    page.goto(`/boards?board=${boardId}`),
  ]);
  const workspaceData: unknown = await workspace.json();
  await expect(
    page.getByRole("heading", { name: "Legacy daily", exact: true }),
  ).toBeVisible();
  const settings = await openEvidenceSettings(page, "Legacy daily");
  await expect(
    settings.getByLabel("Calendar bucket", { exact: true }),
  ).toHaveValue("day");
  await settings
    .getByRole("button", { name: "Date window", exact: true })
    .click();
  await expect(page.getByLabel("From date", { exact: true })).toHaveValue(
    "2026-09-08",
  );
  await expect(page.getByLabel("To date", { exact: true })).toHaveValue(
    "2026-10-07",
  );
  await page.keyboard.press("Escape");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  const gate = evidenceBarrier();
  await page.route("**/api/workspace", async (route) => {
    gate.signalStarted();
    await gate.wait;
    await route.fulfill({ json: workspaceData });
  });
  const manager = page.getByRole("region", {
    name: "Manage Board widgets",
    exact: true,
  });
  await manager
    .getByRole("button", { name: "Edit Legacy daily settings", exact: true })
    .click();
  await gate.started;
  api.state.widgets = [];
  api.state.revision += 1;
  await manager
    .getByRole("button", { name: "Reload widgets", exact: true })
    .click();
  await expect(
    manager.getByText("This Board has no widgets.", { exact: true }),
  ).toBeVisible();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/workspace" &&
        response.status() === 200,
    ),
    Promise.resolve().then(() => gate.release()),
  ]);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(
    manager.getByRole("button", { name: "Save settings", exact: true }),
  ).toHaveCount(0);
  expect(api.writes).toEqual([]);
});

test("S30 saved Chart creation rechecks current authority and stores only its reference", async ({
  page,
}) => {
  const api = await installEvidenceBoardApi(page, null);
  await installS30WidgetData(page);
  let refused = false;
  let reads = 0;
  await page.route("**/api/charts?*", (route) =>
    route.fulfill({ json: evidencePage([evidenceChart()], 25) }),
  );
  await page.route(`**/api/charts/${evidenceChartId}`, (route) => {
    reads += 1;
    return refused
      ? route.fulfill({
          status: 403,
          json: { detail: "Chart source unavailable" },
        })
      : route.fulfill({ json: evidenceChart() });
  });
  await page.goto(`/boards?board=${boardId}`);
  await page
    .getByRole("button", { name: "Manage widgets", exact: true })
    .click();
  const manager = page.getByRole("region", {
    name: "Manage Board widgets",
    exact: true,
  });
  const create = manager.locator("form").filter({
    has: page.getByRole("button", { name: "Add widget", exact: true }),
  });
  await expect(create.getByLabel("Widget type", { exact: true })).toBeVisible();
  await create
    .getByLabel("Widget name", { exact: true })
    .fill("Current saved Chart");
  await create.getByLabel("Widget type", { exact: true }).selectOption("chart");
  await create
    .getByLabel("Chart source", { exact: true })
    .selectOption("saved");
  await create
    .getByLabel("Data source", { exact: true })
    .selectOption(moduleId);
  await create
    .getByRole("combobox", { name: "Saved Chart", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Private source name", exact: true })
    .click();
  await expect(
    create.getByRole("button", { name: "Add widget", exact: true }),
  ).toBeEnabled();
  const beforeSave = reads;
  refused = true;
  await create.getByRole("button", { name: "Add widget", exact: true }).click();
  await expect(
    create.getByText("Private source name", { exact: true }),
  ).toHaveCount(0);
  await expect(
    create.getByRole("button", { name: "Retry saved Chart", exact: true }),
  ).toBeVisible();
  expect(api.writes).toEqual([]);
  expect(reads).toBeGreaterThan(beforeSave);
  refused = false;
  await create
    .getByRole("button", { name: "Retry saved Chart", exact: true })
    .click();
  await expect(
    create.getByRole("button", { name: "Add widget", exact: true }),
  ).toBeEnabled();
  await create.getByRole("button", { name: "Add widget", exact: true }).click();
  await expect(
    manager.getByRole("button", {
      name: "Edit Current saved Chart settings",
      exact: true,
    }),
  ).toBeEnabled();
  expect(api.writes).toHaveLength(1);
  expect(api.writes[0].body).toMatchObject({
    revision: 1,
    widget: {
      widget_type: "chart",
      module_id: moduleId,
      chart_id: evidenceChartId,
      config: null,
    },
  });
  await page.reload();
  await expect(
    page.getByText("123456789012.1234", { exact: true }),
  ).toBeVisible();
  expect(api.state.widgets[0]).toMatchObject({
    chart_id: evidenceChartId,
    config: null,
  });
});

test("S27 Board query editing preserves full definition and outer name module size and pin", async ({
  page,
}) => {
  const api = await installEvidenceBoardApi(page, evidenceWidget("inline"));
  await installS27BoardFields(page);
  await installEvidenceSnapshot(page);
  await page.goto(`/boards?board=${boardId}`);
  const settings = await openEvidenceSettings(page, "Retained Board query");
  await settings.getByLabel("Measure", { exact: true }).selectOption("min");
  if (process.env.OPENVIEW_CAPTURE_DIR) {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await hideDevOverlay(page);
    const options = {
      beforeScreenshot: async (
        capture: Page,
        viewport: { width: number; height: number },
      ) => {
        await expect
          .poll(() =>
            capture.evaluate(() => document.documentElement.scrollWidth),
          )
          .toBeLessThanOrEqual(viewport.width);
        if (viewport.width === 390) {
          await settings
            .getByText("Chart source", { exact: true })
            .evaluate((element) => element.scrollIntoView({ block: "start" }));
        } else {
          await settings
            .getByRole("heading", { name: "Widget settings", exact: true })
            .scrollIntoViewIfNeeded();
        }
        await expect(
          settings.getByLabel("Measure", { exact: true }),
        ).toHaveValue("min");
      },
    };
    await captureOpenViewReview(page, "s27-board-dialog-light", options);
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await captureOpenViewReview(page, "s27-board-dialog-dark", options);
  }
  await settings
    .getByLabel("Widget name", { exact: true })
    .fill("Minimum retained query");
  await settings.getByLabel("Size", { exact: true }).selectOption("L");
  await settings.getByLabel("Pin this widget", { exact: true }).check();
  await settings
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Manage Board widgets", exact: true })
      .getByRole("button", {
        name: "Edit Minimum retained query settings",
        exact: true,
      }),
  ).toBeEnabled();
  await expect(settings).toBeHidden();
  expect(api.writes).toEqual([
    {
      method: "PATCH",
      path: `/api/boards/${boardId}/widgets/${widgetId}`,
      body: {
        revision: 1,
        widget: {
          name: "Minimum retained query",
          widget_type: "chart",
          module_id: moduleId,
          size: "L",
          pinned: true,
          chart_id: null,
          config: {
            version: 1,
            chart_type: "bar",
            query: { ...evidenceQuery, aggregation: "min" },
          },
        },
      },
    },
  ]);
});

test("S27 correction F2 later field-page denial hides all catalog names but retains the typed Board query until fresh recovery", async ({
  page,
}) => {
  const api = await installEvidenceBoardApi(page, evidenceWidget("inline"));
  await installEvidenceSnapshot(page);
  await page.route("**/api/views/data-sources?*", (route) =>
    route.fulfill({
      json: evidencePage(
        [
          {
            id: moduleId,
            department_id: otherBoardId,
            name: "Private catalog source",
            title_field_id: null,
          },
        ],
        100,
      ),
    }),
  );
  let refused = false;
  let deniedReads = 0;
  await page.route(
    `**/api/views/data-sources/${moduleId}/fields?*`,
    (route) => {
      if (
        new URL(route.request().url()).searchParams.get("offset") !== "0" &&
        refused
      ) {
        deniedReads += 1;
        return route.fulfill({
          status: 403,
          json: { detail: "Private fields denial" },
        });
      }
      return route.fulfill({
        json: {
          items: [
            {
              id: fieldId,
              module_id: moduleId,
              name: "Private dimension label",
              type: "text",
              required: false,
              position: 0,
              config: {},
            },
            {
              id: evidenceMeasureId,
              module_id: moduleId,
              name: "Private measure label",
              type: "decimal",
              required: false,
              position: 1,
              config: {},
            },
          ],
          pagination: {
            limit: 100,
            offset: 0,
            count: 2,
            total: 3,
            has_more: true,
          },
        },
      });
    },
  );
  await page.goto(`/boards?board=${boardId}`);
  const settings = await openEvidenceSettings(page, "Retained Board query");
  await settings
    .getByLabel("Widget name", { exact: true })
    .fill("Typed local widget name");
  await settings.getByLabel("Measure", { exact: true }).selectOption("min");
  await settings
    .getByRole("button", { name: "Filters (1)", exact: true })
    .click();
  await page
    .getByLabel("Filter 1 value", { exact: true })
    .fill("typed critical query");
  await page.keyboard.press("Escape");
  const manager = page.getByRole("region", {
    name: "Manage Board widgets",
    exact: true,
  });
  for (const name of [
    "Private catalog source",
    "Private dimension label",
    "Private measure label",
  ])
    await expect(manager).toContainText(name);
  refused = true;
  await settings
    .getByRole("button", { name: "Load more fields", exact: true })
    .click();
  await expect.poll(() => deniedReads).toBe(1);
  for (const name of [
    "Private catalog source",
    "Private dimension label",
    "Private measure label",
    "Private fields denial",
  ])
    await expect(manager).not.toContainText(name);
  await expect(settings.getByLabel("Widget name", { exact: true })).toHaveValue(
    "Typed local widget name",
  );
  await expect(
    settings.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeDisabled();
  expect(api.writes).toEqual([]);
  if (process.env.OPENVIEW_CAPTURE_DIR) {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await hideDevOverlay(page);
    const options = {
      beforeScreenshot: async (
        capture: Page,
        viewport: { width: number; height: number },
      ) => {
        await capture
          .getByRole("dialog", { name: "Manage Board widgets", exact: true })
          .getByLabel("Chart source", { exact: true })
          .scrollIntoViewIfNeeded();
        await expect
          .poll(() =>
            capture.evaluate(() => document.documentElement.scrollWidth),
          )
          .toBeLessThanOrEqual(viewport.width);
        await expect(
          settings.getByRole("button", { name: "Save settings", exact: true }),
        ).toBeDisabled();
        for (const name of [
          "Private catalog source",
          "Private dimension label",
          "Private measure label",
        ])
          await expect(manager).not.toContainText(name);
      },
    };
    await captureOpenViewReview(
      page,
      "s27-correction-board-refusal-light",
      options,
    );
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await captureOpenViewReview(
      page,
      "s27-correction-board-refusal-dark",
      options,
    );
  }
  refused = false;
  await settings
    .getByRole("button", { name: "Retry fields", exact: true })
    .click();
  await expect(settings.getByLabel("Data source", { exact: true })).toHaveValue(
    moduleId,
  );
  await expect(settings.getByLabel("Group by", { exact: true })).toHaveValue(
    fieldId,
  );
  await expect(
    settings.getByLabel("Numeric measure", { exact: true }),
  ).toHaveValue(evidenceMeasureId);
  await expect(settings.getByLabel("Measure", { exact: true })).toHaveValue(
    "min",
  );
  await settings
    .getByRole("button", { name: "Filters (1)", exact: true })
    .click();
  await expect(page.getByLabel("Filter 1 value", { exact: true })).toHaveValue(
    "typed critical query",
  );
  await page.keyboard.press("Escape");
  await expect(
    settings.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeEnabled();
  expect(api.writes).toEqual([]);
});

test("S27 Board saved picker later-page denial withdraws cached names until the list is retried", async ({
  page,
}) => {
  const api = await installEvidenceBoardApi(page, evidenceWidget("inline"));
  await installS27BoardFields(page);
  await installEvidenceSnapshot(page);
  let refused = false;
  let deniedReads = 0;
  await page.route("**/api/charts?*", (route) => {
    const offset = Number(
      new URL(route.request().url()).searchParams.get("offset"),
    );
    if (offset && refused) {
      deniedReads += 1;
      return route.fulfill({
        status: 403,
        json: { detail: "Private page refusal" },
      });
    }
    return route.fulfill({
      json: {
        items: [evidenceChart()],
        pagination: {
          limit: 25,
          offset: 0,
          count: 1,
          total: 2,
          has_more: true,
        },
      },
    });
  });
  await page.route(`**/api/charts/${evidenceChartId}`, (route) =>
    route.fulfill({ json: evidenceChart() }),
  );
  await page.goto(`/boards?board=${boardId}`);
  const settings = await openEvidenceSettings(page, "Retained Board query");
  await settings
    .getByLabel("Chart source", { exact: true })
    .selectOption("saved");
  await settings
    .getByRole("combobox", { name: "Saved Chart", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Private source name", exact: true })
    .click();
  await expect(
    settings.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeEnabled();
  await expect(page.getByPlaceholder("Search…", { exact: true })).toHaveCount(
    0,
  );
  await settings
    .getByRole("combobox", { name: "Saved Chart", exact: true })
    .click();
  refused = true;
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect.poll(() => deniedReads).toBe(1);
  await expect(
    page.getByText("Private source name", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Private page refusal", { exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeDisabled();
  await expect(settings.getByLabel("Widget name", { exact: true })).toHaveValue(
    "Retained Board query",
  );
  expect(api.writes).toEqual([]);
  refused = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("option", { name: "Private source name", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("option", { name: "Private source name", exact: true })
    .click();
  await expect(
    settings.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeEnabled();
  expect(api.writes).toEqual([]);
});

test("S27 Board inline to saved source stores only the reference and reauthorizes before writing", async ({
  page,
}) => {
  const api = await installEvidenceBoardApi(page, evidenceWidget("inline"));
  await installS27BoardFields(page);
  await installEvidenceSnapshot(page);
  await page.route("**/api/charts?*", (route) =>
    route.fulfill({ json: evidencePage([evidenceChart()], 25) }),
  );
  let chartReads = 0;
  let refused = false;
  await page.route(`**/api/charts/${evidenceChartId}`, (route) => {
    chartReads += 1;
    return refused
      ? route.fulfill({
          status: 404,
          json: { detail: "Private saved source refusal" },
        })
      : route.fulfill({ json: evidenceChart() });
  });
  await page.goto(`/boards?board=${boardId}`);
  const settings = await openEvidenceSettings(page, "Retained Board query");
  await settings
    .getByLabel("Chart source", { exact: true })
    .selectOption("saved");
  await settings
    .getByRole("combobox", { name: "Saved Chart", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Private source name", exact: true })
    .click();
  await expect(
    settings.getByText("Checking the current saved Chart…", { exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => chartReads).toBe(1);
  refused = true;
  await settings
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    settings.getByText("Private source name", { exact: true }),
  ).toHaveCount(0);
  await expect(settings.getByLabel("Widget name", { exact: true })).toHaveValue(
    "Retained Board query",
  );
  expect(api.writes).toEqual([]);
  refused = false;
  await settings
    .getByRole("button", { name: "Retry saved Chart", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(settings).toBeHidden();
  await expect(
    page
      .getByRole("region", { name: "Manage Board widgets", exact: true })
      .getByRole("button", {
        name: "Edit Retained Board query settings",
        exact: true,
      }),
  ).toBeEnabled();
  expect(chartReads).toBeGreaterThanOrEqual(2);
  expect(api.writes).toEqual([
    {
      method: "PATCH",
      path: `/api/boards/${boardId}/widgets/${widgetId}`,
      body: {
        revision: 1,
        widget: {
          name: "Retained Board query",
          widget_type: "chart",
          module_id: moduleId,
          size: "M",
          pinned: false,
          chart_id: evidenceChartId,
          config: null,
        },
      },
    },
  ]);
});

for (const source of ["inline", "reference"] as const) {
  test(`E evidence Board ${source} settings save reload duplicate and reorder preserve the complete source`, async ({
    page,
  }, testInfo) => {
    const api = await installEvidenceBoardApi(page, evidenceWidget(source));
    await page.route(`**/api/charts/${evidenceChartId}`, (route) =>
      route.fulfill({ json: evidenceChart() }),
    );
    await installEvidenceSnapshot(page);
    await page.goto(`/boards?board=${boardId}`);
    await expect(
      page
        .getByText("Private Board group", { exact: true })
        .and(page.locator("span")),
    ).toBeVisible();
    let name = "Retained Board query";
    for (const [size, pinned] of [
      ["S", true],
      ["L", false],
      ["M", true],
    ] as const) {
      const settings = await openEvidenceSettings(page, name);
      name = `${source} ${size} retained query`;
      await settings.getByLabel("Widget name", { exact: true }).fill(name);
      await settings.getByLabel("Size", { exact: true }).selectOption(size);
      await settings
        .getByLabel("Pin this widget", { exact: true })
        .setChecked(pinned);
      await settings
        .getByRole("button", { name: "Save settings", exact: true })
        .click();
      const manager = page.getByRole("region", {
        name: "Manage Board widgets",
        exact: true,
      });
      await expect(
        manager.getByRole("button", {
          name: `Edit ${name} settings`,
          exact: true,
        }),
      ).toBeEnabled();
      expect(api.writes.at(-1)?.body).toEqual({
        revision: api.state.revision - 1,
        widget: {
          name,
          widget_type: "chart",
          module_id: moduleId,
          size,
          pinned,
          chart_id: source === "reference" ? evidenceChartId : null,
          config:
            source === "reference"
              ? null
              : { version: 1, chart_type: "bar", query: evidenceQuery },
        },
      });
      await manager
        .getByRole("button", { name: "Reload widgets", exact: true })
        .click();
      await manager
        .getByRole("button", { name: `Edit ${name} settings`, exact: true })
        .click();
      await expect(
        settings.getByLabel("Widget name", { exact: true }),
      ).toHaveValue(name);
      await expect(settings.getByLabel("Size", { exact: true })).toHaveValue(
        size,
      );
      if (pinned)
        await expect(
          settings.getByLabel("Pin this widget", { exact: true }),
        ).toBeChecked();
      else
        await expect(
          settings.getByLabel("Pin this widget", { exact: true }),
        ).not.toBeChecked();
      await settings
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Close widget management", exact: true })
        .click();
    }
    await page
      .getByRole("button", { name: "Manage widgets", exact: true })
      .click();
    const manager = page.getByRole("region", {
      name: "Manage Board widgets",
      exact: true,
    });
    await manager
      .getByRole("button", { name: `Duplicate ${name}`, exact: true })
      .click();
    await expect(
      manager.getByRole("button", {
        name: `Move ${name} copy earlier`,
        exact: true,
      }),
    ).toBeEnabled();
    await manager
      .getByRole("button", { name: `Move ${name} copy earlier`, exact: true })
      .click();
    await expect(
      manager.getByRole("list").getByRole("heading", { level: 3 }),
    ).toHaveText([`${name} copy`, name]);
    expect(api.writes.at(-1)?.body).toEqual({
      revision: api.state.revision - 1,
      widget_ids: [evidenceCopyId, widgetId],
    });
    await page
      .getByRole("button", { name: "Close widget management", exact: true })
      .click();
    await page.reload();
    const overview = page.getByRole("region", {
      name: "Record summaries",
      exact: true,
    });
    await expect(overview.getByRole("heading", { level: 3 })).toHaveText([
      `${name} copy`,
      name,
    ]);
    await expect(overview.getByText("Pinned", { exact: true })).toHaveCount(2);
    for (const item of api.state.widgets) {
      expect(item).toMatchObject({
        size: "M",
        pinned: true,
        chart_id: source === "reference" ? evidenceChartId : null,
        config:
          source === "reference"
            ? null
            : { version: 1, chart_type: "bar", query: evidenceQuery },
      });
    }
    await testInfo.attach("board-settings-wire", {
      body: JSON.stringify({ source, writes: api.writes, stored: api.state }),
      contentType: "application/json",
    });
  });
}

async function settleEvidenceBoard(page: Page) {
  const response = page.waitForResponse(
    (reply) =>
      new URL(reply.url()).pathname === "/api/records/aggregate-snapshot" &&
      reply.request().method() === "POST",
  );
  await sendOpenViewEvent(page, "resync");
  await response;
  await expect(
    page
      .getByText("Private Board group", { exact: true })
      .and(page.locator("span")),
  ).toBeVisible();
  await expect(
    page.getByText("Refreshing… showing the last loaded data.", {
      exact: true,
    }),
  ).toHaveCount(0);
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
  test(`E evidence Board current Chart ${fault} hides private results with zero downstream reads`, async ({
    page,
  }, testInfo) => {
    const api = await installEvidenceBoardApi(
      page,
      evidenceWidget("reference"),
    );
    let refused = false;
    let chartReads = 0;
    const downstream: Array<{ path: string; refused: boolean }> = [];
    await page.route("**/api/fields/**", (route) => {
      downstream.push({
        path: new URL(route.request().url()).pathname,
        refused,
      });
      return route.fallback();
    });
    await page.route("**/api/records/**", (route) => {
      downstream.push({
        path: new URL(route.request().url()).pathname,
        refused,
      });
      return route.fulfill({
        json: evidencePage(
          [
            {
              key: "private",
              label: "Private Board group",
              value: 12.5,
              record_count: 127,
            },
          ],
          1,
        ),
      });
    });
    await page.route(`**/api/charts/${evidenceChartId}`, (route) => {
      chartReads += 1;
      if (refused && (fault === "403" || fault === "404"))
        return route.fulfill({
          status: Number(fault),
          json: { detail: "Private source denial must not be displayed" },
        });
      const source: Record<string, unknown> = evidenceChart();
      if (refused) {
        if (fault === "archived") source.is_deleted = true;
        if (fault === "wrong-id") source.id = evidenceCopyId;
        if (fault === "wrong-module") {
          source.module_id = otherBoardId;
          source.query = { ...evidenceQuery, module_id: otherBoardId };
        }
        if (fault === "wrong-family") source.chart_type = "summary";
        if (fault === "malformed") source.query = { definition: {} };
      }
      return route.fulfill({ json: source });
    });
    await page.goto(`/boards?board=${boardId}`);
    await expect(
      page
        .getByText("Private Board group", { exact: true })
        .and(page.locator("span")),
    ).toBeVisible();
    await settleEvidenceBoard(page);
    const before = downstream.length;
    const originalReads = chartReads;
    refused = true;
    try {
      await sendOpenViewEvent(page, "invalidate", {
        entity: "charts",
        module_id: moduleId,
      });
      await expect.poll(() => chartReads).toBeGreaterThan(originalReads);
      await expect(
        page
          .getByText("Private Board group", { exact: true })
          .and(page.locator("span")),
      ).toHaveCount(0);
      await expect(page.getByText("12.5", { exact: true })).toHaveCount(0);
      await expect(
        page.getByText("Private source denial must not be displayed", {
          exact: true,
        }),
      ).toHaveCount(0);
      const overview = page.getByRole("region", {
        name: "Record summaries",
        exact: true,
      });
      await expect(
        overview.getByText(/unavailable|do not have access/i),
      ).toBeVisible();
      expect(downstream).toHaveLength(before);
      expect(api.writes).toEqual([]);
    } finally {
      await testInfo.attach("current-chart-boundary", {
        body: JSON.stringify({ fault, originalReads, chartReads, downstream }),
        contentType: "application/json",
      });
    }
  });
}

test("E evidence Board records Chart refusal stops both field metadata and record rows", async ({
  page,
}, testInfo) => {
  const api = await installEvidenceBoardApi(page, {
    ...evidenceWidget("reference"),
    widget_type: "records",
  });
  let refused = false;
  const reads: Array<{ path: string; refused: boolean }> = [];
  await page.route(`**/api/charts/${evidenceChartId}`, (route) =>
    route.fulfill(
      refused
        ? { status: 403, json: { detail: "Private denial detail" } }
        : {
            json: evidenceChart({
              chart_type: "records",
              query: { module_id: moduleId, definition: evidenceDefinition },
            }),
          },
    ),
  );
  await page.route(`**/api/fields/${fieldId}`, (route) => {
    reads.push({ path: "/api/fields", refused });
    return route.fulfill({
      json: {
        id: fieldId,
        module_id: moduleId,
        name: "Private column",
        type: "text",
        required: false,
        position: 350,
        config: {},
        is_deleted: false,
      },
    });
  });
  await page.route("**/api/records/query", (route) => {
    reads.push({ path: "/api/records/query", refused });
    return route.fulfill({
      json: evidencePage(
        [
          {
            id: recordId,
            module_id: moduleId,
            data: { [fieldId]: "Private Board row" },
            display_values: { [fieldId]: "Private Board row" },
            created_at: timestamp,
            updated_at: timestamp,
            deleted_at: null,
            is_deleted: false,
            performed_by: null,
          },
        ],
        5,
      ),
    });
  });
  await page.goto(`/boards?board=${boardId}`);
  await expect(
    page.getByText("Private Board row", { exact: true }),
  ).toBeVisible();
  const settled = page.waitForResponse("**/api/records/query");
  await sendOpenViewEvent(page, "resync");
  await settled;
  await expect(
    page.getByText("Private Board row", { exact: true }),
  ).toBeVisible();
  const before = reads.length;
  refused = true;
  await sendOpenViewEvent(page, "invalidate", {
    entity: "charts",
    module_id: moduleId,
  });
  await expect(
    page
      .getByRole("region", { name: "Record summaries", exact: true })
      .getByRole("alert"),
  ).toContainText("You do not have access to this data.");
  await expect(
    page.getByText("Private Board row", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Private column", { exact: true })).toHaveCount(
    0,
  );
  expect(reads).toHaveLength(before);
  expect(reads.some((item) => item.path === "/api/fields")).toBe(true);
  expect(reads.some((item) => item.path === "/api/records/query")).toBe(true);
  expect(api.writes).toEqual([]);
  await testInfo.attach("records-chart-boundary", {
    body: JSON.stringify(reads),
    contentType: "application/json",
  });
});

test("E evidence Board Chart hints and readable department move preserve dirty and pending settings", async ({
  page,
}, testInfo) => {
  const api = await installEvidenceBoardApi(page, evidenceWidget("reference"));
  let revision = 1;
  const sourceWrites: string[] = [];
  const requests: unknown[] = [];
  await page.route(`**/api/charts/${evidenceChartId}`, (route) => {
    if (route.request().method() !== "GET") {
      sourceWrites.push(route.request().method());
      return route.fulfill({ status: 405 });
    }
    return route.fulfill({
      json: evidenceChart({
        revision,
        department_id: revision === 1 ? otherBoardId : evidenceCopyId,
        query: {
          ...evidenceQuery,
          definition: {
            ...evidenceDefinition,
            search:
              revision === 1
                ? "retained search"
                : revision === 2
                  ? "current region"
                  : "pending region",
          },
        },
      }),
    });
  });
  await page.route("**/api/records/aggregate-snapshot", (route) => {
    const request = route.request().postDataJSON() as {
      definition: { search: string };
    };
    requests.push(request);
    const current = request.definition.search === "current region";
    const pending = request.definition.search === "pending region";
    return route.fulfill({
      json: evidencePage(
        [
          {
            key: "current",
            label: current
              ? "Current Board region"
              : pending
                ? "Pending Board region"
                : "Private Board group",
            value: current ? 9.25 : pending ? 23.75 : 12.5,
            record_count: 127,
          },
        ],
        1,
      ),
    });
  });
  await page.goto(`/boards?board=${boardId}`);
  await expect(
    page
      .getByText("Private Board group", { exact: true })
      .and(page.locator("span")),
  ).toBeVisible();
  await settleEvidenceBoard(page);
  const settings = await openEvidenceSettings(page, "Retained Board query");
  await settings
    .getByLabel("Widget name", { exact: true })
    .fill("Independent Board draft");
  await settings.getByLabel("Size", { exact: true }).selectOption("S");
  await settings.getByLabel("Pin this widget", { exact: true }).check();
  revision = 2;
  await sendOpenViewEvent(page, "invalidate", {
    entity: "charts",
    module_id: moduleId,
  });
  await expect(
    page
      .getByText("Current Board region", { exact: true })
      .and(page.locator("span")),
  ).toBeVisible();
  await expect(page.getByText("9.25", { exact: true })).toBeVisible();
  await expect(settings.getByLabel("Widget name", { exact: true })).toHaveValue(
    "Independent Board draft",
  );
  await expect(settings.getByLabel("Size", { exact: true })).toHaveValue("S");
  await expect(
    settings.getByLabel("Pin this widget", { exact: true }),
  ).toBeChecked();
  expect(api.writes).toEqual([]);
  const gate = api.holdSave();
  try {
    await settings
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await gate.started;
    await expect(
      settings.getByRole("button", { name: "Save settings", exact: true }),
    ).toBeDisabled();
    revision = 3;
    await sendOpenViewEvent(page, "invalidate", {
      entity: "charts",
      module_id: moduleId,
    });
    await expect(
      page
        .getByText("Pending Board region", { exact: true })
        .and(page.locator("span")),
    ).toBeVisible();
    await expect(page.getByText("23.75", { exact: true })).toBeVisible();
    await expect(
      settings.getByLabel("Widget name", { exact: true }),
    ).toHaveValue("Independent Board draft");
    await expect(
      settings.getByRole("button", { name: "Save settings", exact: true }),
    ).toBeDisabled();
    expect(api.writes).toHaveLength(1);
    expect(api.writes[0].body).toEqual({
      revision: 1,
      widget: {
        name: "Independent Board draft",
        widget_type: "chart",
        module_id: moduleId,
        size: "S",
        pinned: true,
        chart_id: evidenceChartId,
        config: null,
      },
    });
    expect(sourceWrites).toEqual([]);
    gate.release();
    await expect(
      page.getByRole("button", {
        name: "Edit Independent Board draft settings",
        exact: true,
      }),
    ).toBeEnabled();
    expect(api.state.widgets[0]).toMatchObject({
      name: "Independent Board draft",
      size: "S",
      pinned: true,
      chart_id: evidenceChartId,
      config: null,
    });
  } finally {
    gate.release();
    await testInfo.attach("chart-hint-draft-boundary", {
      body: JSON.stringify({
        requests,
        writes: api.writes,
        sourceWrites,
        stored: api.state.widgets,
      }),
      contentType: "application/json",
    });
  }
});

for (const replacement of ["board", "source", "account"] as const) {
  for (const heldOutcome of ["success", "refusal"] as const) {
    test(`E evidence Board held Chart ${heldOutcome} after ${replacement} replacement cannot disclose overwrite or poison`, async ({
      page,
    }, testInfo) => {
      const api = await installEvidenceBoardApi(
        page,
        evidenceWidget("reference"),
      );
      const nextChartId = "00000000-0000-4000-8000-000000000684";
      const nextActor = "00000000-0000-4000-8000-000000000685";
      let actor = "00000000-0000-4000-8000-000000000661";
      let held = false;
      const gate = evidenceBarrier();
      const replied = evidenceBarrier();
      const requests: Array<{ search: string; request: unknown }> = [];
      const nextQuery = {
        ...evidenceQuery,
        definition: { ...evidenceDefinition, search: "replacement target" },
      };
      const nextWidget: EvidenceWidgetWire = {
        ...evidenceWidget("reference"),
        board_id: replacement === "board" ? otherBoardId : boardId,
        name: "Replacement Board query",
        chart_id: nextChartId,
        updated_at: "2026-10-09T00:00:00Z",
      };
      await page.route("**/api/auth/session", (route) =>
        route.fulfill({
          json: { authenticated: true, user_id: actor, setup_required: false },
        }),
      );
      await page.route("**/api/auth/me", (route) =>
        route.fulfill({ json: { id: actor, role: "admin", access: [] } }),
      );
      await page.route("**/api/users/*/preferences", (route) =>
        route.fulfill({
          json: {
            user_id: new URL(route.request().url()).pathname.split("/")[3],
            theme: "light",
            appearance: { motion: "reduce", keyboard_shortcuts: true },
          },
        }),
      );
      const replacementBoard = {
        id: otherBoardId,
        scope: "project",
        department_id: null,
        name: "Replacement board",
        description: null,
        status: "active",
        revision: 1,
        level: "manage",
        created_at: timestamp,
        updated_at: timestamp,
      };
      await page.route("**/api/boards**", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/boards")
          return route.fulfill({
            json: evidencePage(
              [
                { ...replacementBoard, id: boardId, name: "Query overview" },
                replacementBoard,
              ],
              25,
            ),
          });
        if (path === `/api/boards/${otherBoardId}`)
          return route.fulfill({ json: replacementBoard });
        if (path === `/api/boards/${otherBoardId}/widgets`)
          return route.fulfill({
            json: { ...evidencePage([nextWidget]), board_revision: 1 },
          });
        return route.fallback();
      });
      await page.route(`**/api/charts/${evidenceChartId}`, async (route) => {
        if (!held) return route.fulfill({ json: evidenceChart() });
        gate.signalStarted();
        await gate.wait;
        try {
          await route.fulfill(
            heldOutcome === "refusal"
              ? { status: 403, json: { detail: "Old private source refusal" } }
              : { json: evidenceChart() },
          );
        } finally {
          replied.signalStarted();
        }
      });
      await page.route(`**/api/charts/${nextChartId}`, (route) =>
        route.fulfill({
          json: evidenceChart({
            id: nextChartId,
            name: "Replacement source",
            query: nextQuery,
            revision: 2,
          }),
        }),
      );
      await page.route("**/api/records/aggregate-snapshot", (route) => {
        const request = route.request().postDataJSON() as {
          definition: { search: string };
        };
        requests.push({ search: request.definition.search, request });
        const current = request.definition.search === "replacement target";
        return route.fulfill({
          json: evidencePage(
            [
              {
                key: current ? "new" : "old",
                label: current
                  ? "Replacement Board group"
                  : "Private Board group",
                value: current ? 24.75 : 12.5,
                record_count: 127,
              },
            ],
            1,
          ),
        });
      });
      await page.goto(`/boards?board=${boardId}`);
      await expect(
        page
          .getByText("Private Board group", { exact: true })
          .and(page.locator("span")),
      ).toBeVisible();
      await settleEvidenceBoard(page);
      const oldQueries = requests.filter(
        (item) => item.search === "retained search",
      ).length;
      held = true;
      try {
        await sendOpenViewEvent(page, "invalidate", {
          entity: "charts",
          module_id: moduleId,
        });
        await gate.started;
        if (replacement === "board") {
          await page
            .getByRole("button", { name: "Switch board", exact: true })
            .click();
          await page.getByLabel("Board", { exact: true }).click();
          await page.getByRole("option", { name: /Replacement board/ }).click();
          await expect(page).toHaveURL(new RegExp(`board=${otherBoardId}`));
        } else {
          api.state.widgets = [nextWidget];
          if (replacement === "account") {
            actor = nextActor;
            await page.evaluate(() =>
              window.dispatchEvent(new FocusEvent("focus")),
            );
            await expect(
              page.getByRole("dialog", { name: "Session verification" }),
            ).toBeHidden();
          } else {
            await sendOpenViewEvent(page, "invalidate", {
              entity: "board_widgets",
              board_id: boardId,
            });
          }
        }
        await expect(
          page
            .getByText("Replacement Board group", { exact: true })
            .and(page.locator("span")),
        ).toBeVisible();
        await expect(page.getByText("24.75", { exact: true })).toBeVisible();
        gate.release();
        await replied.started;
        await expect(
          page
            .getByText("Replacement Board group", { exact: true })
            .and(page.locator("span")),
        ).toBeVisible();
        await expect(
          page
            .getByText("Private Board group", { exact: true })
            .and(page.locator("span")),
        ).toHaveCount(0);
        await expect(
          page.getByText("Old private source refusal", { exact: true }),
        ).toHaveCount(0);
        const fresh = page.waitForResponse("**/api/records/aggregate-snapshot");
        await sendOpenViewEvent(page, "invalidate", {
          entity: "charts",
          module_id: moduleId,
        });
        await fresh;
        await expect(
          page
            .getByText("Replacement Board group", { exact: true })
            .and(page.locator("span")),
        ).toBeVisible();
        expect(requests.at(-1)?.request).toEqual(nextQuery);
        expect(
          requests.filter((item) => item.search === "retained search"),
        ).toHaveLength(oldQueries);
        expect(api.writes).toEqual([]);
      } finally {
        gate.release();
        await testInfo.attach("held-chart-target-boundary", {
          body: JSON.stringify({
            replacement,
            heldOutcome,
            actor,
            oldQueries,
            requests,
            writes: api.writes,
          }),
          contentType: "application/json",
        });
      }
    });
  }
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
        pagination: {
          limit: 5,
          offset: 0,
          count: 0,
          total: 0,
          has_more: false,
        },
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
          {
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
            deleted_at: null,
            is_deleted: false,
            performed_by: null,
          },
        ],
        pagination: {
          limit: 5,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
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
          pagination: {
            limit: 1,
            offset: 0,
            count: 0,
            total: 7,
            hasMore: true,
          },
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
          pagination: {
            limit: 5,
            offset: 0,
            count: 1,
            total: 1,
            hasMore: false,
          },
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
      pagination: {
        limit: 1,
        offset: 0,
        count: 0,
        total,
        hasMore: total > 0,
      },
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
          pagination: {
            limit: 5,
            offset: 0,
            count: 1,
            total: 1,
            hasMore: false,
          },
        },
      }),
    ]),
  );
  expect(html).toContain("Field names unavailable");
  expect(html).not.toContain("Private salary");
  expect(html).not.toContain("Field 1");
});

for (const scenario of [
  {
    name: "isolated values across a null gap",
    toDate: "2026-10-03",
    items: [
      { key: "2026-10-01", label: "2026-10-01", value: 3, record_count: 2 },
      { key: "2026-10-02", label: "2026-10-02", value: null, record_count: 0 },
      {
        key: "2026-10-03",
        label: "2026-10-03",
        value: "4.2500",
        record_count: 2,
      },
    ],
    pointCount: 2,
    exactValues: ["3", "—", "4.2500"],
    nullGap: true,
  },
  {
    name: "a single populated bucket",
    toDate: "2026-10-01",
    items: [
      {
        key: "2026-10-01",
        label: "2026-10-01",
        value: "4.2500",
        record_count: 2,
      },
    ],
    pointCount: 1,
    exactValues: ["4.2500"],
    nullGap: false,
  },
] as const) {
  test(`S30 Board line points preserve ${scenario.name}`, async ({
    page,
  }, testInfo) => {
    await installS26WidgetApi(page, [
      {
        ...wireWidget,
        name: "Sparse daily trend",
        widget_type: "chart",
        config: {
          version: 1,
          chart_type: "line",
          query: {
            mode: "date_series",
            module_id: moduleId,
            definition: s30Definition,
            aggregation: "average",
            measure: { field_id: evidenceMeasureId, expected_type: "decimal" },
            date_field: { field_id: s30DateFieldId, expected_type: "date" },
            from_date: "2026-10-01",
            to_date: scenario.toDate,
            bucket: "day",
          },
        },
      },
    ]);
    await installS30WidgetData(page);
    await page.route("**/api/records/aggregate-snapshot", (route) =>
      route.fulfill({
        json: evidencePage([...scenario.items], scenario.items.length),
      }),
    );
    await page.goto(`/boards?board=${boardId}`);
    const card = page.getByRole("listitem").filter({
      has: page.getByRole("heading", {
        name: "Sparse daily trend",
        exact: true,
      }),
    });
    for (const value of scenario.exactValues)
      await expect(
        card.getByRole("list").getByText(value, { exact: true }),
      ).toBeVisible();
    const svg = card.locator("svg.recharts-surface");
    const points = svg.locator("circle.recharts-line-dot");
    const readGeometry = () =>
      svg.evaluate((element) => {
        const surface = element as SVGSVGElement;
        const viewBox = surface.viewBox.baseVal;
        const plot = surface
          .querySelector<SVGGraphicsElement>(".recharts-cartesian-grid")
          ?.getBBox();
        return {
          viewBox: {
            x: viewBox.x,
            y: viewBox.y,
            width: viewBox.width,
            height: viewBox.height,
          },
          plot: plot
            ? { x: plot.x, y: plot.y, width: plot.width, height: plot.height }
            : null,
          points: Array.from(
            surface.querySelectorAll<SVGCircleElement>(
              "circle.recharts-line-dot",
            ),
          ).map((point) => ({
            x: point.cx.baseVal.value,
            y: point.cy.baseVal.value,
            radius: point.r.baseVal.value,
          })),
          path:
            surface
              .querySelector("path.recharts-line-curve")
              ?.getAttribute("d") ?? null,
        };
      });
    try {
      // Point visibility, not an exact-value list or a zero-length isolated path,
      // is the retained Board geometry contract. Null buckets have no point.
      await expect(points).toHaveCount(scenario.pointCount);
      for (let index = 0; index < scenario.pointCount; index++)
        await expect(points.nth(index)).toBeVisible();
      await expect
        .poll(async () => {
          const geometry = await readGeometry();
          const plot = geometry.plot;
          return (
            !!plot &&
            geometry.points.length === scenario.pointCount &&
            geometry.points.every(
              (point) =>
                Number.isFinite(point.x) &&
                Number.isFinite(point.y) &&
                point.radius > 0 &&
                point.x >= plot.x - 1 &&
                point.x <= plot.x + plot.width + 1 &&
                point.y >= plot.y - 1 &&
                point.y <= plot.y + plot.height + 1,
            )
          );
        })
        .toBe(true);
      if (scenario.nullGap) {
        await expect
          .poll(async () => (await readGeometry()).path?.match(/M/g)?.length)
          .toBe(2);
        const geometry = await readGeometry();
        expect(geometry.points[0]!.x).toBeLessThan(geometry.points[1]!.x);
        expect(geometry.points[0]!.y).toBeGreaterThan(geometry.points[1]!.y);
      }
      await expect(svg.locator(".recharts-label-list")).toHaveCount(0);
    } finally {
      await testInfo.attach("s30-line-point-geometry", {
        body: JSON.stringify(
          { scenario: scenario.name, ...(await readGeometry()) },
          null,
          2,
        ),
        contentType: "application/json",
      });
    }
  });
}

test("live Board Overview renders supported group and date charts with exact value text", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const workload = {
    ...wireWidget,
    name: "Work by status",
    widget_type: "workload",
    size: "S",
    pinned: true,
    config: {
      ...wireWidget.config,
      metric: { field_id: evidenceMeasureId, expected_type: "decimal" },
    },
  };
  const bar = {
    ...workload,
    id: otherBoardId,
    name: "Requests by team",
    widget_type: "chart",
    position: 1,
    size: "M",
    pinned: false,
  };
  const pie = {
    ...bar,
    id: recordId,
    name: "Request share",
    position: 2,
    config: { ...bar.config, visualization: "pie" },
  };
  const line = {
    ...bar,
    id: fieldId,
    name: "Daily trend",
    position: 3,
    size: "L",
    config: {
      ...bar.config,
      fields: [{ field_id: s30DateFieldId, expected_type: "date" }],
      visualization: "line",
    },
  };
  const groups = [
    { key: "open", label: "Open", value: "4.25", record_count: 4 },
    { key: "closed", label: "Closed", value: "2.5", record_count: 2 },
  ];
  await installS26WidgetApi(page, [
    workload,
    bar,
    pie,
    line,
    {
      ...wireWidget,
      id: "00000000-0000-4000-8000-000000000685",
      position: 4,
      widget_type: "summary",
      name: "Matching requests",
      size: "S",
    },
    {
      ...wireWidget,
      id: "00000000-0000-4000-8000-000000000686",
      position: 5,
      name: "Recent requests",
      size: "M",
    },
  ]);
  await installS30WidgetData(page);
  for (const path of ["aggregate-query", "aggregate-snapshot"])
    await page.route(`**/api/records/${path}`, (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      const dates =
        body.mode === "date_series"
          ? aggregateBucketKeys(
              String(body.from_date),
              String(body.to_date),
              body.bucket as AggregateBucket,
              "monday",
            )
          : null;
      return route.fulfill({
        json: evidencePage(
          dates
            ? dates.map((key, index) => ({
                key,
                label: key,
                value:
                  index === 0
                    ? 3
                    : index === 1
                      ? null
                      : index === dates.length - 1
                        ? "4.2500"
                        : 0,
                record_count: index === 1 ? 0 : 2,
              }))
            : groups,
          dates
            ? dates.length
            : path === "aggregate-query"
              ? Number(body.limit)
              : 10000,
        ),
      });
    });
  await page.goto(`/boards?board=${boardId}`);
  for (const name of [workload.name, bar.name, pie.name, line.name]) {
    const card = page
      .getByRole("listitem")
      .filter({ has: page.getByRole("heading", { name, exact: true }) });
    await expect(
      card.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    // Live geometry, not SSR of Playwright's JSX transport objects.
    await expect(card.locator("svg.recharts-surface")).toBeVisible();
    const values = card.getByRole("list");
    if (name === line.name) {
      await expect(
        values.getByText("2026-09-08", { exact: true }),
      ).toBeVisible();
      await expect(values.getByText("—", { exact: true })).toBeVisible();
      await expect(values.getByText("4.2500", { exact: true })).toBeVisible();
    } else {
      for (const value of ["4.25", "Open", "Closed"])
        await expect(values.getByText(value, { exact: true })).toBeVisible();
    }
  }
  await expect(page.getByText("127", { exact: true })).toBeVisible();
  await expect(
    page.getByText("S30 priority row", { exact: true }),
  ).toBeVisible();
  // These counts describe the literal fixture above, not whatever happened to render.
  const geometryFixtures = [
    {
      name: "Work by status",
      marks: 2,
      points: 0,
      selector: ".recharts-bar-rectangle path, .recharts-bar-rectangle rect",
    },
    {
      name: "Requests by team",
      marks: 2,
      points: 0,
      selector: ".recharts-bar-rectangle path, .recharts-bar-rectangle rect",
    },
    {
      name: "Request share",
      marks: 2,
      points: 0,
      selector: ".recharts-pie-sector path.recharts-sector",
    },
    {
      name: "Daily trend",
      marks: 1,
      points: 29,
      selector: "path.recharts-line-curve",
    },
  ];
  const readGeometry = () =>
    page.locator('[data-slot="chart"]').evaluateAll((containers, fixtures) => {
      function bounds(rect: DOMRect | SVGRect) {
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
      function shape(element: SVGGraphicsElement) {
        const path = element instanceof SVGPathElement ? element : null;
        const length = path?.getAttribute("d") ? path.getTotalLength() : 0;
        const endpoint = length > 0 ? path?.getPointAtLength(length) : null;
        const style = getComputedStyle(element);
        return {
          bounds: bounds(element.getBBox()),
          attributes: Object.fromEntries(
            ["x", "y", "width", "height", "d", "stroke-dasharray"].map(
              (name) => [name, element.getAttribute(name)],
            ),
          ),
          length,
          endpoint: endpoint ? { x: endpoint.x, y: endpoint.y } : null,
          dash: style.strokeDasharray,
          dashOffset: style.strokeDashoffset,
          fill: style.fill,
          stroke: style.stroke,
          opacity: style.opacity,
        };
      }
      return containers.map((container) => {
        const name = container.closest("li")?.querySelector("h3")?.textContent;
        const fixture = fixtures.find((expected) => expected.name === name);
        const svg = container.querySelector<SVGSVGElement>(
          "svg.recharts-surface",
        );
        const grid = svg?.querySelector<SVGGraphicsElement>(
          ".recharts-cartesian-grid",
        );
        const series = Array.from(
          svg?.querySelectorAll<SVGGraphicsElement>(
            ".recharts-bar, .recharts-pie, .recharts-line",
          ) ?? [],
        );
        const marks = fixture
          ? Array.from(
              svg?.querySelectorAll<SVGGraphicsElement>(fixture.selector) ?? [],
            ).map(shape)
          : [];
        const line = svg?.querySelector<SVGPathElement>(
          "path.recharts-line-curve",
        );
        return {
          name,
          expectedMarks: fixture?.marks ?? 0,
          expectedPoints: fixture?.points ?? 0,
          chartId: container.getAttribute("data-chart"),
          container: bounds(container.getBoundingClientRect()),
          svg: svg ? bounds(svg.getBoundingClientRect()) : null,
          viewBox: svg ? bounds(svg.viewBox.baseVal) : null,
          plot: grid ? bounds(grid.getBBox()) : null,
          series: series.map((element) => ({
            id: element.getAttribute("id"),
            kind: element.getAttribute("class"),
          })),
          marks,
          points: Array.from(
            svg?.querySelectorAll<SVGCircleElement>(
              "circle.recharts-line-dot",
            ) ?? [],
          ).map(shape),
          line: line ? shape(line) : null,
        };
      });
    }, geometryFixtures);
  async function expectGeometryReady(phase: string) {
    let readings: Awaited<ReturnType<typeof readGeometry>> = [];
    let previousGeometry = "";
    try {
      await expect(page.locator("svg.recharts-surface")).toHaveCount(
        geometryFixtures.length,
      );
      await expect
        .poll(
          async () => {
            const charts = await readGeometry();
            readings = charts;
            const geometry = JSON.stringify(charts);
            const stable = geometry === previousGeometry;
            previousGeometry = geometry;
            const inside = (
              box: { x: number; y: number; width: number; height: number },
              area: { x: number; y: number; width: number; height: number },
            ) =>
              box.x >= area.x - 1 &&
              box.y >= area.y - 1 &&
              box.x + box.width <= area.x + area.width + 1 &&
              box.y + box.height <= area.y + area.height + 1;
            return (
              stable &&
              charts.length === geometryFixtures.length &&
              charts.every((chart) => {
                if (
                  !chart.svg ||
                  !chart.viewBox ||
                  chart.expectedMarks === 0 ||
                  chart.svg.width <= 0 ||
                  chart.svg.height <= 0 ||
                  chart.container.width <= 0 ||
                  chart.container.height <= 0 ||
                  Math.abs(chart.svg.width - chart.container.width) > 1 ||
                  Math.abs(chart.svg.height - chart.container.height) > 1 ||
                  Math.abs(chart.viewBox.width - chart.container.width) > 1 ||
                  Math.abs(chart.viewBox.height - chart.container.height) > 1
                )
                  return false;
                const viewBox = chart.viewBox;
                const plot = chart.plot ?? viewBox;
                if (!inside(plot, viewBox)) return false;
                if (
                  chart.marks.length !== chart.expectedMarks ||
                  chart.marks.some(
                    (mark) =>
                      mark.bounds.width <= 0 ||
                      mark.bounds.height <= 0 ||
                      !inside(mark.bounds, plot),
                  )
                )
                  return false;
                if (chart.line) {
                  const dash = Number.parseFloat(chart.line.dash);
                  if (
                    chart.line.length <= 0 ||
                    (chart.line.dash !== "none" &&
                      (!Number.isFinite(dash) || dash < chart.line.length - 1))
                  )
                    return false;
                }
                if (
                  chart.points.length !== chart.expectedPoints ||
                  chart.points.some((point) => {
                    const { x, y, width, height } = point.bounds;
                    const centerX = x + width / 2;
                    const centerY = y + height / 2;
                    return (
                      width <= 0 ||
                      height <= 0 ||
                      !inside(point.bounds, viewBox) ||
                      centerX < plot.x - 1 ||
                      centerX > plot.x + plot.width + 1 ||
                      centerY < plot.y - 1 ||
                      centerY > plot.y + plot.height + 1
                    );
                  })
                )
                  return false;
                return true;
              })
            );
          },
          {
            message: `${phase}: SVG viewBox must exist, with valid container size and stable final marks inside plot`,
          },
        )
        .toBe(true);
    } finally {
      await testInfo.attach(`s30-chart-readiness-${phase}`, {
        body: JSON.stringify(
          {
            nativeClock: true,
            phase,
            viewport: page.viewportSize(),
            charts: readings,
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
    }
  }
  // The same protection exercises the native resize cases even without capture mode.
  for (const [phase, mode, width, height] of [
    ["light desktop", "light", 1440, 900],
    ["light phone after desktop", "light", 390, 844],
    ["dark desktop after phone", "dark", 1440, 900],
    ["dark full-page-height viewport", "dark", 1440, 2005],
    ["dark desktop restored", "dark", 1440, 900],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(applyAppearancePreferences, {
      mode,
      reduceMotion: true,
    });
    await expectGeometryReady(phase);
  }
  if (process.env.OPENVIEW_CAPTURE_DIR) {
    await hideDevOverlay(page);
    await page.evaluate(() => document.fonts.ready);
    for (const mode of ["light", "dark"] as const) {
      await page.evaluate(applyAppearancePreferences, {
        mode,
        reduceMotion: true,
      });
      await captureOpenViewReview(page, `s30-board-${mode}`, {
        beforeScreenshot: async (capture, viewport) => {
          // Native ResizeObserver delivery must settle every SVG and fixture mark,
          // including after the capture helper changes the responsive viewport.
          await expectGeometryReady(
            `capture ${mode} ${viewport.width}x${viewport.height}`,
          );
          expect(
            await capture.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          const fullPageHeight = await capture.evaluate(() =>
            Math.max(
              document.documentElement.scrollHeight,
              document.body.scrollHeight,
            ),
          );
          console.log(
            `S30 Board ${mode} ${viewport.width}x${viewport.height}: full-page height ${fullPageHeight}px`,
          );
        },
      });
    }
  }
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
          pagination: {
            limit: 10000,
            offset: 0,
            count: 2,
            total: 2,
            hasMore: false,
          },
        },
      }),
      widgetItem(line, {
        kind: "snapshot",
        result: {
          items: [
            { ...huge[0], key: "2026-09-22" },
            { ...huge[1], key: "2026-09-23", value: "-1e308" },
          ],
          pagination: {
            limit: 10000,
            offset: 0,
            count: 2,
            total: 2,
            hasMore: false,
          },
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
          pagination: {
            limit: 8,
            offset: 0,
            count: 2,
            total: 2,
            hasMore: false,
          },
        },
      }),
    ]),
  );
  expect(html).toContain("Negative values cannot be shown as bars");
  expect(html).toContain(">5<");
  expect(html).toContain(">-5<");
  expect(html).not.toContain("bg-chart-1 h-full");
});

test("S05 widget create and edit omit refresh even when the server returns a legacy interval", async ({
  page,
}) => {
  await installOpenViewEventSource(page);
  const actor = "00000000-0000-4000-8000-000000000007";
  let revision = 4;
  let widgets: Record<string, unknown>[] = [
    {
      ...wireWidget,
      name: "Legacy requests",
      widget_type: "summary",
      config: { ...wireWidget.config, refresh: "five-minutes" },
    },
  ];
  const writes: Record<string, unknown>[] = [];
  const board = {
    id: boardId,
    scope: "project",
    department_id: null,
    name: "Operations board",
    description: "Synthetic S05 widget controls",
    status: "active",
    revision,
    level: "manage",
    created_at: timestamp,
    updated_at: timestamp,
  };
  const list = (items: unknown[], limit = 25) => ({
    items,
    pagination: {
      limit,
      offset: 0,
      count: items.length,
      total: items.length,
      has_more: false,
    },
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const reply = (json: unknown, status = 200) =>
      route.fulfill({ status, json });
    if (path === "/api/auth/session")
      return reply({
        authenticated: true,
        user_id: actor,
        setup_required: false,
      });
    if (path === "/api/auth/me")
      return reply({ id: actor, role: "admin", access: [] });
    if (path === "/api/views/data-sources")
      return reply(
        list(
          [
            {
              id: moduleId,
              name: "Service requests",
              department_id: otherBoardId,
              title_field_id: null,
            },
          ],
          25,
        ),
      );
    if (path === "/api/boards") return reply(list([{ ...board, revision }]));
    if (path === `/api/boards/${boardId}`) return reply({ ...board, revision });
    if (path === `/api/boards/${boardId}/my-access`)
      return reply({ level: "manage", read: true, write: true, manage: true });
    if (path === `/api/boards/${boardId}/widgets` && request.method() === "GET")
      return reply({
        ...list(widgets, Number(url.searchParams.get("limit") ?? 12)),
        board_revision: revision,
      });
    if (
      path === `/api/boards/${boardId}/widgets` ||
      path === `/api/boards/${boardId}/widgets/${widgetId}`
    ) {
      const input = request.postDataJSON() as {
        widget: {
          name: string;
          widget_type: string;
          module_id: string;
          config: Record<string, unknown>;
        };
        revision: number;
      };
      writes.push(input.widget.config);
      revision += 1;
      const returned = {
        ...wireWidget,
        ...input.widget,
        updated_at: "2035-06-01T00:00:00Z",
        id: request.method() === "POST" ? evidenceCopyId : widgetId,
        position: request.method() === "POST" ? 1 : 0,
        config:
          "fields" in input.widget.config
            ? { ...input.widget.config, refresh: "five-minutes" }
            : input.widget.config,
      };
      widgets =
        request.method() === "POST"
          ? [...widgets, returned]
          : widgets.map((item) => (item.id === widgetId ? returned : item));
      return reply(
        { widget: returned, board_revision: revision },
        request.method() === "POST" ? 201 : 200,
      );
    }
    if (path === "/api/records/query")
      return reply({ columns: [], rows: [], count: 3, has_more: false });
    return route.fallback();
  });
  await installS30WidgetData(page);
  await page.goto(`/boards?board=${boardId}`);
  await page
    .getByRole("button", { name: "Manage widgets", exact: true })
    .click();
  const manager = page.getByRole("region", {
    name: "Manage Board widgets",
    exact: true,
  });
  await manager
    .getByLabel("Widget name", { exact: true })
    .fill("Open requests");
  await manager
    .getByLabel("Data source", { exact: true })
    .selectOption(moduleId);
  await manager.getByLabel("Group by", { exact: true }).selectOption(fieldId);
  await manager
    .getByRole("button", { name: "Add widget", exact: true })
    .click();
  await expect(
    manager.getByRole("heading", { name: "Open requests", exact: true }),
  ).toBeVisible();
  expect(writes[0]).not.toHaveProperty("refresh");
  await manager
    .getByRole("button", { name: "Edit Legacy requests settings", exact: true })
    .click();
  await manager
    .getByLabel("Widget name", { exact: true })
    .first()
    .fill("Updated requests");
  await manager.getByLabel("Size", { exact: true }).selectOption("L");
  await manager.getByLabel("Pin this widget", { exact: true }).check();
  await manager
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    manager.getByRole("heading", { name: "Updated requests", exact: true }),
  ).toBeVisible();
  expect(writes[1]).not.toHaveProperty("refresh");
  await expect(page.getByText("Pinned", { exact: true })).toBeVisible();
  await expect(
    manager.getByRole("heading", { name: "Updated requests", exact: true }),
  ).toBeVisible();
});

test("S11 widget metadata and scoped record bursts refresh once on the shared stream", async ({
  page,
}) => {
  await installOpenViewEventSource(page);
  await page.clock.install();
  await page.route("**/api/users/*/preferences", (route) =>
    route.fulfill({
      json: {
        user_id: new URL(route.request().url()).pathname.split("/")[3],
        theme: "light",
        appearance: { motion: "reduce", keyboard_shortcuts: true },
      },
    }),
  );
  let name = "Open requests";
  let count = 3;
  let queryReads = 0;
  const actor = "00000000-0000-4000-8000-000000000007";
  const list = (items: unknown[], limit = 25) => ({
    items,
    pagination: {
      limit,
      offset: 0,
      count: items.length,
      total: items.length,
      has_more: false,
    },
  });
  const board = {
    id: boardId,
    scope: "project",
    department_id: null,
    name: "Operations board",
    description: "Current requests",
    status: "active",
    revision: 4,
    level: "manage",
    created_at: timestamp,
    updated_at: timestamp,
  };
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const reply = (json: unknown) => route.fulfill({ json });
    if (path === "/api/auth/session")
      return reply({
        authenticated: true,
        user_id: actor,
        setup_required: false,
      });
    if (path === "/api/auth/me")
      return reply({ id: actor, role: "admin", access: [] });
    if (path === "/api/boards") return reply(list([board]));
    if (path === `/api/boards/${boardId}`) return reply(board);
    if (path === `/api/boards/${boardId}/widgets`)
      return reply({
        ...list(
          [
            {
              ...wireWidget,
              name,
              widget_type: "summary",
              config: { ...wireWidget.config, fields: [] },
            },
          ],
          12,
        ),
        board_revision: 4,
      });
    if (path === "/api/records/query") {
      queryReads += 1;
      return reply({
        items: [
          {
            id: recordId,
            module_id: moduleId,
            data: {},
            display_values: {},
            is_deleted: false,
            created_at: timestamp,
            updated_at: timestamp,
            deleted_at: null,
            performed_by: null,
          },
        ],
        pagination: {
          limit: 1,
          offset: 0,
          count: 1,
          total: count,
          has_more: count > 1,
        },
      });
    }
    return route.fallback();
  });
  await page.goto(`/boards?board=${boardId}&section=overview`);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByText("3", { exact: true })).toBeVisible();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const before = queryReads;
  await sendOpenViewEvent(page, "invalidate", {
    entity: "board_widgets",
    board_id: otherBoardId,
  });
  await page.clock.runFor(301);
  expect(queryReads).toBe(before);
  name = "Remote request summary";
  count = 7;
  await sendOpenViewEvent(page, "invalidate", {
    entity: "board_widgets",
    board_id: boardId,
  });
  await page.clock.runFor(301);
  await expect
    .poll(async () => {
      await page.clock.runFor(1);
      return page.getByRole("heading", { name, exact: true }).count();
    })
    .toBe(1);
  await expect
    .poll(async () => {
      await page.clock.runFor(1);
      return page.getByText("7", { exact: true }).count();
    })
    .toBe(1);
  const afterMetadata = queryReads;
  await sendOpenViewEvent(page, "invalidate", {
    entity: "records",
    module_id: otherBoardId,
  });
  await page.clock.runFor(301);
  expect(queryReads).toBe(afterMetadata);
  count = 9;
  for (let index = 0; index < 3; index += 1)
    await sendOpenViewEvent(page, "invalidate", {
      entity: "records",
      module_id: moduleId,
    });
  await page.clock.runFor(299);
  expect(queryReads).toBe(afterMetadata);
  await page.clock.runFor(2);
  await expect
    .poll(async () => {
      await page.clock.runFor(1);
      return page.getByText("9", { exact: true }).count();
    })
    .toBe(1);
  expect(queryReads).toBe(afterMetadata + 1);
  expect(
    await page.evaluate(() => {
      const state = (
        window as Window & { __openViewStreamState?: () => { active: number } }
      ).__openViewStreamState;
      if (!state) throw new Error("The shared stream fixture is unavailable");
      return state().active;
    }),
  ).toBe(1);
  if (process.env.OPENVIEW_CAPTURE_DIR) {
    await hideDevOverlay(page);
    await page.evaluate(() => document.fonts.ready);
    for (const mode of ["light", "dark"] as const) {
      await page.evaluate(applyAppearancePreferences, {
        mode,
        reduceMotion: true,
      });
      await captureOpenViewReview(page, `s11-live-widget-${mode}`, {
        beforeScreenshot: async () => {
          await expect(
            page.getByRole("heading", { name, exact: true }),
          ).toBeInViewport();
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
        },
      });
    }
  }
});
