import { expect, test, type Page } from "./helpers/test";
import { sandboxDocumentFromDesign } from "../helpers/sandbox-fixtures";
import { initialDesign } from "../../src/components/systems/sandbox/domain/model";

const userId = "00000000-0000-4000-8000-000000000301";
const moduleId = "00000000-0000-4000-8000-000000000302";
const departmentId = "00000000-0000-4000-8000-000000000303";

type DataSources = "none" | "some" | "unavailable";

async function installDestination(
  page: Page,
  dataSources: DataSources,
  setupRequired = false,
  sandboxAccess = true,
  authenticated = false,
) {
  let signedIn = authenticated;
  const dataSourceRequests: string[] = [];
  const sandboxProbes: string[] = [];
  await page.route("**/api/auth/login", (route) => {
    signedIn = true;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        setup_required: setupRequired,
      }),
    });
  });
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        signedIn
          ? {
              authenticated: true,
              user_id: userId,
              setup_required: setupRequired,
            }
          : { authenticated: false },
      ),
    }),
  );
  await page.route("**/api/auth/refresh", (route) =>
    route.fulfill({ status: 401, json: { detail: "Unauthenticated" } }),
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
  return { dataSourceRequests, sandboxProbes };
}

async function signInWith(
  page: Page,
  dataSources: DataSources,
  setupRequired = false,
  sandboxAccess = true,
) {
  const requests = await installDestination(
    page,
    dataSources,
    setupRequired,
    sandboxAccess,
  );
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  return requests;
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

const loginFailures = [
  {
    label: "wrong credentials",
    status: 401,
    message: "That email or password is not right.",
  },
  {
    label: "rate limit with a delay rounded up to minutes",
    status: 429,
    retryAfter: "75",
    message: "Too many attempts. Try again in 2 minutes.",
  },
  {
    label: "rate limit without a delay",
    status: 429,
    message: "Too many attempts. Try again later.",
  },
  ...["invalid", "-10", "1.5"].map((retryAfter) => ({
    label: `rate limit with invalid delay ${retryAfter}`,
    status: 429,
    retryAfter,
    message: "Too many attempts. Try again later.",
  })),
  {
    label: "unavailable sign-in",
    status: 503,
    message: "Sign-in is not available now. Try again later.",
  },
  {
    label: "blocked network",
    status: 403,
    code: "ip_not_allowed",
    message:
      "Sign-in from this network is not allowed. Contact your administrator.",
  },
  {
    label: "another forbidden response",
    status: 403,
    code: "other_denial",
    message: "Unable to sign in. Check your connection and try again.",
  },
  {
    label: "network failure",
    status: 0,
    message: "Unable to sign in. Check your connection and try again.",
  },
];

for (const failure of loginFailures) {
  test(`login explains ${failure.label} without exposing account details`, async ({
    page,
  }) => {
    await installDestination(page, "none");
    await page.route("**/api/auth/login", (route) =>
      failure.status === 0
        ? route.abort("failed")
        : route.fulfill({
            status: failure.status,
            headers:
              "retryAfter" in failure && typeof failure.retryAfter === "string"
                ? { "Retry-After": failure.retryAfter }
                : {},
            json: {
              detail: {
                code: "code" in failure ? failure.code : "login_failed",
                message: "Private account detail for owner@example.test",
              },
            },
          }),
    );
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill("owner@example.test");
    await page.getByLabel("Password").fill("correct horse battery");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(
      failure.message,
    );
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
      "owner@example.test",
    );
    await expect(page.getByLabel("Password")).toHaveValue(
      "correct horse battery",
    );
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeEnabled();
    await expect(page).toHaveURL(/\/login$/);
  });
}

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

for (const entry of ["/", "/login"] as const) {
  test(`an authenticated visitor to ${entry} waits for the session and destination with no sign-in flash`, async ({
    page,
  }) => {
    await installDestination(page, "none", false, true, true);
    const session = deferred();
    const destination = deferred();
    const sessionStarted = deferred();
    const destinationStarted = deferred();
    await page.route("**/api/auth/session", async (route) => {
      sessionStarted.release();
      await session.promise;
      await route.fulfill({
        json: { authenticated: true, user_id: userId, setup_required: false },
      });
    });
    await page.route("**/api/sandbox/tests?**", async (route) => {
      destinationStarted.release();
      await destination.promise;
      await route.fulfill({ json: { items: [] } });
    });
    try {
      await page.goto("/setup");
      await page.goto(entry);
      await expect(page.getByRole("main")).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Sign in", exact: true }),
      ).toBeHidden();
      await expect(
        page.getByRole("link", { name: "Open workspace", exact: true }),
      ).toBeHidden();
      await expect(
        page.getByRole("button", { name: "Sign in", exact: true }),
      ).toBeHidden();
      await expect(page.getByLabel("Email", { exact: true })).toBeHidden();
      await sessionStarted.promise;
      session.release();
      await destinationStarted.promise;
      await expect(page).toHaveURL(entry === "/" ? /\/$/ : /\/login$/);
      await expect(
        page.getByRole("link", { name: "Sign in", exact: true }),
      ).toBeHidden();
      await expect(
        page.getByRole("button", { name: "Sign in", exact: true }),
      ).toBeHidden();
      destination.release();
      await expect(page).toHaveURL(/\/sandbox$/);
      await page.goBack();
      await expect(page).toHaveURL(/\/setup$/);
    } finally {
      session.release();
      destination.release();
    }
  });

  for (const state of ["anonymous", "unavailable"] as const) {
    test(`${entry} keeps its public actions after an ${state} session check`, async ({
      page,
    }) => {
      await installDestination(page, "none");
      if (state === "unavailable")
        await page.route("**/api/auth/session", (route) =>
          route.fulfill({ status: 503, json: { detail: "Unavailable" } }),
        );
      await page.goto(entry);
      await expect(page).toHaveURL(entry === "/" ? /\/$/ : /\/login$/);
      if (entry === "/") {
        await expect(
          page.getByRole("link", { name: "Sign in", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("link", { name: "Open workspace", exact: true }),
        ).toBeVisible();
      } else {
        await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Sign in", exact: true }),
        ).toBeEnabled();
      }
    });
  }
}
