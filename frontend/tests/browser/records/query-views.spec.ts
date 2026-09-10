import { expect } from "../coverage";
import { test } from "../files/coverage";
for (const route of [
  "/modules/m/records",
  "/departments/d/modules/m/records",
]) {
  test(`preserves query drafts and conflict revision on refresh at ${route}`, async ({
    page,
  }) => {
    const base = {
      id: "m",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      is_deleted: false,
      deleted_at: null,
      performed_by: null,
    };
    const list = (items: unknown[], has_more = false) => ({
      items,
      pagination: {
        limit: 25,
        offset: 0,
        count: items.length,
        total: has_more ? 30 : items.length,
        has_more,
      },
    });
    await page.route("**/session/status", (r) =>
      r.fulfill({ json: { authenticated: true } }),
    );
    await page.route("**/session/realtime-token", (r) =>
      r.fulfill({ status: 401, json: {} }),
    );
    let viewRevision = 1;
    let removed = false;
    let refreshed = false;
    const updates: unknown[] = [];
    await page.route("**/bff/**", async (r) => {
      const path = new URL(r.request().url()).pathname.replace("/bff", "");
      if (path === "/workspace")
        return r.fulfill({
          json: {
            id: 1,
            display_name: "OpenSlate",
            legal_name: null,
            description: null,
            contact_email: null,
            contact_phone: null,
            postal_address: null,
            timezone: "UTC",
            locale: "en-US",
            revision: 1,
            logo_file_id: null,
          },
        });
      if (path === "/auth/me")
        return r.fulfill({
          json: {
            id: "u",
            role: "reader",
            permissions: [
              "records.read",
              "modules.read",
              "fields.read",
              "departments.read",
            ],
          },
        });
      if (path === "/modules/m")
        return r.fulfill({
          json: {
            ...base,
            module_name: "Cases",
            department_id: "d",
            is_schema_accepted: true,
          },
        });
      if (path === "/departments/d")
        return r.fulfill({
          json: { ...base, id: "d", department_name: "Operations" },
        });
      if (path === "/fields")
        return r.fulfill({
          json: list([
            {
              ...base,
              id: "f",
              name: "Title",
              module_id: "m",
              type: "text",
              position: 0,
              required: false,
              config: {},
            },
          ]),
        });
      if (path === "/views/v" && r.request().method() === "PATCH") {
        updates.push(r.request().postDataJSON());
        return r.fulfill({
          status: 409,
          json: { detail: "Saved view changed; reload before saving." },
        });
      }
      if (path === "/views")
        return r.fulfill({
          json: list(
            removed
              ? []
              : [
                  {
                    ...base,
                    id: "v",
                    module_id: "m",
                    owner_id: "u",
                    name: "Old view",
                    revision: viewRevision,
                    visibility: "private",
                    definition: {
                      version: 1,
                      columns: [],
                      sort: [],
                      deleted: "include",
                      search: null,
                      filters: [
                        {
                          field_id: "gone",
                          expected_type: "text",
                          operator: "eq",
                          value: "retain-me",
                        },
                      ],
                    },
                  },
                ],
          ),
        });
      if (path === "/records/query") {
        const q = r.request().postDataJSON();
        if (q.definition.filters.length)
          return r.fulfill({
            status: 409,
            json: {
              detail: {
                code: "view_invalid",
                message: "Repair unavailable field",
              },
            },
          });
        return r.fulfill({
          json: list(
            [
              {
                ...base,
                id: q.definition.search ? "match-record" : "first-record",
                module_id: "m",
                data: {
                  f: q.definition.search
                    ? "Found beyond first page"
                    : refreshed
                      ? "Fresh results"
                      : "First page",
                },
              },
            ],
            !q.definition.search,
          ),
        });
      }
      return r.fulfill({ json: list([]) });
    });
    await page.goto(route);
    await expect(page.getByText("First page", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Export CSV" })).toHaveCount(
      0,
    );
    await page.getByLabel("Record ID", { exact: true }).fill("match");
    await page.getByRole("button", { name: "Search records" }).click();
    await expect(page.getByText("Found beyond first page")).toBeVisible();
    await page.getByLabel("Saved view", { exact: true }).selectOption("v");
    await expect(page.getByText("Repair unavailable field")).toBeVisible();
    await page
      .getByText("Filters, sorting and columns", { exact: true })
      .click();
    await expect(
      page.getByText("Unavailable field gone · eq · retain-me"),
    ).toBeVisible();
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("openslate:invalidation")),
    );
    await expect(
      page.getByText("Unavailable field gone · eq · retain-me"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Remove filter 1" }).click();
    await page.getByRole("checkbox", { name: "Title", exact: true }).check();
    await expect(page.getByText("Repair unavailable field")).toHaveCount(0);
    await page.getByLabel("View name", { exact: true }).fill("Draft name");
    await page
      .getByLabel("Record ID", { exact: true })
      .fill("Unsubmitted search");
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.getByText("30 records · Page 2")).toBeVisible();
    viewRevision = 2;
    refreshed = true;
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("openslate:invalidation")),
    );
    await expect(
      page.getByText("Fresh results", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("30 records · Page 2")).toBeVisible();
    await expect(page.getByLabel("View name", { exact: true })).toHaveValue(
      "Draft name",
    );
    await expect(page.getByLabel("Record ID", { exact: true })).toHaveValue(
      "Unsubmitted search",
    );
    await expect(page.getByLabel("Saved view", { exact: true })).toHaveValue(
      "v",
    );
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(
      page.getByText("Saved view changed; reload before saving."),
    ).toBeVisible();
    expect(updates).toEqual([
      expect.objectContaining({
        revision: 1,
        name: "Draft name",
        definition: expect.objectContaining({ filters: [] }),
      }),
    ]);
    removed = true;
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("openslate:invalidation")),
    );
    await expect(page.getByLabel("Saved view", { exact: true })).toHaveValue(
      "",
    );
    await expect(
      page.getByText(
        "This saved view is no longer available. Your draft is retained.",
      ),
    ).toBeVisible();
    await expect(page.getByLabel("View name", { exact: true })).toHaveValue(
      "Draft name",
    );
    await expect(
      page.getByRole("button", { name: "Save changes", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Archive view", exact: true }),
    ).toHaveCount(0);

    await test.step("keeps a newly saved view when realtime supersedes the post-save refresh", async () => {
      let saved: Record<string, unknown> = {};
      await page.route("**/bff/views", async (request) => {
        const body = request.request().postDataJSON();
        saved = {
          ...base,
          id: "created",
          module_id: "m",
          owner_id: "u",
          visibility: "private",
          revision: 1,
          name: body.name,
          definition: body.definition,
        };
        await request.fulfill({ status: 201, json: saved });
      });
      let releaseOlder!: () => void;
      let releaseNewer!: () => void;
      let olderStarted!: () => void;
      let newerStarted!: () => void;
      const olderHeld = new Promise<void>((resolve) => {
        releaseOlder = resolve;
      });
      const newerHeld = new Promise<void>((resolve) => {
        releaseNewer = resolve;
      });
      const olderRequested = new Promise<void>((resolve) => {
        olderStarted = resolve;
      });
      const newerRequested = new Promise<void>((resolve) => {
        newerStarted = resolve;
      });
      let refreshes = 0;
      await page.route("**/bff/views?*", async (request) => {
        const refresh = ++refreshes;
        if (refresh === 1) {
          olderStarted();
          await olderHeld;
        }
        if (refresh === 2) {
          newerStarted();
          await newerHeld;
        }
        await request.fulfill({ json: list([saved]) });
      });
      await page
        .getByRole("button", { name: "Save personal view", exact: true })
        .click();
      await olderRequested;
      await page.evaluate(() =>
        window.dispatchEvent(new CustomEvent("openslate:invalidation")),
      );
      await newerRequested;
      releaseOlder();
      try {
        await expect(
          page.getByRole("button", {
            name: "Clone as personal view",
            exact: true,
          }),
        ).toBeEnabled();
        await expect(
          page.getByLabel("Saved view", { exact: true }),
        ).toHaveValue("created");
        await expect(
          page.getByText(
            "This saved view is no longer available. Your draft is retained.",
          ),
        ).toHaveCount(0);
      } finally {
        releaseNewer();
      }
      await expect(page.getByLabel("Saved view", { exact: true })).toHaveValue(
        "created",
      );
    });
  });
}

const queryEntity = {
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  is_deleted: false,
  deleted_at: null,
  performed_by: null,
};

async function installQueryAuthoring(page: import("@playwright/test").Page) {
  const list = (items: unknown[]) => ({
    items,
    pagination: {
      limit: 100,
      offset: 0,
      count: items.length,
      total: items.length,
      has_more: false,
    },
  });
  const state = {
    views: [] as import("../../../src/lib/record-query").SavedView[],
    queries: [] as import("../../../src/lib/record-query").QueryDefinition[],
    exportFailure: true,
    archived: false,
    rejectArchive: false,
    rejectRestore: false,
  };
  await page.route("**/session/status", (r) =>
    r.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (r) =>
    r.fulfill({ status: 401, json: {} }),
  );
  await page.route("**/bff/**", async (r) => {
    const path = new URL(r.request().url()).pathname.replace("/bff", "");
    const method = r.request().method();
    if (path === "/workspace")
      return r.fulfill({
        json: {
          id: 1,
          display_name: "OpenSlate",
          legal_name: null,
          description: null,
          contact_email: null,
          contact_phone: null,
          postal_address: null,
          timezone: "America/New_York",
          locale: "en-US",
          revision: 1,
          logo_file_id: null,
        },
      });
    if (path === "/auth/me")
      return r.fulfill({
        json: {
          id: "u",
          role: "admin",
          permissions: [
            "records.read",
            "records.write",
            "modules.read",
            "fields.read",
            "departments.read",
          ],
        },
      });
    if (path === "/modules/m")
      return r.fulfill({
        json: {
          ...queryEntity,
          id: "m",
          department_id: "d",
          module_name: "Cases",
          is_schema_accepted: true,
        },
      });
    if (path === "/departments/d")
      return r.fulfill({
        json: { ...queryEntity, id: "d", department_name: "Operations" },
      });
    if (path === "/fields")
      return r.fulfill({
        json: list(
          [
            { id: "number", name: "Count", type: "number" },
            { id: "boolean", name: "Approved", type: "boolean" },
            { id: "datetime", name: "Appointment", type: "datetime" },
            { id: "select", name: "Priority", type: "select" },
          ].map((f, position) => ({
            ...queryEntity,
            ...f,
            module_id: "m",
            position,
            required: false,
            config: {},
          })),
        ),
      });
    if (path === "/records/query") {
      state.queries.push(r.request().postDataJSON().definition);
      return r.fulfill({
        json: list([
          {
            ...queryEntity,
            id: "record",
            module_id: "m",
            is_deleted: state.archived,
            data: {
              number: 3,
              boolean: true,
              datetime: "2026-11-01T06:30:00Z",
              select: "urgent",
            },
          },
        ]),
      });
    }
    if (path === "/records/export")
      return state.exportFailure
        ? r.fulfill({
            status: 403,
            json: { detail: { message: "Export access was revoked" } },
          })
        : r.fulfill({
            contentType: "text/csv",
            body: "Count,Approved\n3,true\n",
          });
    if (path === "/records/record" && method === "DELETE") {
      if (state.rejectArchive)
        return r.fulfill({
          status: 409,
          json: { detail: "Record changed; reload before archiving" },
        });
      state.archived = true;
      return r.fulfill({ status: 204 });
    }
    if (path === "/records/record/restore") {
      if (state.rejectRestore)
        return r.fulfill({
          status: 422,
          json: { detail: "Record no longer matches the active schema" },
        });
      state.archived = false;
      return r.fulfill({ json: { ...queryEntity, id: "record" } });
    }
    if (path === "/views" && method === "GET")
      return r.fulfill({ json: list(state.views) });
    if (path === "/views" && method === "POST") {
      const body = r.request().postDataJSON();
      const view = {
        ...queryEntity,
        ...body,
        id: `view-${state.views.length + 1}`,
        owner_id: "u",
        revision: 1,
      };
      state.views.push(view);
      return r.fulfill({ status: 201, json: view });
    }
    if (path.startsWith("/views/") && method === "PATCH") {
      const index = state.views.findIndex((v) => path === `/views/${v.id}`);
      state.views[index] = {
        ...state.views[index],
        ...r.request().postDataJSON(),
        revision: state.views[index].revision + 1,
      };
      return r.fulfill({ json: state.views[index] });
    }
    if (path.startsWith("/views/") && method === "DELETE") {
      state.views = state.views.filter((v) => path !== `/views/${v.id}`);
      return r.fulfill({ status: 204 });
    }
    return r.fulfill({ json: list([]) });
  });
  return state;
}

test("query editor submits typed filters, explicit repeated-time offsets and reversible sorting", async ({
  page,
}) => {
  const state = await installQueryAuthoring(page);
  await page.goto("/modules/m/records");
  await expect(
    page.getByRole("cell", { name: "urgent", exact: true }),
  ).toBeVisible();
  await page.getByText("Filters, sorting and columns", { exact: true }).click();
  await page.getByLabel("Filter field", { exact: true }).selectOption("number");
  await page.getByLabel("Filter operator", { exact: true }).selectOption("gte");
  await page.getByLabel("Filter value", { exact: true }).fill("2.5");
  await page.getByRole("button", { name: "Add filter", exact: true }).click();
  await expect(
    page.getByText("Count · gte · 2.5", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Filter field", { exact: true })
    .selectOption("boolean");
  await page.getByLabel("Filter value", { exact: true }).selectOption("true");
  await page.getByRole("button", { name: "Add filter", exact: true }).click();
  await expect(
    page.getByText("Approved · eq · true", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Filter field", { exact: true }).selectOption("select");
  await page.getByLabel("Filter operator", { exact: true }).selectOption("in");
  await page.getByLabel("Filter value", { exact: true }).fill("urgent, normal");
  await page.getByRole("button", { name: "Add filter", exact: true }).click();
  await page
    .getByLabel("Filter field", { exact: true })
    .selectOption("datetime");
  await page
    .getByLabel("Filter value", { exact: true })
    .fill("2026-11-01T01:30");
  await expect(page.getByLabel("Filter UTC offset")).toBeVisible();
  await page.getByRole("button", { name: "Add filter", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({
      hasText: "This local time occurs twice. Choose its UTC offset.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove filter 4", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Filter UTC offset").selectOption("-05:00");
  await page.getByRole("button", { name: "Add filter", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({
      hasText: "This local time occurs twice. Choose its UTC offset.",
    }),
  ).toHaveCount(0);
  await page.getByLabel("Add sort field").selectOption("number");
  await page.getByLabel("Sort direction 1").selectOption("desc");
  await expect
    .poll(() => state.queries.at(-1))
    .toMatchObject({
      filters: [
        { field_id: "number", operator: "gte", value: 2.5 },
        { field_id: "boolean", operator: "eq", value: true },
        { field_id: "select", operator: "in", value: ["urgent", "normal"] },
        { field_id: "datetime", operator: "eq", value: "2026-11-01T06:30:00Z" },
      ],
      sort: [{ field_id: "number", direction: "desc" }],
    });
  await page.getByRole("button", { name: "Remove sort 1" }).click();
  await page.getByRole("checkbox", { name: "Approved", exact: true }).uncheck();
  await expect(
    page.getByRole("columnheader", { name: "Approved", exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => state.queries.at(-1)?.sort).toEqual([]);
});

test("administrators publish, edit and archive shared views and recover export access", async ({
  page,
}) => {
  const state = await installQueryAuthoring(page);
  await page.goto("/modules/m/records");
  await expect(
    page.getByRole("cell", { name: "urgent", exact: true }),
  ).toBeVisible();
  await page.getByLabel("View name", { exact: true }).fill("Shared priorities");
  await page
    .getByRole("button", { name: "Publish shared copy", exact: true })
    .click();
  await expect(page.getByLabel("Saved view", { exact: true })).toHaveValue(
    "view-1",
  );
  expect(state.views[0].visibility).toBe("workspace");
  await page
    .getByLabel("View name", { exact: true })
    .fill("Updated priorities");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByRole("option", {
      name: "Updated priorities · Shared",
      exact: true,
    }),
  ).toHaveCount(1);
  expect(state.views[0].revision).toBe(2);
  await page.getByRole("button", { name: "Export CSV", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Export access was revoked" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reload views", exact: true }).click();
  await expect(
    page.getByText("Export access was revoked", { exact: false }),
  ).toHaveCount(0);
  state.exportFailure = false;
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("records.csv");
  await page.getByRole("button", { name: "Archive view", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Archive view", exact: true })
    .click();
  await expect(page.getByLabel("Saved view", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("option", {
      name: "Updated priorities · Shared",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("cell", { name: "urgent", exact: true }),
  ).toBeVisible();
});

test("record archive and restore rejection preserve the visible lifecycle until retry succeeds", async ({
  page,
}) => {
  const state = await installQueryAuthoring(page);
  state.rejectArchive = true;
  await page.goto("/modules/m/records");
  const row = page.getByRole("row").filter({ hasText: "urgent" });
  await row.getByRole("button", { name: "Archive", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).not.toBeVisible();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Record changed; reload before archiving" }),
  ).toBeVisible();
  await expect(row).toContainText("Active");
  state.rejectArchive = false;
  await row.getByRole("button", { name: "Archive", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  await expect(row).toContainText("Archived");
  state.rejectRestore = true;
  await row.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Record no longer matches the active schema" }),
  ).toBeVisible();
  await expect(row).toContainText("Archived");
  state.rejectRestore = false;
  await row.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(row).toContainText("Active");
  await expect(
    page.getByText("Record no longer matches the active schema", {
      exact: false,
    }),
  ).toHaveCount(0);
});
