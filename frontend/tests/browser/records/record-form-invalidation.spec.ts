import { expect, type Page, type Request, type Route } from "../coverage";
import { test } from "../files/coverage";

const DEPARTMENT_ID = "11111111-1111-4111-8111-111111111111";
const MODULE_ID = "22222222-2222-4222-8222-222222222222";
const RECORD_ID = "33333333-3333-4333-8333-333333333333";
const NAME_FIELD_ID = "44444444-4444-4444-8444-444444444444";
const NOTES_FIELD_ID = "55555555-5555-4555-8555-555555555555";
const DATETIME_FIELD_ID = "66666666-6666-4666-8666-666666666666";
const CLOSED_FIELD_ID = "77777777-7777-4777-8777-777777777777";
const RELATIONSHIP_FIELD_ID = "88888888-8888-4888-8888-888888888888";
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
    required: true,
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
  {
    ...baseEntity(CLOSED_FIELD_ID),
    module_id: MODULE_ID,
    name: "Legacy label",
    type: "text",
    required: false,
    position: 3,
    config: {},
    deleted_at: "2026-01-02T00:00:00.000Z",
    is_deleted: true,
    relationship_target_module_id: null,
    relationship_multiple_targets: null,
    relationship_multiple_sources: null,
  },
  {
    ...baseEntity(RELATIONSHIP_FIELD_ID),
    module_id: MODULE_ID,
    name: "Related asset",
    type: "relationship",
    required: false,
    position: 3,
    config: {},
    relationship_target_module_id: MODULE_ID,
    relationship_multiple_targets: false,
    relationship_multiple_sources: false,
  },
];

const record = {
  ...baseEntity(RECORD_ID),
  module_id: MODULE_ID,
  data: {
    [NAME_FIELD_ID]: "Asset Alpha",
    [NOTES_FIELD_ID]: "Initial notes",
    [DATETIME_FIELD_ID]: DATETIME_VALUE,
    [CLOSED_FIELD_ID]: "Retained for display",
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

const workspace = {
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
};

async function installMocks(
  page: Page,
  mutationBodies: unknown[] = [],
  patchResponse: { status: number; body: unknown } = { status: 200, body: {} },
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
        await fulfill(route, patchResponse.status, patchResponse.body);
        return;
      }
      await fulfill(route, 405, { detail: "Mutation not expected" });
      return;
    }

    if (path === "/auth/me") {
      await fulfill(route, 200, {
        id: "user",
        role: "admin",
        permissions: ["records.read", "records.write"],
      });
      return;
    }
    if (path === "/workspace") {
      await fulfill(route, 200, workspace);
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
    if (path === "/files") {
      await fulfill(route, 200, listResponse([]));
      return;
    }
    if (path === "/relationships") {
      await fulfill(route, 200, listResponse([]));
      return;
    }
    if (path === "/records") {
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

  test("collects client errors and does not request an invalid new record", async ({
    page,
  }) => {
    const mutations = await installMocks(page);

    await page.goto(
      `/departments/${DEPARTMENT_ID}/modules/${MODULE_ID}/records/new`,
    );
    await page.getByRole("button", { name: "Create record" }).click();

    await expect(page.getByText("Name is required")).toBeVisible();
    await expect(page.getByText("Notes is required")).toBeVisible();
    await expect(page.getByLabel("Name")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.getByLabel("Name")).toHaveAttribute(
      "aria-describedby",
      `${NAME_FIELD_ID}-feedback`,
    );
    await expect(page.getByLabel("Name")).toBeFocused();
    expect(mutations).toEqual([]);
  });

  test("displays every structured backend field error", async ({ page }) => {
    await installMocks(page, [], {
      status: 422,
      body: {
        detail: {
          code: "record_data_invalid",
          message: "Record data is invalid",
          errors: [
            {
              code: "invalid_field_value",
              field_id: NAME_FIELD_ID,
              message: "Name is already used",
            },
            {
              code: "invalid_field_value",
              field_id: NOTES_FIELD_ID,
              message: "Notes are too long",
            },
            {
              code: "invalid_field_value",
              field_id: NOTES_FIELD_ID,
              message: "Notes contain a banned term",
            },
          ],
          truncated: false,
        },
      },
    });

    await page.goto(
      `/departments/${DEPARTMENT_ID}/modules/${MODULE_ID}/records/${RECORD_ID}/edit`,
    );
    await page.getByLabel("Name").fill("Asset Beta");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();

    await expect(page.getByText("Name is already used")).toBeVisible();
    await expect(page.getByText("Notes are too long")).toBeVisible();
    await expect(page.getByText("Notes contain a banned term")).toBeVisible();
    await expect(page.getByLabel("Name")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.getByLabel("Name")).toHaveAttribute(
      "aria-describedby",
      `${NAME_FIELD_ID}-feedback`,
    );
    await expect(page.getByLabel("Name")).toBeFocused();
    await expect(
      page.getByRole("alert").filter({ hasText: /^Name is already used$/ }),
    ).toBeVisible();
  });
});

test("requires explicit offset and reconfirmation after workspace timezone changes", async ({
  page,
}) => {
  const bodies: unknown[] = [];
  await installMocks(page, bodies);
  await page.goto(`/modules/${MODULE_ID}/records/${RECORD_ID}/edit`);
  await page
    .getByLabel("Occurred at", { exact: true })
    .fill("2026-11-01T01:30");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByText("This local time occurs twice. Choose its UTC offset."),
  ).toBeVisible();
  expect(bodies).toHaveLength(0);
  await page
    .getByLabel("This time occurs twice. UTC offset")
    .selectOption("-05:00");
  await page.route("**/bff/workspace", (route) =>
    fulfill(route, 200, { ...workspace, timezone: "Asia/Manila", revision: 2 }),
  );
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("openslate:invalidation")),
  );
  await expect(
    page.getByText("Workspace timezone is now Asia/Manila.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("Occurred at", { exact: true })).toHaveValue(
    "2026-11-01T01:30",
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  expect(bodies).toHaveLength(0);
  await page
    .getByRole("button", { name: "Keep America/New_York for this submission" })
    .click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toMatchObject({
    data: { [DATETIME_FIELD_ID]: "2026-11-01T06:30:00Z" },
  });
});

for (const form of [
  {
    name: "new record",
    path: `/modules/${MODULE_ID}/records/new`,
    submit: "Create record",
  },
  {
    name: "record edit",
    path: `/modules/${MODULE_ID}/records/${RECORD_ID}/edit`,
    submit: "Save changes",
  },
] as const) {
  test(`requires a fresh DST choice after an ambiguous value becomes ordinary in ${form.name}`, async ({
    page,
  }) => {
    const mutations = await installMocks(page);
    await page.goto(form.path);
    if (form.name === "new record") {
      await page.getByLabel("Name").fill("Asset Beta");
      await page.getByLabel("Notes").fill("New notes");
    }

    const occurredAt = page.getByLabel("Occurred at", { exact: true });
    const offset = page.getByLabel("This time occurs twice. UTC offset");
    await occurredAt.fill("2026-11-01T01:30");
    await offset.selectOption("-05:00");
    await occurredAt.fill("2026-11-01T03:30");
    await expect(offset).toHaveCount(0);
    await occurredAt.fill("2026-11-01T01:15");
    await expect(offset).toHaveValue("");

    await page.getByRole("button", { name: form.submit, exact: true }).click();

    await expect(
      page.getByText("This local time occurs twice. Choose its UTC offset."),
    ).toBeVisible();
    expect(mutations).toEqual([]);
  });
}

for (const form of [
  {
    name: "new record",
    path: `/modules/${MODULE_ID}/records/new`,
    submit: "Create record",
  },
  {
    name: "record edit",
    path: `/modules/${MODULE_ID}/records/${RECORD_ID}/edit`,
    submit: "Save changes",
  },
] as const) {
  test(`submits an ordinary datetime after an ambiguous choice in ${form.name}`, async ({
    page,
  }) => {
    const bodies: unknown[] = [];
    await installMocks(page, bodies);
    if (form.name === "new record") {
      await page.route("**/bff/records", async (route) => {
        if (route.request().method() !== "POST") {
          await route.fallback();
          return;
        }
        bodies.push(route.request().postDataJSON());
        await fulfill(route, 201, record);
      });
    }
    await page.goto(form.path);
    if (form.name === "new record") {
      await page.getByLabel("Name").fill("Asset Beta");
      await page.getByLabel("Notes").fill("New notes");
    }

    const occurredAt = page.getByLabel("Occurred at", { exact: true });
    await occurredAt.fill("2026-11-01T01:30");
    await page
      .getByLabel("This time occurs twice. UTC offset")
      .selectOption("-04:00");
    await occurredAt.fill("2027-01-01T10:00");
    await page.getByRole("button", { name: form.submit, exact: true }).click();

    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0]).toMatchObject({
      data: { [DATETIME_FIELD_ID]: "2027-01-01T15:00:00Z" },
    });
  });
}

test("warns administrators when the stored workspace locale is unsupported", async ({
  page,
}) => {
  const mutations = await installMocks(page);
  await page.route("**/bff/workspace", (route) =>
    fulfill(route, 200, { ...workspace, locale: "root" }),
  );

  await page.goto("/settings/workspace");

  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "The stored workspace locale is invalid." }),
  ).toBeVisible();
  await expect(page.getByLabel("Locale", { exact: true })).toHaveValue("root");
  expect(mutations).toEqual([]);
});

for (const failure of [503, 429, 408, "network", "malformed"] as const) {
  test(`retains the draft after a ${failure} workspace refresh and recovers`, async ({
    page,
  }) => {
    await installMocks(page);
    await page.goto(`/modules/${MODULE_ID}/records/new`);
    await page.getByLabel("Name").fill("Keep this draft");
    await page.route("**/bff/workspace", (route) =>
      failure === "network"
        ? route.abort("failed")
        : fulfill(route, failure === "malformed" ? 200 : failure, {}),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Workspace could not be refreshed" }),
    ).toBeVisible();
    await expect(page.getByLabel("Name")).toHaveValue("Keep this draft");
    await page.unroute("**/bff/workspace");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Workspace could not be refreshed" }),
    ).toHaveCount(0);
    await expect(page.getByLabel("Name")).toHaveValue("Keep this draft");
  });
}

test("applies authorization downgrade while the workspace response is pending", async ({
  page,
  isMobile,
}) => {
  await installMocks(page);
  await page.goto(`/modules/${MODULE_ID}/records/new`);
  await page.getByLabel("Name").fill("Keep this draft");
  if (isMobile)
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  await expect(
    page.getByRole("button", { name: "Access", exact: true }),
  ).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/bff/workspace", async (route) => {
    await held;
    await fulfill(route, 503, {});
  });
  await page.route("**/bff/auth/me", (route) =>
    fulfill(route, 200, {
      id: "user",
      role: "reader",
      permissions: ["records.read"],
    }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  try {
    await expect(
      page.getByRole("button", { name: "Access", exact: true }),
    ).toHaveCount(0);
    if (isMobile)
      await page
        .getByRole("button", { name: "Close navigation", exact: true })
        .click();
    await expect(page.getByLabel("Name")).toHaveValue("Keep this draft");
  } finally {
    release();
  }
});

for (const status of [403, 400, 200]) {
  test(`fails closed on ${status === 200 ? "malformed authorization" : status} before a late workspace response`, async ({
    page,
  }) => {
    await installMocks(page);
    await page.goto(`/modules/${MODULE_ID}/records/new`);
    await page.getByLabel("Name").fill("Protected draft");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/bff/workspace", async (route) => {
      await held;
      await fulfill(route, 200, workspace);
    });
    await page.route("**/bff/auth/me", (route) => fulfill(route, status, {}));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    try {
      await expect(
        page.getByText("Workspace could not be loaded."),
      ).toBeVisible();
      await expect(page.getByLabel("Name")).toHaveCount(0);
    } finally {
      release();
    }
    await expect(
      page.getByText("Workspace could not be loaded."),
    ).toBeVisible();
    if (status === 403) {
      await page.unroute("**/bff/auth/me");
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      // Register before Retry so the barrier belongs to the new document.
      const reloaded = page.waitForEvent("load");
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await reloaded;
      await expect(page.getByLabel("Name")).toHaveValue("");
    }
  });
}

test("clears the previous user's draft with a full reload after identity changes", async ({
  page,
}) => {
  await installMocks(page);
  await page.goto(`/modules/${MODULE_ID}/records/new`);
  await page.getByLabel("Name").fill("Previous user's draft");
  await page.route("**/bff/auth/me", (route) =>
    fulfill(route, 200, {
      id: "another-user",
      role: "admin",
      permissions: ["records.read", "records.write"],
    }),
  );
  // A request event only marks navigation start, before the new shell loads.
  const reloaded = page.waitForEvent("load");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await reloaded;
  await expect(page.getByLabel("Name")).toHaveValue("");
});

test("retains a draft on temporary authorization failure and rejects superseded responses", async ({
  page,
  isMobile,
}) => {
  await installMocks(page);
  await page.goto(`/modules/${MODULE_ID}/records/new`);
  await page.getByLabel("Name").fill("Current draft");
  await page.route("**/bff/auth/me", (route) => fulfill(route, 503, {}));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText(
      "Workspace could not be refreshed. Your current work is retained.",
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveValue("Current draft");
  await page.unroute("**/bff/auth/me");
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/bff/auth/me", async (route) => {
    started();
    await held;
    await fulfill(route, 200, {
      id: "user",
      role: "admin",
      permissions: ["records.read", "records.write"],
    });
  });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await requested;
  if (isMobile)
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  await expect(
    page.getByRole("button", { name: "Access", exact: true }),
  ).toBeVisible();
  await page.route("**/bff/auth/me", (route) =>
    fulfill(route, 200, {
      id: "user",
      role: "reader",
      permissions: ["records.read"],
    }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  try {
    await expect(
      page.getByRole("button", { name: "Access", exact: true }),
    ).toHaveCount(0);
  } finally {
    release();
  }
  await expect(
    page.getByRole("button", { name: "Access", exact: true }),
  ).toHaveCount(0);
  if (isMobile)
    await page
      .getByRole("button", { name: "Close navigation", exact: true })
      .click();
  await expect(page.getByLabel("Name")).toHaveValue("Current draft");
});
