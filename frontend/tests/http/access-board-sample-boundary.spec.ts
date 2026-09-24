import { expect, test } from "@playwright/test";

const userId = "00000000-0000-4000-8000-000000000001";

test("Access identifies local Board rules as non-authoritative", async ({
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

  await page.goto("/access?view=rules");
  await expect(
    page.getByRole("heading", { name: "Access", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "This Access workspace is a local preview. Its Board rules and simulator do not control access to connected Boards.",
    ),
  ).toBeVisible();

  await page.goto("/access?view=simulator");
  await expect(
    page.getByText(
      "This Access workspace is a local preview. Its Board rules and simulator do not control access to connected Boards.",
    ),
  ).toBeVisible();
});
