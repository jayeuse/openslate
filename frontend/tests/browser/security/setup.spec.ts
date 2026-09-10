import { expect, test } from "../coverage";
import { testSecret } from "../../helpers/test-secret";
const validPassword = testSecret();

const differentPassword = testSecret();

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
  await page.getByLabel("Password", { exact: true }).fill(validPassword);
  await page.getByLabel("Confirm password").fill(differentPassword);
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

  await page.getByLabel("Confirm password").fill(validPassword);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("**/workspace");
  expect(passwordRequests).toBe(1);
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
  await page.getByLabel("Password", { exact: true }).fill(validPassword);
  await page.getByLabel("Confirm password").fill(validPassword);
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
  const result = await page.evaluate(async (validPassword) => {
    const response = await fetch("/session/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        password: validPassword,
        confirmation: validPassword,
      }),
    });
    return {
      status: response.status,
      body: await response.json(),
    };
  }, validPassword);

  expect(result).toEqual({
    status: 401,
    body: { detail: "Authentication required" },
  });
});

test("waits for hydration before accepting invited-account password input", async ({
  page,
}) => {
  let releaseScripts!: () => void;
  const scriptsHeld = new Promise<void>((resolve) => {
    releaseScripts = resolve;
  });
  await page.route("**/_next/static/**/*.js", async (route) => {
    await scriptsHeld;
    await route.continue();
  });
  let requests = 0;
  await page.route("**/session/password", async (route) => {
    requests += 1;
    await route.fulfill({
      status: 400,
      json: { detail: "upstream invitation details" },
    });
  });
  try {
    await page.goto("/auth/setup", { waitUntil: "commit" });
    const password = page.getByLabel("Password", { exact: true });
    const confirmation = page.getByLabel("Confirm password", { exact: true });
    const submit = page.getByRole("button", { name: "Continue", exact: true });
    await expect(password).toBeDisabled();
    await expect(confirmation).toBeDisabled();
    await expect(submit).toBeDisabled();
    releaseScripts();
    await expect(password).toBeEnabled();
    await expect(confirmation).toBeEnabled();
    await expect(submit).toBeEnabled();
    await password.fill(validPassword);
    await confirmation.fill(validPassword);
    await expect(password).toHaveValue(validPassword);
    await submit.click();
    await expect(page.getByRole("status")).toContainText(
      "We could not set up your password. The invitation may have expired.",
    );
    await expect(password).toHaveValue(validPassword);
    await expect(confirmation).toHaveValue(validPassword);
    await expect(submit).toBeEnabled();
    expect(requests).toBe(1);
  } finally {
    releaseScripts();
  }
});
