import { expect, test } from "../coverage";
import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";

test.beforeEach(async ({ page }) => {
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: { detail: "Unavailable" } }),
  );
  await page.route("**/bff/**", async (route) => {
    if (!(await fulfillWorkspaceRequest(route)))
      await route.fulfill({ json: { items: [], has_more: false } });
  });
});

test("the security deep link manages structured sessions without ending the current session", async ({
  page,
}) => {
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (/\/bff\/|\/session\//.test(request.url()) && request.method() !== "GET")
      mutations.push(request.url());
  });

  await page.goto("/manage?view=security");

  await expect(
    page.getByRole("heading", { name: "Security policies" }),
  ).toBeVisible();
  await expect(
    page.getByText("Current session", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "End session · Mara", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "End session · Eli", exact: true }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "End session · Eli", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm end sample session", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "End session · Eli", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Mara · Desktop", { exact: false }),
  ).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Security policies" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "End session · Eli", exact: true }),
  ).toHaveCount(0);
  expect(mutations).toEqual([]);

  await page.goto("/manage?view=credentials");
  await expect(
    page.getByRole("heading", { name: "Organization", exact: true }),
  ).toBeVisible();
});
