import {
  expect,
  test,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";

const DEPARTMENT_ID = "11111111-1111-4111-8111-111111111111";
const MODULE_ID = "22222222-2222-4222-8222-222222222222";
const RECORD_ID = "33333333-3333-4333-8333-333333333333";
const NAME_FIELD_ID = "44444444-4444-4444-8444-444444444444";
const NOTES_FIELD_ID = "55555555-5555-4555-8555-555555555555";
const DATETIME_FIELD_ID = "66666666-6666-4666-8666-666666666666";
const DATETIME_VALUE = "2026-01-01T00:30:00.000Z";

type JsonObject = Record<string, unknown>;

function baseEntity(id: string): JsonObject {
  return {
    id,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    is_deleted: false,
    performed_by: null,
  };
}

function listResponse(items: unknown[]): JsonObject {
  return {
    items,
    pagination: {
      limit: 100,
      offset: 0,
      count: items.length,
      total: items.length,
      has_more: false,
    },
  };
}

const department = {
  ...baseEntity(DEPARTMENT_ID),
  department_name: "Operations",
};

const moduleItem = {
  ...baseEntity(MODULE_ID),
  department_id: DEPARTMENT_ID,
  module_name: "Assets",
  is_schema_accepted: true,
};

const fields = [
  {
    ...baseEntity(NAME_FIELD_ID),
    module_id: MODULE_ID,
    name: "Name",
    type: "text",
    required: true,
    position: 0,
    config: {},
    relationship_target_module_id: null,
    relationship_multiple_targets: null,
    relationship_multiple_sources: null,
  },
  {
    ...baseEntity(NOTES_FIELD_ID),
    module_id: MODULE_ID,
    name: "Notes",
    type: "text",
    required: false,
    position: 1,
    config: {},
    relationship_target_module_id: null,
    relationship_multiple_targets: null,
    relationship_multiple_sources: null,
  },
  {
    ...baseEntity(DATETIME_FIELD_ID),
    module_id: MODULE_ID,
    name: "Occurred at",
    type: "datetime",
    required: false,
    position: 2,
    config: {},
    relationship_target_module_id: null,
    relationship_multiple_targets: null,
    relationship_multiple_sources: null,
  },
];

const record = {
  ...baseEntity(RECORD_ID),
  module_id: MODULE_ID,
  data: {
    [NAME_FIELD_ID]: "Asset Alpha",
    [NOTES_FIELD_ID]: "Initial notes",
    [DATETIME_FIELD_ID]: DATETIME_VALUE,
  },
};

function pathFor(request: Request): string {
  return new URL(request.url()).pathname.replace(/^\/bff/, "") || "/";
}

test.use({ timezoneId: "America/Los_Angeles" });

async function fulfill(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installMocks(
  page: Page,
  mutationBodies: unknown[] = [],
): Promise<string[]> {
  const mutations: string[] = [];

  await page.route("**/session/status", (route) =>
    fulfill(route, 200, { authenticated: true }),
  );
  await page.route("**/session/realtime-token", (route) =>
    fulfill(route, 401, { detail: "Authentication required" }),
  );
  await page.route("**/bff/**", async (route) => {
    const request = route.request();
    const path = pathFor(request);

    if (request.method() !== "GET") {
      mutations.push(`${request.method()} ${path}`);
      if (request.method() === "PATCH") {
        mutationBodies.push(request.postDataJSON());
        await fulfill(route, 200, {});
        return;
      }
      await fulfill(route, 405, { detail: "Mutation not expected" });
      return;
    }

    if (path === `/modules/${MODULE_ID}`) {
      await fulfill(route, 200, moduleItem);
      return;
    }
    if (path === `/departments/${DEPARTMENT_ID}`) {
      await fulfill(route, 200, department);
      return;
    }
    if (path === "/fields") {
      await fulfill(route, 200, listResponse(fields));
      return;
    }
    if (path === `/records/${RECORD_ID}`) {
      await fulfill(route, 200, record);
      return;
    }
    if (path === "/relationships") {
      await fulfill(route, 200, listResponse([]));
      return;
    }

    await fulfill(route, 404, { detail: `Unhandled GET ${path}` });
  });

  return mutations;
}

test.describe("record form invalidation", () => {
  test("keeps a required new-record value after invalidation", async ({
    page,
  }) => {
    const mutations = await installMocks(page);

    await page.goto(
      `/departments/${DEPARTMENT_ID}/modules/${MODULE_ID}/records/new`,
    );
    const nameField = page.getByLabel("Name");
    await expect(
      page.getByRole("heading", { name: "Add a record" }),
    ).toBeVisible();
    await expect(nameField).toHaveAttribute("required", "");

    await nameField.fill("Asset Beta");
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("openslate:invalidation")),
    );

    await expect(nameField).toHaveValue("Asset Beta");
    expect(mutations).toEqual([]);
  });

  test("keeps an edited required value after invalidation", async ({
    page,
  }) => {
    const mutations = await installMocks(page);

    await page.goto(
      `/departments/${DEPARTMENT_ID}/modules/${MODULE_ID}/records/${RECORD_ID}/edit`,
    );
    const nameField = page.getByLabel("Name");
    await expect(
      page.getByRole("heading", { name: "Edit record" }),
    ).toBeVisible();
    await expect(nameField).toHaveValue("Asset Alpha");
    await expect(nameField).toHaveAttribute("required", "");

    await nameField.fill("Asset Beta");
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("openslate:invalidation")),
    );

    await expect(nameField).toHaveValue("Asset Beta");
    expect(mutations).toEqual([]);
  });

  test("preserves the instant when editing an unrelated text field", async ({
    page,
  }) => {
    const mutationBodies: unknown[] = [];
    await installMocks(page, mutationBodies);

    await page.goto(
      `/departments/${DEPARTMENT_ID}/modules/${MODULE_ID}/records/${RECORD_ID}/edit`,
    );
    const occurredAt = page.getByLabel("Occurred at");
    await expect(occurredAt).toHaveValue("2025-12-31T16:30");

    const patchResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/bff/records/${RECORD_ID}`),
    );
    await page.getByLabel("Name").fill("Asset Beta");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await patchResponse;

    expect(mutationBodies).toEqual([
      {
        data: {
          [NAME_FIELD_ID]: "Asset Beta",
          [NOTES_FIELD_ID]: "Initial notes",
          [DATETIME_FIELD_ID]: DATETIME_VALUE,
        },
      },
    ]);
  });
});
