import {
  authMeBody,
  defaultOrganization,
  expect,
  test,
  type Page,
  isEventStream,
} from "./helpers/test";
import {
  installOpenViewEventSource,
  sendChartInvalidation,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";
import { applyAppearancePreferences } from "../../src/lib/appearance-preferences";
import {
  aggregateBucketKeys,
  type AggregateBucket,
} from "../../src/components/systems/openview/domain/aggregate-buckets";
import { gate as newGate, type Gate } from "./helpers/gate";
import { pageOf, wirePagination } from "../helpers/pagination";
import { emptyWireQuery } from "../helpers/query-definitions";
import {
  wireBoard,
  wireField,
  wireRecord,
  wireWorkspace,
  wireBucket,
} from "../helpers/wire";

const boardId = "00000000-0000-4000-8000-000000000001";
const otherBoardId = "00000000-0000-4000-8000-000000000002";
const moduleId = "00000000-0000-4000-8000-000000000003";
const widgetId = "00000000-0000-4000-8000-000000000004";
const fieldId = "00000000-0000-4000-8000-000000000005";
const recordId = "00000000-0000-4000-8000-000000000006";
const timestamp = "2026-09-23T00:00:00Z";
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

async function expectWidgetAppearanceMatrix(
  page: Page,
  assertState: (
    viewport: { width: number; height: number },
    mode: "light" | "dark",
  ) => Promise<void>,
) {
  const previous = await page.evaluate(() => ({
    mode: document.documentElement.classList.contains("dark")
      ? ("dark" as const)
      : ("light" as const),
    reduceMotion: document.documentElement.dataset.motion === "reduced",
  }));
  try {
    for (const mode of ["light", "dark"] as const) {
      await page.evaluate(applyAppearancePreferences, {
        mode,
        reduceMotion: true,
      });
      const originalViewport = page.viewportSize();
      const originalScrollY = await page.evaluate(() => window.scrollY);
      try {
        await page.evaluate(() => window.scrollTo(0, 0));
        for (const viewport of [
          { width: 1440, height: 900 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          await assertState(viewport, mode);
        }
      } finally {
        if (originalViewport) await page.setViewportSize(originalViewport);
        await page.evaluate((y) => window.scrollTo(0, y), originalScrollY);
      }
    }
  } finally {
    await page.evaluate(applyAppearancePreferences, previous);
  }
}

async function installS26WidgetApi(page: Page, widgets: unknown[]) {
  await installOpenViewEventSource(page);
  const actor = "00000000-0000-4000-8000-000000000661";
  const board = wireBoard({
    id: boardId,
    name: "Query overview",
    description: null,
    level: "manage",
    created_at: timestamp,
    updated_at: timestamp,
  });
  await page.route("**/api/**", (route) => {
    if (isEventStream(route)) return route.fallback();
    const url = new URL(route.request().url());
    const reply = (json: unknown) => route.fulfill({ json });
    if (url.pathname === "/api/auth/session")
      return reply({
        authenticated: true,
        user_id: actor,
        default_organization_blocked: null,
        organization_id: defaultOrganization.org_id,
        setup_required: false,
      });
    if (url.pathname === "/api/auth/me")
      return reply(
        authMeBody({
          id: actor,
          role: "admin",
          access: [],
          default_organization_blocked: null,
        }),
      );
    if (url.pathname === `/api/users/${actor}/preferences`)
      return reply({
        user_id: actor,
        theme: "light",
        appearance: { motion: "reduce", keyboard_shortcuts: true },
      });
    if (url.pathname === "/api/workspace")
      return reply(
        wireWorkspace({
          id: otherBoardId,
          locale: "en-US",
          timezone: "UTC",
          currency: "USD",
          today: "2026-10-07",
          purge_enabled: true,
        }),
      );
    if (url.pathname === "/api/boards")
      return reply(pageOf([board], { limit: 25 }));
    if (url.pathname === `/api/boards/${boardId}`) return reply(board);
    if (url.pathname === `/api/boards/${boardId}/my-access`)
      return reply({ read: true, write: true, manage: true, level: "manage" });
    if (url.pathname === `/api/boards/${boardId}/widgets`)
      return reply({
        ...pageOf(widgets, {
          limit: Number(url.searchParams.get("limit") ?? 12),
        }),
        board_revision: 1,
      });
    if (url.pathname === "/api/views/data-sources")
      return reply(
        pageOf(
          [
            {
              id: moduleId,
              name: "Requests",
              department_id: otherBoardId,
              title_field_id: null,
            },
          ],
          { limit: 25 },
        ),
      );
    return route.fulfill({ status: 404, json: { detail: "No route fixture" } });
  });
}

for (const sourceKind of ["inline", "reference"] as const) {
  for (const visualization of ["pie", "bar", "line"] as const) {
    test(`Board ${sourceKind} ${visualization} keeps all average groups exact with no additive Other`, async ({
      page,
    }) => {
      const chartId = "00000000-0000-4000-8000-000000000662";
      const measureId = "00000000-0000-4000-8000-000000000663";
      const query = {
        mode: "groups",
        module_id: moduleId,
        aggregation: "average",
        measure: { field_id: measureId, expected_type: "decimal" },
        dimension: { field_id: fieldId, expected_type: "text" },
        definition: emptyWireQuery(),
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
            items: Array.from({ length: 10 }, (_, index) =>
              wireBucket({
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
              }),
            ),
            pagination: wirePagination({ limit: 10, count: 10, total: 10 }),
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
  let saveGate: Gate | null = null;
  await page.route("**/api/boards/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith(`/api/boards/${boardId}/widgets`))
      return route.fallback();
    const method = route.request().method();
    if (method === "GET")
      return route.fulfill({
        json: {
          ...pageOf(state.widgets, { limit: 12 }),
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
      saveGate = newGate();
      return saveGate;
    },
  };
}
async function installEvidenceSnapshot(page: Page) {
  const requests: unknown[] = [];
  await page.route("**/api/records/aggregate-snapshot", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      json: pageOf(
        [
          wireBucket({
            key: "private",
            label: "Private Board group",
            value: 12.5,
            record_count: 127,
          }),
        ],
        { limit: 1 },
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
      json: pageOf(
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
        { limit: 100 },
      ),
    }),
  );
}

const s30DateFieldId = "00000000-0000-4000-8000-000000000690";
const s30Definition = emptyWireQuery();

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
    route.fulfill({ json: pageOf(fields, { limit: 100 }) }),
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
        json: pageOf(
          dates
            ? dates.map((key, index) =>
                wireBucket({
                  key,
                  value:
                    index === 0
                      ? body.aggregation === "count"
                        ? 7
                        : "123456789012.1234"
                      : null,
                  record_count: index === 0 ? 7 : 0,
                }),
              )
            : [
                wireBucket({
                  key: "measured",
                  label: "S30 measured group",
                  value: body.aggregation === "count" ? 7 : "123456789012.1234",
                  record_count: 7,
                }),
                wireBucket({
                  key: "missing",
                  label: "No measure",
                  value: body.aggregation === "count" ? 2 : null,
                  record_count: 2,
                }),
              ],
          {
            limit: dates
              ? dates.length
              : path === "aggregate-query"
                ? Number(body.limit)
                : 2,
          },
        ),
      });
    });
  await page.route("**/api/records/query", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    records.push(body);
    return route.fulfill({
      json: {
        items: [
          wireRecord({
            id: recordId,
            module_id: moduleId,
            data: {
              [fieldId]: "S30 priority row",
              [evidenceMeasureId]: "12.5000",
            },
            created_at: timestamp,
            updated_at: timestamp,
          }),
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
  test(`${kind} create edit and reload round trips the shared query and presentation`, async ({
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
  test(`legacy ${kind} opens complete instructions and saves an explicitly chosen query`, async ({
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

test("legacy count-all summary filters remain one bounded records read after shared editing", async ({
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

test("explicit legacy aggregation survives presentation save instead of metric inference", async ({
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

test("legacy line opens its workspace window and a late date read cannot restore removed settings", async ({
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
  const gate = newGate();
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

test("saved Chart creation rechecks current authority and stores only its reference", async ({
  page,
}) => {
  const api = await installEvidenceBoardApi(page, null);
  await installS30WidgetData(page);
  let refused = false;
  let reads = 0;
  await page.route("**/api/charts?*", (route) =>
    route.fulfill({ json: pageOf([evidenceChart()], { limit: 25 }) }),
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

test("Board query editing preserves full definition and outer name module size and pin", async ({
  page,
}) => {
  const api = await installEvidenceBoardApi(page, evidenceWidget("inline"));
  await installS27BoardFields(page);
  await installEvidenceSnapshot(page);
  await page.goto(`/boards?board=${boardId}`);
  const settings = await openEvidenceSettings(page, "Retained Board query");
  await settings.getByLabel("Measure", { exact: true }).selectOption("min");
  await page.emulateMedia({ reducedMotion: "reduce" });
  try {
    await expectWidgetAppearanceMatrix(page, async (viewport) => {
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
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
      await expect(settings.getByLabel("Measure", { exact: true })).toHaveValue(
        "min",
      );
    });
  } finally {
    await page.emulateMedia({ reducedMotion: null });
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

test("later field-page denial hides all catalog names but retains the typed Board query until fresh recovery", async ({
  page,
}) => {
  const api = await installEvidenceBoardApi(page, evidenceWidget("inline"));
  await installEvidenceSnapshot(page);
  await page.route("**/api/views/data-sources?*", (route) =>
    route.fulfill({
      json: pageOf(
        [
          {
            id: moduleId,
            department_id: otherBoardId,
            name: "Private catalog source",
            title_field_id: null,
          },
        ],
        { limit: 100 },
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
        json: pageOf(
          [
            wireField({
              id: fieldId,
              module_id: moduleId,
              name: "Private dimension label",
              type: "text",
              position: 0,
            }),
            wireField({
              id: evidenceMeasureId,
              module_id: moduleId,
              name: "Private measure label",
              type: "decimal",
              position: 1,
            }),
          ],
          { limit: 100, total: 3, hasMore: true },
        ),
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
  await page.emulateMedia({ reducedMotion: "reduce" });
  try {
    await expectWidgetAppearanceMatrix(page, async (viewport) => {
      await page
        .getByRole("dialog", { name: "Manage Board widgets", exact: true })
        .getByLabel("Chart source", { exact: true })
        .scrollIntoViewIfNeeded();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
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
    });
  } finally {
    await page.emulateMedia({ reducedMotion: null });
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

test("Board saved picker later-page denial withdraws cached names until the list is retried", async ({
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
      json: pageOf([evidenceChart()], { limit: 25, total: 2, hasMore: true }),
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

test("Board inline to saved source stores only the reference and reauthorizes before writing", async ({
  page,
}) => {
  const api = await installEvidenceBoardApi(page, evidenceWidget("inline"));
  await installS27BoardFields(page);
  await installEvidenceSnapshot(page);
  await page.route("**/api/charts?*", (route) =>
    route.fulfill({ json: pageOf([evidenceChart()], { limit: 25 }) }),
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
  test(`Board ${source} settings save reload duplicate and reorder preserve the complete source`, async ({
    page,
  }) => {
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
  test(`Board current Chart ${fault} hides private results with zero downstream reads`, async ({
    page,
  }) => {
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
        json: pageOf(
          [
            wireBucket({
              key: "private",
              label: "Private Board group",
              value: 12.5,
              record_count: 127,
            }),
          ],
          { limit: 1 },
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
    await sendChartInvalidation(page, moduleId);
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
  });
}

test("Board records Chart refusal stops both field metadata and record rows", async ({
  page,
}) => {
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
      json: pageOf(
        [
          wireRecord({
            id: recordId,
            module_id: moduleId,
            data: { [fieldId]: "Private Board row" },
            display_values: { [fieldId]: "Private Board row" },
            created_at: timestamp,
            updated_at: timestamp,
          }),
        ],
        { limit: 5 },
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
  await sendChartInvalidation(page, moduleId);
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
});

test("Board Chart hints and readable department move preserve dirty and pending settings", async ({
  page,
}) => {
  const api = await installEvidenceBoardApi(page, evidenceWidget("reference"));
  let revision = 1;
  const sourceWrites: string[] = [];
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
    const current = request.definition.search === "current region";
    const pending = request.definition.search === "pending region";
    return route.fulfill({
      json: pageOf(
        [
          wireBucket({
            key: "current",
            label: current
              ? "Current Board region"
              : pending
                ? "Pending Board region"
                : "Private Board group",
            value: current ? 9.25 : pending ? 23.75 : 12.5,
            record_count: 127,
          }),
        ],
        { limit: 1 },
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
  await sendChartInvalidation(page, moduleId);
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
    await sendChartInvalidation(page, moduleId);
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
  }
});

for (const replacement of ["board", "source", "account"] as const) {
  for (const heldOutcome of ["success", "refusal"] as const) {
    test(`Board held Chart ${heldOutcome} after ${replacement} replacement cannot disclose overwrite or poison`, async ({
      page,
    }) => {
      const api = await installEvidenceBoardApi(
        page,
        evidenceWidget("reference"),
      );
      const nextChartId = "00000000-0000-4000-8000-000000000684";
      const nextActor = "00000000-0000-4000-8000-000000000685";
      let actor = "00000000-0000-4000-8000-000000000661";
      let held = false;
      const gate = newGate();
      const replied = newGate();
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
          json: {
            authenticated: true,
            user_id: actor,
            organization_id: defaultOrganization.org_id,
            setup_required: false,
            default_organization_blocked: null,
          },
        }),
      );
      await page.route("**/api/auth/me", (route) =>
        route.fulfill({
          json: authMeBody({
            id: actor,
            role: "admin",
            access: [],
            default_organization_blocked: null,
          }),
        }),
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
      const replacementBoard = wireBoard({
        id: otherBoardId,
        name: "Replacement board",
        description: null,
        level: "manage",
        created_at: timestamp,
        updated_at: timestamp,
      });
      await page.route("**/api/boards**", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/boards")
          return route.fulfill({
            json: pageOf(
              [
                { ...replacementBoard, id: boardId, name: "Query overview" },
                replacementBoard,
              ],
              { limit: 25 },
            ),
          });
        if (path === `/api/boards/${otherBoardId}`)
          return route.fulfill({ json: replacementBoard });
        if (path === `/api/boards/${otherBoardId}/widgets`)
          return route.fulfill({
            json: { ...pageOf([nextWidget], { limit: 12 }), board_revision: 1 },
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
          json: pageOf(
            [
              wireBucket({
                key: current ? "new" : "old",
                label: current
                  ? "Replacement Board group"
                  : "Private Board group",
                value: current ? 24.75 : 12.5,
                record_count: 127,
              }),
            ],
            { limit: 1 },
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
        await sendChartInvalidation(page, moduleId);
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
        await sendChartInvalidation(page, moduleId);
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
      }
    });
  }
}

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
  test(`Board line points preserve ${scenario.name}`, async ({ page }) => {
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
        json: pageOf([...scenario.items], { limit: scenario.items.length }),
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
  });
}

test("live Board Overview renders supported group and date charts with exact value text", async ({
  page,
}) => {
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
    wireBucket({
      key: "open",
      label: "Open",
      value: "4.25",
      record_count: 4,
    }),
    wireBucket({
      key: "closed",
      label: "Closed",
      value: "2.5",
      record_count: 2,
    }),
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
        json: pageOf(
          dates
            ? dates.map((key, index) =>
                wireBucket({
                  key,
                  value:
                    index === 0
                      ? 3
                      : index === 1
                        ? null
                        : index === dates.length - 1
                          ? "4.2500"
                          : 0,
                  record_count: index === 1 ? 0 : 2,
                }),
              )
            : groups,
          {
            limit: dates
              ? dates.length
              : path === "aggregate-query"
                ? Number(body.limit)
                : 10000,
          },
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
    let previousGeometry = "";
    await expect(page.locator("svg.recharts-surface")).toHaveCount(
      geometryFixtures.length,
    );
    await expect
      .poll(
        async () => {
          const charts = await readGeometry();
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
  await page.evaluate(() => document.fonts.ready);
  await expectWidgetAppearanceMatrix(page, async (viewport, mode) => {
    await expectGeometryReady(
      `matrix ${mode} ${viewport.width}x${viewport.height}`,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
});

test("widget create and edit omit refresh even when the server returns a legacy interval", async ({
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
  const board = wireBoard({
    id: boardId,
    name: "Operations board",
    description: "Synthetic S05 widget controls",
    revision,
    level: "manage",
    created_at: timestamp,
    updated_at: timestamp,
  });
  await page.route("**/api/**", async (route) => {
    if (isEventStream(route)) return route.fallback();
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const reply = (json: unknown, status = 200) =>
      route.fulfill({ status, json });
    if (path === "/api/auth/session")
      return reply({
        authenticated: true,
        organization_id: defaultOrganization.org_id,
        user_id: actor,
        default_organization_blocked: null,
        setup_required: false,
      });
    if (path === "/api/auth/me")
      return reply(
        authMeBody({
          id: actor,
          role: "admin",
          access: [],
          default_organization_blocked: null,
        }),
      );
    if (path === "/api/views/data-sources")
      return reply(
        pageOf(
          [
            {
              id: moduleId,
              name: "Service requests",
              department_id: otherBoardId,
              title_field_id: null,
            },
          ],
          { limit: 25 },
        ),
      );
    if (path === "/api/boards")
      return reply(pageOf([{ ...board, revision }], { limit: 25 }));
    if (path === `/api/boards/${boardId}`) return reply({ ...board, revision });
    if (path === `/api/boards/${boardId}/my-access`)
      return reply({ level: "manage", read: true, write: true, manage: true });
    if (path === `/api/boards/${boardId}/widgets` && request.method() === "GET")
      return reply({
        ...pageOf(widgets, {
          limit: Number(url.searchParams.get("limit") ?? 12),
        }),
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

test("widget metadata and scoped record bursts refresh once on the shared stream", async ({
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
  const board = wireBoard({
    id: boardId,
    name: "Operations board",
    description: "Current requests",
    revision: 4,
    level: "manage",
    created_at: timestamp,
    updated_at: timestamp,
  });
  await page.route("**/api/**", (route) => {
    if (isEventStream(route)) return route.fallback();
    const path = new URL(route.request().url()).pathname;
    const reply = (json: unknown) => route.fulfill({ json });
    if (path === "/api/auth/session")
      return reply({
        authenticated: true,
        organization_id: defaultOrganization.org_id,
        user_id: actor,
        default_organization_blocked: null,
        setup_required: false,
      });
    if (path === "/api/auth/me")
      return reply(
        authMeBody({
          id: actor,
          role: "admin",
          access: [],
          default_organization_blocked: null,
        }),
      );
    if (path === "/api/boards") return reply(pageOf([board], { limit: 25 }));
    if (path === `/api/boards/${boardId}`) return reply(board);
    if (path === `/api/boards/${boardId}/widgets`)
      return reply({
        ...pageOf(
          [
            {
              ...wireWidget,
              name,
              widget_type: "summary",
              config: { ...wireWidget.config, fields: [] },
            },
          ],
          { limit: 12 },
        ),
        board_revision: 4,
      });
    if (path === "/api/records/query") {
      queryReads += 1;
      return reply(
        pageOf(
          [
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
          { limit: 1, total: count, hasMore: count > 1 },
        ),
      );
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
  await page.evaluate(() => document.fonts.ready);
  await expectWidgetAppearanceMatrix(page, async () => {
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
});
