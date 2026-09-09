import { expect, test } from "@playwright/test";
import { SOURCE_MODULE_ID, makeState } from "../helpers/relationships-data";
import { installMocks } from "../helpers/relationships-fixtures";

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
