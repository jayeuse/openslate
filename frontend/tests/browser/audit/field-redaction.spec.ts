import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";
import { expect, test, type Page } from "@playwright/test";
import {
  baseEntity,
  DEPARTMENT_ID,
  departmentFixture,
  installSessionMocks,
  json,
  listResponse,
  MODULE_ID,
  moduleFixture,
  pathFor,
  TARGET_MODULE_ID,
  type JsonObject,
} from "../helpers/lifecycle-fixtures";

const CREATE_FIELD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const PRIMITIVE_FIELD_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const RELATIONSHIP_FIELD_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

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
    if (await fulfillWorkspaceRequest(route)) return;
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
