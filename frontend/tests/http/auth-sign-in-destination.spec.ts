import { expect, test, type Page } from "@playwright/test";
import { migrateSandboxFileV1 } from "../../src/components/systems/sandbox/domain/document";
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

  // The start check reads the Sandbox; later page loads may too.
  const document = migrateSandboxFileV1({
    kind: "openslate-sandbox",
    schemaVersion: 1,
    design: initialDesign,
  });
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
  await page.getByLabel("Email or username").fill("owner@example.test");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  return dataSourceRequests;
}

test("a first sign-in with nothing published opens the Sandbox", async ({
  page,
}) => {
  const requests = await signInWith(page, "none");
  await expect(page).toHaveURL(/\/sandbox$/);
  expect(requests[0]).toContain("limit=1");
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

test("a sign-in that needs account setup skips the catalog check", async ({
  page,
}) => {
  const requests = await signInWith(page, "none", true);
  await expect(page).toHaveURL(/\/auth\/setup\?temporary=1$/);
  expect(requests).toEqual([]);
});

test("finishing temporary-password setup with nothing published opens the Sandbox", async ({
  page,
}) => {
  await signInWith(page, "none", true);
  await expect(page).toHaveURL(/\/auth\/setup\?temporary=1$/);
  await page.route("**/api/auth/password/change", async (route) => {
    // The completed setup is what later session checks report.
    await page.route("**/api/auth/session", (session) =>
      session.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          authenticated: true,
          user_id: userId,
          setup_required: false,
        }),
      }),
    );
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ authenticated: true, setup_required: false }),
    });
  });

  await page.getByLabel("Temporary password").fill("temporary horse battery");
  await page
    .getByLabel("Password", { exact: true })
    .fill("a new horse battery staple");
  await page.getByLabel("Confirm password").fill("a new horse battery staple");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/sandbox$/);
});
