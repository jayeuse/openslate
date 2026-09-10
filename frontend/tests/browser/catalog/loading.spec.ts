import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";
import { expect, test } from "@playwright/test";

test("retries an initial department detail error before rendering empty and mutation states", async ({
  page,
}) => {
  const departmentId = "11111111-1111-4111-8111-111111111111";
  const departmentName = "Operations";
  let departmentAttempts = 0;
  let allowDepartmentSuccess = false;
  const listResponse = {
    items: [],
    pagination: {
      limit: 100,
      offset: 0,
      count: 0,
      total: 0,
      has_more: false,
    },
  };

  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.route("**/bff/**", async (route) => {
    if (await fulfillWorkspaceRequest(route)) return;
    const path = new URL(route.request().url()).pathname.replace(/^\/bff/, "");
    if (path === `/departments/${departmentId}`) {
      departmentAttempts += 1;
      if (!allowDepartmentSuccess) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            detail: "Department is temporarily unavailable",
          }),
        });
        return;
      }
      await route.fulfill({
        json: {
          id: departmentId,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          deleted_at: null,
          is_deleted: false,
          performed_by: null,
          department_name: departmentName,
        },
      });
      return;
    }
    if (path === "/modules") {
      await route.fulfill({ json: listResponse });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: "Not found" } });
  });

  await page.goto(`/departments/${departmentId}`);
  await expect(page.getByRole("status")).toContainText(
    "Department is temporarily unavailable",
  );
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
  await expect(page.getByText("No modules yet", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByLabel("Module name", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create module", exact: true }),
  ).toHaveCount(0);

  allowDepartmentSuccess = true;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: departmentName, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No modules yet. Use the form to create the first one.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Module name", { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Department is temporarily unavailable" }),
  ).toHaveCount(0);
  expect(departmentAttempts).toBeGreaterThanOrEqual(2);
});
