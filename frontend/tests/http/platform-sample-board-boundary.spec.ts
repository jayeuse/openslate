import { expect, test } from "@playwright/test";

const userId = "00000000-0000-4000-8000-000000000001";

test("Platform no longer exposes the retired Record actions section", async ({
  page,
}) => {
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user_id: userId,
        setup_required: false,
      }),
    });
  });

  await page.goto("/platform?section=records");

  await expect(
    page.getByRole("searchbox", { name: "Search workspace" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Record actions", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Connected record actions" }),
  ).toHaveCount(0);
});
