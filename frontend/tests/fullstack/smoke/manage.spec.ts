import { asRole, expect, openWorkspace, test } from "./smoke-fixture";

asRole("admin");

test("Manage Organization shows the seeded workspace @manage", async ({
  page,
}) => {
  await openWorkspace(page, "/manage?view=organization");
  await expect(
    page.getByRole("heading", { name: "Harbor Operations Group" }),
  ).toBeVisible();
});

test("Manage Audit finds an entry and opens its details @manage", async ({
  page,
}) => {
  await openWorkspace(page, "/manage?view=audit");
  const search = page.getByRole("searchbox", { name: "Search activity" });
  await search.fill("Northstar");
  await search.press("Enter");
  const entry = page.getByRole("row", { name: /Northstar/ }).first();
  await expect(entry).toBeVisible();
  await entry.getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("Northstar");
});

test("Manage Backup shows the queued backup request @manage", async ({
  page,
}) => {
  await openWorkspace(page, "/manage?view=backup");
  await expect(
    page.getByRole("button", {
      name: "Inspect Harbor Operations Group workspace backup",
    }),
  ).toBeVisible();
});
