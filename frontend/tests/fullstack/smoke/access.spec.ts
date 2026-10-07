import { asRole, expect, openWorkspace, test } from "./smoke-fixture";

asRole("admin");

test("Access people finds a seeded person and opens their details @access", async ({
  page,
}) => {
  await openWorkspace(page, "/access?view=people");
  await page
    .getByRole("searchbox", { name: "Search people" })
    .fill("Ana Castillo");
  await page.getByRole("button", { name: /^Ana Castillo/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Service Triage");
});

test("Access groups opens a group with access in two departments @access", async ({
  page,
}) => {
  await openWorkspace(page, "/access?view=groups");
  await page.getByRole("button", { name: "Finance Review" }).click();
  const group = page.getByRole("dialog");
  await group.getByRole("tab", { name: "Access" }).click();
  await expect(group).toContainText("Finance");
  await expect(group).toContainText("Sales");
});

test("Access Security lists the seeded people's sessions @access", async ({
  page,
}) => {
  await openWorkspace(page, "/access?view=security");
  await page
    .getByRole("searchbox", { name: "Search sessions" })
    .fill("Ana Castillo");
  await expect(
    page.getByRole("button", { name: "End session for Ana Castillo" }).first(),
  ).toBeVisible();
});
