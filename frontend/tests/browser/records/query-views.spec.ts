import { expect } from "@playwright/test";
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
