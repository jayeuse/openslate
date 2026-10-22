// Shared owned fixture and helpers for the real two-account Comms specs: the functional
// journey (comms-two-account.spec.ts) and the long-bound measurements
// (comms-measurements.spec.ts). No routes, mock transports, seeded messages, saved
// cookie state or auth trace artifacts.
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  expect,
  test as base,
  type APIRequestContext,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

export type Identity = { id: string; email: string; password: string };
export type OwnedFixture = {
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
export type Observations = {
  sockets: number;
  sse: boolean;
  sseStatuses: number[];
  joined: Set<string>;
  foreignTopic: boolean;
  closed: number;
  messages: { topic: string; seq: number; at: number }[];
};
export type Account = {
  context: BrowserContext;
  page: Page;
  id: string;
  orgId: string;
  name: string;
  wire: Observations;
};
// Names keep each spec's member and channels distinct when both run in one stack.
export type JourneyNames = {
  slug: string;
  member: string;
  room: string;
  lobby: string;
  isolated: string;
};
export type Journey = {
  fixture: OwnedFixture;
  names: JourneyNames;
  admin: Account;
  member: Account;
  isolated: Account;
  room: string;
  lobby: string;
  isolatedRoom: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new Error("Owned response omitted a required string");
  return value;
}
export function object(value: unknown): Record<string, unknown> {
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

export async function api(
  page: Page,
  orgId: string,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
) {
  // Browser fetch supplies real cookies/Origin; CSRF never leaves this evaluation result.
  // Like apiFetch(), an expired access cookie is refreshed once through /api/auth/refresh.
  return page.evaluate(
    async ({ organization, verb, endpoint, data, added }) => {
      const csrf = () => {
        const cookie = document.cookie
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith("openslate_csrf="));
        return cookie
          ? decodeURIComponent(cookie.slice("openslate_csrf=".length))
          : undefined;
      };
      const call = () => {
        const headers: Record<string, string> = {
          "X-Org": organization,
          ...added,
        };
        if (data !== undefined) headers["Content-Type"] = "application/json";
        const token = csrf();
        if (token && verb !== "GET") headers["X-CSRF-Token"] = token;
        return fetch(endpoint, {
          method: verb,
          headers,
          credentials: "same-origin",
          cache: "no-store",
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        });
      };
      let response = await call();
      let refreshed = false;
      if (response.status === 401) {
        // Same protocol as apiFetch(): one refresh at a time per browser, after a
        // session recheck, so this helper never races the app's token rotation.
        const renew = async () => {
          const session = await fetch("/api/auth/session", {
            credentials: "same-origin",
            cache: "no-store",
          });
          const state: unknown = session.ok ? await session.json() : null;
          if (
            state &&
            typeof state === "object" &&
            "authenticated" in state &&
            state.authenticated === true
          )
            return true;
          const token = csrf();
          const refresh = await fetch("/api/auth/refresh", {
            method: "POST",
            headers: token ? { "X-CSRF-Token": token } : {},
            credentials: "same-origin",
            cache: "no-store",
          });
          return refresh.ok;
        };
        refreshed = await navigator.locks.request(
          "openslate-auth-refresh",
          { mode: "exclusive" },
          renew,
        );
        if (refreshed) response = await call();
      }
      let payload: unknown = null;
      if (response.status !== 204) {
        try {
          payload = await response.json();
        } catch {
          /* status is the oracle */
        }
      }
      return {
        status: response.status,
        payload,
        etag: response.headers.get("etag"),
        refreshed,
      };
    },
    {
      organization: orgId,
      verb: method,
      endpoint: path,
      data: body,
      added: extra,
    },
  );
}

async function signIn(
  page: Page,
  origin: string,
  identity: Pick<Identity, "email" | "password">,
  workspace: RegExp,
  organization: string,
) {
  // API login shares this context's cookie jar; never print a request/response on auth failure.
  try {
    const response = await page.request.post(`${origin}/api/auth/login`, {
      headers: { Origin: origin },
      data: { email: identity.email, password: identity.password },
    });
    if (response.status() !== 200) throw new Error("login refused");
    await page.goto(`${origin}/openview`);
    // The shell names its landmark after the active organization's display name.
    // An account in several organizations without an active one chooses first.
    const landmark = page.getByLabel(workspace);
    const gate = page.getByRole("heading", { name: "Choose an organization" });
    await expect(landmark.or(gate)).toBeVisible();
    if (await gate.isVisible())
      await page
        .getByRole("button", { name: new RegExp(`^${organization} `, "u") })
        .click();
    await expect(landmark).toBeVisible();
  } catch (error) {
    // Path and visible headings only: never the request, response or cookies.
    const reason =
      error instanceof Error && error.message === "login refused"
        ? "login refused"
        : `workspace not shown at ${new URL(page.url()).pathname}; ${(
            await page
              .locator("h1, h2, [role=alert], [aria-label$=' workspace']")
              .evaluateAll((nodes) =>
                nodes
                  .map(
                    (node) =>
                      node.getAttribute("aria-label") ??
                      node.textContent?.trim(),
                  )
                  .join(" | "),
              )
              .catch(() => "no snapshot")
          ).slice(0, 160)}`;
    throw new Error(`Owned account sign-in did not complete (${reason})`);
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
      { intervals: [100, 250, 500] },
    )
    .toBe(true);
  if (!token) throw new Error("Owned invitation mail was not captured");
  return token;
}

export function observe(page: Page, org: string, origin: string): Observations {
  const result: Observations = {
    sockets: 0,
    sse: false,
    sseStatuses: [],
    joined: new Set(),
    foreignTopic: false,
    closed: 0,
    messages: [],
  };
  // One SSE stream per account and organization, owned by a leader tab (connection set).
  page.context().on("response", (response) => {
    const url = new URL(response.url());
    if (
      url.origin !== origin ||
      url.pathname !== "/api/events" ||
      url.searchParams.get("org") !== org
    )
      return;
    result.sseStatuses.push(response.status());
    if (response.status() === 200) result.sse = true;
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
    // A new socket must join again; earlier joins prove nothing about it.
    result.joined.clear();
    socket.on("close", () => {
      result.closed += 1;
    });
    socket.on("framereceived", ({ payload }) => ingest(result, org, payload));
  });
  return result;
}

// Receive-only: never inspect outbound joins/access tokens or retain raw frames.
export function ingest(
  result: Observations,
  org: string,
  payload: string | Buffer,
) {
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
    result.messages.push({
      topic,
      seq: frame.payload.payload.seq,
      at: Date.now(),
    });
  }
}

async function openRoom(
  account: Account,
  origin: string,
  name: string,
  room: string,
) {
  await account.page.goto(`${origin}/comms`);
  await account.page
    .getByRole("button", { name: new RegExp(`^${name}(,|$)`, "u") })
    .click();
  await expect(
    account.page.getByRole("heading", { name, exact: true }),
  ).toBeVisible();
  try {
    await expect
      .poll(() =>
        account.wire.joined.has(`org:${account.orgId}:conversation:${room}`),
      )
      .toBe(true);
  } catch {
    // Topic kinds and counts only; ids, frames and tokens stay out of the error.
    const kinds = [...account.wire.joined].map((topic) =>
      topic === `org:${account.orgId}:conversation:${room}`
        ? "this-room"
        : (topic.split(":")[2] ?? "other"),
    );
    throw new Error(
      `${name} join not observed: sockets=${account.wire.sockets} closed=${account.wire.closed} sse=${account.wire.sse} joined=[${kinds.join(",")}]`,
    );
  }
}

export function commsTest(names: JourneyNames) {
  return base.extend<{ comms: Journey }>({
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
        const workspace = new RegExp(
          `^(?:${owned.comms.orgName}|${owned.comms.otherOrgName}) workspace$`,
          "u",
        );
        await signIn(
          adminPage,
          owned.baseURL,
          owned.admin,
          workspace,
          owned.comms.orgName,
        );
        await selectOrganization(adminPage, owned.comms.orgName);
        stage = "real member invitation";
        const memberIdentity = {
          email: `s32-${names.slug}-${owned.runId}@example.test`,
          password: `S32!${randomUUID()}a9`,
        };
        const invited = await api(
          adminPage,
          owned.comms.orgId,
          "POST",
          "/api/auth/invitations",
          {
            email: memberIdentity.email,
            username: `s32-${names.slug}-${owned.runId}`,
            display_name: names.member,
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
        await signIn(
          memberPage,
          owned.baseURL,
          memberIdentity,
          workspace,
          owned.comms.orgName,
        );
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
        const room = await create(owned.comms.orgId, names.room, [memberId]);
        // A second shared channel lets the member stand outside the measured room.
        const lobby = await create(owned.comms.orgId, names.lobby, [memberId]);
        const isolatedRoom = await create(
          owned.comms.otherOrgId,
          names.isolated,
          [],
        );
        const isolatedPage = await adminContext.newPage();
        await isolatedPage.goto(`${owned.baseURL}/openview`);
        await selectOrganization(isolatedPage, owned.comms.otherOrgName);
        const admin = {
          context: adminContext,
          page: adminPage,
          id: owned.admin.id,
          orgId: owned.comms.orgId,
          name: "S32 Administrator",
          wire: observe(adminPage, owned.comms.orgId, owned.baseURL),
        };
        const member = {
          context: memberContext,
          page: memberPage,
          id: memberId,
          orgId: owned.comms.orgId,
          name: names.member,
          wire: observe(memberPage, owned.comms.orgId, owned.baseURL),
        };
        const isolated = {
          context: adminContext,
          page: isolatedPage,
          id: owned.admin.id,
          orgId: owned.comms.otherOrgId,
          name: admin.name,
          wire: observe(isolatedPage, owned.comms.otherOrgId, owned.baseURL),
        };
        stage = "real conversation joins";
        await openRoom(admin, owned.baseURL, names.room, room);
        await openRoom(member, owned.baseURL, names.room, room);
        await openRoom(isolated, owned.baseURL, names.isolated, isolatedRoom);
        journey = {
          fixture: owned,
          names,
          admin,
          member,
          isolated,
          room,
          lobby,
          isolatedRoom,
        };
      } catch (error) {
        await mail?.dispose();
        await Promise.allSettled(contexts.map((context) => context.close()));
        // First line only, with any owned password shape removed; never a response body.
        const reason = (error instanceof Error ? error.message : "")
          .split("\n")[0]!
          .replaceAll(owned.admin.password, "[redacted]")
          .replace(/S32![0-9a-f-]+a9/giu, "[redacted]")
          .slice(0, 200);
        throw new Error(
          `Owned Comms fixture failed during ${stage} (${reason}); credentials and provider output suppressed`,
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
}

export function roomPage(account: Account, origin: string, room: string) {
  return account.page.goto(`${origin}/comms?conversation=${room}`);
}

export async function focusRoom(
  account: Account,
  origin: string,
  name: string,
  room: string,
) {
  await roomPage(account, origin, room);
  await expect(
    account.page.getByRole("heading", { name, exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      account.wire.joined.has(`org:${account.orgId}:conversation:${room}`),
    )
    .toBe(true);
}

// Client-side return to the room: a full reload per step would request a new Realtime
// token each time, which the token rate limit (correctly) refuses in bursts.
export async function showRoom(account: Account, name: string, room: string) {
  await account.page.keyboard.press("Escape");
  const heading = account.page.getByRole("heading", { name, exact: true });
  const composer = account.page.getByRole("textbox", {
    name: "Message",
    exact: true,
  });
  if (!(await heading.isVisible()) || !(await composer.isVisible()))
    await account.page
      .getByRole("button", { name: new RegExp(`^${name}(,|$)`, "u") })
      .click();
  await expect(heading).toBeVisible();
  await expect(composer).toBeVisible();
  await expect
    .poll(() =>
      account.wire.joined.has(`org:${account.orgId}:conversation:${room}`),
    )
    .toBe(true);
}

export async function send(account: Account, room: string, body: string) {
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
    mentions: message.mention_user_ids,
  };
}

export async function received(
  account: Account,
  room: string,
  seq: number,
  author: string,
  body: string,
) {
  const topic = `org:${account.orgId}:conversation:${room}`;
  // The accessible name carries the author even when a grouped message hides its header.
  const article = account.page.getByRole("article", {
    name: new RegExp(`^Message ${seq}: ${author},`, "u"),
  });
  try {
    await expect
      .poll(() =>
        account.wire.messages.some(
          (item) => item.topic === topic && item.seq === seq,
        ),
      )
      .toBe(true);
  } catch {
    const rendered = await article.count();
    throw new Error(
      `no live frame for seq ${seq} on ${account.name}: sockets=${account.wire.sockets} closed=${account.wire.closed} joined-room=${account.wire.joined.has(topic)} article-rendered=${rendered}`,
    );
  }
  await expect(article).toContainText(body);
  return article;
}

// The root by sequence: a reply's quote also contains the root's text.
export function rootArticle(account: Account, seq: number) {
  return account.page.getByRole("article", {
    name: new RegExp(`^Message ${seq}: `, "u"),
  });
}

export function articleWith(account: Account, body: string) {
  return account.page.getByRole("article").filter({ hasText: body });
}

export async function messageAction(
  article: Locator,
  page: Page,
  action: string,
) {
  await article.getByRole("button", { name: /^Message actions: /u }).click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}

// D19 allows 20 committed sends per author per 10 s; keep each author at 15.
export async function paced(history: number[]) {
  const recent = history.filter((at) => Date.now() - at < 10_000);
  if (recent.length >= 15)
    await new Promise((resolve) =>
      setTimeout(resolve, 10_000 - (Date.now() - recent[0]!) + 50),
    );
  history.push(Date.now());
}

export type Step = {
  name: string;
  status: "passed" | "failed";
  ms: number;
  data?: unknown;
  error?: string;
};

// Per-step numeric proof in a stable results file; a failed step is recorded and the
// remaining steps still run, so one run reports every item.
export function proofRecorder(runId: string, fileName: string) {
  const directory = join("test-results", "s32", runId);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, fileName);
  const proof = {
    runId,
    startedAt: new Date().toISOString(),
    steps: [] as Step[],
  };
  const failed: string[] = [];
  const write = () => writeFileSync(file, JSON.stringify(proof, null, 2));
  async function step(name: string, run: () => Promise<unknown>) {
    const started = Date.now();
    try {
      const data = await run();
      proof.steps.push({
        name,
        status: "passed",
        ms: Date.now() - started,
        data,
      });
    } catch (error) {
      failed.push(name);
      proof.steps.push({
        name,
        status: "failed",
        ms: Date.now() - started,
        error: (error instanceof Error ? error.message : String(error)).slice(
          0,
          800,
        ),
      });
    }
    write();
  }
  function finish() {
    proof.steps.push({
      name: "summary",
      status: failed.length ? "failed" : "passed",
      ms: 0,
      data: { failed },
    });
    write();
    return failed;
  }
  return { proof, step, write, finish };
}
