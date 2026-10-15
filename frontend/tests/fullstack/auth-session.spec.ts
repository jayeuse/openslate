import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

type Identity = Readonly<{ email: string; password: string; id: string }>;

type Fixture = Readonly<{
  runId: string;
  baseURL: string;
  mailpitUrl: string;
  admin: Identity;
  member: Identity;
}>;

type ActionType = "invite" | "recovery";

test.use({ trace: "off", screenshot: "off", video: "off" });

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
    !Object.hasOwn(parsed, "mailpitUrl") ||
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
  if (typeof value.mailpitUrl !== "string")
    throw new Error("full-stack fixture Mailpit endpoint is malformed");
  validateLoopbackMailpitOrigin(value.mailpitUrl);
  if (!value.admin.email || !value.admin.password || !value.admin.id)
    throw new Error("full-stack administrator fixture is malformed");
  if (!value.member.email || !value.member.password || !value.member.id)
    throw new Error("full-stack member fixture is malformed");
  return value;
}

function validateLoopbackMailpitOrigin(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      "full-stack fixture Mailpit endpoint must be a loopback origin",
    );
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "::1", "localhost"].includes(hostname) ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  )
    throw new Error(
      "full-stack fixture Mailpit endpoint must be a loopback origin",
    );
  return new URL(parsed.origin);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function findMailpitActionLink(
  request: APIRequestContext,
  mailpitOrigin: URL,
  browserOrigin: URL,
  recipient: string,
  action: ActionType,
): Promise<string | undefined> {
  const expectedPath = action === "invite" ? "/auth/setup" : "/auth/recovery";
  const messagesResponse = await request.get(
    new URL("/api/v1/messages", mailpitOrigin).href,
    { timeout: 2_500 },
  );
  if (!messagesResponse.ok()) return undefined;
  let messagesPayload: unknown;
  try {
    messagesPayload = await messagesResponse.json();
  } catch {
    return undefined;
  }
  if (!isRecord(messagesPayload) || !Array.isArray(messagesPayload.messages))
    return undefined;

  for (const value of messagesPayload.messages) {
    if (!isRecord(value) || typeof value.ID !== "string") continue;
    if (
      !Array.isArray(value.To) ||
      !value.To.some(
        (recipientValue) =>
          isRecord(recipientValue) &&
          typeof recipientValue.Address === "string" &&
          recipientValue.Address.toLowerCase() === recipient.toLowerCase(),
      )
    )
      continue;
    const messageResponse = await request.get(
      new URL(`/api/v1/message/${encodeURIComponent(value.ID)}`, mailpitOrigin)
        .href,
      { timeout: 2_500 },
    );
    if (!messageResponse.ok()) continue;
    let messagePayload: unknown;
    try {
      messagePayload = await messageResponse.json();
    } catch {
      continue;
    }
    if (!isRecord(messagePayload) || typeof messagePayload.HTML !== "string")
      continue;
    for (const match of messagePayload.HTML.matchAll(/href="([^"]+)"/gu)) {
      const rawHref = match[1];
      if (!rawHref) continue;
      const href = rawHref.replace(/&(?:amp|#0*38|#x0*26);/giu, "&");
      try {
        const link = new URL(href);
        const fragment = new URLSearchParams(link.hash.slice(1));
        const tokenHashes = fragment.getAll("token_hash");
        const types = fragment.getAll("type");
        if (
          link.origin === browserOrigin.origin &&
          link.pathname === expectedPath &&
          !link.search &&
          !link.username &&
          !link.password &&
          link.hash.slice(1).split("&").length === 2 &&
          tokenHashes.length === 1 &&
          Boolean(tokenHashes[0]) &&
          types.length === 1 &&
          types[0] === action
        )
          return href;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

async function waitForMailpitActionLink(
  request: APIRequestContext,
  mailpitOrigin: URL,
  browserOrigin: URL,
  recipient: string,
  action: ActionType,
): Promise<string> {
  let foundLink: string | undefined;
  await expect
    .poll(
      async () => {
        foundLink = await findMailpitActionLink(
          request,
          mailpitOrigin,
          browserOrigin,
          recipient,
          action,
        );
        return foundLink !== undefined;
      },
      { timeout: 10_000, intervals: [100, 250, 500] },
    )
    .toBe(true);
  if (!foundLink)
    throw new Error(`Mailpit did not capture the ${action} email`);
  return foundLink;
}

async function openEmailActionLink(
  page: Page,
  actionLink: string,
  action: ActionType,
): Promise<void> {
  try {
    await page.goto(actionLink, { waitUntil: "domcontentloaded" });
  } catch {
    throw new Error(`The provider ${action} link could not be opened`);
  }
  const expectedPath = action === "invite" ? "/auth/setup" : "/auth/recovery";
  if (action === "invite")
    await expect(page.getByLabel("Password", { exact: true })).toBeEnabled();
  else
    await expect(
      page.getByRole("heading", { name: "Choose a new password" }),
    ).toBeVisible();
  const addressState = await page.evaluate(() => ({
    pathname: window.location.pathname,
    hasQuery: Boolean(window.location.search),
    hasFragment: Boolean(window.location.hash),
  }));
  expect(addressState.pathname).toBe(expectedPath);
  expect(addressState.hasQuery).toBe(false);
  expect(addressState.hasFragment).toBe(false);
}

test("the same-origin gateway authenticates, serves the session, and revokes it on logout", async ({
  page,
}) => {
  const credentials = fixture().admin;

  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/(openview|sandbox)$/);
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
  await tabA.getByLabel("Email", { exact: true }).fill(admin.email);
  await tabA.getByLabel("Password").fill(admin.password);
  await tabA.getByRole("button", { name: "Sign in" }).click();
  await expect(tabA).toHaveURL(/\/(openview|sandbox)$/);
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
  await tabB.getByLabel("Email", { exact: true }).fill(member.email);
  await tabB.getByLabel("Password").fill(member.password);
  await tabB.getByRole("button", { name: "Sign in" }).click();
  await expect(tabB).toHaveURL(/\/(openview|sandbox)$/);

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

test("provider invitation and recovery emails complete through rendered forms", async ({
  page,
  request,
}) => {
  const fullstack = fixture();
  const mailpitOrigin = validateLoopbackMailpitOrigin(fullstack.mailpitUrl);
  const browserOrigin = new URL(fullstack.baseURL);
  const email = `auth-link-${randomUUID()}@example.test`;
  const username = `auth-link-${randomUUID().replaceAll("-", "")}`;
  const invitationPassword = `Invite!${randomUUID()}`;
  const replacementPassword = `Replace!${randomUUID()}`;
  const replayPassword = `Replay!${randomUUID()}`;

  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(fullstack.admin.email);
  await page.getByLabel("Password").fill(fullstack.admin.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByLabel("OpenSlate workspace")).toBeVisible();

  const invitation = await page.evaluate(
    async ({ email, username }) => {
      const csrfCookie = document.cookie
        .split(";")
        .map((segment) => segment.trim())
        .find((segment) => segment.startsWith("openslate_csrf="));
      if (!csrfCookie) return { httpStatus: 0 };
      let csrfToken: string;
      try {
        csrfToken = decodeURIComponent(
          csrfCookie.slice("openslate_csrf=".length),
        );
      } catch {
        return { httpStatus: 0 };
      }
      const response = await fetch("/api/auth/invitations", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({ email, username }),
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { httpStatus: response.status };
      }
      if (
        typeof body !== "object" ||
        body === null ||
        !("user" in body) ||
        typeof body.user !== "object" ||
        body.user === null ||
        !("status" in body.user)
      )
        return { httpStatus: response.status };
      return {
        httpStatus: response.status,
        delivery: "delivery" in body ? body.delivery : undefined,
        profileStatus: body.user.status,
      };
    },
    { email, username },
  );
  expect(invitation.httpStatus).toBe(201);
  expect(invitation.delivery).toBe("email");
  expect(invitation.profileStatus).toBe("pending");

  const invitationLink = await waitForMailpitActionLink(
    request,
    mailpitOrigin,
    browserOrigin,
    email,
    "invite",
  );
  await page.getByRole("button", { name: "Account" }).click();
  const adminLogoutResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/logout") &&
      response.request().method() === "POST",
  );
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  expect((await adminLogoutResponse).status()).toBe(204);
  await expect(page).toHaveURL(new URL("/login", browserOrigin).href);
  const signedOutSession = await page.request.get("/api/auth/session");
  expect(signedOutSession.status()).toBe(200);
  expect(await signedOutSession.json()).toEqual({ authenticated: false });

  await openEmailActionLink(page, invitationLink, "invite");
  await page.getByLabel("Password", { exact: true }).fill(invitationPassword);
  await page.getByLabel("Confirm password").fill(invitationPassword);
  const invitationCompletion = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/invitations/complete") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Continue" }).click();
  expect((await invitationCompletion).status()).toBe(204);
  await expect(page).toHaveURL(
    new URL("/login?completed=password", browserOrigin).href,
  );
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password").fill(invitationPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByLabel("OpenSlate workspace")).toBeVisible();
  const invitedIdentityResponse = await page.request.get("/api/auth/me");
  expect(invitedIdentityResponse.status()).toBe(200);
  const invitedIdentity = (await invitedIdentityResponse.json()) as {
    email: string;
  };
  expect(invitedIdentity.email).toBe(email);

  await page.getByRole("button", { name: "Account" }).click();
  const logoutResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/logout") &&
      response.request().method() === "POST",
  );
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  expect((await logoutResponse).status()).toBe(204);
  await expect(
    page.getByRole("link", { name: "Forgot password?" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(
    page.getByRole("heading", { name: "Reset password" }),
  ).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Request recovery" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "If an account matches that email, we will send recovery instructions.",
  );

  const recoveryLink = await waitForMailpitActionLink(
    request,
    mailpitOrigin,
    browserOrigin,
    email,
    "recovery",
  );
  await openEmailActionLink(page, recoveryLink, "recovery");
  await page
    .getByLabel("New password", { exact: true })
    .fill(replacementPassword);
  await page.getByLabel("Confirm new password").fill(replacementPassword);
  const recoveryCompletion = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/recovery/complete") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Reset password" }).click();
  expect((await recoveryCompletion).status()).toBe(204);
  await expect(page).toHaveURL(
    new URL("/login?completed=password", browserOrigin).href,
  );
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();

  await openEmailActionLink(page, recoveryLink, "recovery");
  await page.getByLabel("New password", { exact: true }).fill(replayPassword);
  await page.getByLabel("Confirm new password").fill(replayPassword);
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "We could not reset your password. Check the requirements and try again.",
  );

  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password").fill(replacementPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByLabel("OpenSlate workspace")).toBeVisible();
  const recoveredIdentityResponse = await page.request.get("/api/auth/me");
  expect(recoveredIdentityResponse.status()).toBe(200);
  const recoveredIdentity = (await recoveredIdentityResponse.json()) as {
    email: string;
  };
  expect(recoveredIdentity.email).toBe(email);
});
