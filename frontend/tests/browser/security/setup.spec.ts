import { expect, test } from "@playwright/test";
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
