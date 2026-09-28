import { expect, test } from "./helpers/test";

const userA = "00000000-0000-4000-8000-000000000101";
const userB = "00000000-0000-4000-8000-000000000201";

test("blurring during the first session check does not strand an unverified workspace", async ({
  page,
}) => {
  let signalSession = () => {};
  let releaseSession = () => {};
  const sessionStarted = new Promise<void>((resolve) => {
    signalSession = resolve;
  });
  const sessionReleased = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  await page.route("**/api/auth/session", async (route) => {
    signalSession();
    await sessionReleased;
    try {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          authenticated: true,
          user_id: userA,
          setup_required: false,
        }),
      });
    } catch {
      // The pre-fix gate aborted this request on blur.
    }
  });

  try {
    await page.goto("/platform?section=search");
    await sessionStarted;
    await expect(page.getByText("Checking your session…")).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new FocusEvent("blur")));
    releaseSession();
    await expect(page.getByRole("heading", { name: "Platform" })).toBeVisible();
  } finally {
    releaseSession();
  }
});

test("a returning tab conceals the old account before revalidation and ignores delayed old responses", async ({
  context,
  page,
}) => {
  await page.addInitScript(() => {
    class FakeEventSource extends EventTarget {
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: FakeEventSource });
  });
  let activeUser = userA;
  let holdNextSession = false;
  let releaseOldSession = () => {};
  let signalOldSession = () => {};
  const oldSessionReleased = new Promise<void>((resolve) => {
    releaseOldSession = resolve;
  });
  const oldSessionStarted = new Promise<void>((resolve) => {
    signalOldSession = resolve;
  });
  let releaseNewSession = () => {};
  let signalNewSession = () => {};
  const newSessionReleased = new Promise<void>((resolve) => {
    releaseNewSession = resolve;
  });
  const newSessionStarted = new Promise<void>((resolve) => {
    signalNewSession = resolve;
  });
  let holdNextNotice = false;
  let releaseOldNotice = () => {};
  let signalOldNotice = () => {};
  const oldNoticeReleased = new Promise<void>((resolve) => {
    releaseOldNotice = resolve;
  });
  const oldNoticeStarted = new Promise<void>((resolve) => {
    signalOldNotice = resolve;
  });

  await context.route("**/api/auth/session", async (route) => {
    const requestedUser = activeUser;
    if (holdNextSession) {
      holdNextSession = false;
      signalOldSession();
      await oldSessionReleased;
    }
    if (requestedUser === userB) {
      signalNewSession();
      await newSessionReleased;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user_id: requestedUser,
        setup_required: false,
      }),
    });
  });
  await context.route("**/api/notifications**", async (route) => {
    const requestedUser = activeUser;
    if (holdNextNotice) {
      holdNextNotice = false;
      signalOldNotice();
      await oldNoticeReleased;
    }
    const items =
      requestedUser === userA
        ? [
            {
              id: "00000000-0000-4000-8000-000000000102",
              kind: "report-run",
              report_id: "00000000-0000-4000-8000-000000000103",
              run_id: "00000000-0000-4000-8000-000000000104",
              status: "unread",
              scheduled_for: "2026-09-23T00:00:00Z",
              created_at: "2026-09-23T00:00:00Z",
              read_at: null,
            },
          ]
        : [];
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items,
        pagination: {
          limit: 25,
          offset: 0,
          count: items.length,
          total: items.length,
          has_more: false,
        },
      }),
    });
  });

  await page.goto("/platform?section=notifications");
  const notices = page.getByRole("region", { name: "Connected notifications" });
  await expect(notices.getByText("Scheduled report run")).toBeVisible();

  holdNextNotice = true;
  await notices.getByRole("button", { name: "Refresh" }).click();
  await oldNoticeStarted;
  holdNextSession = true;
  const concealedImmediately = await page.evaluate(() => {
    window.dispatchEvent(new FocusEvent("focus"));
    const modal = document.querySelector<HTMLDialogElement>(
      'dialog[aria-label="Session verification"]',
    );
    const hit = document.elementFromPoint(
      window.innerWidth / 2,
      window.innerHeight / 2,
    );
    return (
      modal?.matches(":modal") === true &&
      hit !== null &&
      (hit === modal || modal.contains(hit))
    );
  });
  expect(concealedImmediately).toBe(true);
  await oldSessionStarted;
  await expect(notices).toHaveCount(0);

  const otherTab = await context.newPage();
  await otherTab.goto("about:blank");
  activeUser = userB;
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  await newSessionStarted;
  try {
    await expect(
      page
        .getByRole("dialog", { name: "Session verification" })
        .getByText("Checking your session…"),
    ).toBeVisible();
  } finally {
    releaseOldSession();
    releaseOldNotice();
    releaseNewSession();
  }

  const currentNotices = page.getByRole("region", {
    name: "Connected notifications",
  });
  await expect(
    currentNotices.getByText("No connected notifications on this page."),
  ).toBeVisible();
  await expect(currentNotices.getByText("Scheduled report run")).toHaveCount(0);
});

test("a returning tab with a revoked session hides the workspace and redirects to login", async ({
  page,
}) => {
  let authenticated = true;
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        authenticated
          ? { authenticated: true, user_id: userA, setup_required: false }
          : { authenticated: false },
      ),
    });
  });
  await page.route("**/api/auth/refresh", async (route) => {
    await route.fulfill({ status: 401 });
  });

  await page.goto("/platform?section=search");
  await expect(page.getByRole("heading", { name: "Platform" })).toBeVisible();

  authenticated = false;
  const concealedImmediately = await page.evaluate(() => {
    window.dispatchEvent(new FocusEvent("focus"));
    const modal = document.querySelector<HTMLDialogElement>(
      'dialog[aria-label="Session verification"]',
    );
    return modal?.matches(":modal") === true;
  });
  expect(concealedImmediately).toBe(true);
  await expect(page.getByRole("heading", { name: "Platform" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/login$/);
});

test("a same-account recheck preserves an in-progress workspace input behind the privacy curtain", async ({
  page,
}) => {
  let holdNextSession = false;
  let releaseRecheck = () => {};
  let signalRecheck = () => {};
  const recheckReleased = new Promise<void>((resolve) => {
    releaseRecheck = resolve;
  });
  const recheckStarted = new Promise<void>((resolve) => {
    signalRecheck = resolve;
  });
  await page.route("**/api/auth/session", async (route) => {
    if (holdNextSession) {
      holdNextSession = false;
      signalRecheck();
      await recheckReleased;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user_id: userA,
        setup_required: false,
      }),
    });
  });

  await page.goto("/platform?section=search");
  const search = page.getByRole("searchbox", { name: "Search workspace" });
  await search.fill("unsaved search draft");
  holdNextSession = true;
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  await recheckStarted;
  await expect(
    page.getByRole("dialog", { name: "Session verification" }),
  ).toBeVisible();

  releaseRecheck();
  await expect(
    page.getByRole("dialog", { name: "Session verification" }),
  ).toBeHidden();
  await expect(search).toHaveValue("unsaved search draft");
});

test("an unavailable returning-tab check stays private through Escape and recovers on Retry", async ({
  page,
}) => {
  let available = true;
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      status: available ? 200 : 503,
      contentType: "application/json",
      body: available
        ? JSON.stringify({
            authenticated: true,
            user_id: userA,
            setup_required: false,
          })
        : JSON.stringify({ detail: "Temporary error" }),
    });
  });

  await page.goto("/platform?section=search");
  const search = page.getByRole("searchbox", { name: "Search workspace" });
  await search.fill("draft kept during outage");

  available = false;
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  const curtain = page.getByRole("dialog", { name: "Session verification" });
  await expect(
    curtain.getByText("We can’t verify your session right now."),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Platform" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(curtain).toBeVisible();

  available = true;
  await curtain.getByRole("button", { name: "Retry" }).click();
  await expect(curtain).toBeHidden();
  await expect(search).toHaveValue("draft kept during outage");
});

test("a returning tab starts a new identity check while an old refresh remains pending", async ({
  page,
}) => {
  let activeUser = userA;
  let oldSessionExpired = false;
  let signalOldRefresh = () => {};
  let releaseOldRefresh = () => {};
  const oldRefreshStarted = new Promise<void>((resolve) => {
    signalOldRefresh = resolve;
  });
  const oldRefreshReleased = new Promise<void>((resolve) => {
    releaseOldRefresh = resolve;
  });
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        oldSessionExpired
          ? { authenticated: false }
          : {
              authenticated: true,
              user_id: activeUser,
              setup_required: false,
            },
      ),
    });
  });
  await page.route("**/api/auth/refresh", async (route) => {
    signalOldRefresh();
    await oldRefreshReleased;
    await route.fulfill({ status: 401 });
  });

  await page.goto("/platform?section=search");
  const search = page.getByRole("searchbox", { name: "Search workspace" });
  await search.fill("A-only draft");

  oldSessionExpired = true;
  try {
    await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
    await oldRefreshStarted;
    const curtain = page.getByRole("dialog", {
      name: "Session verification",
    });
    await expect(curtain).toBeVisible();

    oldSessionExpired = false;
    activeUser = userB;
    await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
    await expect(curtain).toBeHidden();
    await expect(search).toHaveValue("");
  } finally {
    releaseOldRefresh();
  }
  await expect(page).toHaveURL(/\/platform\?section=search$/);
  await expect(search).toHaveValue("");
});

test("Retry starts a fresh check when the current session request never settles", async ({
  page,
}) => {
  let holdNextSession = false;
  let signalHeldSession = () => {};
  let releaseHeldSession = () => {};
  const heldSessionStarted = new Promise<void>((resolve) => {
    signalHeldSession = resolve;
  });
  const heldSessionReleased = new Promise<void>((resolve) => {
    releaseHeldSession = resolve;
  });
  await page.route("**/api/auth/session", async (route) => {
    if (holdNextSession) {
      holdNextSession = false;
      signalHeldSession();
      await heldSessionReleased;
    }
    try {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          authenticated: true,
          user_id: userA,
          setup_required: false,
        }),
      });
    } catch {
      // A superseded browser request may already have been aborted.
    }
  });

  await page.goto("/platform?section=search");
  const search = page.getByRole("searchbox", { name: "Search workspace" });
  await search.fill("still editing");
  holdNextSession = true;
  try {
    await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
    await heldSessionStarted;
    const curtain = page.getByRole("dialog", {
      name: "Session verification",
    });
    await curtain.getByRole("button", { name: "Retry session check" }).click();
    await expect(curtain).toBeHidden();
    await expect(search).toHaveValue("still editing");
  } finally {
    releaseHeldSession();
  }
});
