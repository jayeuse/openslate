import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

type Fixture = Readonly<{
  runId: string;
  baseURL: string;
  admin: Readonly<{ email: string; password: string; id: string }>;
}>;

function fixture(): Fixture {
  const location = process.env.OPENSLATE_FULLSTACK_FIXTURE;
  const runId = process.env.OPENSLATE_FULLSTACK_RUN_ID;
  if (!location || !runId) throw new Error("full-stack fixture is unavailable");
  const parsed: unknown = JSON.parse(readFileSync(location, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Object.hasOwn(parsed, "runId") ||
    !Object.hasOwn(parsed, "baseURL") ||
    !Object.hasOwn(parsed, "admin")
  )
    throw new Error("full-stack fixture is malformed");
  const value = parsed as Fixture;
  if (
    value.runId !== runId ||
    value.baseURL !== test.info().project.use.baseURL
  )
    throw new Error("full-stack fixture does not match this gateway run");
  if (!value.admin.email || !value.admin.password || !value.admin.id)
    throw new Error("full-stack administrator fixture is malformed");
  return value;
}

test("the same-origin gateway authenticates, serves the session, and revokes it on logout", async ({
  page,
}) => {
  const credentials = fixture().admin;

  await page.goto("/login");
  await page.getByLabel("Email or username").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/openview$/);
  await expect(page.getByLabel("OpenSlate workspace")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const response = await fetch("/api/auth/session", {
          cache: "no-store",
        });
        return {
          origin: new URL(response.url).origin,
          status: response.status,
          body: await response.json(),
        };
      }),
    )
    .toEqual(
      expect.objectContaining({
        origin: new URL(page.url()).origin,
        status: 200,
        body: expect.objectContaining({
          authenticated: true,
          user_id: credentials.id,
        }),
      }),
    );

  await page.getByRole("button", { name: "Account" }).click();
  const logoutResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/logout") &&
      response.request().method() === "POST",
  );
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  expect((await logoutResponse).status()).toBe(204);
  await expect(page).toHaveURL(/\/login$/);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const response = await fetch("/api/auth/session", {
          cache: "no-store",
        });
        return response.json();
      }),
    )
    .toEqual({ authenticated: false });
});
