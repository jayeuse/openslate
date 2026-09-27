import { expect, test, type Page } from "@playwright/test";
import { sandboxDocumentFromDesign } from "../helpers/sandbox-fixtures";
import { initialDesign } from "../../src/components/systems/sandbox/domain/model";

const userId = "00000000-0000-4000-8000-000000000301";
const moduleId = "00000000-0000-4000-8000-000000000302";
const departmentId = "00000000-0000-4000-8000-000000000303";

type DataSources = "none" | "some" | "unavailable";

async function signInWith(
  page: Page,
  dataSources: DataSources,
  setupRequired = false,
  sandboxAccess = true,
) {
  const dataSourceRequests: string[] = [];
  const sandboxProbes: string[] = [];
  await page.route("**/api/auth/login", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        setup_required: setupRequired,
      }),
    }),
  );
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user_id: userId,
        setup_required: setupRequired,
      }),
    }),
  );
  await page.route("**/api/views/data-sources?**", (route) => {
    dataSourceRequests.push(new URL(route.request().url()).search);
    if (dataSources === "unavailable")
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Catalog unavailable." }),
      });
    const items =
      dataSources === "some"
        ? [{ id: moduleId, name: "Equipment", department_id: departmentId }]
        : [];
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items,
        pagination: {
          limit: 1,
          offset: 0,
          count: items.length,
          total: items.length,
          has_more: false,
        },
      }),
    });
  });

  // The start check asks for one Test run, which needs the same access as
  // the Sandbox document without downloading it.
  await page.route("**/api/sandbox/tests?**", (route) => {
    sandboxProbes.push(new URL(route.request().url()).search);
    return route.fulfill(
      sandboxAccess
        ? {
            contentType: "application/json",
            body: JSON.stringify({ items: [] }),
          }
        : {
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({ detail: "Forbidden" }),
          },
    );
  });
  // The Sandbox page itself loads the document after navigation.
  const document = sandboxDocumentFromDesign(initialDesign);
  await page.route("**/api/sandbox/document", (route) =>
    route.fulfill(
      sandboxAccess
        ? {
            contentType: "application/json",
            body: JSON.stringify({
              document,
              revision: 1,
              contentHash: "a".repeat(64),
              byteCount: JSON.stringify(document).length,
              issues: [],
              latestPublishedVersion: null,
              publishedHash: null,
              hasUnpublishedChanges: true,
            }),
          }
        : {
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({ detail: "Forbidden" }),
          },
    ),
  );
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  return { dataSourceRequests, sandboxProbes };
}

test("a first sign-in with nothing published opens the Sandbox", async ({
  page,
}) => {
  const { dataSourceRequests, sandboxProbes } = await signInWith(page, "none");
  await expect(page).toHaveURL(/\/sandbox$/);
  expect(dataSourceRequests[0]).toContain("limit=1");
  expect(sandboxProbes[0]).toContain("limit=1");
});

test("a first sign-in without Sandbox access opens OpenView", async ({
  page,
}) => {
  await signInWith(page, "none", false, false);
  await expect(page).toHaveURL(/\/openview$/);
});

test("a sign-in with published modules opens OpenView", async ({ page }) => {
  await signInWith(page, "some");
  await expect(page).toHaveURL(/\/openview$/);
});

test("a sign-in opens OpenView when the catalog check fails", async ({
  page,
}) => {
  await signInWith(page, "unavailable");
  await expect(page).toHaveURL(/\/openview$/);
});

test("a sign-in that needs account setup explains it and skips the catalog check", async ({
  page,
}) => {
  const { dataSourceRequests } = await signInWith(page, "none", true);
  await expect(
    page.getByText("Finish setup using the link in your invitation email."),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  expect(dataSourceRequests).toEqual([]);
});
