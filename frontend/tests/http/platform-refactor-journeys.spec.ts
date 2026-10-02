import { expect, test } from "./helpers/test";

test("Platform preserves search-to-file navigation across sections and reload", async ({
  page,
}) => {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user_id: "00000000-0000-4000-8000-000000000101",
        setup_required: false,
      },
    }),
  );
  await page.goto("/platform?section=search");
  await page
    .getByRole("searchbox", { name: "Search workspace" })
    .fill("Inspection checklist");
  await page
    .getByRole("button", { name: "Inspection checklist.pdf", exact: true })
    .click();
  await expect(page).toHaveURL(/section=files/);
  await expect(page).toHaveURL(/file=sample-file-checklist/);
  await expect(
    page.getByRole("link", { name: "Replace pump seal", exact: true }),
  ).toHaveAttribute("href", "/openview?record=sample-sr-1004");
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await expect(page).not.toHaveURL(/file=/);
  await page.reload();
  await expect(
    page.getByRole("searchbox", { name: "Search files by name" }),
  ).toBeVisible();
});
