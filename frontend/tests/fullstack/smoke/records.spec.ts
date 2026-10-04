import { asRole, expect, openWorkspace, test } from "./smoke-fixture";

const SITE = "Northstar Agri Traders — Iloilo City processing plant";

test.describe("as a service clerk", () => {
  asRole("member");

  test("OpenView lists Customer Sites and opens a record @records", async ({
    page,
  }) => {
    await openWorkspace(page, "/openview");
    await page.getByRole("combobox", { name: "Data source" }).selectOption({
      label: "Customer Sites",
    });
    await page.getByRole("button", { name: SITE }).click();
    await expect(page.getByRole("heading", { name: SITE })).toBeVisible();
  });

  test("A site's customer link names the other department @records", async ({
    page,
  }) => {
    await openWorkspace(page, "/openview");
    await page.getByRole("combobox", { name: "Data source" }).selectOption({
      label: "Customer Sites",
    });
    await page.getByRole("button", { name: SITE }).click();
    await page.getByRole("tab", { name: "Linked records" }).click();
    await expect(
      page.getByRole("region", { name: "Record details content" }),
    ).toContainText("Sales");
  });

  test("A record edit is saved @records", async ({ page }) => {
    await openWorkspace(page, "/openview");
    await page.getByRole("combobox", { name: "Data source" }).selectOption({
      label: "Customer Sites",
    });
    await page.getByRole("button", { name: SITE }).click();
    await page.getByRole("button", { name: "Edit record" }).click();
    await page.getByLabel("Notes").fill("Gate code changed — smoke check");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(
      page
        .getByRole("region", { name: "Record details content" })
        .getByText("Gate code changed — smoke check"),
    ).toBeVisible();
  });
});

test.describe("as a guest", () => {
  asRole("guest");

  test("A guest reads records but cannot add one @records", async ({
    page,
  }) => {
    await openWorkspace(page, "/openview");
    await expect(page.getByRole("table").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "New record" })).toHaveCount(
      0,
    );
  });
});
