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

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`an Auth outage during refresh keeps the person signed in at ${viewport.width}px`, async ({
    page,
    baseURL,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const state = await workspaceWithAuthOutage(page, baseURL);
    const reconnecting = page.getByText("Reconnecting…");
    state.expired = true;
    await page
      .getByRole("searchbox", { name: "Search workspace" })
      .fill("Outage search");

    // Quiet first: the three unavailable answers take 1 + 2 + 4 seconds.
    await expect(reconnecting).toBeHidden();
    await expect(reconnecting).toBeVisible({ timeout: 6_500 });
    await expect(
      page.getByRole("status").filter({ hasText: "Reconnecting…" }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`reconnecting-${viewport.width}.png`),
    });

    await expect(page.getByText("Outage search result")).toBeVisible({
      timeout: 6_000,
    });
    await expect(reconnecting).toBeHidden();
    expect(new URL(page.url()).pathname).toBe("/platform");
    expect(state.refreshes).toBe(4);
  });
}
