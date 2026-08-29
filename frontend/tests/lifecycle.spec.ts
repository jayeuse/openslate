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
const TARGET_MODULE_ID = "44444444-4444-4444-8444-444444444444";
const TARGET_RECORD_ID = "55555555-5555-4555-8555-555555555555";
const FIELD_ID = "66666666-6666-4666-8666-666666666666";
const EDGE_ID = "77777777-7777-4777-8777-777777777777";
const ACTIVE_FIRST_FIELD_ID = "88888888-8888-4888-8888-888888888888";
const CLOSED_FIELD_ID = "99999999-9999-4999-8999-999999999999";
const ACTIVE_LAST_FIELD_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type JsonObject = Record<string, unknown>;

function baseEntity(id: string, isDeleted = false): JsonObject {
  return {
    id,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: isDeleted ? "2026-01-02T00:00:00.000Z" : null,
    is_deleted: isDeleted,
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

function pathFor(route: Route) {
  return pathForRequest(route.request());
}

function pathForRequest(request: Request) {
  return new URL(request.url()).pathname.replace(/^\/bff/, "");
}

async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installSessionMocks(page: Page) {
  await page.route("**/session/status", (route) =>
    json(route, 200, { authenticated: true }),
  );
  await page.route("**/session/realtime-token", (route) =>
    json(route, 401, { detail: "Authentication required" }),
  );
}

function departmentFixture(isDeleted = false) {
  return {
    ...baseEntity(DEPARTMENT_ID, isDeleted),
    department_name: "Operations",
  };
}

function moduleFixture(isDeleted = false) {
  return {
    ...baseEntity(MODULE_ID, isDeleted),
    department_id: DEPARTMENT_ID,
    module_name: "Assets",
    is_schema_accepted: true,
  };
}

function lifecycleImpact(operation: "close" | "purge", isDeleted = false) {
  return {
    target_type: "department",
    target_id: DEPARTMENT_ID,
    operation,
    actor_id: null,
    rows: [
      {
        entity_type: "department",
        entity_id: DEPARTMENT_ID,
        is_deleted: isDeleted,
        deleted_at: null,
        updated_at: "2026-01-01T00:00:00.000Z",
        state_fingerprint: "fingerprint",
      },
    ],
    external_impacts: [
      {
        edge_id: EDGE_ID,
        field_id: FIELD_ID,
        external_record_id: RECORD_ID,
        external_module_id: MODULE_ID,
        external_module_name: "Assets",
        external_department_id: DEPARTMENT_ID,
        external_department_name: "Operations",
      },
    ],
    key_strips: [],
    blockers: [],
    impact_digest: "digest",
  };
}

test("requests departments with deleted=include and shows Closed badges", async ({
  page,
}) => {
  await installSessionMocks(page);
  let departmentsUrl = "";
  await page.route("**/bff/departments?**", async (route) => {
    departmentsUrl = route.request().url();
    await json(route, 200, listResponse([departmentFixture(true)]));
  });

  await page.goto("/departments");

  await expect(page.getByText("Closed", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close", exact: true }),
  ).toHaveCount(0);
  expect(new URL(departmentsUrl).searchParams.get("deleted")).toBe("include");
});

test("keeps closed schema fields in place while reordering active fields", async ({
  page,
}) => {
  await installSessionMocks(page);
  const activeFirst = {
    ...baseEntity(ACTIVE_FIRST_FIELD_ID),
    module_id: MODULE_ID,
    name: "First active",
    type: "text",
    required: false,
    position: 0,
    config: {},
    relationship_target_module_id: null,
    relationship_multiple_targets: null,
    relationship_multiple_sources: null,
  };
  const closed = {
    ...baseEntity(CLOSED_FIELD_ID, true),
    module_id: MODULE_ID,
    name: "Closed field",
    type: "text",
    required: false,
    position: 1,
    config: {},
    relationship_target_module_id: null,
    relationship_multiple_targets: null,
    relationship_multiple_sources: null,
  };
  const activeLast = {
    ...baseEntity(ACTIVE_LAST_FIELD_ID),
    module_id: MODULE_ID,
    name: "Last active",
    type: "text",
    required: false,
    position: 2,
    config: {},
    relationship_target_module_id: null,
    relationship_multiple_targets: null,
    relationship_multiple_sources: null,
  };
  let schemaFields = [activeFirst, closed, activeLast];
  let fieldsUrl = "";
  let reorderBody: JsonObject | undefined;
  await page.route("**/bff/**", async (route) => {
    const request = route.request();
    const path = pathFor(route);
    if (request.method() === "GET" && path === `/modules/${MODULE_ID}`) {
      await json(route, 200, moduleFixture());
    } else if (
      request.method() === "GET" &&
      path === `/departments/${DEPARTMENT_ID}`
    ) {
      await json(route, 200, departmentFixture());
    } else if (request.method() === "GET" && path === "/fields") {
      fieldsUrl = request.url();
      await json(route, 200, listResponse(schemaFields));
    } else if (request.method() === "GET" && path === "/modules") {
      await json(route, 200, listResponse([]));
    } else if (
      request.method() === "POST" &&
      path === `/modules/${MODULE_ID}/fields/reorder`
    ) {
      reorderBody = request.postDataJSON() as JsonObject;
      schemaFields = [activeLast, closed, activeFirst];
      await json(route, 200, [activeLast, activeFirst]);
    } else {
      await json(route, 404, { detail: "Unhandled mock route" });
    }
  });

  await page.goto(`/modules/${MODULE_ID}/schema`);
  const rows = page.locator("[data-schema-field-id]");
  await expect(rows).toHaveCount(3);
  const fieldDangerZone = rows.first().locator("details");
  await expect(fieldDangerZone).toBeVisible();
  expect(await fieldDangerZone.getAttribute("open")).toBeNull();
  await expect(
    fieldDangerZone.getByRole("button", { name: "Close", exact: true }),
  ).toBeHidden();
  const closedFieldDangerZone = rows.nth(1).locator("details");
  await closedFieldDangerZone.locator("summary").click();
  await expect(
    closedFieldDangerZone.getByRole("button", { name: "Reopen", exact: true }),
  ).toBeVisible();
  expect(new URL(fieldsUrl).searchParams.get("deleted")).toBe("include");
  await expect(page.getByText("Closed", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Move Closed field up" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Move Closed field down" }),
  ).toBeDisabled();
  expect(
    await rows.evaluateAll((items) =>
      items.map((item) => item.getAttribute("data-schema-field-id")),
    ),
  ).toEqual([ACTIVE_FIRST_FIELD_ID, CLOSED_FIELD_ID, ACTIVE_LAST_FIELD_ID]);

  await page.getByRole("button", { name: "Move Last active up" }).click();
  await expect
    .poll(() => reorderBody)
    .toEqual({
      field_ids: [ACTIVE_LAST_FIELD_ID, ACTIVE_FIRST_FIELD_ID],
    });
  await expect
    .poll(() =>
      rows.evaluateAll((items) =>
        items.map((item) => item.getAttribute("data-schema-field-id")),
      ),
    )
    .toEqual([ACTIVE_LAST_FIELD_ID, CLOSED_FIELD_ID, ACTIVE_FIRST_FIELD_ID]);
});

test("places module lifecycle controls in the bottom danger zone", async ({
  page,
}) => {
  await installSessionMocks(page);
  await page.route("**/bff/**", async (route) => {
    const request = route.request();
    const path = pathFor(route);
    if (request.method() === "GET" && path === `/modules/${MODULE_ID}`) {
      await json(route, 200, moduleFixture());
    } else if (
      request.method() === "GET" &&
      path === `/departments/${DEPARTMENT_ID}`
    ) {
      await json(route, 200, departmentFixture());
    } else if (request.method() === "GET" && path === "/fields") {
      await json(route, 200, listResponse([]));
    } else {
      await json(route, 404, { detail: "Unhandled mock route" });
    }
  });

  await page.goto(`/modules/${MODULE_ID}`);
  const dangerZone = page.getByTestId("module-danger-zone");
  await expect(dangerZone).toBeVisible();
  expect(
    await dangerZone.evaluate(
      (node) => node.parentElement?.lastElementChild === node,
    ),
  ).toBe(true);
  await expect(
    dangerZone.getByRole("button", { name: "Close", exact: true }),
  ).toHaveClass(/bg-destructive/);
});

test("completes the Close preview, exact-name, and password steps", async ({
  page,
}) => {
  await installSessionMocks(page);
  const requests: { path: string; body: JsonObject }[] = [];
  await page.route("**/bff/**", async (route) => {
    const request = route.request();
    const path = pathFor(route);
    const body: JsonObject =
      request.method() === "GET" ? {} : (request.postDataJSON() as JsonObject);
    if (request.method() !== "GET") requests.push({ path, body });
    if (
      request.method() === "GET" &&
      path === `/departments/${DEPARTMENT_ID}`
    ) {
      await json(route, 200, departmentFixture());
    } else if (request.method() === "GET" && path === "/modules") {
      await json(route, 200, listResponse([moduleFixture()]));
    } else if (
      request.method() === "POST" &&
      path === `/departments/${DEPARTMENT_ID}/close/preview`
    ) {
      await json(route, 200, {
        impact: lifecycleImpact("close"),
        token: "opaque-token",
        expires_at: "2099-01-01T00:00:00.000Z",
        confirmation_name: "Operations",
      });
    } else if (
      request.method() === "POST" &&
      path === `/departments/${DEPARTMENT_ID}/close`
    ) {
      await json(route, 200, {
        impact: lifecycleImpact("close", true),
        operation_id: null,
      });
    } else {
      await json(route, 404, {
        detail: `Unhandled ${request.method()} ${path}`,
      });
    }
  });

  await page.goto(`/departments/${DEPARTMENT_ID}`);
  const dangerZone = page.getByTestId("department-danger-zone");
  await expect(dangerZone).toBeVisible();
  expect(
    await dangerZone.evaluate(
      (node) => node.parentElement?.lastElementChild === node,
    ),
  ).toBe(true);
  await expect(
    dangerZone.getByRole("button", { name: "Close", exact: true }),
  ).toHaveClass(/bg-destructive/);
  await page
    .getByRole("button", { name: "Close", exact: true })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "External relationship impacts" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel(/Type Operations to continue/).fill("Operations");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("Your password").fill("correct horse battery staple");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();

  const closeRequest = requests.find(
    (request) => request.path === `/departments/${DEPARTMENT_ID}/close`,
  );
  expect(closeRequest?.body).toEqual({
    token: "opaque-token",
    confirmation_name: "Operations",
    password: "correct horse battery staple",
  });
});

test("reopens a closed department with one confirmed request", async ({
  page,
}) => {
  await installSessionMocks(page);
  let reopenBody: unknown;
  await page.route("**/bff/**", async (route) => {
    const request = route.request();
    const path = pathFor(route);
    if (
      request.method() === "GET" &&
      path === `/departments/${DEPARTMENT_ID}`
    ) {
      await json(route, 200, departmentFixture(true));
    } else if (request.method() === "GET" && path === "/modules") {
      await json(route, 200, listResponse([]));
    } else if (
      request.method() === "POST" &&
      path === `/departments/${DEPARTMENT_ID}/reopen`
    ) {
      reopenBody = request.postDataJSON();
      await json(route, 200, {
        impact: lifecycleImpact("close"),
        operation_id: null,
      });
    } else {
      await json(route, 404, { detail: "Unhandled mock route" });
    }
  });

  await page.goto(`/departments/${DEPARTMENT_ID}`);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("All closed descendants");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await expect.poll(() => reopenBody).toEqual({ confirmed: true });
});

async function installRecordMocks(page: Page, sourceClosed: boolean) {
  await installSessionMocks(page);
  await page.route("**/bff/**", async (route) => {
    const request = route.request();
    const path = pathFor(route);
    const url = new URL(request.url());
    if (request.method() === "GET" && path === `/modules/${MODULE_ID}`) {
      await json(route, 200, moduleFixture(sourceClosed));
    } else if (
      request.method() === "GET" &&
      path === `/departments/${DEPARTMENT_ID}`
    ) {
      await json(route, 200, departmentFixture());
    } else if (request.method() === "GET" && path === "/fields") {
      await json(
        route,
        200,
        listResponse([
          {
            ...baseEntity(FIELD_ID),
            module_id: MODULE_ID,
            name: "Owner",
            type: "relationship",
            required: false,
            position: 0,
            config: {},
            relationship_target_module_id: TARGET_MODULE_ID,
            relationship_multiple_targets: false,
            relationship_multiple_sources: false,
          },
        ]),
      );
    } else if (request.method() === "GET" && path === `/records/${RECORD_ID}`) {
      await json(route, 200, {
        ...baseEntity(RECORD_ID),
        module_id: MODULE_ID,
        data: {},
      });
    } else if (request.method() === "GET" && path === "/relationships") {
      await json(
        route,
        200,
        listResponse([
          {
            ...baseEntity(EDGE_ID),
            field_id: FIELD_ID,
            source_record_id: RECORD_ID,
            target_record_id: TARGET_RECORD_ID,
            visibility: "hidden",
            hidden_reasons: ["target_record_archived"],
          },
        ]),
      );
    } else if (request.method() === "GET" && path === "/records") {
      expect(url.searchParams.get("deleted")).toBe("exclude");
      await json(route, 200, listResponse([]));
    } else if (
      request.method() === "DELETE" &&
      path === `/relationships/${EDGE_ID}`
    ) {
      await route.fulfill({ status: 204 });
    } else {
      await json(route, 404, { detail: "Unhandled mock route" });
    }
  });
}

test("disables closed-source relationship controls", async ({ page }) => {
  await installRecordMocks(page, true);
  await page.goto(`/modules/${MODULE_ID}/records/${RECORD_ID}/edit`);
  await expect(
    page.getByRole("combobox", { name: "Owner target" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Unlink hidden target" }),
  ).toBeDisabled();
});

test("active sources can unlink a hidden closed target while picker queries exclude deleted targets", async ({
  page,
}) => {
  await installRecordMocks(page, false);
  const deleteRequest = page.waitForRequest(
    (request) =>
      request.method() === "DELETE" &&
      pathForRequest(request) === `/relationships/${EDGE_ID}`,
  );
  await page.goto(`/modules/${MODULE_ID}/records/${RECORD_ID}/edit`);
  await page.getByRole("button", { name: "Unlink hidden target" }).click();
  await deleteRequest;
  await expect(
    page.getByRole("combobox", { name: "Owner target" }),
  ).toBeEnabled();
});
