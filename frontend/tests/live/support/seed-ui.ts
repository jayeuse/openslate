import { expect, type Page, type Response } from "@playwright/test";

import type {
  CatalogModule,
  PrimitiveFieldType,
  RelationshipDefinition,
} from "./catalog";
import type { LiveField } from "./api";
import { assertNoRedirect, validateLoopbackHttpOrigin } from "./preflight";
import { assertCanonicalUuid } from "./manifest";
import {
  controlRoleForField,
  mapSanityFormValuesToFields,
  recordPayloadFromFormValues,
  relationshipTargetAccessibleName,
  type SeedFieldDescriptor,
} from "./seed-helpers";

export type LiveMutation = Readonly<{
  response: Response;
  body: unknown;
  requestBody: unknown;
}>;

export type SchemaFieldInput = Readonly<{
  name: string;
  type: PrimitiveFieldType | "relationship";
  required?: boolean;
  options?: readonly string[];
  targetModuleId?: string;
  multipleTargets?: boolean;
  multipleSources?: boolean;
  forbiddenTargetModuleName?: string;
}>;

function apiPath(url: string): string {
  return new URL(url).pathname.replace(/^\/bff/, "") || "/";
}

function uiOriginForPage(page: Page, configuredOrigin?: string): string {
  if (configuredOrigin) return validateLoopbackHttpOrigin(configuredOrigin);
  if (process.env.LIVE_BASE_URL) {
    return validateLoopbackHttpOrigin(process.env.LIVE_BASE_URL);
  }
  return new URL(page.url()).origin;
}

export function assertExactUiPath(
  page: Page,
  pathname: string,
  configuredOrigin?: string,
): void {
  const url = new URL(page.url());
  const origin = uiOriginForPage(page, configuredOrigin);
  if (
    url.origin !== origin ||
    url.pathname !== pathname ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`Live browser navigated away from ${pathname}`);
  }
}

async function gotoExactUiPath(
  page: Page,
  pathname: string,
  configuredOrigin?: string,
): Promise<void> {
  await page.goto(pathname);
  assertExactUiPath(page, pathname, configuredOrigin);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function responseBody(response: Response): Promise<unknown> {
  return (await response.json().catch(() => null)) as unknown;
}

function requestBody(response: Response): unknown {
  const postData = response.request().postData();
  if (!postData) return null;
  try {
    return JSON.parse(postData) as unknown;
  } catch {
    return postData;
  }
}

function payloadMatches(
  value: unknown,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== Object.keys(expected).length
  ) {
    return false;
  }
  return Object.entries(expected).every(
    ([key, expectedValue]) =>
      key in value &&
      JSON.stringify(value[key]) === JSON.stringify(expectedValue),
  );
}

export async function waitForLiveMutation(
  page: Page,
  method: string,
  path: string,
  action: () => Promise<void>,
  configuredOrigin?: string,
): Promise<LiveMutation> {
  const expectedOrigin = uiOriginForPage(page, configuredOrigin);
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === method &&
      url.origin === expectedOrigin &&
      url.search === "" &&
      url.hash === "" &&
      apiPath(response.url()) === path
    );
  });
  await action();
  const response = await responsePromise;
  assertNoRedirect(response.url(), expectedOrigin);
  const body = await responseBody(response);
  if (!response.ok()) {
    throw new Error(
      `Live UI mutation failed: ${method} ${path} (${response.status()})`,
    );
  }
  return { response, body, requestBody: requestBody(response) };
}

export function exactEntityId(body: unknown, operation: string): string {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    !("id" in body) ||
    typeof body.id !== "string" ||
    body.id.length === 0
  ) {
    throw new Error(`Live ${operation} response did not contain an exact ID`);
  }
  return assertCanonicalUuid(body.id, `Live ${operation} response ID`);
}

function moduleRoute(
  departmentId: string,
  moduleId: string,
  suffix = "",
): string {
  return `/departments/${departmentId}/modules/${moduleId}${suffix}`;
}

function relationshipFieldset(page: Page, relationshipName: string) {
  return page
    .locator("fieldset")
    .filter({ has: page.getByText(relationshipName, { exact: true }) })
    .first();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function recordFieldControl(page: Page, field: SeedFieldDescriptor) {
  const checkboxSuffix = field.type === "boolean" ? " Yes" : "";
  const accessibleName = new RegExp(
    `^${escapeRegExp(field.name)}(?: \\*)?${checkboxSuffix}$`,
  );
  return page.getByRole(controlRoleForField(field.type), {
    name: accessibleName,
  });
}

export class LiveSeedPage {
  constructor(
    private readonly page: Page,
    private readonly uiOrigin?: string,
  ) {}

  async createDepartment(name: string): Promise<LiveMutation> {
    await gotoExactUiPath(this.page, "/departments/new", this.uiOrigin);
    await expect(
      this.page.getByRole("heading", { name: "Create a department" }),
    ).toBeVisible();
    await this.page.getByLabel("Department name", { exact: true }).fill(name);
    const mutation = await waitForLiveMutation(
      this.page,
      "POST",
      "/departments",
      () =>
        this.page.getByRole("button", { name: /Create department/ }).click(),
      this.uiOrigin,
    );
    const departmentId = exactEntityId(mutation.body, "department creation");
    await this.page.waitForURL(
      (url) =>
        url.origin === uiOriginForPage(this.page, this.uiOrigin) &&
        url.pathname === `/departments/${departmentId}` &&
        url.search === "" &&
        url.hash === "",
    );
    assertExactUiPath(this.page, `/departments/${departmentId}`, this.uiOrigin);
    await expect(
      this.page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    return mutation;
  }

  async openDepartment(departmentId: string, name: string): Promise<void> {
    await gotoExactUiPath(
      this.page,
      `/departments/${departmentId}`,
      this.uiOrigin,
    );
    await expect(
      this.page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    await expect(
      this.page.getByRole("heading", { name: "Modules", exact: true }),
    ).toBeVisible();
  }

  async createModule(
    departmentId: string,
    name: string,
  ): Promise<LiveMutation> {
    await this.page.getByLabel("Module name", { exact: true }).fill(name);
    const mutation = await waitForLiveMutation(
      this.page,
      "POST",
      "/modules",
      () => this.page.getByRole("button", { name: /Create module/ }).click(),
      this.uiOrigin,
    );
    exactEntityId(mutation.body, "module creation");
    const body = mutation.body;
    if (
      typeof body !== "object" ||
      body === null ||
      !("department_id" in body) ||
      body.department_id !== departmentId
    ) {
      throw new Error(
        `Live module ${name} was returned under the wrong department`,
      );
    }
    await expect(this.page.getByText(name, { exact: true })).toBeVisible();
    return mutation;
  }

  async openSchema(departmentId: string, moduleId: string): Promise<void> {
    await gotoExactUiPath(
      this.page,
      moduleRoute(departmentId, moduleId, "/schema"),
      this.uiOrigin,
    );
    await expect(
      this.page.getByRole("heading", { name: "Field builder", exact: true }),
    ).toBeVisible();
    await expect(
      this.page.getByLabel("Field name", { exact: true }),
    ).toBeVisible();
  }

  async assertTargetModuleOptionAbsent(moduleName: string): Promise<void> {
    const targetModule = this.page.getByLabel("Target module", { exact: true });
    await expect(targetModule).toBeVisible();
    await expect(
      targetModule.getByRole("option", { name: moduleName, exact: true }),
    ).toHaveCount(0);
  }

  async addField(input: SchemaFieldInput): Promise<LiveMutation> {
    const type = this.page.getByLabel("Type", { exact: true });
    await expect(type).toBeEnabled();
    await this.page.getByLabel("Field name", { exact: true }).fill(input.name);
    await type.selectOption(input.type);

    const required = this.page.getByRole("checkbox", {
      name: "Required field",
      exact: true,
    });
    if (input.type === "relationship") {
      await expect(required).toBeDisabled();
      await expect(required).not.toBeChecked();
      if (input.forbiddenTargetModuleName) {
        await this.assertTargetModuleOptionAbsent(
          input.forbiddenTargetModuleName,
        );
      }
      const targetModule = this.page.getByLabel("Target module", {
        exact: true,
      });
      await targetModule.selectOption({ value: input.targetModuleId ?? "" });
      await this.page
        .getByRole("group", { name: "Targets per source", exact: true })
        .getByRole("radio", {
          name: input.multipleTargets ? "Multiple" : "Single",
          exact: true,
        })
        .check();
      await this.page
        .getByRole("group", { name: "Sources per target", exact: true })
        .getByRole("radio", {
          name: input.multipleSources ? "Multiple" : "Single",
          exact: true,
        })
        .check();
    } else {
      if (input.required === true) await required.check();
      else await required.uncheck();
      if (input.type === "select") {
        await this.page
          .getByLabel("Options", { exact: true })
          .fill(input.options?.join(", ") ?? "");
      }
    }

    const mutation = await waitForLiveMutation(
      this.page,
      "POST",
      "/fields",
      () =>
        this.page
          .getByRole("button", { name: "Add field", exact: true })
          .click(),
      this.uiOrigin,
    );
    const fieldId = exactEntityId(mutation.body, "field creation");
    await expect(
      this.page.locator(`[data-schema-field-id="${fieldId}"]`),
    ).toBeVisible();
    return mutation;
  }

  async acceptSchema(moduleId: string): Promise<LiveMutation> {
    const button = this.page.getByRole("button", {
      name: "Accept Schema",
      exact: true,
    });
    await expect(button).toBeEnabled();
    const mutation = await waitForLiveMutation(
      this.page,
      "POST",
      `/modules/${moduleId}/schema/accept`,
      () => button.click(),
      this.uiOrigin,
    );
    if (
      typeof mutation.body !== "object" ||
      mutation.body === null ||
      !("is_schema_accepted" in mutation.body) ||
      mutation.body.is_schema_accepted !== true
    ) {
      throw new Error(
        `Live schema acceptance for ${moduleId} was not confirmed`,
      );
    }
    await expect(
      this.page.getByText("Schema accepted", { exact: true }),
    ).toBeVisible();
    return mutation;
  }

  async createRecord(
    departmentId: string,
    moduleId: string,
    catalogModule: CatalogModule,
    fields: readonly SeedFieldDescriptor[],
    recordNumber: number,
    namespace: string,
  ): Promise<LiveMutation> {
    await gotoExactUiPath(
      this.page,
      moduleRoute(departmentId, moduleId, "/records/new"),
      this.uiOrigin,
    );
    await expect(
      this.page.getByRole("heading", { name: "Add a record", exact: true }),
    ).toBeVisible();

    const primitiveFields = fields.filter(
      (field) => field.type !== "relationship",
    );
    const formValues = mapSanityFormValuesToFields(
      catalogModule,
      primitiveFields,
      recordNumber,
      namespace,
    );
    for (const field of primitiveFields) {
      const value = formValues[field.id];
      if (value === undefined) {
        throw new Error(`Live record value is missing for field ${field.id}`);
      }
      const control = recordFieldControl(this.page, field);
      if (field.type === "boolean") {
        if (value === true) await control.check();
        else await control.uncheck();
      } else if (field.type === "select") {
        await control.selectOption({ label: String(value) });
      } else {
        await control.fill(String(value));
      }
    }
    for (const field of primitiveFields) {
      const value = formValues[field.id];
      if (value === undefined) {
        throw new Error(`Live record value is missing for field ${field.id}`);
      }
      const control = recordFieldControl(this.page, field);
      if (field.type === "boolean") {
        await expect(control).toBeChecked({ checked: value === true });
      } else {
        await expect(control).toHaveValue(String(value));
      }
    }
    for (const field of fields.filter((item) => item.type === "relationship")) {
      await expect(
        this.page.getByLabel(field.name, { exact: true }),
      ).toHaveCount(0);
    }

    const mutation = await waitForLiveMutation(
      this.page,
      "POST",
      "/records",
      () =>
        this.page
          .getByRole("button", { name: "Create record", exact: true })
          .click(),
      this.uiOrigin,
    );
    const recordId = exactEntityId(mutation.body, "record creation");
    const expectedPayload = recordPayloadFromFormValues(
      primitiveFields,
      formValues,
    );
    if (
      typeof mutation.requestBody !== "object" ||
      mutation.requestBody === null ||
      !("module_id" in mutation.requestBody) ||
      mutation.requestBody.module_id !== moduleId ||
      !("data" in mutation.requestBody) ||
      !payloadMatches(mutation.requestBody.data, expectedPayload)
    ) {
      throw new Error(
        `Live record ${recordId} did not submit the expected primitive payload`,
      );
    }
    await this.page.waitForURL(
      (url) =>
        url.origin === uiOriginForPage(this.page, this.uiOrigin) &&
        url.pathname ===
          moduleRoute(departmentId, moduleId, `/records/${recordId}/edit`) &&
        url.search === "" &&
        url.hash === "",
    );
    assertExactUiPath(
      this.page,
      moduleRoute(departmentId, moduleId, `/records/${recordId}/edit`),
      this.uiOrigin,
    );
    await expect(
      this.page.getByRole("heading", { name: "Edit record", exact: true }),
    ).toBeVisible();
    return mutation;
  }

  async openRecordEdit(
    departmentId: string,
    moduleId: string,
    recordId: string,
  ): Promise<void> {
    await gotoExactUiPath(
      this.page,
      moduleRoute(departmentId, moduleId, `/records/${recordId}/edit`),
      this.uiOrigin,
    );
    await expect(
      this.page.getByRole("heading", { name: "Edit record", exact: true }),
    ).toBeVisible();
  }

  async addRelationship(
    relationship: RelationshipDefinition,
    field: Pick<LiveField, "id" | "relationship_multiple_targets">,
    sourceRecordId: string,
    targetRecordId: string,
  ): Promise<LiveMutation> {
    const fieldContainer = relationshipFieldset(this.page, relationship.name);
    const target = fieldContainer.getByRole("combobox", {
      name: relationshipTargetAccessibleName(relationship.name),
      exact: true,
    });
    await expect(target).toBeVisible();

    if (field.relationship_multiple_targets === true) {
      await target.selectOption({ value: targetRecordId });
      await expect(target).toHaveValue(targetRecordId);
      const mutation = await waitForLiveMutation(
        this.page,
        "POST",
        "/relationships",
        () =>
          fieldContainer
            .getByRole("button", { name: "Add link", exact: true })
            .click(),
        this.uiOrigin,
      );
      if (
        typeof mutation.requestBody !== "object" ||
        mutation.requestBody === null ||
        !("field_id" in mutation.requestBody) ||
        mutation.requestBody.field_id !== field.id ||
        !("source_record_id" in mutation.requestBody) ||
        mutation.requestBody.source_record_id !== sourceRecordId ||
        !("target_record_id" in mutation.requestBody) ||
        mutation.requestBody.target_record_id !== targetRecordId
      ) {
        throw new Error(
          `Live relationship ${relationship.key} submitted the wrong edge payload`,
        );
      }
      return mutation;
    }

    const mutation = await waitForLiveMutation(
      this.page,
      "PUT",
      `/relationships/fields/${field.id}/sources/${sourceRecordId}`,
      async () => {
        await target.selectOption({ value: targetRecordId });
      },
      this.uiOrigin,
    );
    if (
      typeof mutation.requestBody !== "object" ||
      mutation.requestBody === null ||
      !("target_record_id" in mutation.requestBody) ||
      mutation.requestBody.target_record_id !== targetRecordId
    ) {
      throw new Error(
        `Live relationship ${relationship.key} submitted the wrong assignment payload`,
      );
    }
    return mutation;
  }
}
