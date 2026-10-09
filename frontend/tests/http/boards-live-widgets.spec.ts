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
  emptyLiveWidgetsState,
  classifyLiveWidgetFailure,
  loadLiveWidgetData,
  loadLiveWidgetMetadata,
  transitionLiveWidgetsState,
  type LiveWidgetData,
  type LiveWidgetItem,
  type LiveWidgetsState,
} from "../../src/components/systems/boards/hooks/use-live-widgets";

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
  size: "M",
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
        page.getByText(
          visualization === "line" ? "2025-10-01" : "Work group 10",
          { exact: true },
        ),
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
              await capture.addStyleTag({
                content: "nextjs-portal { display: none !important; }",
              });
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
  initial: EvidenceWidgetWire,
) {
  await installS26WidgetApi(page, [initial]);
  const state = { widgets: [initial], revision: 1 };
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
      page.getByText("Private Board group", { exact: true }),
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
    page.getByText("Private Board group", { exact: true }),
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
      page.getByText("Private Board group", { exact: true }),
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
        page.getByText("Private Board group", { exact: true }),
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
    page.getByText("Private Board group", { exact: true }),
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
    page.getByText("Current Board region", { exact: true }),
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
      page.getByText("Pending Board region", { exact: true }),
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
        page.getByText("Private Board group", { exact: true }),
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
          page.getByText("Replacement Board group", { exact: true }),
        ).toBeVisible();
        await expect(page.getByText("24.75", { exact: true })).toBeVisible();
        gate.release();
        await replied.started;
        await expect(
          page.getByText("Replacement Board group", { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByText("Private Board group", { exact: true }),
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
          page.getByText("Replacement Board group", { exact: true }),
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

test("live Board Overview renders supported group and date charts with exact value text", () => {
  const workload = {
    ...widget,
    name: "Work by status",
    widgetType: "workload" as const,
  };
  const bar = {
    ...widget,
    id: otherBoardId,
    name: "Requests by team",
    widgetType: "chart" as const,
  };
  const pie = {
    ...bar,
    id: recordId,
    name: "Request share",
    config: { ...bar.config, visualization: "pie" as const },
  };
  const line = {
    ...bar,
    id: fieldId,
    name: "Daily trend",
    config: {
      ...bar.config,
      fields: [{ fieldId, expectedType: "date" as const }],
      visualization: "line" as const,
    },
  };
  const groups = [
    { key: "open", label: "Open", value: "4.25", recordCount: 4 },
    { key: "closed", label: "Closed", value: "2.5", recordCount: 2 },
  ];
  const html = renderWidgets(
    displayState([
      widgetItem(workload, {
        kind: "aggregate",
        result: {
          items: groups,
          pagination: {
            limit: 8,
            offset: 0,
            count: 2,
            total: 2,
            hasMore: false,
          },
        },
      }),
      widgetItem(bar, {
        kind: "aggregate",
        result: {
          items: groups,
          pagination: {
            limit: 12,
            offset: 0,
            count: 2,
            total: 2,
            hasMore: false,
          },
        },
      }),
      widgetItem(pie, {
        kind: "snapshot",
        result: {
          items: groups,
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
            { key: "2026-09-23", label: "Sep 23", value: 3, recordCount: 3 },
          ],
          pagination: {
            limit: 10000,
            offset: 0,
            count: 1,
            total: 1,
            hasMore: false,
          },
        },
      }),
    ]),
  );
  expect(html).toContain("Work by status");
  expect(html).toContain("Requests by team");
  expect(html).toContain("Request share");
  expect(html).toContain("Daily trend");
  expect(html).toContain("4.25");
  expect(html).toContain("Sep 23");
  expect(html).toContain("Open");
  expect(html).toContain("Closed");
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
  let widgets: Record<string, unknown>[] = [];
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
        config: { ...input.widget.config, refresh: "five-minutes" },
      };
      widgets = [returned];
      return reply(
        { widget: returned, board_revision: revision },
        request.method() === "POST" ? 201 : 200,
      );
    }
    if (path === "/api/records/query")
      return reply({ columns: [], rows: [], count: 3, has_more: false });
    return route.fallback();
  });
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
    .getByLabel("Active record source", { exact: true })
    .selectOption(moduleId);
  await manager
    .getByRole("button", { name: "Add summary widget", exact: true })
    .click();
  await expect(
    manager.getByRole("heading", { name: "Open requests", exact: true }),
  ).toBeVisible();
  expect(writes[0]).not.toHaveProperty("refresh");
  await manager
    .getByRole("button", { name: "Edit Open requests settings", exact: true })
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
    await page.addStyleTag({
      content: "nextjs-portal { display: none !important; }",
    });
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
