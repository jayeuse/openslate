import {
  authMeBody,
  expect,
  quietEventSource,
  test,
  type Page,
} from "./helpers/test";
import { pageOf } from "../helpers/pagination";

const userId = "00000000-0000-4000-8000-000000000001";

test.use({ trace: "off", video: "off" });

// Live seven-pack run: a short Auth outage answered the session refresh with 503
// and the browser signed the person out. The server now keeps the session, so the
// browser retries quietly and shows "Reconnecting…" only after 5 seconds.
async function workspaceWithAuthOutage(page: Page, baseURL?: string) {
  if (!baseURL) throw new Error("HTTP browser baseURL is required");
  const state = { expired: false, unavailableRefreshes: 3, refreshes: 0 };
  await page
    .context()
    .addCookies([
      { name: "openslate_csrf", value: "reconnect-csrf", url: baseURL },
    ]);
  await quietEventSource(page);
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: state.expired
        ? { authenticated: false }
        : {
            authenticated: true,
            user_id: userId,
            default_organization_blocked: null,
            setup_required: false,
          },
    }),
  );
  await page.route("**/api/auth/refresh", (route) => {
    state.refreshes += 1;
    if (state.unavailableRefreshes > 0) {
      state.unavailableRefreshes -= 1;
      return route.fulfill({
        status: 503,
        headers: { "Retry-After": "1" },
        json: { detail: "Authentication service unavailable" },
      });
    }
    state.expired = false;
    return route.fulfill({
      json: { authenticated: true, setup_required: false },
    });
  });
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: authMeBody({
        id: userId,
        role: "admin",
        access: [],
        default_organization_blocked: null,
      }),
    }),
  );
  await page.route("**/api/search?**", (route) => {
    if (state.expired)
      return route.fulfill({ status: 401, json: { detail: "Expired" } });
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({
      json: pageOf(
        params.get("kind") === "person"
          ? [
              {
                kind: "person",
                id: userId,
                title: `${params.get("search")} result`,
                context_label: "Reconnect test",
                module_id: null,
                board_id: null,
                can_open: false,
              },
            ]
          : [],
        { limit: 10 },
      ),
    });
  });
  await page.goto("/platform?section=search");
  await expect(
    page.getByRole("heading", { name: "Platform", exact: true }),
  ).toBeVisible();
  return state;
}

// The page's clock is paused so the retry waits (1, 2 and 4 seconds) and the
// 5 second quiet time pass on demand. Each step waits until the browser has the
// refresh answer, so its next wait starts at a known time.
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`an Auth outage during refresh keeps the person signed in at ${viewport.width}px`, async ({
    page,
    baseURL,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.clock.install();
    const state = await workspaceWithAuthOutage(page, baseURL);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
    const reconnecting = page.getByText("Reconnecting…");
    const refreshAnswer = () => page.waitForResponse("**/api/auth/refresh");
    state.expired = true;

    // The first unavailable answer starts the outage at time zero.
    let answer = refreshAnswer();
    const search = page.getByRole("searchbox", { name: "Search workspace" });
    await search.fill("Outage search");
    await expect(search).toHaveValue("Outage search");
    await page.clock.runFor(250); // The search waits 250 ms for typing to settle.
    expect((await answer).status()).toBe(503);
    await expect(reconnecting).toBeHidden();

    // Quiet first: the second and third answers come at 1 and 3 seconds.
    for (const wait of [1_000, 2_000]) {
      answer = refreshAnswer();
      await page.clock.runFor(wait);
      expect((await answer).status()).toBe(503);
      await expect(reconnecting).toBeHidden();
    }
    await page.clock.runFor(1_999);
    await expect(reconnecting).toBeHidden();

    // At 5 seconds the page says so, as a status.
    await page.clock.runFor(1);
    await expect(
      page.getByRole("status").filter({ hasText: "Reconnecting…" }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`reconnecting-${viewport.width}.png`),
    });

    // The fourth refresh, 4 seconds after the third, succeeds; the search runs.
    answer = refreshAnswer();
    await page.clock.runFor(2_001);
    expect((await answer).status()).toBe(200);
    await page.clock.resume();
    await expect(page.getByText("Outage search result")).toBeVisible();
    await expect(reconnecting).toBeHidden();
    expect(new URL(page.url()).pathname).toBe("/platform");
    expect(state.refreshes).toBe(4);
  });
}
