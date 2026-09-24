import { expect, test } from "@playwright/test";

const userId = "00000000-0000-4000-8000-000000000001";

test("Platform keeps sample records separate from connected Boards", async ({
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
    page.getByRole("heading", { name: "Connected record actions" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /add record to board|added to board|adding to board|organization board unavailable/i,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText("These sample records can’t be linked to connected Boards."),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Boards" })).toHaveAttribute(
    "href",
    "/boards",
  );
});
