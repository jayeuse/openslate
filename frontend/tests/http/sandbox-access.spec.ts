import { expect, signedInAs, test } from "./helpers/test";

// The Sandbox belongs to administrators: every Sandbox API refuses anyone
// else, so another account sees one calm notice and a way back, never a
// Retry that sends the same refused requests again.

test("a member who follows a Sandbox link sees that it is not available, with a way back and no Retry", async ({
  page,
}) => {
  await signedInAs(page, {
    id: "00000000-0000-4000-8000-000000000201",
    role: "member",
  });
  // The identity already says this account is not an administrator, so
  // the page sends no Sandbox request to be refused (S25).
  const sandboxRequests: string[] = [];
  await page.route("**/api/sandbox/**", (route) => {
    sandboxRequests.push(route.request().url());
    return route.fulfill({ status: 403, json: { detail: "Forbidden" } });
  });
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto("/sandbox?section=triggers");

  await expect(
    page.getByRole("heading", { level: 1, name: "Sandbox", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Sandbox is not available to your account.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("main").getByRole("link", { name: "Go to Boards" }),
  ).toHaveAttribute("href", "/boards?section=overview");
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .locator('a[href^="/sandbox"]'),
  ).toHaveCount(0);
  expect(sandboxRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("an administrator whose Sandbox read fails on the server keeps Retry and sees no access notice", async ({
  page,
}) => {
  await signedInAs(page, {
    id: "00000000-0000-4000-8000-000000000202",
    role: "admin",
  });
  await page.route("**/api/sandbox/**", (route) =>
    route.fulfill({ status: 500, json: { detail: "Server error" } }),
  );
  await page.goto("/sandbox?section=build");

  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(
    page.getByText("Sandbox is not available to your account.", {
      exact: true,
    }),
  ).toHaveCount(0);
});
