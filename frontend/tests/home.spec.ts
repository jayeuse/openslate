import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

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
