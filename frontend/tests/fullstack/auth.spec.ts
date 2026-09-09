import { readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { z } from "zod";

const Identity = z.object({
  email: z.string().email(),
  password: z.string(),
  id: z.uuid(),
});
const Fixture = z.object({
  runId: z.string(),
  baseURL: z.literal("http://localhost:3008"),
  authURL: z.literal("http://127.0.0.1:55321"),
  mailURL: z.literal("http://127.0.0.1:55324"),
  admin: Identity,
  member: Identity,
});
const fixturePath = process.env.OPENSLATE_FULLSTACK_FIXTURE!;
if ((statSync(fixturePath).mode & 0o077) !== 0)
  throw new Error("Fixture must be private");
const fixture = Fixture.parse(JSON.parse(readFileSync(fixturePath, "utf8")));
if (fixture.runId !== process.env.OPENSLATE_FULLSTACK_RUN_ID)
  throw new Error("Wrong test namespace");
const origin = { Origin: fixture.baseURL };

async function signIn(page: Page, identity: z.infer<typeof Identity>) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(identity.email);
  await page.getByLabel("Password", { exact: true }).fill(identity.password);
  const signedIn = page.waitForResponse((r) =>
    r.url().endsWith("/session/login"),
  );
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  expect((await signedIn).status()).toBe(200);
}

async function me(context: BrowserContext) {
  return context.request.get(`${fixture.baseURL}/bff/auth/me`);
}

test("real login, expiry refresh, identity, logout and boundary enforcement", async ({
  page,
  context,
  browser,
}) => {
  await signIn(page, fixture.admin);
  const identity = await me(context);
  expect(identity.status()).toBe(200);
  expect((await identity.json()).id === fixture.admin.id).toBe(true);
  expect(Boolean(identity.headers()["x-request-id"])).toBe(true);
  const cookies = await context.cookies();
  const access = cookies.find((cookie) => cookie.name === "openslate_access")!;
  expect(
    cookies
      .filter((cookie) => cookie.name.startsWith("openslate_"))
      .every((cookie) => cookie.httpOnly),
  ).toBe(true);
  expect(
    await page.evaluate(() => document.cookie.includes("openslate_access")),
  ).toBe(false);
  const state = await context.storageState();
  const claims: unknown = JSON.parse(
    Buffer.from(access.value.split(".")[1], "base64url").toString(),
  );
  const expiresAt = z.object({ exp: z.number() }).parse(claims).exp;
  // Hold the actual signed token past expiry without background status polling.
  await page.close();
  await expect
    .poll(() => Date.now() / 1000, { timeout: 75_000, intervals: [1000] })
    .toBeGreaterThan(expiresAt + 1);
  const expired = await browser.newContext({
    baseURL: fixture.baseURL,
    storageState: state,
  });
  try {
    await expired.addCookies([{ ...access, expires: Date.now() / 1000 + 120 }]);
    const refreshed = await me(expired);
    expect(refreshed.status()).toBe(200);
    const rotated = (await expired.cookies()).find(
      (cookie) => cookie.name === "openslate_access",
    );
    expect(rotated?.value !== access.value).toBe(true);
    expect(
      (
        await expired.request.post("/bff/auth/invitations/accept", {
          headers: origin,
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await expired.request.post("/bff/departments", {
          headers: { Origin: "https://invalid.example" },
          data: {},
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await expired.request.post("/session/logout", { headers: origin })
      ).status(),
    ).toBe(204);
    expect((await me(expired)).status()).toBe(401);
    expect((await expired.request.get("/session/status")).status()).toBe(200);
    expect(
      (await expired.cookies()).some(
        (cookie) => cookie.name === "openslate_refresh",
      ),
    ).toBe(false);
  } finally {
    await expired.close();
  }
});

test("local capability and disabled-account checks survive real provider sessions", async ({
  page,
  browser,
}) => {
  await signIn(page, fixture.admin);
  const member = await browser.newContext({ baseURL: fixture.baseURL });
  try {
    const memberPage = await member.newPage();
    await signIn(memberPage, fixture.member);
    expect((await me(member)).status()).toBe(200);
    expect((await member.request.get("/bff/users")).status()).toBe(403);
    const oldAccess = (await member.cookies()).find(
      (cookie) => cookie.name === "openslate_access",
    )!;
    const disabled = await page.request.patch(
      `/bff/users/${fixture.member.id}`,
      { headers: origin, data: { status: "disabled" } },
    );
    expect(disabled.status()).toBe(200);
    expect((await me(member)).status()).toBe(401);
    const enabled = await page.request.patch(
      `/bff/users/${fixture.member.id}`,
      { headers: origin, data: { status: "active" } },
    );
    expect(enabled.status()).toBe(200);
    const previousToken = await browser.newContext({
      baseURL: fixture.baseURL,
    });
    try {
      // Re-enabling the account must not reactivate a pre-cutoff access token.
      await previousToken.addCookies([oldAccess]);
      expect((await me(previousToken)).status()).toBe(401);
    } finally {
      await previousToken.close();
    }
  } finally {
    await member.close();
  }
});

test("real invitation email callback and password acceptance", async ({
  page,
  browser,
  request,
}) => {
  await signIn(page, fixture.admin);
  const email = `p5-${fixture.runId}-invite@example.com`;
  const invited = await page.request.post("/bff/users", {
    headers: origin,
    data: { email, username: "p5-invite" },
  });
  expect(invited.status()).toBe(201);
  const pendingId = (await invited.json()).id as string;
  let messageId = "";
  await expect
    .poll(
      async () => {
        const result = await request.get(`${fixture.mailURL}/api/v1/messages`);
        const mailbox = z
          .object({
            messages: z.array(
              z.object({
                ID: z.string(),
                To: z.array(z.object({ Address: z.string() })),
              }),
            ),
          })
          .parse(await result.json());
        messageId =
          mailbox.messages.find((message) =>
            message.To.some((to) => to.Address === email),
          )?.ID ?? "";
        return Boolean(messageId);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  const message = await request.get(
    `${fixture.mailURL}/api/v1/message/${messageId}`,
  );
  const html = z.object({ HTML: z.string() }).parse(await message.json()).HTML;
  const href = /href="([^"]+)"/.exec(html)?.[1]?.replaceAll("&amp;", "&");
  expect(Boolean(href)).toBe(true);
  const callback = new URL(href!);
  expect(
    callback.origin === fixture.baseURL &&
      callback.pathname === "/auth/callback",
  ).toBe(true);
  const invitee = await browser.newContext({ baseURL: fixture.baseURL });
  try {
    const setup = await invitee.newPage();
    await setup.goto(callback.toString());
    await expect(setup).toHaveURL(/\/auth\/setup$/);
    const password = `P5-${randomUUID()}!9`;
    await setup.getByLabel("Password", { exact: true }).fill(password);
    await setup.getByLabel("Confirm password", { exact: true }).fill(password);
    const saved = setup.waitForResponse((r) =>
      r.url().endsWith("/session/password"),
    );
    await setup
      .getByRole("button", { name: /save|set password|continue/i })
      .click();
    const passwordResponse = await saved;
    expect(passwordResponse.status()).toBe(200);
    // FastAPI generates UUIDv7 IDs; Next.js generates its separate UUIDv4 ID.
    expect(passwordResponse.headers()["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const accepted = await me(invitee);
    expect(accepted.status()).toBe(200);
    expect((await accepted.json()).id === pendingId).toBe(true);
  } finally {
    await invitee.close();
  }
});
