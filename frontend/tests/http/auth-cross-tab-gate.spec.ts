import { expect, test } from "./helpers/test";
import { mockManageSecurity } from "./helpers/manage-security";
import { mockManageBackups } from "./helpers/manage-backups";
import {
  concealMfaTestCredentials,
  deferredMfaResponse,
  mockMfa,
  mfaUserA,
  mfaUserB,
} from "./helpers/mfa";

test.use({ trace: "off", screenshot: "off", video: "off" });
test.afterEach(async ({ page }) => {
  await concealMfaTestCredentials(page);
});

test("MFA gate stays accessible over an unrelated dialog and restores its same-account draft", async ({
  page,
}) => {
  const policy = await mockManageSecurity(page);
  const backups = await mockManageBackups(page);
  const state = await mockMfa(page, { verified: true, aal2: true });
  await page.goto("/manage?view=security");
  await page.getByRole("tab", { name: /Backups/ }).click();
  await page.getByRole("button", { name: "Back up now", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Back up now",
    exact: true,
  });
  await dialog
    .getByRole("textbox", { name: "Backup name" })
    .fill("Unsubmitted backup request");
  state.actors.get(mfaUserA)!.assurance = "aal1";
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  const gate = page.getByRole("dialog", {
    name: "Session verification",
    exact: true,
  });
  await expect(
    gate.getByLabel("Verification code", { exact: true }),
  ).toBeVisible();
  await gate.getByLabel("Verification code", { exact: true }).fill("222222");
  await gate.getByRole("button", { name: "Verify code", exact: true }).click();
  await expect(gate).toBeHidden();
  await expect(
    dialog.getByRole("textbox", { name: "Backup name" }),
  ).toHaveValue("Unsubmitted backup request");
  expect(policy.writes).toEqual([]);
  expect(backups.queueRequests).toEqual([]);
  expect(backups.patches).toEqual([]);
  await page.keyboard.press("Escape");
});

test("MFA gate stays accessible over an alert dialog and restores its typed confirmation without a write", async ({
  page,
}) => {
  const id = "00000000-0000-4000-8000-000000000301";
  const board = {
    id,
    scope: "project",
    department_id: null,
    name: "Pending dispatch",
    description: null,
    status: "active",
    revision: 1,
    level: "manage",
    created_at: "2026-10-02T00:00:00Z",
    updated_at: "2026-10-02T00:00:00Z",
  };
  const writes: string[] = [];
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        today: "2026-10-02",
        week_start: "monday",
        locale: "en-US",
        timezone: "UTC",
      },
    }),
  );
  await page.route("**/api/boards**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") writes.push(path);
    if (path === `/api/boards/${id}`) return route.fulfill({ json: board });
    if (path === `/api/boards/${id}/my-access`)
      return route.fulfill({
        json: { level: "manage", read: true, write: true, manage: true },
      });
    if (path === `/api/boards/${id}/groups`)
      return route.fulfill({ json: { board_id: id, revision: 1, groups: [] } });
    const items = path === "/api/boards" ? [board] : [];
    return route.fulfill({
      json: {
        items,
        pagination: {
          limit: 25,
          offset: 0,
          count: items.length,
          total: items.length,
          has_more: false,
        },
        board_revision: 1,
      },
    });
  });
  const state = await mockMfa(page, { verified: true, aal2: true });
  await page.goto(`/boards?board=${id}&section=overview`);
  await page.getByRole("button", { name: "Board menu", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Manage Board and groups", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Manage Board", exact: true })
    .getByRole("button", { name: "Archive Board", exact: true })
    .click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Archive Board?",
    exact: true,
  });
  await confirmation
    .getByLabel("Type “Pending dispatch” to confirm", { exact: true })
    .fill("Pending dispatch");
  state.actors.get(mfaUserA)!.assurance = "aal1";
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  const gate = page.getByRole("dialog", {
    name: "Session verification",
    exact: true,
  });
  await expect(
    gate.getByLabel("Verification code", { exact: true }),
  ).toBeVisible();
  await gate.getByLabel("Verification code", { exact: true }).fill("222222");
  await gate.getByRole("button", { name: "Verify code", exact: true }).click();
  await expect(gate).toBeHidden();
  await expect(
    confirmation.getByLabel("Type “Pending dispatch” to confirm", {
      exact: true,
    }),
  ).toHaveValue("Pending dispatch");
  expect(writes).toEqual([]);
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
});

test("required MFA challenges an existing factor and waits for the real session recheck", async ({
  page,
}) => {
  const state = await mockMfa(page, { verified: true });
  state.statusFailure = 503;
  await page.goto("/platform?section=search");
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeVisible();
  state.statusFailure = 0;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Complete multi-factor authentication" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Platform", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Set up authenticator", exact: true }),
  ).toHaveCount(0);
  const session = deferredMfaResponse();
  state.holdSession = session;
  await page.getByLabel("Verification code", { exact: true }).fill("222222");
  await page.getByRole("button", { name: "Verify code", exact: true }).click();
  await session.begun;
  await expect(
    page.getByRole("heading", { name: "Platform", exact: true }),
  ).toHaveCount(0);
  session.release();
  await expect(
    page.getByRole("heading", { name: "Platform", exact: true }),
  ).toBeVisible();
  expect(
    state.calls.filter(
      (call) => call.method === "POST" && call.path === "/auth/mfa/factors",
    ),
  ).toHaveLength(0);
});

test("required enrollment survives an authenticator app switch without exposing credentials during recheck", async ({
  page,
}) => {
  const state = await mockMfa(page, { required: true, aal2: true });
  await page.goto("/platform?section=search");
  await page
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: "Authenticator QR code" }),
  ).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("blur")));
  await expect(
    page.getByRole("img", { name: "Authenticator QR code" }),
  ).toHaveCount(0);
  const identity = deferredMfaResponse();
  state.holdStatus = identity;
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  await identity.begun;
  await expect(
    page.getByRole("img", { name: "Authenticator QR code" }),
  ).toHaveCount(0);
  identity.release();
  await expect(
    page.getByRole("img", { name: "Authenticator QR code" }),
  ).toBeVisible();
  expect(
    state.calls.filter(
      (call) => call.method === "POST" && call.path === "/auth/mfa/factors",
    ),
  ).toHaveLength(1);
  await page.getByLabel("Verification code", { exact: true }).fill("222222");
  await page.getByRole("button", { name: "Verify code", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Platform", exact: true }),
  ).toBeVisible();
});

test("late MFA enrollment and verification cannot expose the prior account after cookies switch", async ({
  page,
}) => {
  const state = await mockMfa(page, { required: true });
  await page.goto("/platform?section=search");
  const enrollment = deferredMfaResponse();
  state.holdEnroll = enrollment;
  await page
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  await enrollment.begun;
  state.userId = mfaUserB;
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  await expect
    .poll(
      () =>
        state.calls.filter(
          (call) => call.path === "/auth/mfa" && call.userId === mfaUserB,
        ).length,
    )
    .toBeGreaterThan(0);
  enrollment.release();
  await expect(
    page.getByRole("img", { name: "Authenticator QR code" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: "Authenticator QR code" }),
  ).toBeVisible();
  const verification = deferredMfaResponse();
  state.holdVerify = verification;
  await page.getByLabel("Verification code", { exact: true }).fill("222222");
  await page.getByRole("button", { name: "Verify code", exact: true }).click();
  await verification.begun;
  state.userId = mfaUserA;
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  await expect(
    page.getByRole("button", { name: "Set up authenticator", exact: true }),
  ).toBeVisible();
  verification.release();
  await expect(
    page.getByRole("heading", { name: "Platform", exact: true }),
  ).toHaveCount(0);
  expect(state.calls.filter((call) => call.method === "DELETE")).toHaveLength(
    0,
  );
});

test("an IP-denied session is distinct from an outage and permits retry or sign-out", async ({
  page,
}) => {
  const state = await mockMfa(page);
  state.networkDenied = true;
  await page.goto("/platform?section=search");
  await expect(
    page.getByRole("alert").filter({ hasText: "address is not allowed" }),
  ).toBeVisible();
  await expect(
    page.getByText("We can’t verify your session right now.", { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeVisible();
  state.networkDenied = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Platform", exact: true }),
  ).toBeVisible();
});

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
    if (
      new URL(route.request().url()).pathname ===
      "/api/notifications/unread-count"
    ) {
      await route.fulfill({
        json: { unread_count: activeUser === userA ? 1 : 0 },
      });
      return;
    }
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
              subject_type: "report_run",
              subject_id: "00000000-0000-4000-8000-000000000104",
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

for (const transition of [
  "logout",
  "invalid",
  "account-change",
  "closing-account-change",
] as const) {
  test(`private notices and Undo leave at ${transition}, and errors can report for the next account`, async ({
    page,
  }) => {
    const changingAccount = transition.includes("account-change");
    let activeUser: string | null = userA;
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({
        json: activeUser
          ? { authenticated: true, user_id: activeUser, setup_required: false }
          : { authenticated: false },
      }),
    );
    await page.route("**/api/auth/refresh", (route) =>
      route.fulfill({ status: 401 }),
    );
    await page.route("**/api/auth/logout", (route) => {
      activeUser = null;
      return route.fulfill({ status: 204 });
    });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: () =>
            Promise.reject(new Error("owned clipboard rejection")),
        },
      });
    });
    await page.goto("/comms");
    const workshop = page.getByRole("button", { name: /^workshop(,|$)/ });
    async function copyFailure() {
      await workshop.click({ button: "right" });
      await page
        .getByRole("menuitem", { name: "Copy channel link", exact: true })
        .click();
    }
    await copyFailure();
    const failure = page
      .getByRole("region", { name: "Notifications", exact: true })
      .getByText("The browser could not copy the link.", {
        exact: true,
      });
    await expect(failure).toBeVisible();
    await copyFailure();
    await expect(failure).toHaveCount(1);
    await workshop.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Archive channel", exact: true })
      .click();
    await page
      .getByRole("alertdialog", { name: "Archive #workshop?" })
      .getByRole("button", { name: "Archive channel", exact: true })
      .click();
    await expect(
      page
        .getByRole("region", { name: "Notifications", exact: true })
        .getByText("#workshop archived.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Undo", exact: true }),
    ).toBeVisible();
    if (transition === "closing-account-change") {
      const endingNotice = page
        .getByRole("region", { name: "Notifications", exact: true })
        .getByRole("alertdialog", { includeHidden: true })
        .filter({ hasText: "The browser could not copy the link." });
      // Hold a real ending animation so dismissal is still pending when the
      // verified account changes; the notice and its callbacks stay real.
      await endingNotice.evaluate((element) => {
        element.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 30_000 });
      });
      await endingNotice.getByLabel("Dismiss notification").click();
      await expect(
        page
          .getByRole("alert")
          .filter({ hasText: "The browser could not copy the link." }),
      ).toHaveCount(1);
    }
    if (transition === "logout") {
      await page.getByRole("button", { name: "Account", exact: true }).click();
      await page
        .getByRole("menuitem", { name: "Sign out", exact: true })
        .click();
    } else {
      activeUser = transition === "invalid" ? null : userB;
      await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
    }
    if (!changingAccount) await expect(page).toHaveURL(/\/login$/);
    await expect(failure).toHaveCount(0);
    await expect(
      page
        .getByRole("region", { name: "Notifications", exact: true })
        .getByText("#workshop archived.", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Undo", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("The browser could not copy the link.", { exact: true }),
    ).toHaveCount(0);
    if (!changingAccount) {
      activeUser = userB;
      await page.goto("/comms");
    }
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeVisible();
    await copyFailure();
    await expect(failure).toBeVisible();
    await expect(failure).toHaveCount(1);
  });
}
