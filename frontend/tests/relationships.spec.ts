import {
  expect,
  test,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";

const DEPARTMENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_DEPARTMENT_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_MODULE_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_MODULE_ID = "44444444-4444-4444-8444-444444444444";
const CONTACTS_MODULE_ID = "55555555-5555-4555-8555-555555555555";
const EXTERNAL_MODULE_ID = "66666666-6666-4666-8666-666666666666";
const SOURCE_RECORD_ID = "77777777-7777-4777-8777-777777777777";
const TARGET_RECORD_ID = "88888888-8888-4888-8888-888888888888";
const SECOND_TARGET_RECORD_ID = "99999999-9999-4999-8999-999999999999";
const ARCHIVED_TARGET_RECORD_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INCOMING_SOURCE_RECORD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NAME_FIELD_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOTES_FIELD_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OWNER_FIELD_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CONTACTS_FIELD_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const INCOMING_FIELD_ID = "10101010-1010-4010-8010-101010101010";
const OWNER_EDGE_ID = "12121212-1212-4121-8121-121212121212";
const CONTACT_EDGE_ID = "13131313-1313-4131-8131-131313131313";
const HIDDEN_EDGE_ID = "14141414-1414-4141-8141-141414141414";
const INCOMING_EDGE_ID = "15151515-1515-4151-8151-151515151515";
const NEW_OWNER_RECORD_ID = "20202020-2020-4020-8020-202020202020";
const NEW_TARGET_RECORD_ID = "21212121-2121-4121-8121-212121212121";
const OWNER_NAME_FIELD_ID = "23232323-2323-4232-8232-232323232323";
const CONTACT_NAME_FIELD_ID = "24242424-2424-4242-8242-242424242424";

type JsonObject = { [key: string]: unknown };

function compactId(id: string): string {
  return `${id.slice(0, 8)}…${id.slice(-8)}`;
}

type BaseEntityFixture = {
  id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  is_deleted: boolean;
  performed_by: string | null;
};

type ModuleFixture = BaseEntityFixture & {
  department_id: string;
  module_name: string;
  is_schema_accepted: boolean;
};

type FieldFixture = BaseEntityFixture & {
  module_id: string;
  name: string;
  type: string;
  required: boolean;
  position: number;
  config: JsonObject;
  relationship_target_module_id: string | null;
  relationship_multiple_targets: boolean | null;
  relationship_multiple_sources: boolean | null;
};

type RecordFixture = BaseEntityFixture & {
  module_id: string;
  data: JsonObject;
};

type RelationshipFixture = BaseEntityFixture & {
  field_id: string;
  source_record_id: string;
  target_record_id: string;
  visibility: "available" | "hidden";
  hidden_reasons: string[];
};

type FixtureState = {
  modules: ModuleFixture[];
  fields: FieldFixture[];
  records: RecordFixture[];
  relationships: RelationshipFixture[];
  acceptanceError?: string;
};

type CapturedRequest = {
  method: string;
  path: string;
  url: string;
  body: unknown;
};

const CREATED_AT = "2026-01-01T00:00:00.000Z";

function baseEntity(id: string, isDeleted = false): BaseEntityFixture {
  return {
    id,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    deleted_at: isDeleted ? "2026-01-02T00:00:00.000Z" : null,
    is_deleted: isDeleted,
    performed_by: null,
  };
}

function moduleFixture(
  id: string,
  departmentId: string,
  moduleName: string,
  isSchemaAccepted = true,
): ModuleFixture {
  return {
    ...baseEntity(id),
    department_id: departmentId,
    module_name: moduleName,
    is_schema_accepted: isSchemaAccepted,
  };
}

function primitiveField(
  id: string,
  moduleId: string,
  name: string,
  position: number,
): FieldFixture {
  return {
    ...baseEntity(id),
    module_id: moduleId,
    name,
    type: "text",
    required: false,
    position,
    config: {},
    relationship_target_module_id: null,
    relationship_multiple_targets: null,
    relationship_multiple_sources: null,
  };
}

function relationshipField(
  id: string,
  moduleId: string,
  name: string,
  position: number,
  targetModuleId: string,
  multipleTargets: boolean,
  multipleSources: boolean,
): FieldFixture {
  return {
    ...baseEntity(id),
    module_id: moduleId,
    name,
    type: "relationship",
    required: false,
    position,
    config: {},
    relationship_target_module_id: targetModuleId,
    relationship_multiple_targets: multipleTargets,
    relationship_multiple_sources: multipleSources,
  };
}

function recordFixture(
  id: string,
  moduleId: string,
  data: JsonObject,
  isDeleted = false,
): RecordFixture {
  return { ...baseEntity(id, isDeleted), module_id: moduleId, data };
}

function relationshipFixture(
  id: string,
  fieldId: string,
  sourceRecordId: string,
  targetRecordId: string,
  visibility: "available" | "hidden" = "available",
  hiddenReasons: string[] = [],
  isDeleted = false,
): RelationshipFixture {
  return {
    ...baseEntity(id, isDeleted),
    field_id: fieldId,
    source_record_id: sourceRecordId,
    target_record_id: targetRecordId,
    visibility,
    hidden_reasons: hiddenReasons,
  };
}

function makeState(): FixtureState {
  return {
    modules: [
      moduleFixture(SOURCE_MODULE_ID, DEPARTMENT_ID, "Assets"),
      moduleFixture(TARGET_MODULE_ID, DEPARTMENT_ID, "Owners"),
      moduleFixture(CONTACTS_MODULE_ID, DEPARTMENT_ID, "Contacts"),
      moduleFixture(EXTERNAL_MODULE_ID, OTHER_DEPARTMENT_ID, "External"),
    ],
    fields: [
      primitiveField(NAME_FIELD_ID, SOURCE_MODULE_ID, "Name", 0),
      primitiveField(NOTES_FIELD_ID, SOURCE_MODULE_ID, "Notes", 1),
      relationshipField(
        OWNER_FIELD_ID,
        SOURCE_MODULE_ID,
        "Owner",
        2,
        TARGET_MODULE_ID,
        false,
        false,
      ),
      relationshipField(
        CONTACTS_FIELD_ID,
        SOURCE_MODULE_ID,
        "Related contacts",
        3,
        CONTACTS_MODULE_ID,
        true,
        true,
      ),
      relationshipField(
        INCOMING_FIELD_ID,
        TARGET_MODULE_ID,
        "Linked asset",
        0,
        SOURCE_MODULE_ID,
        false,
        true,
      ),
      primitiveField(OWNER_NAME_FIELD_ID, TARGET_MODULE_ID, "Name", 0),
      primitiveField(CONTACT_NAME_FIELD_ID, CONTACTS_MODULE_ID, "Name", 0),
    ],
    records: [
      recordFixture(SOURCE_RECORD_ID, SOURCE_MODULE_ID, {
        [NAME_FIELD_ID]: "Asset Alpha",
        [NOTES_FIELD_ID]: "Initial notes",
      }),
      recordFixture(TARGET_RECORD_ID, TARGET_MODULE_ID, {
        [OWNER_NAME_FIELD_ID]: "Owner One",
      }),
      recordFixture(NEW_OWNER_RECORD_ID, TARGET_MODULE_ID, {
        [OWNER_NAME_FIELD_ID]: "Owner Two",
      }),
      recordFixture(SECOND_TARGET_RECORD_ID, CONTACTS_MODULE_ID, {
        [CONTACT_NAME_FIELD_ID]: "Contact Two",
      }),
      recordFixture(NEW_TARGET_RECORD_ID, CONTACTS_MODULE_ID, {
        [CONTACT_NAME_FIELD_ID]: "Contact Three",
      }),
      recordFixture(
        ARCHIVED_TARGET_RECORD_ID,
        CONTACTS_MODULE_ID,
        {
          [CONTACT_NAME_FIELD_ID]: "Archived Contact",
        },
        true,
      ),
      recordFixture(INCOMING_SOURCE_RECORD_ID, TARGET_MODULE_ID, {
        [NAME_FIELD_ID]: "Incoming Owner",
      }),
    ],
    relationships: [
      relationshipFixture(
        OWNER_EDGE_ID,
        OWNER_FIELD_ID,
        SOURCE_RECORD_ID,
        TARGET_RECORD_ID,
      ),
      relationshipFixture(
        CONTACT_EDGE_ID,
        CONTACTS_FIELD_ID,
        SOURCE_RECORD_ID,
        SECOND_TARGET_RECORD_ID,
      ),
      relationshipFixture(
        HIDDEN_EDGE_ID,
        CONTACTS_FIELD_ID,
        SOURCE_RECORD_ID,
        ARCHIVED_TARGET_RECORD_ID,
        "hidden",
        ["target_record_archived"],
      ),
      relationshipFixture(
        INCOMING_EDGE_ID,
        INCOMING_FIELD_ID,
        INCOMING_SOURCE_RECORD_ID,
        SOURCE_RECORD_ID,
      ),
    ],
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestBody(request: Request): JsonObject {
  const postData = request.postData();
  if (!postData) return {};
  const parsed: unknown = JSON.parse(postData);
  return isJsonObject(parsed) ? parsed : {};
}

function pathFor(request: Request): string {
  return new URL(request.url()).pathname.replace(/^\/bff/, "") || "/";
}

function listResponse<T>(items: T[]): JsonObject {
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

async function fulfill(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installMocks(
  page: Page,
  state: FixtureState,
): Promise<CapturedRequest[]> {
  const requests: CapturedRequest[] = [];

  await page.route("**/session/status", (route) =>
    fulfill(route, 200, { authenticated: true }),
  );
  await page.route("**/session/realtime-token", (route) =>
    fulfill(route, 401, { detail: "Authentication required" }),
  );
  await page.route("**/bff/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const path = pathFor(request);
    const body = method === "GET" ? {} : requestBody(request);
    requests.push({ method, path, url: request.url(), body });

    if (method === "GET" && path === "/modules") {
      const departmentId = new URL(request.url()).searchParams.get(
        "department_id",
      );
      const modules = state.modules.filter(
        (module) => !departmentId || module.department_id === departmentId,
      );
      await fulfill(route, 200, listResponse(modules));
      return;
    }
    if (method === "GET" && /^\/departments\/[^/]+$/.test(path)) {
      const departmentId = path.split("/").pop();
      const department = state.modules.find(
        (item) => item.department_id === departmentId,
      );
      await fulfill(
        route,
        department ? 200 : 404,
        department
          ? {
              ...baseEntity(department.department_id),
              department_name: "Operations",
            }
          : { detail: "Not found" },
      );
      return;
    }
    if (method === "GET" && /^\/modules\/[^/]+$/.test(path)) {
      const moduleItem = state.modules.find((item) => path.endsWith(item.id));
      await fulfill(
        route,
        moduleItem ? 200 : 404,
        moduleItem ?? { detail: "Not found" },
      );
      return;
    }
    if (method === "POST" && /^\/modules\/[^/]+\/schema\/accept$/.test(path)) {
      const moduleItem = state.modules.find((item) =>
        path.includes(`/modules/${item.id}/`),
      );
      if (!moduleItem) {
        await fulfill(route, 404, { detail: "Not found" });
        return;
      }
      if (state.acceptanceError) {
        await fulfill(route, 409, { detail: state.acceptanceError });
        return;
      }
      moduleItem.is_schema_accepted = true;
      await fulfill(route, 200, moduleItem);
      return;
    }
    if (method === "GET" && path === "/fields") {
      const moduleId = new URL(request.url()).searchParams.get("module_id");
      const fields = state.fields.filter(
        (field) => !moduleId || field.module_id === moduleId,
      );
      await fulfill(route, 200, listResponse(fields));
      return;
    }
    if (method === "POST" && path === "/fields") {
      const field: FieldFixture = {
        ...baseEntity("16161616-1616-4161-8161-161616161616"),
        module_id:
          typeof body.module_id === "string"
            ? body.module_id
            : SOURCE_MODULE_ID,
        name: typeof body.name === "string" ? body.name : "New field",
        type: typeof body.type === "string" ? body.type : "text",
        required: body.required === true,
        position: typeof body.position === "number" ? body.position : 0,
        config: isJsonObject(body.config) ? body.config : {},
        relationship_target_module_id:
          typeof body.relationship_target_module_id === "string"
            ? body.relationship_target_module_id
            : null,
        relationship_multiple_targets:
          typeof body.relationship_multiple_targets === "boolean"
            ? body.relationship_multiple_targets
            : null,
        relationship_multiple_sources:
          typeof body.relationship_multiple_sources === "boolean"
            ? body.relationship_multiple_sources
            : null,
      };
      state.fields.push(field);
      const moduleItem = state.modules.find(
        (item) => item.id === field.module_id,
      );
      if (moduleItem) moduleItem.is_schema_accepted = false;
      await fulfill(route, 201, field);
      return;
    }
    if (method === "GET" && path === "/records") {
      const moduleId = new URL(request.url()).searchParams.get("module_id");
      const includeDeleted =
        new URL(request.url()).searchParams.get("deleted") === "include";
      const records = state.records.filter(
        (record) =>
          (!moduleId || record.module_id === moduleId) &&
          (includeDeleted || !record.is_deleted),
      );
      await fulfill(route, 200, listResponse(records));
      return;
    }
    if (method === "POST" && path === "/records") {
      const record = recordFixture(
        "17171717-1717-4171-8171-171717171717",
        typeof body.module_id === "string" ? body.module_id : SOURCE_MODULE_ID,
        isJsonObject(body.data) ? body.data : {},
      );
      state.records.push(record);
      await fulfill(route, 201, record);
      return;
    }
    if (method === "GET" && /^\/records\/[^/]+$/.test(path)) {
      const record = state.records.find((item) => path.endsWith(item.id));
      await fulfill(
        route,
        record ? 200 : 404,
        record ?? { detail: "Not found" },
      );
      return;
    }
    if (method === "PATCH" && /^\/records\/[^/]+$/.test(path)) {
      const record = state.records.find((item) => path.endsWith(item.id));
      if (!record) {
        await fulfill(route, 404, { detail: "Not found" });
        return;
      }
      if (isJsonObject(body.data)) record.data = body.data;
      record.updated_at = "2026-01-03T00:00:00.000Z";
      await fulfill(route, 200, record);
      return;
    }
    if (method === "GET" && path === "/relationships") {
      const params = new URL(request.url()).searchParams;
      const includeDeleted = params.get("deleted") === "include";
      const relationships = state.relationships.filter((relationship) => {
        if (!includeDeleted && relationship.is_deleted) return false;
        return (
          (!params.get("field_id") ||
            relationship.field_id === params.get("field_id")) &&
          (!params.get("source_record_id") ||
            relationship.source_record_id === params.get("source_record_id")) &&
          (!params.get("target_record_id") ||
            relationship.target_record_id === params.get("target_record_id"))
        );
      });
      await fulfill(route, 200, listResponse(relationships));
      return;
    }
    if (method === "POST" && path === "/relationships") {
      const relationship = relationshipFixture(
        "18181818-1818-4181-8181-181818181818",
        typeof body.field_id === "string" ? body.field_id : CONTACTS_FIELD_ID,
        typeof body.source_record_id === "string"
          ? body.source_record_id
          : SOURCE_RECORD_ID,
        typeof body.target_record_id === "string"
          ? body.target_record_id
          : SECOND_TARGET_RECORD_ID,
      );
      state.relationships.push(relationship);
      await fulfill(route, 201, relationship);
      return;
    }
    if (
      method === "PUT" &&
      /^\/relationships\/fields\/[^/]+\/sources\/[^/]+$/.test(path)
    ) {
      const [, , , fieldId, , sourceRecordId] = path.split("/");
      const current = state.relationships.find(
        (relationship) =>
          relationship.field_id === fieldId &&
          relationship.source_record_id === sourceRecordId &&
          !relationship.is_deleted,
      );
      if (current) {
        current.is_deleted = true;
        current.deleted_at = "2026-01-03T00:00:00.000Z";
      }
      if (typeof body.target_record_id !== "string") {
        await fulfill(route, 200, null);
        return;
      }
      const replacement = relationshipFixture(
        "19191919-1919-4191-8191-191919191919",
        fieldId,
        sourceRecordId,
        body.target_record_id,
      );
      state.relationships.push(replacement);
      await fulfill(route, 200, replacement);
      return;
    }
    if (method === "DELETE" && /^\/relationships\/[^/]+$/.test(path)) {
      const relationship = state.relationships.find((item) =>
        path.endsWith(item.id),
      );
      if (!relationship) {
        await fulfill(route, 404, { detail: "Not found" });
        return;
      }
      relationship.is_deleted = true;
      relationship.deleted_at = "2026-01-03T00:00:00.000Z";
      await route.fulfill({ status: 204 });
      return;
    }

    await fulfill(route, 404, {
      detail: `Unhandled mock route: ${method} ${path}`,
    });
  });

  return requests;
}

function requestMatching(
  requests: CapturedRequest[],
  method: string,
  path: string,
): CapturedRequest {
  const request = requests.find(
    (item) => item.method === method && item.path === path,
  );
  if (!request) throw new Error(`No ${method} request captured for ${path}`);
  return request;
}

function lastRequestMatching(
  requests: CapturedRequest[],
  method: string,
  path: string,
): CapturedRequest {
  const request = [...requests]
    .reverse()
    .find((item) => item.method === method && item.path === path);
  if (!request) throw new Error(`No ${method} request captured for ${path}`);
  return request;
}

test.describe("relationship UI", () => {
  test("accepts a valid schema and reflects the accepted status", async ({
    page,
  }) => {
    const state = makeState();
    const moduleItem = state.modules.find(
      (item) => item.id === SOURCE_MODULE_ID,
    );
    if (!moduleItem) throw new Error("Source module fixture is missing");
    moduleItem.is_schema_accepted = false;
    const requests = await installMocks(page, state);

    await page.goto(`/modules/${SOURCE_MODULE_ID}/schema`);
    const acceptButton = page.getByRole("button", { name: "Accept Schema" });
    await expect(acceptButton).toBeEnabled();

    const acceptRequest = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        pathFor(response.request()) ===
          `/modules/${SOURCE_MODULE_ID}/schema/accept`,
    );
    await acceptButton.click();
    await acceptRequest;

    expect(
      requestMatching(
        requests,
        "POST",
        `/modules/${SOURCE_MODULE_ID}/schema/accept`,
      ).body,
    ).toEqual({});
    await expect(
      page.getByText("Schema accepted", { exact: true }),
    ).toBeVisible();
    await expect(acceptButton).toBeDisabled();
  });

  test("shows a safe error when schema acceptance is rejected", async ({
    page,
  }) => {
    const state = makeState();
    const moduleItem = state.modules.find(
      (item) => item.id === SOURCE_MODULE_ID,
    );
    if (!moduleItem) throw new Error("Source module fixture is missing");
    moduleItem.is_schema_accepted = false;
    state.acceptanceError = "Schema contains an invalid field definition";
    await installMocks(page, state);

    await page.goto(`/modules/${SOURCE_MODULE_ID}/schema`);
    await page.getByRole("button", { name: "Accept Schema" }).click();

    await expect(
      page.getByRole("status").filter({
        hasText:
          "This schema conflicts with current data. Refresh and try again.",
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Schema contains an invalid field definition"),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Accept Schema" }),
    ).toBeEnabled();
  });

  test("reflects schema invalidation after a field is added", async ({
    page,
  }) => {
    const state = makeState();
    await installMocks(page, state);

    await page.goto(`/modules/${SOURCE_MODULE_ID}/schema`);
    await expect(
      page.getByText("Schema accepted", { exact: true }),
    ).toBeVisible();

    await page.getByLabel("Field name").fill("Asset status");
    const addRequest = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        pathFor(response.request()) === "/fields",
    );
    await page.getByRole("button", { name: /Add field/i }).click();
    await addRequest;

    await expect(
      page.getByText("Schema unaccepted", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Accept Schema" }),
    ).toBeEnabled();
  });

  test("shows the unaccepted status on the module page", async ({ page }) => {
    const state = makeState();
    const moduleItem = state.modules.find(
      (item) => item.id === SOURCE_MODULE_ID,
    );
    if (!moduleItem) throw new Error("Source module fixture is missing");
    moduleItem.is_schema_accepted = false;
    await installMocks(page, state);

    await page.goto(`/modules/${SOURCE_MODULE_ID}`);

    await expect(
      page.getByText("Schema unaccepted", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/Accept the schema before adding records/i),
    ).toBeVisible();
  });

  test("gates record creation until the schema is accepted", async ({
    page,
  }) => {
    const state = makeState();
    const moduleItem = state.modules.find(
      (item) => item.id === SOURCE_MODULE_ID,
    );
    if (!moduleItem) throw new Error("Source module fixture is missing");
    moduleItem.is_schema_accepted = false;
    await installMocks(page, state);

    await page.goto(`/modules/${SOURCE_MODULE_ID}/records`);

    await expect(
      page.getByRole("button", { name: "Add record" }),
    ).toBeDisabled();
    await expect(
      page.getByText(/Accept the schema before creating a record/i),
    ).toBeVisible();
  });

  test("configures relationship fields and summarizes existing cardinality", async ({
    page,
  }) => {
    const state = makeState();
    const requests = await installMocks(page, state);

    await page.goto(
      `/departments/${DEPARTMENT_ID}/modules/${SOURCE_MODULE_ID}/schema`,
    );
    await expect(
      page.getByRole("heading", { name: "Field builder" }),
    ).toBeVisible();
    await expect(page.getByText("Contacts", { exact: true })).toBeVisible();
    await expect(page.getByText(/multiple targets/i)).toBeVisible();
    await expect(page.getByText(/multiple sources/i)).toBeVisible();

    const required = page.getByRole("checkbox", { name: /Required/ });
    await required.check();
    await page.getByLabel("Type").selectOption("relationship");

    const targetModule = page.getByLabel("Target module");
    await expect(targetModule).toBeVisible();
    await expect(targetModule).toHaveAttribute("required", "");
    await expect(targetModule.locator("option")).toContainText([
      "Assets",
      "Owners",
      "Contacts",
    ]);
    await expect(
      targetModule.locator("option", { hasText: "External" }),
    ).toHaveCount(0);
    await expect(required).toBeDisabled();
    await expect(required).not.toBeChecked();

    await page
      .getByRole("group", { name: "Targets per source" })
      .getByRole("radio", { name: "Multiple" })
      .check();
    await page
      .getByRole("group", { name: "Sources per target" })
      .getByRole("radio", { name: "Single" })
      .check();
    await targetModule.selectOption({ label: "Contacts" });
    await page.getByLabel("Field name").fill("Related vendors");

    const postRequest = page.waitForRequest(
      (request) =>
        request.method() === "POST" && pathFor(request) === "/fields",
    );
    await page.getByRole("button", { name: /Add field/i }).click();
    await postRequest;

    expect(requestMatching(requests, "POST", "/fields").body).toEqual({
      module_id: SOURCE_MODULE_ID,
      name: "Related vendors",
      type: "relationship",
      required: false,
      audit_redacted: false,
      position: 4,
      config: {},
      relationship_target_module_id: CONTACTS_MODULE_ID,
      relationship_multiple_targets: true,
      relationship_multiple_sources: false,
    });
    await expect(page.getByText("Related vendors")).toBeVisible();
  });

  test("keeps relationship fields out of new-record inputs and record data", async ({
    page,
  }) => {
    const state = makeState();
    const requests = await installMocks(page, state);

    await page.goto(
      `/departments/${DEPARTMENT_ID}/modules/${SOURCE_MODULE_ID}/records/new`,
    );
    await expect(
      page.getByRole("heading", { name: "Add a record" }),
    ).toBeVisible();
    await expect(page.getByLabel("Name")).toBeVisible();
    await expect(page.getByLabel("Owner", { exact: true })).toHaveCount(0);
    await expect(
      page.getByText(/links are managed after creating the record/i),
    ).toBeVisible();

    await page.getByLabel("Name").fill("Asset Beta");
    const postRequest = page.waitForRequest(
      (request) =>
        request.method() === "POST" && pathFor(request) === "/records",
    );
    await page.getByRole("button", { name: /Create record/i }).click();
    await postRequest;

    const body = requestMatching(requests, "POST", "/records").body;
    expect(body).toEqual({
      module_id: SOURCE_MODULE_ID,
      data: { [NAME_FIELD_ID]: "Asset Beta" },
    });
    expect(
      isJsonObject(body) && isJsonObject(body.data) ? body.data : {},
    ).not.toHaveProperty(OWNER_FIELD_ID);
    expect(
      isJsonObject(body) && isJsonObject(body.data) ? body.data : {},
    ).not.toHaveProperty(CONTACTS_FIELD_ID);
  });

  test("manages outgoing links while keeping primitive edits separate and incoming links read-only", async ({
    page,
  }) => {
    const state = makeState();
    const requests = await installMocks(page, state);

    await page.goto(
      `/departments/${DEPARTMENT_ID}/modules/${SOURCE_MODULE_ID}/records/${SOURCE_RECORD_ID}/edit`,
    );
    await expect(
      page.getByRole("heading", { name: "Edit record" }),
    ).toBeVisible();
    await expect(page.getByLabel("Notes")).toHaveValue("Initial notes");
    await expect(page.getByText(/Manage relationships/i)).toBeVisible();

    const ownerTarget = page.getByRole("combobox", { name: /Owner/ });
    await expect(ownerTarget).toHaveValue(TARGET_RECORD_ID);
    const ownerPut = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        pathFor(response.request()) ===
          `/relationships/fields/${OWNER_FIELD_ID}/sources/${SOURCE_RECORD_ID}`,
    );
    await ownerTarget.selectOption({
      label: compactId(NEW_OWNER_RECORD_ID),
    });
    await ownerPut;
    expect(
      lastRequestMatching(
        requests,
        "PUT",
        `/relationships/fields/${OWNER_FIELD_ID}/sources/${SOURCE_RECORD_ID}`,
      ).body,
    ).toEqual({ target_record_id: NEW_OWNER_RECORD_ID });
    await expect(ownerTarget).toHaveValue(NEW_OWNER_RECORD_ID);

    const clearOwnerPut = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        pathFor(response.request()) ===
          `/relationships/fields/${OWNER_FIELD_ID}/sources/${SOURCE_RECORD_ID}`,
    );
    await ownerTarget.selectOption({ value: "" });
    await clearOwnerPut;
    expect(
      lastRequestMatching(
        requests,
        "PUT",
        `/relationships/fields/${OWNER_FIELD_ID}/sources/${SOURCE_RECORD_ID}`,
      ).body,
    ).toEqual({ target_record_id: null });

    const contactsTarget = page.getByRole("combobox", {
      name: /Related contacts/,
    });
    await contactsTarget.selectOption({
      label: compactId(NEW_TARGET_RECORD_ID),
    });
    const addRelationship = page.waitForRequest(
      (request) =>
        request.method() === "POST" && pathFor(request) === "/relationships",
    );
    await page.getByRole("button", { name: /Add link/i }).click();
    await addRelationship;
    expect(requestMatching(requests, "POST", "/relationships").body).toEqual({
      field_id: CONTACTS_FIELD_ID,
      source_record_id: SOURCE_RECORD_ID,
      target_record_id: NEW_TARGET_RECORD_ID,
    });

    const visibleRelationship = page
      .getByText(compactId(SECOND_TARGET_RECORD_ID), { exact: true })
      .locator("..");
    const visibleUnlink = visibleRelationship.getByRole("button", {
      name: /Unlink/i,
    });
    await expect(visibleUnlink).toBeVisible();
    const visibleDelete = page.waitForRequest(
      (request) =>
        request.method() === "DELETE" &&
        pathFor(request) === `/relationships/${CONTACT_EDGE_ID}`,
    );
    await visibleUnlink.click();
    await visibleDelete;

    await expect(page.getByText(/target record archived/i)).toBeVisible();
    const hiddenRelationship = page
      .getByText(/target record archived/i)
      .locator("..");
    const hiddenUnlink = hiddenRelationship.getByRole("button", {
      name: /Unlink/i,
    });
    await expect(hiddenUnlink).toBeVisible();
    const hiddenDelete = page.waitForRequest(
      (request) =>
        request.method() === "DELETE" &&
        pathFor(request) === `/relationships/${HIDDEN_EDGE_ID}`,
    );
    await hiddenUnlink.click();
    await hiddenDelete;

    const incoming = page.getByRole("region", { name: /Incoming links/i });
    await expect(incoming).toContainText(compactId(INCOMING_SOURCE_RECORD_ID));
    const incomingRequest = requests.find(
      (request) =>
        request.method === "GET" &&
        request.path === "/relationships" &&
        request.url.includes(`target_record_id=${SOURCE_RECORD_ID}`),
    );
    expect(incomingRequest).toBeDefined();
    await expect(
      incoming.getByRole("button", { name: /Unlink|Remove/i }),
    ).toHaveCount(0);

    await page.getByLabel("Notes").fill("Updated notes");
    const patchRequest = page.waitForRequest(
      (request) =>
        request.method() === "PATCH" &&
        pathFor(request) === `/records/${SOURCE_RECORD_ID}`,
    );
    await page.getByRole("button", { name: /Save changes/i }).click();
    await patchRequest;
    expect(
      requestMatching(requests, "PATCH", `/records/${SOURCE_RECORD_ID}`).body,
    ).toEqual({
      data: {
        [NAME_FIELD_ID]: "Asset Alpha",
        [NOTES_FIELD_ID]: "Updated notes",
      },
    });
  });

  test("renders relationship columns as edit-managed links instead of JSONB values", async ({
    page,
  }) => {
    const state = makeState();
    await installMocks(page, state);

    await page.goto(
      `/departments/${DEPARTMENT_ID}/modules/${SOURCE_MODULE_ID}/records`,
    );
    await expect(
      page.getByRole("columnheader", { name: "Related contacts" }),
    ).toBeVisible();
    const sourceRow = page.getByRole("row").filter({ hasText: "Asset Alpha" });
    await expect(sourceRow).toContainText(/links are managed from edit/i);
    await expect(sourceRow).not.toContainText(CONTACTS_FIELD_ID);
    const sourceRecordLink = sourceRow.locator(
      `a[href$="/records/${SOURCE_RECORD_ID}/edit"]`,
    );
    await expect(sourceRecordLink).toHaveAccessibleName(
      compactId(SOURCE_RECORD_ID),
    );
  });
});
