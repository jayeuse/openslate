import { expect, test } from "../coverage";
import {
  SOURCE_MODULE_ID,
  TARGET_MODULE_ID,
  primitiveField,
  makeState,
} from "../helpers/relationships-data";
import {
  fulfill,
  requestBody,
  installMocks,
} from "../helpers/relationships-fixtures";

test.describe("relationship UI", () => {
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
});

test("field builder creates configured select and relationship fields before accepting schema", async ({
  page,
}) => {
  const state = makeState();
  const moduleItem = state.modules.find(
    (item) => item.id === SOURCE_MODULE_ID,
  )!;
  moduleItem.is_schema_accepted = false;
  state.fields = [];
  await installMocks(page, state);
  const bodies: unknown[] = [];
  await page.route("**/bff/fields", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = requestBody(route.request());
    bodies.push(body);
    const field = {
      ...primitiveField(
        `cccccccc-cccc-4ccc-8ccc-${String(bodies.length).padStart(12, "0")}`,
        SOURCE_MODULE_ID,
        String(body.name),
        state.fields.length,
      ),
      ...body,
    };
    state.fields.push(field);
    await fulfill(route, 201, field);
  });
  await page.goto(`/modules/${SOURCE_MODULE_ID}/schema`);
  await expect(
    page.getByText("No fields yet. Add the first field using the form."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept Schema" }),
  ).toBeDisabled();
  await page.getByLabel("Field name").fill("Priority");
  await page.getByLabel("Type", { exact: true }).selectOption("select");
  await page.getByLabel("Options", { exact: true }).fill(" Low, , High ");
  await page.getByLabel("Required field").check();
  await page.getByLabel("Redact values in future audit snapshots").check();
  await page.getByRole("button", { name: "Add field", exact: true }).click();
  await expect(
    page.getByText("select · 2 options", { exact: true }),
  ).toBeVisible();
  expect(bodies[0]).toMatchObject({
    name: "Priority",
    type: "select",
    required: true,
    audit_redacted: true,
    position: 0,
    config: { options: ["Low", "High"] },
  });
  await expect(page.getByLabel("Field name")).toHaveValue("");
  await expect(
    page.getByLabel("Redact values in future audit snapshots"),
  ).not.toBeChecked();
  await page.getByLabel("Field name").fill("Assigned owners");
  await page.getByLabel("Type", { exact: true }).selectOption("relationship");
  await expect(page.getByLabel("Required field")).toBeDisabled();
  await expect(page.getByLabel("Required field")).not.toBeChecked();
  await page
    .getByLabel("Target module", { exact: true })
    .selectOption(TARGET_MODULE_ID);
  await page
    .getByRole("group", { name: "Targets per source" })
    .getByLabel("Multiple", { exact: true })
    .check();
  await page
    .getByRole("group", { name: "Sources per target" })
    .getByLabel("Multiple", { exact: true })
    .check();
  await page.getByRole("button", { name: "Add field", exact: true }).click();
  await expect(
    page.getByText("Assigned owners", { exact: true }),
  ).toBeVisible();
  expect(bodies[1]).toMatchObject({
    type: "relationship",
    required: false,
    relationship_target_module_id: TARGET_MODULE_ID,
    relationship_multiple_targets: true,
    relationship_multiple_sources: true,
    position: 1,
  });
  await page.getByRole("button", { name: "Accept Schema" }).click();
  await expect(
    page.getByText("Schema is accepted", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept Schema" }),
  ).toBeDisabled();
});

test("reordering restores server order after rejection and persists a successful retry", async ({
  page,
}) => {
  const state = makeState();
  const first = primitiveField(
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    SOURCE_MODULE_ID,
    "First",
    0,
  );
  const second = primitiveField(
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    SOURCE_MODULE_ID,
    "Second",
    1,
  );
  state.fields = [first, second];
  await installMocks(page, state);
  let reject = true;
  await page.route(
    `**/bff/modules/${SOURCE_MODULE_ID}/fields/reorder`,
    async (route) => {
      expect(requestBody(route.request())).toEqual({
        field_ids: [second.id, first.id],
      });
      if (reject)
        return fulfill(route, 422, { detail: "private validation context" });
      state.fields = [
        { ...second, position: 0 },
        { ...first, position: 1 },
      ];
      await fulfill(route, 200, state.fields);
    },
  );
  await page.goto(`/modules/${SOURCE_MODULE_ID}/schema`);
  await expect(
    page.getByRole("button", { name: "Move First up", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Move Second up", exact: true })
    .click();
  await expect(
    page.getByText("The field order was rejected. Refresh and try again."),
  ).toBeVisible();
  await expect(page.getByText("private validation context")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Move First up", exact: true }),
  ).toBeDisabled();
  reject = false;
  await page
    .getByRole("button", { name: "Move Second up", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Move Second up", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Move First down", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("The field order was rejected. Refresh and try again."),
  ).toHaveCount(0);
});

test("rejected field creation preserves the draft for correction", async ({
  page,
}) => {
  const state = makeState();
  await installMocks(page, state);
  await page.route("**/bff/fields", (route) =>
    fulfill(route, 422, { detail: "private field validation" }),
  );
  await page.goto(`/modules/${SOURCE_MODULE_ID}/schema`);
  await page.getByLabel("Field name").fill("New reference");
  await page.getByRole("button", { name: "Add field", exact: true }).click();
  await expect(
    page.getByText(
      "The field details were rejected. Check the values and try again.",
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Field name")).toHaveValue("New reference");
  await expect(
    page.getByRole("button", { name: "Add field", exact: true }),
  ).toBeEnabled();
  await expect(page.getByText("private field validation")).toHaveCount(0);
});
