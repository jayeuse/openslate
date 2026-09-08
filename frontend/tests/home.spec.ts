import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";

test("shows the operational entry point", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Make the next action obvious",
  );
  await expect(
    page.getByRole("link", { name: /Open workspace/ }),
  ).toHaveAttribute("href", "/login");
  await expect(
    page.getByRole("link", { name: /First deployment/ }),
  ).toHaveAttribute("href", "/setup");
});

test("has no serious accessibility violations", async ({ page }) => {
  await page.goto("/");
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("explains the external first administrator prerequisite", async ({
  page,
}) => {
  await page.goto("/setup");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Provision the administrator",
  );
  await expect(
    page.getByText("This is a deployment prerequisite"),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Continue to sign in/ }),
  ).toHaveAttribute("href", "/login");
});

test("renders the login form with deployment guidance", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 2 })).toContainText(
    "Welcome back",
  );
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Read the setup guide/ }),
  ).toBeVisible();
});

test("shows a safe error when sign in is rejected", async ({ page }) => {
  await page.route("**/*session/login*", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Invalid email or password" }),
    });
  });

  await page.goto("/login");
  await page.getByLabel("Email").fill("person@example.com");
  await page.getByLabel("Password").fill("a-password-long-enough");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("status")).toContainText(
    "Invalid email or password",
  );
  await expect(page).not.toHaveURL(/workspace/);
});

test("renders the invited-account password setup form", async ({ page }) => {
  await page.goto("/auth/setup");

  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Set your password",
  );
  await expect(
    page.getByRole("textbox", { name: "Password", exact: true }),
  ).toHaveAttribute("minlength", "12");
  await expect(page.getByLabel("Confirm password")).toHaveAttribute(
    "minlength",
    "12",
  );
  await expect(
    page.getByText("Finish setting up your invited OpenSlate account."),
  ).toBeVisible();
});

test("rejects mismatched invited-account passwords before sending a request", async ({
  page,
}) => {
  let passwordRequests = 0;
  await page.route("**/session/password", async (route) => {
    passwordRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ authenticated: true }),
    });
  });
  await page.route("**/session/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ authenticated: true }),
    });
  });

  await page.goto("/auth/setup");
  await page
    .getByLabel("Password", { exact: true })
    .fill("a-password-long-enough");
  await page.getByLabel("Confirm password").fill("a-different-password");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(
    page.getByText("Passwords must match.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Confirm password")).toBeFocused();
  await expect(page.getByLabel("Confirm password")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  expect(passwordRequests).toBe(0);
  await expect(page).toHaveURL(/\/auth\/setup$/);

  await page.getByLabel("Confirm password").fill("a-password-long-enough");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("**/workspace");
  expect(passwordRequests).toBe(1);
});

test("completes invited account setup after password acceptance", async ({
  page,
}) => {
  const passwordRequests: string[] = [];
  await page.route("**/session/password", async (route) => {
    passwordRequests.push(route.request().postData() ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ authenticated: true }),
    });
  });
  await page.route("**/session/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ authenticated: true }),
    });
  });

  await page.goto("/auth/setup");
  await page
    .getByLabel("Password", { exact: true })
    .fill("a-password-long-enough");
  await page.getByLabel("Confirm password").fill("a-password-long-enough");
  await page.getByRole("button", { name: "Continue" }).click();

  await page.waitForURL("**/workspace");
  await expect(
    page.getByRole("heading", { name: /Good morning/ }),
  ).toBeVisible();
  expect(passwordRequests).toEqual([
    JSON.stringify({
      password: "a-password-long-enough",
      confirmation: "a-password-long-enough",
    }),
  ]);
});

test("shows a safe recoverable error when invitation acceptance fails", async ({
  page,
}) => {
  await page.route("**/session/password", async (route) => {
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ detail: "upstream invitation details" }),
    });
  });

  await page.goto("/auth/setup");
  await page
    .getByLabel("Password", { exact: true })
    .fill("a-password-long-enough");
  await page.getByLabel("Confirm password").fill("a-password-long-enough");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("status")).toContainText(
    "We could not set up your password. The invitation may have expired.",
  );
  await expect(page.getByRole("status")).not.toContainText(
    "upstream invitation details",
  );
  await expect(page).toHaveURL(/\/auth\/setup$/);
});

test("rejects password setup when the session or token is missing", async ({
  page,
}) => {
  await page.goto("/auth/setup");
  const result = await page.evaluate(async () => {
    const response = await fetch("/session/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        password: "a-password-long-enough",
        confirmation: "a-password-long-enough",
      }),
    });
    return {
      status: response.status,
      body: await response.json(),
    };
  });

  expect(result).toEqual({
    status: 401,
    body: { detail: "Authentication required" },
  });
});

test("allows a failed invitation acceptance to be retried safely", async ({
  page,
}) => {
  const passwordRequests: string[] = [];
  await page.route("**/session/password", async (route) => {
    passwordRequests.push(route.request().postData() ?? "");
    const attempt = passwordRequests.length;
    await route.fulfill({
      status: attempt === 1 ? 400 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        attempt === 1
          ? { detail: "Invitation cannot be accepted" }
          : { authenticated: true },
      ),
    });
  });
  await page.route("**/session/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ authenticated: true }),
    });
  });

  await page.goto("/auth/setup");
  await page
    .getByLabel("Password", { exact: true })
    .fill("a-password-long-enough");
  await page.getByLabel("Confirm password").fill("a-password-long-enough");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("status")).toContainText(
    "We could not set up your password",
  );

  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("**/workspace");

  expect(passwordRequests).toHaveLength(2);
  expect(passwordRequests[1]).toBe(passwordRequests[0]);
});

test("keeps navigation structures in Appearance and preserves the shell routes", async ({
  page,
  isMobile,
}) => {
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: { detail: "Authentication required" } }),
  );
  await page.route("**/bff/**", (route) =>
    route.fulfill({
      json: {
        items: [],
        pagination: {
          limit: 100,
          offset: 0,
          count: 0,
          total: 0,
          has_more: false,
        },
      },
    }),
  );
  await page.goto("/workspace");
  if (isMobile)
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  const navigation = page
    .getByRole("navigation", { name: "Main navigation" })
    .filter({ visible: true });
  await expect(
    navigation.getByRole("combobox", { name: "Navigation structure" }),
  ).toHaveCount(0);
  await expect(
    navigation.getByRole("link", { name: "Workspace overview", exact: true }),
  ).toHaveCount(0);
  await expect(
    navigation.getByRole("link", { name: "Workspace", exact: true }),
  ).toHaveCount(0);
  for (const name of [
    "Sandbox",
    "Boards",
    "OpenComms",
    "Access",
    "OpenView",
    "Manage",
  ]) {
    await expect(navigation.getByText(name, { exact: true })).toBeVisible();
  }
  await navigation.getByText("Boards", { exact: true }).click();
  for (const name of [
    "Organization",
    "Departments",
    "Calendars",
    "Announcements",
    "Embedded Views",
  ]) {
    await expect(
      navigation.getByRole("button", {
        name: `${name} Future feature`,
        exact: true,
      }),
    ).toBeDisabled();
  }
  await navigation.getByText("OpenComms", { exact: true }).click();
  for (const name of ["Channels", "Direct Messages", "Threads"]) {
    await expect(
      navigation.getByRole("button", {
        name: `${name} Future feature`,
        exact: true,
      }),
    ).toBeDisabled();
  }
  await navigation.getByText("OpenView", { exact: true }).click();
  for (const name of ["Views", "Dashboards", "Charts", "Reports"]) {
    await expect(
      navigation.getByRole("button", { name: `${name} Planned`, exact: true }),
    ).toBeDisabled();
  }
  await navigation.getByText("Manage", { exact: true }).click();
  await expect(
    navigation.getByRole("link", { name: "Organization", exact: true }),
  ).toHaveAttribute("href", "/departments");
  await expect(
    navigation.getByRole("link", { name: "Audit", exact: true }),
  ).toHaveAttribute("href", "/administration/audit");
  for (const name of ["Security", "Backup", "Updates", "Licensing"]) {
    await expect(
      navigation.getByRole("button", { name: `${name} Planned`, exact: true }),
    ).toBeDisabled();
  }
  await navigation.getByText("Access", { exact: true }).click();
  await navigation.getByRole("link", { name: "Users", exact: true }).click();
  await expect(page).toHaveURL(/\/administration\/users$/);
  if (isMobile)
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  await expect(
    navigation.getByRole("link", { name: "Users", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page
    .getByRole("button", { name: "Appearance", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page).toHaveURL(/\/settings\/appearance$/);
  const structure = page.getByRole("combobox", {
    name: "Navigation structure",
    exact: true,
  });
  await expect(structure).toHaveValue("structured");
  await expect(structure.getByRole("option")).toHaveText([
    "OpenSlate",
    "Classic",
  ]);
  await structure.selectOption("classic");
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("openslate:invalidation")),
  );
  await expect(structure).toHaveValue("classic");
  if (isMobile)
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  const workspaceLogo = isMobile
    ? page.locator("#mobile-navigation a[href='/workspace']").first()
    : page
        .getByRole("link", { name: "OpenSlate workspace", exact: true })
        .filter({ visible: true });
  await workspaceLogo.click();
  await expect(page).toHaveURL(/\/workspace$/);
  if (isMobile)
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  for (const name of [
    "Departments",
    "Sandbox",
    "People",
    "Roles",
    "Audit trail",
  ]) {
    await expect(
      navigation.getByRole("link", { name, exact: true }),
    ).toBeVisible();
  }
  await expect(
    navigation.getByRole("link", { name: "Workspace", exact: true }),
  ).toHaveCount(0);
  await navigation
    .getByRole("link", { name: "Departments", exact: true })
    .click();
  await expect(page).toHaveURL(/\/departments$/);
  if (isMobile)
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  await page
    .getByRole("button", { name: "Appearance", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page).toHaveURL(/\/settings\/appearance$/);
  await expect(structure).toHaveValue("classic");
  await structure.selectOption("structured");
  if (isMobile)
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  const structuredWorkspaceLogo = isMobile
    ? page.locator("#mobile-navigation a[href='/workspace']").first()
    : page
        .getByRole("link", { name: "OpenSlate workspace", exact: true })
        .filter({ visible: true });
  await structuredWorkspaceLogo.click();
  await expect(page).toHaveURL(/\/workspace$/);
  if (isMobile)
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  await navigation.getByText("Sandbox", { exact: true }).click();
  for (const name of ["Simulation", "Preview", "Publish"]) {
    await expect(
      navigation.getByRole("button", { name: `${name} Planned`, exact: true }),
    ).toBeDisabled();
  }
  for (const name of ["Relationships", "Automation"]) {
    await expect(
      navigation.getByRole("link", {
        name: `${name} In designer`,
        exact: true,
      }),
    ).toHaveAttribute("href", "/sandbox");
  }

  await navigation
    .getByRole("link", { name: "Organization Designer", exact: true })
    .click();
  await expect(page).toHaveURL(/\/sandbox$/);
  await expect(
    page.getByRole("heading", { name: "Sandbox", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Sandbox canvas", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Sandbox progress" }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Back to workspace" }).click();
  await expect(page).toHaveURL(/\/workspace$/);
});

test("renders nested breadcrumbs with a current page and one page heading", async ({
  page,
  isMobile,
}) => {
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.goto("/departments/new");

  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(breadcrumb).toBeVisible();
  await expect(
    breadcrumb.getByRole("link", { name: "OpenSlate", exact: true }),
  ).toHaveAttribute("href", "/workspace");
  await expect(
    breadcrumb.getByRole("link", { name: "Departments", exact: true }),
  ).toHaveAttribute("href", "/departments");
  await expect(
    breadcrumb.getByText("New department", { exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { level: 1, name: "Create a department" }),
  ).toBeVisible();
  await expect(page.locator("header").getByRole("heading")).toHaveCount(0);

  if (isMobile) {
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
    await expect(
      breadcrumb.getByText("New department", { exact: true }),
    ).toBeVisible();
  }
});

test("keeps a long current breadcrumb usable on a narrow viewport", async ({
  page,
}) => {
  const departmentId = "11111111-1111-4111-8111-111111111111";
  const departmentName = "Operations and inventory coordination";
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.route("**/bff/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith(`/departments/${departmentId}`)) {
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
    await route.fulfill({
      json: {
        items: [],
        pagination: {
          limit: 100,
          offset: 0,
          count: 0,
          total: 0,
          has_more: false,
        },
      },
    });
  });
  await page.goto(`/departments/${departmentId}`);

  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  const current = breadcrumb.getByText(departmentName, { exact: true });
  await expect(current).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { level: 1, name: departmentName }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
});

test("retries an initial department detail error before rendering empty and mutation states", async ({
  page,
}) => {
  const departmentId = "11111111-1111-4111-8111-111111111111";
  const departmentName = "Operations";
  let departmentAttempts = 0;
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
    const path = new URL(route.request().url()).pathname.replace(/^\/bff/, "");
    if (path === `/departments/${departmentId}`) {
      departmentAttempts += 1;
      if (departmentAttempts === 1) {
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
  expect(departmentAttempts).toBe(2);
});

test("retries an initial module detail error before rendering schema and record actions", async ({
  page,
}) => {
  const departmentId = "11111111-1111-4111-8111-111111111111";
  const moduleId = "22222222-2222-4222-8222-222222222222";
  const moduleName = "Assets";
  let moduleAttempts = 0;
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
    const path = new URL(route.request().url()).pathname.replace(/^\/bff/, "");
    if (path === `/modules/${moduleId}`) {
      moduleAttempts += 1;
      if (moduleAttempts === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Module is temporarily unavailable" }),
        });
        return;
      }
      await route.fulfill({
        json: {
          id: moduleId,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          deleted_at: null,
          is_deleted: false,
          performed_by: null,
          department_id: departmentId,
          module_name: moduleName,
          is_schema_accepted: true,
        },
      });
      return;
    }
    if (path === `/departments/${departmentId}`) {
      await route.fulfill({
        json: {
          id: departmentId,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          deleted_at: null,
          is_deleted: false,
          performed_by: null,
          department_name: "Operations",
        },
      });
      return;
    }
    if (path === "/fields") {
      await route.fulfill({ json: listResponse });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: "Not found" } });
  });

  await page.goto(`/modules/${moduleId}`);
  await expect(page.getByRole("status")).toContainText(
    "Module is temporarily unavailable",
  );
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
  await expect(page.getByText("Module schema", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Open records", exact: true }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: moduleName, exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Module schema", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open records", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Module is temporarily unavailable" }),
  ).toHaveCount(0);
  expect(moduleAttempts).toBe(2);
});

test("navigates from Sandbox to Appearance on desktop and mobile", async ({
  page,
  isMobile,
}) => {
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.goto("/sandbox");
  if (isMobile) {
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  }
  await page
    .getByRole("button", { name: "Appearance", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page).toHaveURL(/\/settings\/appearance$/);
  await expect(
    page.getByRole("heading", { name: "Appearance", exact: true }),
  ).toBeVisible();
});

test("supports Account menu keyboard dismissal, outside click, and logout", async ({
  page,
  isMobile,
}) => {
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  let logoutMethod = "";
  await page.route("**/session/logout", async (route) => {
    logoutMethod = route.request().method();
    await route.fulfill({ json: { authenticated: false } });
  });
  await page.goto("/workspace");

  let account: Locator;
  if (isMobile) {
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    account = page
      .locator("#mobile-navigation")
      .getByRole("button", { name: "Account", exact: true });
  } else {
    account = page
      .getByRole("complementary", { name: "Primary sidebar" })
      .getByRole("button", { name: "Account", exact: true });
  }
  const menu = page.getByRole("menu", { name: "Account", exact: true });
  await account.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Sign out", exact: true }),
  ).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(account).toBeFocused();

  await account.click();
  await expect(menu).toBeVisible();
  if (!isMobile) {
    await page.mouse.click(800, 200);
    await expect(menu).toHaveCount(0);
  } else {
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }

  await account.click();
  await menu.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(logoutMethod).toBe("POST");
});

test("persists navigation preferences, resizes only when expanded, and preserves collapsed groups", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.goto("/workspace");
  const sidebar = page.getByRole("complementary", { name: "Primary sidebar" });
  const sidebarWidth = async () => (await sidebar.boundingBox())?.width;
  const sidebarGap = page.locator('[data-slot="sidebar-gap"]');
  await expect.poll(sidebarWidth).toBe(256);
  await expect(
    sidebar.getByRole("button", { name: "Collapse sidebar", exact: true }),
  ).toHaveCount(1);
  await expect(
    sidebar.getByRole("button", { name: "Expand sidebar", exact: true }),
  ).toHaveCount(0);
  const appearance = sidebar.getByRole("button", {
    name: "Appearance",
    exact: true,
  });
  const collapse = sidebar.getByRole("button", {
    name: "Collapse sidebar",
    exact: true,
  });
  const collapseBox = await collapse.boundingBox();
  const appearanceBox = await appearance.boundingBox();
  if (collapseBox === null || appearanceBox === null) {
    throw new Error("Sidebar footer controls have no bounds");
  }
  expect(collapseBox.y).toBeLessThan(appearanceBox.y);

  await appearance.click();
  await expect(page).toHaveURL(/\/settings\/appearance$/);
  const structure = page.getByRole("combobox", {
    name: "Navigation structure",
    exact: true,
  });
  await structure.selectOption("classic");
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("openslate:invalidation")),
  );
  await expect(structure).toHaveValue("classic");
  await page.reload();
  await expect(structure).toHaveValue("classic");
  await page.getByRole("link", { name: "OpenSlate workspace" }).click();
  await expect(page).toHaveURL(/\/workspace$/);

  await expect.poll(sidebarWidth).toBe(256);
  const separator = sidebar.getByRole("separator", {
    name: "Resize sidebar",
    exact: true,
  });
  await expect(separator).toBeVisible();
  await expect(separator).toHaveCSS("touch-action", "none");

  const transitionMs = async (locator: Locator) =>
    locator.evaluate((element) => {
      const styles = getComputedStyle(element);
      if (styles.transitionProperty.trim() === "none") return 0;
      const value = styles.transitionDuration.split(",")[0]?.trim();
      if (!value) return 0;
      const amount = Number.parseFloat(value);
      return value.endsWith("ms") ? amount : amount * 1000;
    });
  await expect.poll(() => transitionMs(sidebar)).toBeCloseTo(180, 0);
  await expect.poll(() => transitionMs(sidebarGap)).toBeCloseTo(180, 0);

  await separator.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(sidebarWidth).toBe(272);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(sidebarWidth).toBe(256);
  await page.keyboard.press("End");
  await expect.poll(sidebarWidth).toBe(400);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.localStorage.getItem("openslate-sidebar-width"),
      ),
    )
    .toBe("400");
  await separator.dblclick();
  await expect.poll(sidebarWidth).toBe(256);
  await page.keyboard.press("ArrowRight");
  await expect.poll(sidebarWidth).toBe(272);
  await page.keyboard.press("Home");
  await expect.poll(sidebarWidth).toBe(256);

  const separatorBox = await separator.boundingBox();
  if (separatorBox === null) throw new Error("Resize separator has no bounds");
  await page.mouse.move(
    separatorBox.x + separatorBox.width / 2,
    separatorBox.y + separatorBox.height / 2,
  );
  await page.mouse.down();
  await expect.poll(() => transitionMs(sidebar)).toBe(0);
  await expect.poll(() => transitionMs(sidebarGap)).toBe(0);
  await page.mouse.move(
    separatorBox.x + separatorBox.width / 2 + 500,
    separatorBox.y + separatorBox.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect.poll(sidebarWidth).toBe(400);

  let resizedWidth = 400;
  if (testInfo.project.name.includes("chromium")) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 1,
    });
    const touchBox = await separator.boundingBox();
    if (touchBox === null) throw new Error("Touch separator has no bounds");
    const touchX = touchBox.x + touchBox.width / 2;
    const touchY = touchBox.y + touchBox.height / 2;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ id: 1, x: touchX, y: touchY, radiusX: 1, radiusY: 1 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { id: 1, x: touchX - 64, y: touchY, radiusX: 1, radiusY: 1 },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await cdp.detach();
    resizedWidth = 336;
    await expect.poll(sidebarWidth).toBe(336);
  }

  await page.reload();
  await expect.poll(sidebarWidth).toBe(resizedWidth);
  await sidebar.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect.poll(sidebarWidth).toBe(64);
  await expect(
    sidebar.getByRole("button", { name: "Expand sidebar" }),
  ).toBeFocused();
  await expect(separator).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: "Expand sidebar", exact: true }),
  ).toHaveCount(1);
  await sidebar.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(
    sidebar.getByRole("button", { name: "Collapse sidebar" }),
  ).toBeFocused();
  await expect.poll(sidebarWidth).toBe(resizedWidth);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => transitionMs(sidebar)).toBe(0);
  await expect.poll(() => transitionMs(sidebarGap)).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await page.goto("/settings/appearance");
  await page
    .getByRole("combobox", { name: "Navigation structure", exact: true })
    .selectOption("structured");
  await page.goto("/sandbox");
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(64);
  const mainNavigation = page.getByRole("navigation", {
    name: "Main navigation",
  });
  const accessButton = mainNavigation.getByRole("button", {
    name: "Access",
    exact: true,
  });
  await accessButton.click();
  await expect.poll(sidebarWidth).toBe(resizedWidth);
  await expect(accessButton).toHaveAttribute("aria-expanded", "true");
  await expect(
    mainNavigation.getByRole("link", { name: "Users", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await accessButton.click();
  await expect(accessButton).toHaveAttribute("aria-expanded", "false");
  await expect(
    mainNavigation.getByRole("link", { name: "Users", exact: true }),
  ).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect.poll(sidebarWidth).toBe(64);
  const boardsButton = mainNavigation.getByRole("button", {
    name: /^Boards(?:\s+Future)?$/,
  });
  await boardsButton.focus();
  await page.keyboard.press("Enter");
  await expect.poll(sidebarWidth).toBe(resizedWidth);
  await expect(boardsButton).toHaveAttribute("aria-expanded", "true");
  await expect(
    mainNavigation.getByRole("button", {
      name: "Organization Future feature",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.getByRole("link", { name: "Back to workspace" }).click();
  await expect(
    page.getByRole("button", { name: "Appearance", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Collapse sidebar" }),
  ).toBeVisible();
});

test("keeps sidebar icons anchored through expanded collapse motion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.goto("/workspace");

  const sidebar = page.getByRole("complementary", { name: "Primary sidebar" });
  const sidebarWidth = async () => (await sidebar.boundingBox())?.width;
  await expect.poll(sidebarWidth).toBe(256);
  const separator = sidebar.getByRole("separator", {
    name: "Resize sidebar",
    exact: true,
  });
  await separator.focus();
  await page.keyboard.press("End");
  await expect.poll(sidebarWidth).toBe(400);

  for (const structure of ["structured", "classic"] as const) {
    await page.goto("/settings/appearance");
    await page
      .getByRole("combobox", { name: "Navigation structure", exact: true })
      .selectOption(structure);
    await page.getByRole("link", { name: "OpenSlate workspace" }).click();
    await expect.poll(sidebarWidth).toBe(400);

    if (structure === "structured") {
      await sidebar
        .getByRole("button", { name: "Access", exact: true })
        .click();
      await expect(
        sidebar.getByRole("link", { name: "Users", exact: true }),
      ).toBeVisible();
    }

    const probes =
      structure === "structured"
        ? ["logo", "appearance", "Manage"]
        : ["logo", "appearance", "departments"];
    const motion = await page.evaluate((probeNames) => {
      const navigation = document.querySelector(
        '#primary-sidebar nav[aria-label="Main navigation"]',
      );
      const findProbe = (name: string): Element | null => {
        if (name === "logo")
          return document.querySelector(
            '#primary-sidebar a[aria-label="OpenSlate workspace"] > span:first-child',
          );
        if (name === "appearance") {
          return (
            Array.from(
              document.querySelectorAll<HTMLElement>(
                "#primary-sidebar button, #primary-sidebar summary",
              ),
            )
              .find(
                (candidate) =>
                  candidate.getAttribute("aria-label") === "Appearance" ||
                  candidate.textContent?.trim() === "Appearance",
              )
              ?.querySelector("svg") ?? null
          );
        }
        if (name === "departments")
          return (
            navigation?.querySelector('a[href="/departments"] > svg') ?? null
          );
        const button = Array.from(
          navigation?.querySelectorAll("button") ?? [],
        ).find(
          (candidate) =>
            candidate.getAttribute("aria-label") === name ||
            candidate.textContent?.trim() === name,
        );
        return button?.querySelector("svg") ?? null;
      };
      const read = () =>
        probeNames.map((name) => {
          const element = findProbe(name);
          if (!element)
            throw new Error(`Missing sidebar motion probe: ${name}`);
          const rect = element.getBoundingClientRect();
          return { x: rect.x, y: rect.y };
        });
      const initial = read();
      const collapse = document.querySelector<HTMLButtonElement>(
        '#primary-sidebar button[aria-label="Collapse sidebar"]',
      );
      if (!collapse) throw new Error("Missing collapse sidebar control");
      collapse.click();
      return new Promise<{
        initial: Array<{ x: number; y: number }>;
        samples: Array<{ values: Array<{ x: number; y: number }> }>;
      }>((resolve) => {
        const samples: Array<{ values: Array<{ x: number; y: number }> }> = [];
        let frame = 0;
        const sample = () => {
          samples.push({ values: read() });
          frame += 1;
          if (frame >= 18) resolve({ initial, samples });
          else window.requestAnimationFrame(sample);
        };
        window.requestAnimationFrame(sample);
      });
    }, probes);

    const final = motion.samples[motion.samples.length - 1]!.values;
    for (let index = 0; index < motion.initial.length; index += 1) {
      const initialX = motion.initial[index]!.x;
      const finalX = final[index]!.x;
      for (const sample of motion.samples) {
        expect(sample.values[index]!.x).toBeLessThanOrEqual(initialX + 1);
        expect(sample.values[index]!.x).toBeGreaterThanOrEqual(
          Math.min(initialX, finalX) - 1,
        );
        expect(sample.values[index]!.x).toBeLessThanOrEqual(
          Math.max(initialX, finalX) + 1,
        );
      }
    }
    await expect.poll(sidebarWidth).toBe(64);
    await sidebar.getByRole("button", { name: "Expand sidebar" }).click();
    await expect.poll(sidebarWidth).toBe(400);
  }
});

test("keeps mobile navigation focused without desktop rail controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.goto("/workspace");

  const trigger = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  await trigger.click();
  const drawer = page.locator("#mobile-navigation");
  await expect(
    drawer.getByRole("button", { name: "Close navigation", exact: true }),
  ).toBeFocused();
  await expect(
    drawer.getByRole("separator", { name: "Resize sidebar", exact: true }),
  ).toHaveCount(0);
  await expect(
    drawer.getByRole("button", { name: "Collapse sidebar", exact: true }),
  ).toHaveCount(0);
  await expect(
    drawer.getByRole("button", { name: "Expand sidebar", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("appearance controls restore saved values and every accent remains readable in dark mode", async ({
  page,
}) => {
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.goto("/settings/appearance");
  const theme = page.getByRole("radiogroup", { name: "Theme", exact: true });
  const accent = page.getByRole("radiogroup", {
    name: "Accent",
    exact: true,
  });
  const density = page.getByRole("radiogroup", {
    name: "Density",
    exact: true,
  });
  const cornerStyle = page.getByRole("radiogroup", {
    name: "Corner style",
    exact: true,
  });
  await expect(page.getByRole("radiogroup")).toHaveCount(4);
  await expect(theme.getByRole("radio", { name: "Light" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await theme.getByRole("radio", { name: "Light" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(theme.getByRole("radio", { name: "Dark" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(theme.getByRole("radio", { name: "Dark" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(theme.getByRole("radio", { name: "Light" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await theme.getByRole("radio", { name: "Dark" }).click();
  await density
    .getByRole("radio", { name: "Comfortable", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    density.getByRole("radio", { name: "Compact", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await cornerStyle
    .getByRole("radio", { name: "Rounded", exact: true })
    .click();
  await expect(
    cornerStyle.getByRole("radio", { name: "Rounded", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  for (const name of ["Cobalt", "Indigo", "Emerald", "Neutral"]) {
    await accent.getByRole("radio", { name, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-accent",
      name.toLowerCase(),
    );
    // Contrast applies to the settled theme, not an interpolated transition frame.
    await page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .map((animation) => animation.finished.catch(() => undefined)),
      );
    });
    const results = await new AxeBuilder({ page })
      .include("main")
      .withRules(["color-contrast"])
      .analyze();
    expect(results.violations).toEqual([]);
  }
  await page.reload();
  await expect(
    theme.getByRole("radio", { name: "Dark", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    accent.getByRole("radio", { name: "Neutral", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    density.getByRole("radio", { name: "Compact", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    cornerStyle.getByRole("radio", { name: "Rounded", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveClass(/dark/);
});
