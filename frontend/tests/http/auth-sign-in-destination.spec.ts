import { expect, heldResponse, test, type Page } from "./helpers/test";
import { sandboxDocumentFromDesign } from "../helpers/sandbox-fixtures";
import { initialDesign } from "../../src/components/systems/sandbox/domain/model";
import { regionalDefaults } from "./helpers/profile-api";

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
  const identity = {
    id: userId,
    role: "admin" as "admin" | "member" | "guest",
    access: [] as {
      department_id: string;
      module_id: string | null;
      level: "manage";
    }[],
  };
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: identity }),
  );
  const dataSourceRequests: string[] = [];
  const sandboxProbes: string[] = [];
  const loginRequests: unknown[] = [];
  await page.route("**/api/auth/login", (route) => {
    signedIn = true;
    loginRequests.push(route.request().postDataJSON());
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
              user_id: identity.id,
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
  return { dataSourceRequests, sandboxProbes, loginRequests, identity };
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
  const { dataSourceRequests, sandboxProbes, loginRequests } = await signInWith(
    page,
    "none",
  );
  await expect(page).toHaveURL(/\/sandbox$/);
  expect(dataSourceRequests[0]).toContain("limit=1");
  expect(sandboxProbes[0]).toContain("limit=1");
  // The form posts the Email and Password fields and nothing else.
  expect(loginRequests).toEqual([
    { email: "owner@example.test", password: "correct horse battery" },
  ]);
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

// The other preferred landings, the member manager's Groups landing and the
// hidden and off-site fallbacks are rows of tests/isolated/auth/workspace-start.spec.ts.
test("preferred landing sandbox opens an admitted route without rewriting preferences", async ({
  page,
}) => {
  const fixture = await installDestination(page, "some", false, true, true);
  let writes = 0;
  await page.route("**/api/users/*/preferences", (route) => {
    if (route.request().method() !== "GET") writes += 1;
    return route.fulfill({
      json: {
        user_id: fixture.identity.id,
        theme: "light",
        appearance: {
          motion: "system",
          keyboard_shortcuts: true,
          ...regionalDefaults,
          start_page: "sandbox",
        },
      },
    });
  });
  await page.goto("/login");
  await expect(page).toHaveURL(/\/sandbox$/);
  expect(writes).toBe(0);
  // The start check reads one Test run; the Sandbox page then loads its own list.
  expect(
    fixture.sandboxProbes.filter((query) => query.startsWith("?limit=1&")),
  ).toHaveLength(1);
});

for (const failure of [
  "sandbox-denied",
  "preference-unavailable",
  "wrong-owner",
] as const) {
  test(`preferred landing ${failure} falls back without deleting the stored choice`, async ({
    page,
  }) => {
    const fixture = await installDestination(page, "some", false, false, true);
    fixture.identity.role = "member";
    const preference = failure === "sandbox-denied" ? "sandbox" : "access";
    let writes = 0;
    await page.route("**/api/users/*/preferences", (route) => {
      if (route.request().method() !== "GET") writes += 1;
      return route.fulfill({
        status: failure === "preference-unavailable" ? 503 : 200,
        json: {
          user_id: failure === "wrong-owner" ? departmentId : userId,
          theme: "light",
          appearance: {
            motion: "system",
            keyboard_shortcuts: true,
            ...regionalDefaults,
            start_page: preference,
          },
        },
      });
    });
    await page.goto("/login");
    await expect(page).toHaveURL(/\/openview$/);
    expect(writes).toBe(0);
  });
}

test("preferred landing refuses a held prior-account response against a fresh identity", async ({
  page,
}) => {
  const fixture = await installDestination(page, "some", false, false, true);
  const preference = heldResponse();
  await page.route("**/api/users/*/preferences", async (route) => {
    const owner = new URL(route.request().url()).pathname.split("/")[3];
    if (owner === userId) {
      preference.enter();
      await preference.released;
    }
    await route
      .fulfill({
        json: {
          user_id: owner,
          theme: "light",
          appearance: {
            motion: "system",
            keyboard_shortcuts: true,
            ...regionalDefaults,
            start_page: owner === userId ? "platform" : "automatic",
          },
        },
      })
      .catch(() => {});
  });
  try {
    await page.goto("/login");
    await preference.entered;
    fixture.identity.id = departmentId;
    preference.release();
    await expect(page).toHaveURL(/\/openview$/);
  } finally {
    preference.release();
  }
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

for (const entry of ["/", "/login"] as const) {
  test(`an authenticated visitor to ${entry} waits for the session and destination with no sign-in flash`, async ({
    page,
  }) => {
    await installDestination(page, "none", false, true, true);
    const session = heldResponse();
    const destination = heldResponse();
    await page.route("**/api/auth/session", async (route) => {
      session.enter();
      await session.released;
      await route.fulfill({
        json: { authenticated: true, user_id: userId, setup_required: false },
      });
    });
    await page.route("**/api/sandbox/tests?**", async (route) => {
      destination.enter();
      await destination.released;
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
      await session.entered;
      session.release();
      await destination.entered;
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
