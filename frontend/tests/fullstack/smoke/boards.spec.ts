import { asRole, expect, openWorkspace, test } from "./smoke-fixture";

asRole("manager");

test("A department Board post is written and published @boards", async ({
  page,
}) => {
  const title = `Smoke check: targets ${Date.now()}`;
  await openWorkspace(page, "/boards?section=posts");
  await page.getByRole("button", { name: "Switch board" }).click();
  await page.getByRole("combobox", { name: "Board", exact: true }).click();
  await page.getByRole("option", { name: "Sales" }).click();
  await expect(
    page.getByRole("heading", { name: "Sales", level: 1 }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Posts" })
    .click();
  await page.getByRole("button", { name: /New post/ }).click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("Title").fill(title);
  await editor
    .getByRole("textbox", { name: "Message" })
    .fill("Targets are posted on the shared drive.");
  await editor.getByRole("button", { name: "Save draft" }).click();
  await editor.getByRole("button", { name: /^Publish/ }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
});

test("A Board calendar shows the seeded events @boards", async ({ page }) => {
  await openWorkspace(page, "/boards?section=calendar");
  await page.getByRole("button", { name: "Agenda" }).click();
  await expect(
    page.getByRole("region", { name: "Board calendar" }),
  ).not.toContainText("No events");
});
