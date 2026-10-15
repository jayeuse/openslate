import { expect, test, type Page, isEventStream } from "./helpers/test";

import { accessDraftStorageKey } from "../../src/components/systems/access/state/draft-journal-storage";

const userA = "00000000-0000-4000-8000-0000000000a1";
const userB = "00000000-0000-4000-8000-0000000000b2";
const draftA = accessDraftStorageKey(userA, "identity");
const draftB = accessDraftStorageKey(userB, "identity");

async function mockSession(page: Page, verifiedUser: () => string) {
  // A completed logout ends the session, so /login keeps its form instead of
  // sending a still-authenticated session back to its start page.
  let signedOut = false;
  await page.route("**/api/**", async (route) => {
    if (isEventStream(route)) return route.fallback();
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/auth/session") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          signedOut
            ? { authenticated: false }
            : {
                authenticated: true,
                user_id: verifiedUser(),
                setup_required: false,
              },
        ),
      });
      return;
    }
    if (pathname === "/api/auth/logout") {
      signedOut = true;
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: "{}",
    });
  });
}

test("a verified reload keeps only the current account's Access drafts", async ({
  page,
}) => {
  await mockSession(page, () => userB);
  await page.addInitScript(
    ([keyA, keyB]) => {
      sessionStorage.setItem(keyA, "A draft");
      sessionStorage.setItem(keyB, "B draft");
    },
    [draftA, draftB],
  );

  await page.goto("/manage");
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate((key) => sessionStorage.getItem(key), draftA))
    .toBeNull();
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), draftB),
  ).toBe("B draft");
});

test("logout with a failed draft cleanup stays on a recovery screen", async ({
  page,
}) => {
  await mockSession(page, () => userA);
  let logoutAccepted = false;
  let logoutRequests = 0;
  let endedSessionChecks = 0;
  await page.route("**/api/auth/logout", async (route) => {
    logoutRequests += 1;
    logoutAccepted = true;
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/auth/session", async (route) => {
    if (logoutAccepted) endedSessionChecks += 1;
    await route.fulfill({
      json: logoutAccepted
        ? { authenticated: false }
        : {
            authenticated: true,
            user_id: userA,
            setup_required: false,
          },
    });
  });
  await page.goto("/manage");
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
  await page.evaluate((key) => {
    sessionStorage.setItem(key, "A draft");
    const remove = Storage.prototype.removeItem;
    (
      window as Window & { restoreDraftStorage?: () => void }
    ).restoreDraftStorage = () => {
      Storage.prototype.removeItem = remove;
    };
    Storage.prototype.removeItem = function (candidate) {
      if (candidate === key) throw new Error("Storage cleanup failed");
      return remove.call(this, candidate);
    };
  }, draftA);

  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: /could not clear saved Access drafts/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(
    page.getByRole("heading", { name: "Signed out", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry clearing drafts" }),
  ).toBeVisible();
  expect(endedSessionChecks).toBe(0);
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), draftA),
  ).toBe("A draft");

  await page.evaluate(() => {
    (
      window as Window & { restoreDraftStorage?: () => void }
    ).restoreDraftStorage?.();
  });
  await page.getByRole("button", { name: "Retry clearing drafts" }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(logoutRequests).toBe(1);
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), draftA),
  ).toBeNull();
});

test("normal logout clears Access drafts before opening sign-in", async ({
  page,
}) => {
  await mockSession(page, () => userA);
  await page.goto("/manage");
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
  await page.evaluate((key) => sessionStorage.setItem(key, "A draft"), draftA);

  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), draftA),
  ).toBeNull();
});

test("switching verified accounts clears unfinished Access drafts in the tab", async ({
  page,
}) => {
  let currentUser = userA;
  await mockSession(page, () => currentUser);
  await page.goto("/manage");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await expect(navigation).toBeVisible();
  await page.evaluate(
    ([keyA, keyB]) => {
      sessionStorage.setItem(keyA, "A draft");
      sessionStorage.setItem(keyB, "B draft");
    },
    [draftA, draftB],
  );

  currentUser = userB;
  await navigation
    .getByRole("button", { name: "Platform", exact: true })
    .click();
  await navigation.getByRole("link", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/\/platform/);
  await expect
    .poll(() => page.evaluate((key) => sessionStorage.getItem(key), draftA))
    .toBeNull();
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), draftB),
  ).toBeNull();
});

test("a failed draft cleanup blocks an account switch and explains recovery", async ({
  page,
}) => {
  let currentUser = userA;
  await mockSession(page, () => currentUser);
  await page.goto("/manage");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await expect(navigation).toBeVisible();
  await page.evaluate((key) => {
    sessionStorage.setItem(key, "A draft");
  }, draftA);
  await page.evaluate((key) => {
    const remove = Storage.prototype.removeItem;
    (
      window as Window & { restoreDraftStorage?: () => void }
    ).restoreDraftStorage = () => {
      Storage.prototype.removeItem = remove;
    };
    Storage.prototype.removeItem = function (candidate) {
      if (candidate === key) throw new Error("Storage cleanup failed");
      return remove.call(this, candidate);
    };
  }, draftA);

  currentUser = userB;
  await navigation
    .getByRole("button", { name: "Platform", exact: true })
    .click();
  await navigation.getByRole("link", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/\/platform/);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: /could not clear saved Access drafts/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), draftA),
  ).toBe("A draft");
  await page.evaluate(() => {
    (
      window as Window & { restoreDraftStorage?: () => void }
    ).restoreDraftStorage?.();
  });
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), draftA),
  ).toBeNull();
});

test("an invalid session after reload clears Access drafts before sign-in", async ({
  page,
}) => {
  await page.route("**/api/**", async (route) => {
    if (isEventStream(route)) return route.fallback();
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/auth/session") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ authenticated: false }),
      });
      return;
    }
    if (pathname === "/api/auth/refresh") {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: "{}",
      });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: "{}",
    });
  });
  await page.addInitScript((key) => {
    if (location.pathname === "/manage") sessionStorage.setItem(key, "A draft");
  }, draftA);

  await page.goto("/manage");
  await expect(page).toHaveURL(/\/login$/);
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), draftA),
  ).toBeNull();
});
