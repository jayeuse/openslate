import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  expect,
  test as base,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";

// Preparation only until the owner releases S27–S31 and the exclusive runtime window.
// No routes, mock transports, seeded messages, saved cookie state or auth trace artifacts.
base.use({ trace: "off", screenshot: "off", video: "off" });

type Identity = { id: string; email: string; password: string };
type OwnedFixture = {
  runId: string;
  baseURL: string;
  mailpitUrl: string;
  admin: Identity;
  comms: {
    orgId: string;
    orgName: string;
    otherOrgId: string;
    otherOrgName: string;
  };
};
type Observations = {
  sockets: number;
  sse: boolean;
  joined: Set<string>;
  foreignTopic: boolean;
  messages: { topic: string; seq: number }[];
};
type Account = {
  page: Page;
  id: string;
  orgId: string;
  name: string;
  wire: Observations;
};
type Journey = {
  fixture: OwnedFixture;
  admin: Account;
  member: Account;
  isolated: Account;
  room: string;
  isolatedRoom: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new Error("Owned response omitted a required string");
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new Error("Owned response was not an object");
  return value;
}
function fixture(baseURL: string | undefined): OwnedFixture {
  const path = process.env.OPENSLATE_FULLSTACK_FIXTURE;
  const runId = process.env.OPENSLATE_FULLSTACK_RUN_ID;
  if (
    !path ||
    !runId ||
    !/^[a-f0-9]{32}$/u.test(runId) ||
    process.env.E2E_ALLOW_MUTATIONS !== "true"
  )
    throw new Error("Owned fullstack mutation/run fixture is required");
  const file = lstatSync(path);
  const directory = lstatSync(dirname(path));
  if (
    !file.isFile() ||
    (file.mode & 0o777) !== 0o600 ||
    (directory.mode & 0o777) !== 0o700
  )
    throw new Error("Fullstack handoff must be a private runner file");
  const value = object(JSON.parse(readFileSync(path, "utf8")));
  if (value.runId !== runId || value.baseURL !== baseURL)
    throw new Error("Fullstack fixture does not match this gateway run");
  const origin = new URL(text(value.baseURL));
  const mail = new URL(text(value.mailpitUrl));
  if (
    origin.protocol !== "https:" ||
    origin.hostname !== "localhost" ||
    !origin.port ||
    mail.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(mail.hostname) ||
    !mail.port ||
    [origin, mail].some(
      (url) =>
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/",
    )
  )
    throw new Error("Fixture endpoints must be exact owned loopback origins");
  const admin = object(value.admin),
    comms = object(value.comms);
  return {
    runId,
    baseURL: origin.origin,
    mailpitUrl: mail.origin,
    admin: {
      id: text(admin.id),
      email: text(admin.email),
      password: text(admin.password),
    },
    comms: {
      orgId: text(comms.orgId),
      orgName: text(comms.orgName),
      otherOrgId: text(comms.otherOrgId),
      otherOrgName: text(comms.otherOrgName),
    },
  };
}

async function api(
  page: Page,
  orgId: string,
  method: string,
  path: string,
  body?: unknown,
) {
  // Browser fetch supplies real cookies/Origin; CSRF never leaves this evaluation result.
  return page.evaluate(
    async ({ organization, verb, endpoint, data }) => {
      const cookie = document.cookie
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("openslate_csrf="));
      const headers: Record<string, string> = { "X-Org": organization };
      if (data !== undefined) headers["Content-Type"] = "application/json";
      if (cookie && verb !== "GET")
        headers["X-CSRF-Token"] = decodeURIComponent(
          cookie.slice("openslate_csrf=".length),
        );
      const response = await fetch(endpoint, {
        method: verb,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      let payload: unknown = null;
      if (response.status !== 204) {
        try {
          payload = await response.json();
        } catch {
          /* status is the oracle */
        }
      }
      return { status: response.status, payload };
    },
    { organization: orgId, verb: method, endpoint: path, data: body },
  );
}

async function signIn(
  page: Page,
  origin: string,
  identity: Pick<Identity, "email" | "password">,
) {
  // API login shares this context's cookie jar; never print a request/response on auth failure.
  try {
    const response = await page.request.post(`${origin}/api/auth/login`, {
      headers: { Origin: origin },
      data: { email: identity.email, password: identity.password },
    });
    if (response.status() !== 200) throw new Error("login refused");
    await page.goto(`${origin}/openview`);
    await expect(
      page.getByLabel("OpenSlate workspace", { exact: true }),
    ).toBeVisible();
  } catch {
    throw new Error("Owned account sign-in did not complete");
  }
}

async function selectOrganization(page: Page, name: string) {
  await page.getByRole("button", { name: /^Organization: /u }).click();
  await page
    .getByRole("menuitem", { name: new RegExp(`^${name} Administrator`, "u") })
    .click();
  await expect(
    page.getByRole("button", { name: `Organization: ${name}`, exact: true }),
  ).toBeVisible();
}

async function invitationToken(
  mail: APIRequestContext,
  recipient: string,
  origin: string,
) {
  let token: string | undefined;
  await expect
    .poll(
      async () => {
        const response = await mail.get("/api/v1/messages");
        if (response.status() !== 200) return false;
        const listing: unknown = await response.json();
        if (!record(listing) || !Array.isArray(listing.messages)) return false;
        for (const item of listing.messages) {
          if (
            !record(item) ||
            typeof item.ID !== "string" ||
            !Array.isArray(item.To) ||
            !item.To.some((to) => record(to) && to.Address === recipient)
          )
            continue;
          const content = await mail.get(
            `/api/v1/message/${encodeURIComponent(item.ID)}`,
          );
          if (content.status() !== 200) continue;
          const message: unknown = await content.json();
          if (!record(message) || typeof message.HTML !== "string") continue;
          for (const match of message.HTML.matchAll(/href="([^"]+)"/gu)) {
            if (!match[1]) continue;
            try {
              const link = new URL(
                match[1].replace(/&(?:amp|#0*38|#x0*26);/giu, "&"),
              );
              const fragment = new URLSearchParams(link.hash.slice(1));
              const candidate = fragment.get("token_hash");
              if (
                link.origin === origin &&
                link.pathname === "/auth/setup" &&
                !link.search &&
                !link.username &&
                !link.password &&
                [...fragment].length === 2 &&
                fragment.getAll("type").length === 1 &&
                fragment.get("type") === "invite" &&
                fragment.getAll("token_hash").length === 1 &&
                candidate &&
                /^[a-f0-9]{56}$/u.test(candidate)
              ) {
                token = candidate;
                return true;
              }
            } catch {
              /* Ignore unrelated/malformed links without exposing their contents. */
            }
          }
        }
        return false;
      },
      { timeout: 15_000, intervals: [100, 250, 500] },
    )
    .toBe(true);
  if (!token) throw new Error("Owned invitation mail was not captured");
  return token;
}

function observe(page: Page, org: string, origin: string): Observations {
  const result: Observations = {
    sockets: 0,
    sse: false,
    joined: new Set(),
    foreignTopic: false,
    messages: [],
  };
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (
      url.origin === origin &&
      url.pathname === "/api/events" &&
      url.searchParams.get("org") === org &&
      response.status() === 200
    )
      result.sse = true;
  });
  page.on("websocket", (socket) => {
    const url = new URL(socket.url());
    if (
      url.host !== new URL(origin).host ||
      url.protocol !== "wss:" ||
      url.pathname !== "/realtime/v1/websocket"
    )
      return;
    result.sockets += 1;
    socket.on("framereceived", ({ payload }) => {
      // Receive-only observer: never inspect outbound joins/access tokens or retain raw frames.
      let value: unknown;
      try {
        value = JSON.parse(
          typeof payload === "string" ? payload : payload.toString("utf8"),
        );
      } catch {
        return;
      }
      const frame =
        Array.isArray(value) && value.length === 5
          ? { topic: value[2], event: value[3], payload: value[4] }
          : value;
      if (
        !record(frame) ||
        typeof frame.topic !== "string" ||
        !record(frame.payload)
      )
        return;
      const topic = frame.topic.replace(/^realtime:/u, "");
      if (!topic.startsWith("org:")) return;
      if (!topic.startsWith(`org:${org}:`)) result.foreignTopic = true;
      if (frame.event === "phx_reply" && frame.payload.status === "ok")
        result.joined.add(topic);
      if (
        frame.event === "broadcast" &&
        frame.payload.event === "message" &&
        record(frame.payload.payload) &&
        typeof frame.payload.payload.seq === "number"
      ) {
        result.messages.push({ topic, seq: frame.payload.payload.seq });
      }
    });
  });
  return result;
}

async function openRoom(
  account: Account,
  origin: string,
  name: string,
  room: string,
) {
  await account.page.goto(`${origin}/comms`);
  await account.page.getByRole("button", { name, exact: true }).click();
  await expect(
    account.page.getByRole("heading", { name, exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      () =>
        account.wire.joined.has(`org:${account.orgId}:conversation:${room}`),
      { timeout: 15_000 },
    )
    .toBe(true);
  await expect.poll(() => account.wire.sse).toBe(true);
}

const test = base.extend<{ comms: Journey }>({
  comms: async ({ browser, baseURL, playwright }, provide) => {
    const owned = fixture(baseURL);
    const contexts: BrowserContext[] = [];
    let mail: APIRequestContext | undefined;
    let stage = "create contexts";
    let journey: Journey;
    try {
      const adminContext = await browser.newContext({
        baseURL: owned.baseURL,
        ignoreHTTPSErrors: true,
      });
      contexts.push(adminContext);
      const memberContext = await browser.newContext({
        baseURL: owned.baseURL,
        ignoreHTTPSErrors: true,
      });
      contexts.push(memberContext);
      const adminPage = await adminContext.newPage(),
        memberPage = await memberContext.newPage();
      stage = "administrator authentication";
      await signIn(adminPage, owned.baseURL, owned.admin);
      await selectOrganization(adminPage, owned.comms.orgName);
      stage = "real member invitation";
      const memberIdentity = {
        email: `s32-member-${owned.runId}@example.test`,
        password: `S32!${randomUUID()}a9`,
      };
      const invited = await api(
        adminPage,
        owned.comms.orgId,
        "POST",
        "/api/auth/invitations",
        {
          email: memberIdentity.email,
          username: `s32-${owned.runId}`,
          display_name: "S32 Member",
          role: "member",
        },
      );
      expect(invited.status).toBe(201);
      const invitation = object(invited.payload);
      expect(invitation.delivery).toBe("email");
      const memberId = text(object(invitation.user).id);
      mail = await playwright.request.newContext({
        baseURL: owned.mailpitUrl,
        timeout: 2500,
      });
      const token = await invitationToken(
        mail,
        memberIdentity.email,
        owned.baseURL,
      );
      stage = "real invitation completion";
      const completed = await memberPage.request.post(
        `${owned.baseURL}/api/auth/invitations/complete`,
        {
          headers: { Origin: owned.baseURL },
          data: { token_hash: token, password: memberIdentity.password },
        },
      );
      expect(completed.status()).toBe(204);
      await signIn(memberPage, owned.baseURL, memberIdentity);
      stage = "owned channel setup";
      const create = async (org: string, name: string, members: string[]) => {
        const response = await api(
          adminPage,
          org,
          "POST",
          "/api/comms/conversations",
          {
            name,
            scope: "members",
            member_ids: members,
            topic: "",
            position: 0,
            category_id: null,
          },
        );
        expect(response.status).toBe(201);
        return text(object(response.payload).id);
      };
      const room = await create(owned.comms.orgId, "s32-two-account", [
        memberId,
      ]);
      const isolatedRoom = await create(
        owned.comms.otherOrgId,
        "s32-isolated",
        [],
      );
      const isolatedPage = await adminContext.newPage();
      await isolatedPage.goto(`${owned.baseURL}/openview`);
      await selectOrganization(isolatedPage, owned.comms.otherOrgName);
      const admin = {
        page: adminPage,
        id: owned.admin.id,
        orgId: owned.comms.orgId,
        name: "S32 Administrator",
        wire: observe(adminPage, owned.comms.orgId, owned.baseURL),
      };
      const member = {
        page: memberPage,
        id: memberId,
        orgId: owned.comms.orgId,
        name: "S32 Member",
        wire: observe(memberPage, owned.comms.orgId, owned.baseURL),
      };
      const isolated = {
        page: isolatedPage,
        id: owned.admin.id,
        orgId: owned.comms.otherOrgId,
        name: admin.name,
        wire: observe(isolatedPage, owned.comms.otherOrgId, owned.baseURL),
      };
      stage = "real conversation joins";
      await openRoom(admin, owned.baseURL, "s32-two-account", room);
      await openRoom(member, owned.baseURL, "s32-two-account", room);
      await openRoom(isolated, owned.baseURL, "s32-isolated", isolatedRoom);
      journey = { fixture: owned, admin, member, isolated, room, isolatedRoom };
    } catch {
      await mail?.dispose();
      await Promise.allSettled(contexts.map((context) => context.close()));
      throw new Error(
        `Owned Comms fixture failed during ${stage}; credentials and provider output suppressed`,
      );
    }
    try {
      await provide(journey);
    } finally {
      await mail?.dispose();
      await Promise.allSettled(contexts.map((context) => context.close()));
    }
  },
});

async function send(account: Account, room: string, body: string) {
  await account.page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill(body);
  const [response] = await Promise.all([
    account.page.waitForResponse(
      (reply) =>
        new URL(reply.url()).pathname ===
          `/api/comms/conversations/${room}/messages` &&
        reply.request().method() === "POST",
    ),
    account.page
      .getByRole("button", { name: "Send message", exact: true })
      .click(),
  ]);
  expect(response.status()).toBe(201);
  const message = object(await response.json());
  expect(typeof message.seq).toBe("number");
  return {
    id: text(message.id),
    seq: message.seq as number,
    replyTo: message.reply_to_id,
  };
}

async function received(
  account: Account,
  room: string,
  seq: number,
  author: string,
  body: string,
) {
  const topic = `org:${account.orgId}:conversation:${room}`;
  await expect
    .poll(() =>
      account.wire.messages.some(
        (item) => item.topic === topic && item.seq === seq,
      ),
    )
    .toBe(true);
  const article = account.page.getByRole("article", {
    name: new RegExp(`^Message ${seq}: ${author},`, "u"),
  });
  await expect(article).toContainText(body);
  // Avatar labels can repeat the name; the visible author heading follows the avatar.
  await expect(article.getByText(author, { exact: true }).last()).toBeVisible();
  return article;
}

test.setTimeout(90_000);
test("real invited accounts receive named messages and replies without crossing organization or session", async ({
  comms,
}, info) => {
  const { fixture: owned, admin, member, isolated, room, isolatedRoom } = comms;
  const proof = {
    runId: owned.runId,
    completed: false,
    rootReceived: false,
    replyReceived: false,
    secondOrgControl: false,
    foreignOrgRefused: false,
    independentLogout: false,
  };
  try {
    for (const account of [admin, member, isolated]) {
      const session = await api(
        account.page,
        account.orgId,
        "GET",
        "/api/auth/session",
      );
      expect(session.status).toBe(200);
      const state = object(session.payload);
      expect(state.authenticated).toBe(true);
      expect(state.user_id).toBe(account.id);
      expect(state.organization_id).toBe(account.orgId);
      expect(
        await account.page.evaluate(() =>
          /(?:^|;\s*)openslate_(?:access|refresh)=/u.test(document.cookie),
        ),
      ).toBe(false);
    }
    const rootBody = `Owned administrator message ${owned.runId}`;
    const root = await send(admin, room, rootBody);
    const incoming = await received(
      member,
      room,
      root.seq,
      admin.name,
      rootBody,
    );
    proof.rootReceived = true;
    await incoming.getByRole("button", { name: /^Message actions: /u }).click();
    await member.page
      .getByRole("menuitem", { name: "Reply", exact: true })
      .click();
    const replyBody = `Owned member reply ${owned.runId}`;
    const reply = await send(member, room, replyBody);
    expect(reply.replyTo).toBe(root.id);
    await received(admin, room, reply.seq, member.name, replyBody);
    const stored = await api(
      admin.page,
      admin.orgId,
      "GET",
      `/api/comms/conversations/${room}/messages/${reply.id}`,
    );
    expect(stored.status).toBe(200);
    expect(object(stored.payload).author_id).toBe(member.id);
    expect(object(stored.payload).reply_to_id).toBe(root.id);
    proof.replyReceived = true;
    const canary = await send(
      isolated,
      isolatedRoom,
      "Owned second-organization positive control",
    );
    await received(
      isolated,
      isolatedRoom,
      canary.seq,
      admin.name,
      "Owned second-organization positive control",
    );
    proof.secondOrgControl = true;
    for (const account of [admin, member, isolated])
      expect(account.wire.foreignTopic).toBe(false);
    expect(
      isolated.wire.messages.some((item) => item.topic.includes(room)),
    ).toBe(false);
    await expect(
      isolated.page.getByRole("article").filter({ hasText: rootBody }),
    ).toHaveCount(0);
    const denied = await api(
      member.page,
      isolated.orgId,
      "GET",
      `/api/comms/conversations/${room}/messages/${root.id}`,
    );
    expect(denied.status).toBe(403);
    proof.foreignOrgRefused = true;
    await member.page
      .getByRole("button", { name: "Account", exact: true })
      .click();
    await member.page
      .getByRole("menuitem", { name: "Sign out", exact: true })
      .click();
    await expect(member.page).toHaveURL(/\/login$/u);
    const signedOut = await api(
      member.page,
      member.orgId,
      "GET",
      "/api/auth/session",
    );
    expect(object(signedOut.payload).authenticated).toBe(false);
    const stillAdmin = await api(
      admin.page,
      admin.orgId,
      "GET",
      "/api/auth/session",
    );
    expect(object(stillAdmin.payload).user_id).toBe(admin.id);
    proof.independentLogout = true;
    proof.completed = true;
  } finally {
    // Real execution creates this safe evidence; preparation does not fabricate a journal.
    await info.attach("owned-comms-journey", {
      contentType: "application/json",
      body: JSON.stringify(proof),
    });
  }
});
