import { expect, test, type Page } from "./helpers/test";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";
import { captureOpenViewReview } from "./helpers/openview-review-capture";

const moduleId = "00000000-0000-4000-8000-000000000210";
const otherModule = "00000000-0000-4000-8000-000000000211";
const departmentId = "00000000-0000-4000-8000-000000000212";
const categoryId = "00000000-0000-4000-8000-000000000213";
const amountId = "00000000-0000-4000-8000-000000000214";
const dateId = "00000000-0000-4000-8000-000000000215";
const chartId = "00000000-0000-4000-8000-000000000216";
const copyId = "00000000-0000-4000-8000-000000000217";
const userId = "00000000-0000-4000-8000-000000000218";
const consumerId = "00000000-0000-4000-8000-000000000219";
const definition = {
  version: 1,
  columns: [],
  filters: [],
  logic: "and",
  sort: [],
  deleted: "exclude",
  search: null,
  search_fields: [],
};
const query = {
  mode: "groups",
  module_id: moduleId,
  definition,
  aggregation: "count",
  measure: null,
  dimension: { field_id: categoryId, expected_type: "text" },
};
function chart(id = chartId, name = "Intake by category") {
  return {
    id,
    name,
    module_id: moduleId,
    department_id: departmentId,
    chart_type: "bar",
    query,
    revision: 1,
    is_deleted: false,
    created_at: "2026-10-10T00:00:00Z",
    updated_at: "2026-10-10T00:00:00Z",
  };
}
function listed(
  items: unknown[],
  offset = 0,
  total = items.length,
  limit = 25,
) {
  return {
    items,
    pagination: {
      limit,
      offset,
      count: items.length,
      total,
      has_more: offset + items.length < total,
    },
  };
}
async function setup(
  page: Page,
  access: "department" | "module" | "read" = "department",
) {
  await installOpenViewEventSource(page);
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: { authenticated: true, user_id: userId, setup_required: false },
    }),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        id: userId,
        role: "member",
        access: [
          {
            department_id: departmentId,
            module_id: access === "module" ? moduleId : null,
            level: access === "read" ? "read" : "manage",
          },
        ],
      },
    }),
  );
  const fields = [
    { id: categoryId, name: "Category", type: "text", config: {} },
    { id: amountId, name: "Amount", type: "decimal", config: {} },
    { id: dateId, name: "Submitted", type: "date", config: {} },
  ].map((field, position) => ({
    ...field,
    module_id: moduleId,
    required: false,
    position,
  }));
  await page.route("**/api/views/data-sources**", (route) =>
    route.fulfill({
      json: listed(
        new URL(route.request().url()).pathname.endsWith("/fields")
          ? fields
          : [
              {
                id: moduleId,
                name: "Requests",
                department_id: departmentId,
                title_field_id: null,
              },
              {
                id: otherModule,
                name: "Other requests",
                department_id: departmentId,
                title_field_id: null,
              },
            ],
        0,
        new URL(route.request().url()).pathname.endsWith("/fields") ? 3 : 2,
        100,
      ),
    }),
  );
  await page.route("**/api/modules/*", (route) =>
    route.fulfill({
      json: {
        id: new URL(route.request().url()).pathname.split("/").at(-1),
        department_id: departmentId,
        module_name: "Fresh requests",
        title_field_id: null,
        is_deleted: false,
      },
    }),
  );
  await page.route("**/api/fields/*", (route) => {
    const field = fields.find((field) =>
      route.request().url().endsWith(field.id),
    );
    return route.fulfill({ json: { ...field, is_deleted: false } });
  });
  await page.route("**/api/charts?*", (route) =>
    route.fulfill({ json: listed([]) }),
  );
  await page.route(`**/api/charts/${chartId}`, (route) =>
    route.fulfill({ json: chart() }),
  );
  await page.route("**/api/records/aggregate-snapshot", (route) =>
    route.fulfill({
      json: listed(
        [
          { key: "support", label: "Support", value: 8, record_count: 8 },
          { key: "delivery", label: "Delivery", value: 3, record_count: 3 },
        ],
        0,
        2,
        2,
      ),
    }),
  );
}
async function saveName(
  page: Page,
  action: "Save chart" | "Save as",
  name: string,
) {
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: action, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: action, exact: true });
  await dialog.getByLabel("Chart name", { exact: true }).fill(name);
  await dialog.getByLabel("Chart name", { exact: true }).press("Enter");
}

test("S28 named Save, edited query, rename and Save as use revisioned literal definitions and URL reload", async ({
  page,
}) => {
  await setup(page);
  let current = chart();
  const writes: Array<{ method: string; body: unknown }> = [];
  await page.route("**/api/charts", (route) => {
    writes.push({
      method: route.request().method(),
      body: route.request().postDataJSON(),
    });
    const body = route.request().postDataJSON();
    current = {
      ...current,
      ...body,
      id: writes.length === 1 ? chartId : copyId,
    };
    return route.fulfill({ status: 201, json: current });
  });
  await page.route(`**/api/charts/${chartId}`, (route) => {
    if (route.request().method() === "PATCH") {
      writes.push({ method: "PATCH", body: route.request().postDataJSON() });
      current = { ...current, ...route.request().postDataJSON(), revision: 2 };
    }
    return route.fulfill({ json: current });
  });
  await page.goto("/openview?section=charts");
  await saveName(page, "Save chart", "Intake by category");
  await expect(page).toHaveURL(new RegExp(`chart=${chartId}`));
  await page.getByLabel("Measure", { exact: true }).selectOption("sum");
  await page
    .getByLabel("Numeric measure", { exact: true })
    .selectOption(amountId);
  await saveName(page, "Save chart", "Intake value");
  const edited = {
    ...query,
    aggregation: "sum",
    measure: { field_id: amountId, expected_type: "decimal" },
  };
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("Measure", { exact: true })).toHaveValue("sum");
  await expect(page.getByLabel("Numeric measure", { exact: true })).toHaveValue(
    amountId,
  );
  await saveName(page, "Save as", "Intake copy");
  await expect(page).toHaveURL(new RegExp(`chart=${copyId}`));
  expect(writes).toEqual([
    {
      method: "POST",
      body: {
        module_id: moduleId,
        name: "Intake by category",
        chart_type: "bar",
        query,
      },
    },
    {
      method: "PATCH",
      body: {
        revision: 1,
        name: "Intake value",
        chart_type: "bar",
        query: edited,
      },
    },
    {
      method: "POST",
      body: {
        module_id: moduleId,
        name: "Intake copy",
        chart_type: "bar",
        query: edited,
      },
    },
  ]);
});

test("S28 saved URL opens off-page source and full grammar without substituting paged metadata", async ({
  page,
}) => {
  await setup(page);
  const full = {
    ...definition,
    logic: "or",
    columns: [{ field_id: amountId, expected_type: "decimal" }],
    filters: [
      {
        field_id: categoryId,
        expected_type: "text",
        operator: "contains",
        value: "Support",
      },
      {
        field_id: amountId,
        expected_type: "decimal",
        operator: "empty",
        value: null,
      },
    ],
    sort: [{ field_id: amountId, expected_type: "decimal", direction: "desc" }],
    search: "queue",
    search_fields: [{ field_id: categoryId, expected_type: "text" }],
    deleted: "include",
  };
  const saved = { ...chart(), query: { ...query, definition: full } };
  await page.route(`**/api/charts/${chartId}`, (route) =>
    route.fulfill({ json: saved }),
  );
  await page.route("**/api/views/data-sources**", (route) =>
    route.fulfill({ json: listed([], 0, 0, 100) }),
  );
  let posted: unknown;
  await page.route("**/api/charts", (route) => {
    posted = route.request().postDataJSON();
    return route.fulfill({
      status: 201,
      json: { ...saved, id: copyId, name: "Full copy" },
    });
  });
  await page.goto(`/openview?section=charts&chart=${chartId}`);
  await expect(page.getByLabel("Group by", { exact: true })).toHaveValue(
    categoryId,
  );
  await expect(page.getByLabel("Data source", { exact: true })).toContainText(
    "Fresh requests",
  );
  await saveName(page, "Save as", "Full copy");
  await expect(page).toHaveURL(new RegExp(`chart=${copyId}`));
  expect(posted).toEqual({
    name: "Full copy",
    module_id: moduleId,
    chart_type: "bar",
    query: { ...query, definition: full },
  });
});

test("S28 revision conflict preserves edited draft and refreshes current read only on intent", async ({
  page,
}) => {
  await setup(page);
  let reads = 0;
  let revision = 1;
  let failRefresh = true;
  const patches: unknown[] = [];
  await page.route(`**/api/charts/${chartId}`, (route) => {
    if (route.request().method() === "PATCH") {
      patches.push(route.request().postDataJSON());
      if (revision === 1) {
        revision = 4;
        return route.fulfill({
          status: 409,
          json: {
            detail: {
              code: "stale_revision",
              message: "Chart changed",
              current_revision: 4,
            },
          },
        });
      }
      return route.fulfill({
        json: { ...chart(), ...route.request().postDataJSON(), revision: 5 },
      });
    }
    reads += 1;
    if (revision === 4 && failRefresh) {
      failRefresh = false;
      return route.fulfill({
        status: 404,
        json: { detail: "Private changed source" },
      });
    }
    return route.fulfill({
      json: {
        ...chart(),
        name: revision === 4 ? "Other editor's name" : chart().name,
        revision,
      },
    });
  });
  await page.goto(`/openview?section=charts&chart=${chartId}`);
  await page.getByLabel("Measure", { exact: true }).selectOption("max");
  await page
    .getByLabel("Numeric measure", { exact: true })
    .selectOption(amountId);
  const initialReads = reads;
  await saveName(page, "Save chart", "My retained name");
  await expect(
    page.getByRole("alert").filter({ hasText: "changed" }),
  ).toBeVisible();
  await expect(page.getByRole("dialog").getByLabel("Chart name")).toHaveValue(
    "My retained name",
  );
  expect(reads).toBe(initialReads);
  await page
    .getByRole("button", { name: "Refresh current chart", exact: true })
    .click();
  await expect.poll(() => reads).toBe(initialReads + 1);
  await expect(page.getByLabel("Measure", { exact: true })).toHaveValue("max");
  await expect(page.getByRole("dialog").getByLabel("Chart name")).toHaveValue(
    "My retained name",
  );
  expect(patches).toHaveLength(1);
  await expect(
    page.getByRole("button", { name: "Refresh current chart", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Refresh current chart", exact: true })
    .click();
  await expect.poll(() => reads).toBe(initialReads + 2);
  await expect(page.getByLabel("Measure", { exact: true })).toHaveValue("max");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save chart", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(patches).toHaveLength(2);
  expect(patches[1]).toMatchObject({
    revision: 4,
    name: "My retained name",
    query: { aggregation: "max" },
  });
});

for (const access of ["module", "read"] as const) {
  test(`S28 ${access} permission may read but cannot save or archive Charts`, async ({
    page,
  }) => {
    await setup(page, access);
    await page.route("**/api/charts?*", (route) =>
      route.fulfill({ json: listed([chart()]) }),
    );
    const writes: string[] = [];
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname.startsWith("/api/charts") &&
        request.method() !== "GET"
      )
        writes.push(request.method());
    });
    await page.goto(`/openview?section=charts&chart=${chartId}`);
    await expect(page.getByLabel("Group by", { exact: true })).toHaveValue(
      categoryId,
    );
    await expect(
      page.getByRole("button", { name: "Save chart", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Saved charts", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Open Intake by category",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Archive Intake by category",
        exact: true,
      }),
    ).toHaveCount(0);
    expect(writes).toEqual([]);
  });
}

test("S28 save denial and unknown receipt retain name and never automatically retry POST", async ({
  page,
}) => {
  await setup(page);
  let listReads = 0;
  await page.route("**/api/charts?*", (route) => {
    listReads += 1;
    return route.fulfill({ json: listed([]) });
  });
  const writes: unknown[] = [];
  await page.route("**/api/charts", (route) => {
    writes.push(route.request().postDataJSON());
    return writes.length === 1
      ? route.fulfill({
          status: 403,
          json: { detail: "Private permission error" },
        })
      : route.fulfill({ status: 201, json: { invalid: true } });
  });
  await page.goto("/openview?section=charts");
  await saveName(page, "Save chart", "Retained unsaved chart");
  await expect(
    page.getByRole("alert").filter({ hasText: "access" }),
  ).toBeVisible();
  await expect(page.getByRole("dialog").getByLabel("Chart name")).toHaveValue(
    "Retained unsaved chart",
  );
  expect(writes).toHaveLength(1);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save chart", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "outcome" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Refresh saved charts", exact: true })
    .click();
  await expect.poll(() => listReads).toBeGreaterThan(0);
  expect(writes).toHaveLength(2);
  await expect(page).not.toHaveURL(/chart=/);
  await expect(page.getByRole("dialog").getByLabel("Chart name")).toHaveValue(
    "Retained unsaved chart",
  );
});

test("S28 saved list search paging archive and restore use accepted revision and refresh authoritative rows", async ({
  page,
}) => {
  await setup(page);
  let archived = false;
  const lists: string[] = [];
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  await page.route("**/api/charts?*", (route) => {
    const url = new URL(route.request().url());
    lists.push(url.search);
    const offset = Number(url.searchParams.get("offset"));
    const items =
      url.searchParams.get("search") === "Absent"
        ? []
        : offset
          ? [chart(copyId, "Later chart")]
          : [{ ...chart(), revision: archived ? 2 : 1, is_deleted: archived }];
    return route.fulfill({ json: listed(items, offset, items.length ? 2 : 0) });
  });
  await page.route(`**/api/charts/${chartId}*`, (route) => {
    if (route.request().method() === "DELETE") {
      writes.push({
        method: "DELETE",
        path: new URL(route.request().url()).search,
        body: null,
      });
      archived = true;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({
      json: { ...chart(), is_deleted: archived, revision: archived ? 2 : 1 },
    });
  });
  await page.route(`**/api/charts/${chartId}/restore`, (route) => {
    writes.push({
      method: "POST",
      path: "/restore",
      body: route.request().postDataJSON(),
    });
    archived = false;
    return route.fulfill({ json: { ...chart(), revision: 3 } });
  });
  await page.goto("/openview?section=charts");
  await page.getByRole("button", { name: "Saved charts", exact: true }).click();
  await page
    .getByRole("button", { name: "Load more saved charts", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Open Later chart", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search saved charts", { exact: true }).fill("Absent");
  await expect(
    page.getByText("No saved charts match this search.", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search saved charts", { exact: true }).fill("");
  await page
    .getByRole("button", { name: "Archive Intake by category", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Archive chart", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Restore Intake by category",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Restore Intake by category", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Archive Intake by category",
      exact: true,
    }),
  ).toBeVisible();
  expect(writes).toEqual([
    { method: "DELETE", path: "?revision=1", body: null },
    { method: "POST", path: "/restore", body: { revision: 2 } },
  ]);
  expect(lists.some((value) => value.includes("offset=1"))).toBe(true);
  expect(
    lists.every(
      (value) =>
        value.includes("deleted=include") && value.includes("limit=25"),
    ),
  ).toBe(true);
});

test("S28 usage 409 renders readable consumers and generic restricted flag, never hidden counts or identities", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/charts?*", (route) =>
    route.fulfill({ json: listed([chart()]) }),
  );
  const usage = {
    ...listed([{ kind: "dashboard", id: consumerId, name: "Team overview" }]),
    has_restricted_usage: true,
  };
  await page.route(`**/api/charts/${chartId}/usage?*`, (route) =>
    route.fulfill({ json: usage }),
  );
  let deletes = 0;
  await page.route(`**/api/charts/${chartId}*`, (route) => {
    if (route.request().method() === "DELETE") {
      deletes += 1;
      return route.fulfill({
        status: 409,
        json: {
          detail: { code: "chart_in_use", message: "Used elsewhere", usage },
        },
      });
    }
    return route.fulfill({ json: chart() });
  });
  await page.goto("/openview?section=charts");
  await page.getByRole("button", { name: "Saved charts", exact: true }).click();
  await page
    .getByRole("button", { name: "Usage of Intake by category", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByText("Team overview", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("dialog")
      .getByText("Also used in locations you cannot access.", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Archive Intake by category", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Archive chart", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "used" }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").getByText("Team overview", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("dialog")
      .getByText(/^(\d+ restricted|restricted.*\d+ (locations|uses))$/i),
  ).toHaveCount(0);
  expect(deletes).toBe(1);
});

test("S28 changing the editor module detaches saved identity and list refusal withdraws names", async ({
  page,
}) => {
  await setup(page);
  let denied = false;
  await page.route("**/api/charts?*", (route) =>
    denied
      ? route.fulfill({ status: 403, json: { detail: "Private list denial" } })
      : route.fulfill({ json: listed([chart()]) }),
  );
  await page.goto(`/openview?section=charts&chart=${chartId}`);
  await expect(page.getByLabel("Group by", { exact: true })).toHaveValue(
    categoryId,
  );
  await page
    .getByLabel("Data source", { exact: true })
    .selectOption(otherModule);
  await expect(page).not.toHaveURL(/chart=/);
  await page.getByRole("button", { name: "Saved charts", exact: true }).click();
  denied = true;
  await sendOpenViewEvent(page, "invalidate", { entity: "charts" });
  await expect(
    page.getByRole("button", { name: "Open Intake by category", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Private list denial", { exact: true }),
  ).toHaveCount(0);
});

test("S28 archived URL cannot apply or save until restored", async ({
  page,
}) => {
  await setup(page);
  let archived = true;
  await page.route(`**/api/charts/${chartId}`, (route) =>
    route.fulfill({
      json: { ...chart(), is_deleted: archived, revision: archived ? 2 : 3 },
    }),
  );
  await page.route("**/api/charts?*", (route) =>
    route.fulfill({
      json: listed([
        { ...chart(), is_deleted: archived, revision: archived ? 2 : 3 },
      ]),
    }),
  );
  await page.route(`**/api/charts/${chartId}/restore`, (route) => {
    archived = false;
    return route.fulfill({ json: { ...chart(), revision: 3 } });
  });
  await page.goto(`/openview?section=charts&chart=${chartId}`);
  await expect(
    page.getByText("Archived · restore before editing", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save chart", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Apply chart", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Saved charts", exact: true }).click();
  await page
    .getByRole("button", { name: "Restore Intake by category", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Apply chart", exact: true }),
  ).toBeEnabled();
});

test("S28 an opened chart resolves fresh bounded labels before Apply and withdraws on metadata refusal", async ({
  page,
}) => {
  await setup(page);
  let fieldName = "Original category";
  let refused = false;
  const metadata: string[] = [];
  await page.route(`**/api/fields/${categoryId}`, (route) => {
    metadata.push(categoryId);
    return refused
      ? route.fulfill({ status: 403, json: { detail: "Private field label" } })
      : route.fulfill({
          json: {
            id: categoryId,
            module_id: moduleId,
            name: fieldName,
            type: "text",
            config: {},
            required: false,
            position: 0,
            is_deleted: false,
          },
        });
  });
  await page.route("**/api/views/data-sources**", (route) =>
    route.fulfill({ json: listed([], 0, 0, 100) }),
  );
  let aggregates = 0;
  await page.route("**/api/records/aggregate-snapshot", (route) => {
    aggregates += 1;
    return route.fulfill({
      json: listed(
        [
          {
            key: "queue",
            label: "Authorised value",
            value: 9,
            record_count: 9,
          },
        ],
        0,
        1,
        1,
      ),
    });
  });
  await page.goto(`/openview?section=charts&chart=${chartId}`);
  await expect(page.getByLabel("Group by", { exact: true })).toHaveValue(
    categoryId,
  );
  fieldName = "Current category";
  await page.getByRole("button", { name: "Apply chart", exact: true }).click();
  await expect(
    page.getByText("Fresh requests · Count records by Current category", {
      exact: true,
    }),
  ).toBeVisible();
  refused = true;
  await page.getByRole("button", { name: "Apply chart", exact: true }).click();
  await expect(page.getByText("Authorised value", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Private field label", { exact: true }),
  ).toHaveCount(0);
  expect(aggregates).toBe(1);
  expect(metadata.length).toBeGreaterThanOrEqual(3);
});

test("S28 date-series Save persists bucket, window and measure without preview settings", async ({
  page,
}) => {
  await setup(page);
  const writes: unknown[] = [];
  await page.route("**/api/charts", (route) => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({
      status: 201,
      json: { ...chart(), ...route.request().postDataJSON() },
    });
  });
  await page.goto("/openview?section=charts");
  await page.getByLabel("Chart type", { exact: true }).selectOption("line");
  await page
    .getByLabel("Calendar bucket", { exact: true })
    .selectOption("month");
  await page.getByRole("button", { name: "Date window", exact: true }).click();
  await page.getByLabel("From date", { exact: true }).fill("2025-01-01");
  await page.getByLabel("To date", { exact: true }).fill("2026-12-31");
  await page.keyboard.press("Escape");
  await saveName(page, "Save chart", "Monthly intake");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(writes).toEqual([
    {
      module_id: moduleId,
      name: "Monthly intake",
      chart_type: "line",
      query: {
        mode: "date_series",
        module_id: moduleId,
        definition,
        aggregation: "count",
        measure: null,
        date_field: { field_id: dateId, expected_type: "date" },
        from_date: "2025-01-01",
        to_date: "2026-12-31",
        bucket: "month",
      },
    },
  ]);
});

test("S28 admin usage pages show every returned consumer without a restricted flag", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { id: userId, role: "admin", access: [] } }),
  );
  await page.route("**/api/charts?*", (route) =>
    route.fulfill({ json: listed([chart()]) }),
  );
  const offsets: string[] = [];
  await page.route(`**/api/charts/${chartId}/usage?*`, (route) => {
    const offset = new URL(route.request().url()).searchParams.get("offset")!;
    offsets.push(offset);
    return route.fulfill({
      json: {
        ...listed(
          offset === "0"
            ? [
                {
                  kind: "dashboard",
                  id: consumerId,
                  name: "Department overview",
                },
              ]
            : [{ kind: "board", id: copyId, name: "Archived board" }],
          Number(offset),
          2,
        ),
        has_restricted_usage: false,
      },
    });
  });
  await page.goto("/openview?section=charts");
  await page.getByRole("button", { name: "Saved charts", exact: true }).click();
  await page
    .getByRole("button", { name: "Usage of Intake by category", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Load more chart usage", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Chart usage", exact: true });
  await expect(
    dialog.getByText("Department overview", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Archived board", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText(consumerId, { exact: false })).toBeVisible();
  await expect(
    dialog.getByText("Also used in locations you cannot access.", {
      exact: true,
    }),
  ).toHaveCount(0);
  expect(offsets).toEqual(["0", "1"]);
});

test("S28 navigating away from a held open fences the late definition", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/charts?*", (route) =>
    route.fulfill({ json: listed([chart(copyId, "Other chart")]) }),
  );
  let started!: () => void;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/charts/${copyId}`, async (route) => {
    started();
    await held;
    return route.fulfill({
      json: { ...chart(copyId, "Other chart"), chart_type: "pie" },
    });
  });
  await page.goto(`/openview?section=charts&chart=${chartId}`);
  await expect(page.getByLabel("Group by", { exact: true })).toHaveValue(
    categoryId,
  );
  await page.getByRole("button", { name: "Saved charts", exact: true }).click();
  await page
    .getByRole("button", { name: "Open Other chart", exact: true })
    .click();
  try {
    await pending;
    await page
      .getByRole("button", { name: "Saved charts", exact: true })
      .click();
    await page.getByRole("link", { name: "Charts", exact: true }).click();
    await expect(page).not.toHaveURL(/chart=/);
    const late = page.waitForResponse(`**/api/charts/${copyId}`);
    release();
    await (await late).finished();
    await expect(page.getByLabel("Chart type", { exact: true })).toHaveValue(
      "bar",
    );
    await expect(
      page
        .getByRole("region", { name: "Saved chart management", exact: true })
        .getByText("Other chart", { exact: true }),
    ).toHaveCount(0);
  } finally {
    release();
  }
});

for (const recover of [false, true]) {
  test(`S28 held save receipt after read refusal ${recover ? "and later read recovery " : ""}cannot select the saved object or expose a server name`, async ({
    page,
  }) => {
    await setup(page);
    let denied = false;
    let deniedReads = 0;
    await page.route("**/api/charts?*", (route) => {
      if (denied) {
        deniedReads += 1;
        return route.fulfill({
          status: 403,
          json: { detail: "Private chart list" },
        });
      }
      return route.fulfill({ json: listed([]) });
    });
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    let writes = 0;
    await page.route("**/api/charts", async (route) => {
      writes += 1;
      started();
      await held;
      return route.fulfill({
        status: 201,
        json: { ...chart(), name: "Private late chart" },
      });
    });
    await page.goto("/openview?section=charts");
    await page
      .getByRole("button", { name: "Saved charts", exact: true })
      .click();
    await saveName(page, "Save chart", "Private late chart");
    try {
      await pending;
      denied = true;
      await sendOpenViewEvent(page, "invalidate", { entity: "charts" });
      await expect.poll(() => deniedReads).toBeGreaterThan(0);
      // The app must observe the refusal before recovery; on a slow runner the
      // fresh read could otherwise supersede the refused one unseen.
      await expect(
        page.getByText(
          "Saved charts are unavailable. Refresh to check current access.",
          { exact: false },
        ),
      ).toBeVisible();
      if (recover) {
        denied = false;
        const fresh = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/charts" &&
            response.request().method() === "GET" &&
            response.status() === 200,
        );
        await sendOpenViewEvent(page, "invalidate", { entity: "fields" });
        await (await fresh).finished();
      }
      const receipt = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/charts" &&
          response.request().method() === "POST",
      );
      release();
      await (await receipt).finished();
      await expect(page).not.toHaveURL(/chart=/);
      await expect(
        page.getByText("Private late chart", { exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("dialog").getByLabel("Chart name"),
      ).toHaveValue("Private late chart");
      expect(writes).toBe(1);
    } finally {
      release();
    }
  });
}

test("S28 mobile keyboard Save form rejects empty name and captures saved Charts in both themes", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/charts", (route) =>
    route.fulfill({ status: 201, json: { ...chart(), name: "Weekly intake" } }),
  );
  await page.route("**/api/charts?*", (route) =>
    route.fulfill({ json: listed([{ ...chart(), name: "Weekly intake" }]) }),
  );
  await page.goto("/openview?section=charts");
  const save = page.getByRole("button", { name: "Save chart", exact: true });
  // A disabled button takes no focus, so wait until the draft can be saved.
  await expect(save).toBeEnabled();
  await save.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Save chart", exact: true });
  await dialog.getByLabel("Chart name", { exact: true }).fill("   ");
  await dialog.getByLabel("Chart name", { exact: true }).press("Enter");
  await expect(
    dialog.getByText("Enter a chart name (1–120 characters).", { exact: true }),
  ).toBeVisible();
  await dialog.getByLabel("Chart name", { exact: true }).fill("Weekly intake");
  await dialog.getByLabel("Chart name", { exact: true }).press("Enter");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Apply chart", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Complete aggregate data", exact: true }),
  ).toContainText("Support");
  await page.getByRole("button", { name: "Saved charts", exact: true }).click();
  if (process.env.OPENVIEW_CAPTURE_DIR) {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addStyleTag({
      content: "nextjs-portal { display: none !important; }",
    });
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
      },
    };
    await captureOpenViewReview(page, "s28-charts-light", options);
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await captureOpenViewReview(page, "s28-charts-dark", options);
  }
});
