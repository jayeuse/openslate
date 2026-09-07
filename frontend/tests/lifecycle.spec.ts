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
const CREATE_FIELD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PRIMITIVE_FIELD_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RELATIONSHIP_FIELD_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

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

function schemaFieldFixture(
  id: string,
  name: string,
  type: "text" | "relationship" = "text",
  auditRedacted = false,
): JsonObject {
  return {
    ...baseEntity(id),
    module_id: MODULE_ID,
    name,
    type,
    required: false,
    position: 0,
    audit_redacted: auditRedacted,
    config: {},
    relationship_target_module_id:
      type === "relationship" ? TARGET_MODULE_ID : null,
    relationship_multiple_targets: type === "relationship" ? false : null,
    relationship_multiple_sources: type === "relationship" ? false : null,
  };
}

type SchemaMockOptions = {
  patchStatus?: number;
  patchDetail?: string;
  fieldReloadHold?: Promise<void>;
  schemaAccepted?: boolean;
};

type SchemaMockTracker = {
  createBodies: JsonObject[];
  fieldReloadStarted: Promise<void>;
  fieldListRequests: number;
  patchBodies: JsonObject[];
  patchPaths: string[];
};

async function installSchemaBuilderMocks(
  page: Page,
  schemaFields: JsonObject[],
  options: SchemaMockOptions = {},
): Promise<SchemaMockTracker> {
  await installSessionMocks(page);
  const tracker: SchemaMockTracker = {
    createBodies: [],
    fieldReloadStarted: Promise.resolve(),
    fieldListRequests: 0,
    patchBodies: [],
    patchPaths: [],
  };
  let notifyFieldReloadStarted: () => void = () => undefined;
  tracker.fieldReloadStarted = new Promise<void>((resolve) => {
    notifyFieldReloadStarted = resolve;
  });
  await page.route("**/bff/**", async (route) => {
    const request = route.request();
    const path = pathFor(route);
    if (request.method() === "GET" && path === `/modules/${MODULE_ID}`) {
      const moduleResponse = moduleFixture();
      moduleResponse.is_schema_accepted = options.schemaAccepted ?? true;
      await json(route, 200, moduleResponse);
    } else if (
      request.method() === "GET" &&
      path === `/departments/${DEPARTMENT_ID}`
    ) {
      await json(route, 200, departmentFixture());
    } else if (request.method() === "GET" && path === "/fields") {
      tracker.fieldListRequests += 1;
      if (tracker.fieldListRequests > 1) {
        notifyFieldReloadStarted();
        if (options.fieldReloadHold) await options.fieldReloadHold;
      }
      await json(route, 200, listResponse(schemaFields));
    } else if (request.method() === "GET" && path === "/modules") {
      await json(route, 200, listResponse([]));
    } else if (request.method() === "POST" && path === "/fields") {
      const body = request.postDataJSON() as JsonObject;
      tracker.createBodies.push(body);
      const created = schemaFieldFixture(
        CREATE_FIELD_ID,
        typeof body.name === "string" ? body.name : "New field",
        body.type === "relationship" ? "relationship" : "text",
        body.audit_redacted === true,
      );
      created.position =
        typeof body.position === "number" ? body.position : schemaFields.length;
      schemaFields.push(created);
      await json(route, 201, created);
    } else if (request.method() === "PATCH" && /^\/fields\/[^/]+$/.test(path)) {
      const body = request.postDataJSON() as JsonObject;
      tracker.patchBodies.push(body);
      tracker.patchPaths.push(path);
      if (options.patchStatus !== undefined) {
        await json(route, options.patchStatus, {
          detail: options.patchDetail ?? "Field update failed",
        });
        return;
      }
      const fieldId = path.split("/").pop();
      const field = schemaFields.find((item) => item.id === fieldId);
      if (!field) {
        await json(route, 404, { detail: "Field not found" });
        return;
      }
      field.audit_redacted = body.audit_redacted;
      await json(route, 200, field);
    } else {
      await json(route, 404, { detail: "Unhandled mock route" });
    }
  });
  return tracker;
}

test("creates fields with audit redaction off by default", async ({ page }) => {
  const schemaFields: JsonObject[] = [];
  const tracker = await installSchemaBuilderMocks(page, schemaFields);

  await page.goto(`/modules/${MODULE_ID}/schema`);
  await expect(
    page.getByRole("checkbox", {
      name: "Redact values in future audit snapshots",
    }),
  ).not.toBeChecked();
  await page.getByLabel("Field name").fill("Internal notes");
  await page.getByRole("button", { name: "Add field", exact: true }).click();

  await expect.poll(() => tracker.createBodies.length).toBe(1);
  expect(tracker.createBodies[0]).toMatchObject({ audit_redacted: false });
});

test("includes enabled audit redaction when creating a field", async ({
  page,
}) => {
  const schemaFields: JsonObject[] = [];
  const tracker = await installSchemaBuilderMocks(page, schemaFields);

  await page.goto(`/modules/${MODULE_ID}/schema`);
  await page
    .getByRole("checkbox", {
      name: "Redact values in future audit snapshots",
    })
    .check();
  await page.getByLabel("Field name").fill("Sensitive notes");
  await page.getByRole("button", { name: "Add field", exact: true }).click();

  await expect.poll(() => tracker.createBodies.length).toBe(1);
  expect(tracker.createBodies[0]).toMatchObject({ audit_redacted: true });
  await expect(
    page.getByText("Audit redaction: On", { exact: true }),
  ).toBeVisible();
});

test("displays and toggles audit redaction for primitive and relationship fields", async ({
  page,
}) => {
  const schemaFields = [
    schemaFieldFixture(PRIMITIVE_FIELD_ID, "Internal notes"),
    schemaFieldFixture(
      RELATIONSHIP_FIELD_ID,
      "Account owner",
      "relationship",
      true,
    ),
  ];
  const tracker = await installSchemaBuilderMocks(page, schemaFields);

  await page.goto(`/modules/${MODULE_ID}/schema`);
  const primitiveRow = page.locator(
    `[data-schema-field-id="${PRIMITIVE_FIELD_ID}"]`,
  );
  const relationshipRow = page.locator(
    `[data-schema-field-id="${RELATIONSHIP_FIELD_ID}"]`,
  );
  await expect(
    primitiveRow.getByText("Audit redaction: Off", { exact: true }),
  ).toBeVisible();
  await expect(
    relationshipRow.getByText("Audit redaction: On", { exact: true }),
  ).toBeVisible();

  const enablePrimitive = primitiveRow.getByRole("button", {
    name: "Enable audit redaction for Internal notes",
  });
  await enablePrimitive.focus();
  await enablePrimitive.press("Enter");
  await expect.poll(() => tracker.patchBodies.length).toBe(1);
  expect(tracker.patchPaths[0]).toBe(`/fields/${PRIMITIVE_FIELD_ID}`);
  expect(tracker.patchBodies[0]).toEqual({ audit_redacted: true });
  await expect(
    primitiveRow.getByText("Audit redaction: On", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Schema accepted", { exact: true }),
  ).toBeVisible();

  await relationshipRow
    .getByRole("button", {
      name: "Disable audit redaction for Account owner",
    })
    .click();
  await expect.poll(() => tracker.patchBodies.length).toBe(2);
  expect(tracker.patchPaths[1]).toBe(`/fields/${RELATIONSHIP_FIELD_ID}`);
  expect(tracker.patchBodies[1]).toEqual({ audit_redacted: false });
  await expect(
    relationshipRow.getByText("Audit redaction: Off", { exact: true }),
  ).toBeVisible();
});

test("reloads fields and shows a safe error when audit redaction fails", async ({
  page,
}) => {
  const schemaFields = [
    schemaFieldFixture(PRIMITIVE_FIELD_ID, "Internal notes"),
  ];
  const tracker = await installSchemaBuilderMocks(page, schemaFields, {
    patchStatus: 409,
    patchDetail: "Audit redaction update was rejected",
  });

  await page.goto(`/modules/${MODULE_ID}/schema`);
  const row = page.locator(`[data-schema-field-id="${PRIMITIVE_FIELD_ID}"]`);
  await row
    .getByRole("button", { name: "Enable audit redaction for Internal notes" })
    .click();

  await expect(
    page.getByText(
      "This schema conflicts with current data. Refresh and try again.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Audit redaction update was rejected", { exact: true }),
  ).toHaveCount(0);
  await expect(
    row.getByText("Audit redaction: Off", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => tracker.fieldListRequests).toBeGreaterThan(1);
});

test("explains that audit redaction only affects future snapshots", async ({
  page,
}) => {
  await installSchemaBuilderMocks(page, []);

  await page.goto(`/modules/${MODULE_ID}/schema`);
  await expect(
    page.getByText(
      "When enabled, values remain in records, but future audit snapshots are masked. Stored record values and historical audit logs are unchanged.",
      { exact: true },
    ),
  ).toBeVisible();
});

test("keeps every schema mutation control disabled through audit reload", async ({
  page,
}) => {
  const schemaFields = [
    schemaFieldFixture(PRIMITIVE_FIELD_ID, "Internal notes"),
    schemaFieldFixture(RELATIONSHIP_FIELD_ID, "Account owner"),
  ];
  let releaseReload!: () => void;
  const fieldReloadHold = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });
  const tracker = await installSchemaBuilderMocks(page, schemaFields, {
    fieldReloadHold,
    schemaAccepted: false,
  });

  await page.goto(`/modules/${MODULE_ID}/schema`);
  const firstRow = page.locator(
    `[data-schema-field-id="${PRIMITIVE_FIELD_ID}"]`,
  );
  const secondRow = page.locator(
    `[data-schema-field-id="${RELATIONSHIP_FIELD_ID}"]`,
  );
  await firstRow
    .getByRole("button", { name: "Enable audit redaction for Internal notes" })
    .click();
  await expect.poll(() => tracker.fieldListRequests).toBeGreaterThan(1);
  await tracker.fieldReloadStarted;

  await expect(page.getByRole("button", { name: "Add field" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Accept Schema" }),
  ).toBeDisabled();
  await expect(
    firstRow.getByRole("button", {
      name: "Enable audit redaction for Internal notes",
    }),
  ).toBeDisabled();
  await expect(
    secondRow.getByRole("button", {
      name: "Enable audit redaction for Account owner",
    }),
  ).toBeDisabled();
  await expect(
    firstRow.getByRole("button", { name: "Move Internal notes down" }),
  ).toBeDisabled();

  releaseReload();
  await expect(
    secondRow.getByRole("button", {
      name: "Enable audit redaction for Account owner",
    }),
  ).toBeEnabled();
});
