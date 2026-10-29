import {
  authMeBody,
  expect,
  heldResponse,
  quietEventSource,
  test,
  type Page,
} from "./helpers/test";
import { pageOf } from "../helpers/pagination";

const userA = "00000000-0000-4000-8000-000000000001";
const userB = "00000000-0000-4000-8000-000000000002";
const minute = 60_000;
const idleLifetime = 15 * minute;

test.use({ trace: "off", screenshot: "off", video: "off" });

// This HTTP fixture models the existing server boundary: probes never renew,
// refresh rejects an expired/revoked local session, and cached provider access
// still renews local expiry. It does not mock the client activity/coordinator.
async function workspaceSession(page: Page, baseURL: string | undefined) {
  if (!baseURL) throw new Error("HTTP browser baseURL is required");
  const start = new Date("2026-10-05T09:00:00Z");
  const state = {
    now: start.getTime(),
    userId: userA,
    expiresAt: start.getTime() + idleLifetime,
    accessExpiresAt: start.getTime() + idleLifetime,
    revoked: false,
    sessionFailure: 0,
    renewedUsers: [] as string[],
  };
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(state.now + 1_000));
  await page.context().addCookies([
    {
      name: "openslate_csrf",
      value: "owned-activity-csrf",
      url: baseURL,
    },
  ]);
  await quietEventSource(page);
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      status: state.sessionFailure || 200,
      json: state.sessionFailure
        ? { detail: "Authentication unavailable" }
        : !state.revoked &&
            state.now < state.expiresAt &&
            state.now < state.accessExpiresAt
          ? {
              authenticated: true,
              user_id: state.userId,
              default_organization_blocked: null,
              setup_required: false,
            }
          : { authenticated: false },
    }),
  );
  await page.route("**/api/auth/refresh", (route) => {
    if (route.request().headers()["x-csrf-token"] !== "owned-activity-csrf")
      return route.fulfill({ status: 403, json: { detail: "CSRF required" } });
    if (state.revoked || state.now >= state.expiresAt)
      return route.fulfill({
        status: 401,
        json: { detail: "Invalid session" },
      });
    state.renewedUsers.push(state.userId);
    state.expiresAt = state.now + idleLifetime;
    if (state.accessExpiresAt <= state.now + 30_000)
      state.accessExpiresAt = state.now + idleLifetime;
    return route.fulfill({
      json: { authenticated: true, setup_required: false },
    });
  });
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: authMeBody({
        id: state.userId,
        role: "admin",
        access: [],
        default_organization_blocked: null,
      }),
    }),
  );
  await page.route("**/api/search?**", (route) => {
    if (
      state.revoked ||
      state.now >= state.expiresAt ||
      state.now >= state.accessExpiresAt
    )
      return route.fulfill({
        status: 401,
        json: { detail: "Invalid session" },
      });
    const params = new URL(route.request().url()).searchParams;
    const items =
      params.get("kind") === "person"
        ? [
            {
              kind: "person",
              id: userA,
              title: `${params.get("search")} result`,
              context_label: "Owned activity test",
              module_id: null,
              board_id: null,
              can_open: false,
            },
          ]
        : [];
    return route.fulfill({
      json: pageOf(items, { limit: 10 }),
    });
  });
  await page.goto("/platform?section=search");
  await expect(
    page.getByRole("heading", { name: "Platform", exact: true }),
  ).toBeVisible();
  return {
    state,
    search: page.getByRole("searchbox", { name: "Search workspace" }),
    advance: async (minutes: number) => {
      state.now += minutes * minute;
      await page.clock.fastForward(minutes * minute);
    },
  };
}

test("trusted activity keeps a workspace usable beyond its original 15-minute deadline, then idle expiry signs out", async ({
  page,
  baseURL,
}) => {
  const { state, search, advance } = await workspaceSession(page, baseURL);
  const expiredAccessEvents: string[] = [];
  const initialAccessExpiry = state.accessExpiresAt;
  let releaseExpiredRefresh = () => {};
  const expiredSearchRefused = new Promise<void>((resolve) => {
    releaseExpiredRefresh = resolve;
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (
      url.pathname === "/api/search" &&
      url.searchParams.get("search") === "Eighteen minute search" &&
      url.searchParams.get("kind") === "person"
    ) {
      expiredAccessEvents.push(`search:${response.status()}`);
      if (response.status() === 401) releaseExpiredRefresh();
    } else if (
      url.pathname === "/api/auth/refresh" &&
      state.now >= initialAccessExpiry
    ) {
      expiredAccessEvents.push(`refresh:${response.status()}`);
    }
  });
  // Let the real protected fetch receive expired provider access before the
  // held server refresh renews it. Keep the client coordinator unmocked.
  await page.route("**/api/auth/refresh", async (route) => {
    if (state.now >= state.accessExpiresAt) await expiredSearchRefused;
    await route.fallback();
  });
  async function completeSearch(value: string, activity: () => Promise<void>) {
    const renewalsBefore = state.renewedUsers.length;
    const activityRefresh =
      state.now < initialAccessExpiry
        ? page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === "/api/auth/refresh" &&
              response.ok(),
          )
        : null;
    const response = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/search" &&
        url.searchParams.get("search") === value &&
        url.searchParams.get("kind") === "person" &&
        response.ok()
      );
    });
    await search.fill(value);
    await activity();
    await page.clock.runFor(400);
    if (activityRefresh)
      await Promise.all([
        activityRefresh.then((completed) => completed.finished()),
        expect
          .poll(async () => {
            await page.clock.runFor(1);
            return state.renewedUsers.length;
          })
          .toBeGreaterThan(renewalsBefore),
      ]);
    // A protected fetch can first refuse expired access. Wait for its accepted
    // retry while progressing query notification timers within normal timeout.
    await Promise.all([
      response.then((completed) => completed.finished()),
      expect
        .poll(async () => {
          await page.clock.runFor(1);
          return page.getByText(`${value} result`, { exact: true }).count();
        })
        .toBe(1),
    ]);
    await expect(
      page.getByText(`${value} result`, { exact: true }),
    ).toBeVisible();
  }
  await advance(6);
  await completeSearch("Six minute search", () => search.press("ArrowRight"));
  await advance(6);
  await completeSearch("Twelve minute search", () => page.mouse.wheel(0, 10));
  await advance(6);
  await completeSearch("Eighteen minute search", () => search.click());
  expect(expiredAccessEvents).toEqual([
    "search:401",
    "refresh:200",
    "search:200",
  ]);
  await expect(search).toHaveValue("Eighteen minute search");
  await expect(
    page.getByRole("heading", { name: "Platform", exact: true }),
  ).toBeVisible();

  await advance(16);
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("heading", { name: "Platform", exact: true }),
  ).toHaveCount(0);
  expect(state.renewedUsers.every((userId) => userId === userA)).toBe(true);
});

test("rapid trusted inputs share a bounded renewal instead of flooding refresh", async ({
  page,
  baseURL,
}) => {
  const { state, search, advance } = await workspaceSession(page, baseURL);
  await advance(6);
  await Promise.all([
    page.waitForResponse("**/api/auth/refresh"),
    search.press("ArrowRight"),
  ]);
  await search.click();
  await search.press("ArrowLeft");
  await page.mouse.wheel(0, 10);
  await advance(4);
  await search.press("ArrowRight");
  expect(state.renewedUsers).toEqual([userA]);
  await advance(2);
  await Promise.all([
    page.waitForResponse("**/api/auth/refresh"),
    search.press("ArrowLeft"),
  ]);
  expect(state.renewedUsers).toEqual([userA, userA]);
});

test("an API request sharing a pending activity probe still refreshes a live session with expired access", async ({
  page,
  baseURL,
}) => {
  const { state, search, advance } = await workspaceSession(page, baseURL);
  await advance(6);
  state.accessExpiresAt = state.now;
  const probe = heldResponse();
  let holdNext = true;
  await page.route("**/api/auth/session", async (route) => {
    if (holdNext) {
      holdNext = false;
      probe.enter();
      await probe.released;
    }
    await route.fulfill({
      json:
        state.now < state.accessExpiresAt
          ? {
              authenticated: true,
              user_id: userA,
              setup_required: false,
              default_organization_blocked: null,
            }
          : { authenticated: false },
    });
  });
  await search.press("ArrowRight");
  await probe.entered;
  const retriedSearch = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/search" &&
      url.searchParams.get("kind") === "person" &&
      response.ok()
    );
  });
  try {
    const response = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/search" &&
        response.status() === 401,
    );
    await search.fill("Concurrent protected search");
    await page.clock.runFor(400);
    await response;
    await page.clock.runFor(1);
  } finally {
    probe.release();
  }
  await retriedSearch;
  await page.clock.runFor(1);
  await expect(
    page.getByText("Concurrent protected search result", { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/platform\?section=search$/);
  expect(state.renewedUsers).toEqual([userA]);
});

test("passive viewing, probes, focus and synthetic input do not renew an idle workspace", async ({
  page,
  baseURL,
}) => {
  const { state, advance } = await workspaceSession(page, baseURL);
  await advance(6);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
  });
  await page.keyboard.press("ArrowRight");
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "visibilityState");
  });
  await page.evaluate(async () => {
    document.dispatchEvent(new PointerEvent("pointerdown"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    document.dispatchEvent(new WheelEvent("wheel"));
    await fetch("/api/auth/session");
    window.dispatchEvent(new FocusEvent("focus"));
  });
  await expect(
    page.getByRole("dialog", { name: "Session verification" }),
  ).toBeHidden();
  await advance(10);
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  await expect(page).toHaveURL(/\/login$/);
  expect(state.renewedUsers).toEqual([]);
});

test("a queued activity renewal is cancelled when the account changes behind the session gate", async ({
  page,
  baseURL,
}) => {
  const { state, search, advance } = await workspaceSession(page, baseURL);
  await page.evaluate(() => {
    const scope = window as unknown as { releaseRefresh?: () => void };
    void navigator.locks.request("openslate-auth-refresh", async () => {
      await new Promise<void>((resolve) => {
        scope.releaseRefresh = resolve;
      });
    });
  });
  await advance(6);
  // A draft typed as account A is gone once the workspace remounts for B.
  await search.fill("Account A search");
  await search.press("ArrowRight");
  state.userId = userB;
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  // Account B's workspace starts its own renewal interval now, at minute 6;
  // the clock must not move before it is mounted.
  await expect(search).toHaveValue("");
  await expect(
    page.getByRole("dialog", { name: "Session verification" }),
  ).toBeHidden();
  // The renewal queued for account A runs once the lock is free and must not
  // refresh; the lock queue is in order, so a later request waits for it.
  await page.evaluate(async () => {
    (window as unknown as { releaseRefresh: () => void }).releaseRefresh();
    await navigator.locks.request("openslate-auth-refresh", async () => {});
  });
  expect(state.renewedUsers).toEqual([]);
  await advance(6);
  await Promise.all([
    page.waitForResponse("**/api/auth/refresh"),
    search.press("ArrowRight"),
  ]);
  expect(state.renewedUsers).toEqual([userB]);
});

test("revocation discovered during trusted activity does not revive the session", async ({
  page,
  baseURL,
}) => {
  const { state, search, advance } = await workspaceSession(page, baseURL);
  await advance(6);
  state.revoked = true;
  await search.press("ArrowRight");
  await expect(page).toHaveURL(/\/login$/);
  expect(state.renewedUsers).toEqual([]);
});
