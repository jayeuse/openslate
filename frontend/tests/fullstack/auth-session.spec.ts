import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

type Identity = Readonly<{ email: string; password: string; id: string }>;

type Fixture = Readonly<{
  runId: string;
  baseURL: string;
  admin: Identity;
  member: Identity;
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
    !Object.hasOwn(parsed, "admin") ||
    !Object.hasOwn(parsed, "member")
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
  if (!value.member.email || !value.member.password || !value.member.id)
    throw new Error("full-stack member fixture is malformed");
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

test("a returning tab conceals the old account until the shared cookie session is revalidated", async ({
  context,
  page: tabA,
}) => {
  const { admin, member } = fixture();
  await tabA.goto("/login");
  await tabA.getByLabel("Email or username").fill(admin.email);
  await tabA.getByLabel("Password").fill(admin.password);
  await tabA.getByRole("button", { name: "Sign in" }).click();
  await expect(tabA).toHaveURL(/\/openview$/);
  await tabA.goto("/platform?section=search");
  const search = tabA.getByRole("searchbox", { name: "Search workspace" });
  await search.fill("admin-only in-progress draft");

  const tabB = await context.newPage();
  const startup: string[] = [];
  tabB.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/auth/session")
      startup.push("session request");
  });
  tabB.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (response.request().resourceType() === "script")
      startup.push(`script ${response.status()} ${path}`);
    if (path === "/api/auth/session")
      startup.push(`session ${response.status()}`);
  });
  tabB.on("requestfailed", (request) => {
    if (request.resourceType() === "script")
      startup.push(`script failed ${new URL(request.url()).pathname}`);
  });
  tabB.on("pageerror", (error) => startup.push(`pageerror ${error.name}`));
  try {
    await tabB.goto("/openview");
    await expect(tabB.getByRole("button", { name: "Account" })).toBeVisible();
  } catch (error) {
    throw new Error(`Tab B startup status:\n${startup.join("\n")}`, {
      cause: error,
    });
  }
  await tabB.getByRole("button", { name: "Account" }).click();
  await tabB.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(tabB).toHaveURL(/\/login$/);
  await tabB.getByLabel("Email or username").fill(member.email);
  await tabB.getByLabel("Password").fill(member.password);
  await tabB.getByRole("button", { name: "Sign in" }).click();
  await expect(tabB).toHaveURL(/\/openview$/);

  let releaseSession = () => {};
  let signalSession = () => {};
  const sessionReleased = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  const sessionStarted = new Promise<void>((resolve) => {
    signalSession = resolve;
  });
  await tabA.route("**/api/auth/session", async (route) => {
    signalSession();
    await sessionReleased;
    try {
      await route.continue();
    } catch {
      // A newer focus may abort a superseded request before it is forwarded.
    }
  });

  let sessionResponse: ReturnType<typeof tabA.waitForResponse> | undefined;
  try {
    await tabA.bringToFront();
    const coveredSynchronously = await tabA.evaluate(() => {
      window.dispatchEvent(new FocusEvent("focus"));
      return (
        document
          .querySelector<HTMLDialogElement>(
            'dialog[aria-label="Session verification"]',
          )
          ?.matches(":modal") === true
      );
    });
    expect(coveredSynchronously).toBe(true);
    await sessionStarted;
    await expect(
      tabA.getByRole("dialog", { name: "Session verification" }),
    ).toBeVisible();
    await expect(tabA.getByRole("heading", { name: "Platform" })).toHaveCount(
      0,
    );
    sessionResponse = tabA.waitForResponse(
      (response) =>
        response.url().endsWith("/api/auth/session") &&
        response.request().method() === "GET" &&
        response.status() === 200,
    );
  } finally {
    releaseSession();
  }
  if (!sessionResponse)
    throw new Error("session response listener was not set");
  expect(await sessionResponse.then((response) => response.json())).toEqual(
    expect.objectContaining({ authenticated: true, user_id: member.id }),
  );
  await expect(
    tabA.getByRole("dialog", { name: "Session verification" }),
  ).toBeHidden();
  await expect(search).toHaveValue("");
});
