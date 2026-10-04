import { asRole, expect, openWorkspace, test } from "./smoke-fixture";

test.describe("as a service clerk", () => {
  asRole("member");

  test("Platform search finds a seeded record @platform", async ({ page }) => {
    await openWorkspace(page, "/platform?section=search");
    await page
      .getByRole("searchbox", { name: "Search workspace" })
      .fill("Northstar");
    await expect(
      page.getByRole("region", { name: "Records search results" }),
    ).toContainText("Northstar Agri Traders");
  });

  test("Platform account shows the person's sessions @platform", async ({
    page,
  }) => {
    await openWorkspace(page, "/platform?section=account");
    await expect(
      page.getByRole("heading", { name: "Device sessions" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Change password" }),
    ).toBeEnabled();
  });
});

test.describe("as an administrator", () => {
  asRole("admin");

  test("Platform export downloads a module as CSV @platform", async ({
    page,
  }) => {
    await openWorkspace(page, "/platform?section=import-export");
    await page.getByRole("combobox", { name: "Export module" }).selectOption({
      label: "Customers",
    });
    await page.getByRole("button", { name: "Preview export" }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: /Download/ }).click();
    expect((await download).suggestedFilename()).toMatch(/\.csv$/);
  });
});
