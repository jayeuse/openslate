import { expect, test, type Page, type Route } from "./helpers/test";
import { accessDraftStorageKey } from "../../src/components/systems/access/state/draft-journal-storage";
import { workspaceSessionSnapshotStorageKey } from "../../src/components/systems/shared/runtime/workspace-identity";
import {
  commsDraftTextKey,
  ownedCommsDraftTextId,
} from "../../src/components/systems/comms/state/draft-text";

const accountUser = "00000000-0000-4000-8000-000000000001";
const currentUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const workspaceSettings = {
  id: "44444444-4444-4444-8444-444444444444",
  display_name: "OpenSlate test workspace",
  legal_name: null,
  description: null,
  contact_email: null,
  contact_phone: null,
  postal_address: null,
  locale: "en-GB",
  timezone: "Europe/London",
  logo_file_id: null,
  mark: "RS",
  currency: "PHP",
  week_start: "monday",
  business_hours: "09:00–18:00",
  theme: "slate",
  revision: 1,
};
const cleanupKeys = [
  accessDraftStorageKey(accountUser, "identity"),
  workspaceSessionSnapshotStorageKey(accountUser),
  commsDraftTextKey(ownedCommsDraftTextId(accountUser, "owned-composer")),
];

const currentSession = {
  id: "11111111-1111-4111-8111-111111111111",
  created_at: "2026-10-01T08:00:00Z",
  refreshed_at: "2026-10-01T09:00:00Z",
  expires_at: "2026-10-02T08:00:00Z",
  user_agent: currentUserAgent,
  current: true,
};

const otherSession = {
  id: "22222222-2222-4222-8222-222222222222",
  created_at: "2026-09-30T08:00:00Z",
  refreshed_at: "2026-10-01T07:30:00Z",
  expires_at: "2026-10-02T08:00:00Z",
  user_agent: "Firefox on Android",
  current: false,
};

const anotherSession = {
  id: "33333333-3333-4333-8333-333333333333",
  created_at: "2026-09-29T08:00:00Z",
  refreshed_at: "2026-10-01T06:00:00Z",
  expires_at: "2026-10-02T08:00:00Z",
  user_agent: "Safari on iPadOS",
  current: false,
};

async function openAccount(
  page: Page,
  workspaceHandler: (route: Route) => Promise<void> = (route) =>
    route.fulfill({ json: workspaceSettings }),
) {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user_id: "00000000-0000-4000-8000-000000000001",
        setup_required: false,
      },
    }),
  );
  await page.route("**/api/workspace", workspaceHandler);
  await page.goto("/platform?section=account");
}

test("loads own sessions and exposes a retryable denied and empty state", async ({
  page,
}) => {
  let releaseResponse: (() => void) | undefined;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route("**/api/auth/sessions", async (route) => {
    await responseGate;
    await route.fulfill({
      json: [
        currentSession,
        { ...anotherSession, user_agent: "Synthetic unknown client" },
      ],
    });
  });

  try {
    const request = page.waitForRequest(
      (candidate) =>
        candidate.method() === "GET" &&
        new URL(candidate.url()).pathname === "/api/auth/sessions",
      { timeout: 5_000 },
    );
    await openAccount(page);
    await request;
    await expect(page.getByText("Loading active sessions…")).toBeVisible();
    releaseResponse?.();
    await expect(
      page.getByRole("listitem").filter({ hasText: "Current session" }),
    ).toContainText("Chrome on macOS");
    await expect(
      page.getByText("Chrome on macOS", { exact: true }),
    ).toHaveAttribute("title", currentUserAgent);
    await expect(
      page.getByText("Unknown device", { exact: true }),
    ).toHaveAttribute("title", "Synthetic unknown client");
  } finally {
    releaseResponse?.();
  }

  let sessionsDenied = true;
  await page.route("**/api/auth/sessions", async (route) => {
    if (sessionsDenied) {
      await route.fulfill({
        status: 403,
        json: { detail: "Internal access detail" },
      });
      return;
    }
    await route.fulfill({ json: [] });
  });
  await page.reload();
  await expect(
    page.getByText("Session access is not available for this account.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("Internal access detail")).toHaveCount(0);
  sessionsDenied = false;
  await page.getByRole("button", { name: "Retry sessions" }).click();
  await expect(page.getByText("No active sessions.")).toBeVisible();
});

test("password changes send the API payload, show status-specific feedback, clear fields, and refresh sessions", async ({
  page,
}) => {
  const cases = [
    {
      status: 403,
      body: { detail: "Password cannot be changed" },
      message: "The current password was not accepted.",
    },
    {
      status: 429,
      body: { detail: "Password cannot be changed" },
      message: "Too many password attempts. Wait before trying again.",
    },
    {
      status: 503,
      body: { detail: "Password service unavailable" },
      message: "Password changes are temporarily unavailable. Try again later.",
    },
    {
      status: 422,
      body: { detail: "Password requirements were not met" },
      message:
        "The new password was not accepted. Check the password requirements and try again.",
    },
  ] as const;
  let activeSessions = [currentSession, otherSession];
  let sessionReads = 0;
  let passwordAttempts = 0;
  const bodies: unknown[] = [];
  await page.route("**/api/auth/sessions", async (route) => {
    sessionReads += 1;
    await route.fulfill({ json: activeSessions });
  });
  await page.route("**/api/auth/password/change", async (route) => {
    bodies.push(route.request().postDataJSON());
    const current = cases[passwordAttempts];
    if (!current) throw new Error("Unexpected password change request");
    passwordAttempts += 1;
    activeSessions = activeSessions.filter((session) => session.current);
    await route.fulfill({
      status: current.status,
      json: current.body,
    });
  });

  await openAccount(page);
  await expect(page.getByText("Chrome on macOS")).toBeVisible();
  const currentPassword = page.getByLabel("Current password", { exact: true });
  const newPassword = page.getByLabel("New password", { exact: true });
  await expect(newPassword).toHaveAttribute("minlength", "12");
  await expect(newPassword).toHaveAttribute("maxlength", "128");

  for (const [index, response] of cases.entries()) {
    const readsBefore = sessionReads;
    await currentPassword.fill("current test password");
    await newPassword.fill("new test password 123");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(
      page.getByText(response.message, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Other sessions may have ended."),
    ).toBeVisible();
    await expect(currentPassword).toHaveValue("");
    await expect(newPassword).toHaveValue("");
    const currentPasswordHasError = response.status === 403;
    const newPasswordHasError = response.status === 422;
    await expect(currentPassword).toHaveAttribute(
      "aria-invalid",
      String(currentPasswordHasError),
    );
    await expect(newPassword).toHaveAttribute(
      "aria-invalid",
      String(newPasswordHasError),
    );
    expect(await currentPassword.getAttribute("aria-describedby")).toBe(
      currentPasswordHasError ? "current-password-error" : null,
    );
    expect(await newPassword.getAttribute("aria-describedby")).toBe(
      newPasswordHasError
        ? "new-password-guidance new-password-error"
        : "new-password-guidance",
    );
    await expect.poll(() => sessionReads).toBe(readsBefore + 1);
    if (index === 0)
      await expect(
        page.getByRole("listitem").filter({ hasText: "Firefox on Android" }),
      ).toHaveCount(0);
  }

  expect(bodies).toEqual(
    cases.map(() => ({
      current_password: "current test password",
      password: "new test password 123",
    })),
  );
  expect(passwordAttempts).toBe(cases.length);
});

test("serializes password changes and session revocations", async ({
  page,
}) => {
  let releasePassword: (() => void) | undefined;
  let releaseSession: (() => void) | undefined;
  let activeSessions = [currentSession, otherSession];
  const passwordGate = new Promise<void>((resolve) => {
    releasePassword = resolve;
  });
  const sessionGate = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  await page.route("**/api/auth/sessions**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: activeSessions });
      return;
    }
    if (route.request().method() === "DELETE") {
      await sessionGate;
      activeSessions = activeSessions.filter(
        (session) => session.id !== otherSession.id,
      );
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/auth/password/change", async (route) => {
    await passwordGate;
    await route.fulfill({
      json: { authenticated: true, setup_required: false },
    });
  });

  try {
    await openAccount(page);
    await expect(page.getByText("Chrome on macOS")).toBeVisible();
    await page.getByLabel("Current password", { exact: true }).fill("current");
    await page
      .getByLabel("New password", { exact: true })
      .fill("new password 123");
    const passwordRequest = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/auth/password/change",
    );
    await page.getByRole("button", { name: "Change password" }).click();
    await passwordRequest;
    await expect(
      page.getByRole("button", { name: "End all other sessions" }),
    ).toBeDisabled();
    await expect(
      page
        .getByRole("listitem")
        .filter({ hasText: "Firefox on Android" })
        .getByRole("button", { name: "End session" }),
    ).toBeDisabled();

    releasePassword?.();
    await expect(
      page.getByText(
        "Password changed. Other sessions were ended; this session remains active.",
        { exact: true },
      ),
    ).toBeVisible();
    const other = page
      .getByRole("listitem")
      .filter({ hasText: "Firefox on Android" });
    await expect(
      other.getByRole("button", { name: "End session" }),
    ).toBeEnabled();
    await other.getByRole("button", { name: "End session" }).click();
    const sessionRequest = page.waitForRequest(
      (request) =>
        request.method() === "DELETE" &&
        new URL(request.url()).pathname ===
          `/api/auth/sessions/${otherSession.id}`,
    );
    await page
      .getByRole("alertdialog", { name: "Confirm account action" })
      .getByRole("button", { name: "Confirm end session" })
      .click();
    await sessionRequest;
    await expect(
      page.getByRole("button", {
        name: "Change password",
        includeHidden: true,
      }),
    ).toBeDisabled();
    releaseSession?.();
    await expect(other).toHaveCount(0);
  } finally {
    releasePassword?.();
    releaseSession?.();
  }
});

test("associates missing and short password errors with only their input", async ({
  page,
}) => {
  let attempts = 0;
  await page.route("**/api/auth/sessions", (route) =>
    route.fulfill({ json: [currentSession] }),
  );
  await page.route("**/api/auth/password/change", async (route) => {
    attempts += 1;
    await route.fulfill({ status: 204 });
  });
  await openAccount(page);

  await page.getByLabel("Current password", { exact: true }).fill("current");
  const newPassword = page.getByLabel("New password", { exact: true });
  const currentPassword = page.getByLabel("Current password", { exact: true });
  await newPassword.fill("too short");
  await page.getByRole("button", { name: "Change password" }).click();

  await expect(
    page.getByRole("alert").filter({ hasText: "Use 12 to 128 characters." }),
  ).toBeVisible();
  await expect(newPassword).toHaveAttribute("aria-invalid", "true");
  await expect(newPassword).toHaveAttribute(
    "aria-describedby",
    "new-password-error",
  );
  await expect(currentPassword).toHaveAttribute("aria-invalid", "false");
  expect(await currentPassword.getAttribute("aria-describedby")).toBeNull();
  await expect(
    page.getByText("Use 12 to 128 characters.", { exact: true }),
  ).toHaveCount(1);

  await newPassword.fill("valid new password 123");
  await currentPassword.fill("");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Enter your current password." }),
  ).toBeVisible();
  await expect(currentPassword).toHaveAttribute("aria-invalid", "true");
  await expect(currentPassword).toHaveAttribute(
    "aria-describedby",
    "current-password-error",
  );
  await expect(newPassword).toHaveAttribute("aria-invalid", "false");
  await expect(newPassword).toHaveAttribute(
    "aria-describedby",
    "new-password-guidance",
  );
  expect(attempts).toBe(0);
});

test("keeps password and session controls reachable on mobile with full device descriptions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const otherUserAgent =
    "Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0";
  let activeSessions = [
    { ...currentSession, user_agent: currentUserAgent },
    { ...otherSession, user_agent: otherUserAgent },
    anotherSession,
  ];
  const requests: Array<{ method: string; path: string }> = [];
  await page.route("**/api/auth/sessions**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push({ method: request.method(), path });
    if (request.method() === "GET") {
      await route.fulfill({ json: activeSessions });
      return;
    }
    if (request.method() === "DELETE") {
      activeSessions = activeSessions.filter(
        (session) => path !== `/api/auth/sessions/${session.id}`,
      );
      await route.fulfill({ status: 204 });
      return;
    }
    if (request.method() === "POST") {
      activeSessions = activeSessions.filter((session) => session.current);
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fallback();
  });
  await openAccount(page);
  await expect(
    page.getByText("Chrome on macOS", { exact: true }),
  ).toHaveAttribute("title", currentUserAgent);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1);

  const currentPassword = page.getByLabel("Current password", { exact: true });
  const newPassword = page.getByLabel("New password", { exact: true });
  for (const control of [
    currentPassword,
    newPassword,
    page.getByRole("button", { name: "Change password" }),
    page.getByRole("button", { name: "End all other sessions" }),
  ]) {
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport({ ratio: 1 });
  }
  await currentPassword.fill("current test password");
  await newPassword.fill("new test password 123");
  await expect(currentPassword).toHaveValue("current test password");
  await expect(newPassword).toHaveValue("new test password 123");

  const firefox = page
    .getByRole("listitem")
    .filter({ hasText: "Firefox on Android" });
  await firefox
    .getByRole("button", { name: "End session" })
    .scrollIntoViewIfNeeded();
  await expect(
    firefox.getByRole("button", { name: "End session" }),
  ).toBeInViewport({ ratio: 1 });
  await firefox.getByRole("button", { name: "End session" }).click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Confirm account action",
  });
  await expect(confirmation).toContainText(
    "Ending this session will sign out that device.",
  );
  await confirmation
    .getByRole("button", { name: "Confirm end session" })
    .click();
  await expect(firefox).toHaveCount(0);
  await expect(
    page.getByRole("listitem").filter({ hasText: "Current session" }),
  ).toContainText("Chrome on macOS");

  await page.getByRole("button", { name: "End all other sessions" }).click();
  await expect(confirmation).toContainText(
    "Your current session will remain active.",
  );
  await confirmation
    .getByRole("button", { name: "Confirm end all other sessions" })
    .click();
  await expect(
    page.getByRole("listitem").filter({ hasText: "Safari on iPadOS" }),
  ).toHaveCount(0);

  expect(requests).toContainEqual({
    method: "DELETE",
    path: `/api/auth/sessions/${otherSession.id}`,
  });
  expect(requests).toContainEqual({
    method: "POST",
    path: "/api/auth/sessions/revoke-others",
  });
});

test("warns before ending the current session and routes to sign-in after confirmation", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("**/api/auth/sessions**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ json: [currentSession] });
      return;
    }
    requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    await route.fulfill({ status: 204 });
  });
  await openAccount(page);

  const current = page
    .getByRole("listitem")
    .filter({ hasText: "Current session" });
  await current.getByRole("button", { name: "End session" }).click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Confirm account action",
  });
  await expect(confirmation).toContainText(
    "Ending this session will sign you out on this device.",
  );
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  expect(requests).toEqual([]);

  await current.getByRole("button", { name: "End session" }).click();
  await confirmation
    .getByRole("button", { name: "End this session and sign out" })
    .click();
  await expect(page).toHaveURL(/\/login$/);
  expect(requests).toEqual([`DELETE /api/auth/sessions/${currentSession.id}`]);
});

test("current-session revocation clears owned drafts and attachment URLs through the shared sign-out flow", async ({
  page,
}) => {
  let revocations = 0;
  await page.route("**/api/auth/sessions**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: [currentSession] });
      return;
    }
    revocations += 1;
    await route.fulfill({ status: 204 });
  });
  await page.addInitScript(() => {
    const urls: string[] = [];
    const revoked: string[] = [];
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    Object.assign(window, {
      ownedAttachmentUrls: urls,
      revokedAttachmentUrls: revoked,
    });
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      urls.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      revoked.push(url);
      revoke(url);
    };
  });
  await openAccount(page);
  await page.goto("/comms");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Owned unsent draft");
  await page.getByLabel("Upload files", { exact: true }).setInputFiles({
    name: "owned-note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Owned synthetic attachment"),
  });
  await expect(page.getByText("owned-note.txt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Account settings", exact: true })
    .click();
  await expect(
    page.getByText("Chrome on macOS", { exact: true }),
  ).toBeVisible();
  await page.evaluate(
    (key) => sessionStorage.setItem(key, "Owned Access draft"),
    cleanupKeys[0]!,
  );
  const persistedComms = await page.evaluate(() =>
    Object.keys(sessionStorage).filter((key) =>
      key.startsWith("openslate.sample.draft-text.v1."),
    ),
  );
  expect(persistedComms.length).toBeGreaterThan(0);
  await page
    .getByRole("listitem")
    .filter({ hasText: "Current session" })
    .getByRole("button", { name: "End session" })
    .click();
  await page
    .getByRole("button", {
      name: /^(Confirm end session|End this session and sign out)$/,
    })
    .click();
  await expect(page).toHaveURL(/\/login$/);
  for (const key of [cleanupKeys[0]!, cleanupKeys[1]!, ...persistedComms])
    expect(
      await page.evaluate(
        (candidate) => sessionStorage.getItem(candidate),
        key,
      ),
    ).toBeNull();
  const attachmentState = await page.evaluate(() => {
    const state = window as unknown as Window & {
      ownedAttachmentUrls: string[];
      revokedAttachmentUrls: string[];
    };
    return {
      created: state.ownedAttachmentUrls,
      revoked: state.revokedAttachmentUrls,
    };
  });
  expect(attachmentState.created).toHaveLength(1);
  expect(attachmentState.revoked).toContain(attachmentState.created[0]);
  expect(revocations).toBe(1);
});

for (const [index, failure] of ["Access", "workspace", "Comms"].entries()) {
  test(`accepted current-session revocation fails closed on ${failure} cleanup and retries without another revoke`, async ({
    page,
  }) => {
    let revocations = 0;
    await page.route("**/api/auth/sessions**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: [currentSession] });
        return;
      }
      revocations += 1;
      await route.fulfill({ status: 204 });
    });
    await openAccount(page);
    await expect(
      page.getByText("Chrome on macOS", { exact: true }),
    ).toBeVisible();
    let endedSessionChecks = 0;
    await page.route("**/api/auth/session", async (route) => {
      if (revocations > 0) endedSessionChecks += 1;
      await route.fulfill({
        json:
          revocations > 0
            ? { authenticated: false }
            : {
                authenticated: true,
                user_id: accountUser,
                setup_required: false,
              },
      });
    });
    await page.evaluate(
      ({ keys, failingKey }) => {
        for (const key of keys)
          sessionStorage.setItem(key, "Owned retained draft");
        const remove = Storage.prototype.removeItem;
        Object.assign(window, {
          restoreCleanupStorage: () => {
            Storage.prototype.removeItem = remove;
          },
        });
        Storage.prototype.removeItem = function (key) {
          if (key === failingKey) throw new Error("Owned storage failure");
          return remove.call(this, key);
        };
      },
      { keys: cleanupKeys, failingKey: cleanupKeys[index]! },
    );
    await page
      .getByRole("listitem")
      .filter({ hasText: "Current session" })
      .getByRole("button", { name: "End session" })
      .click();
    await page
      .getByRole("button", {
        name: /^(Confirm end session|End this session and sign out)$/,
      })
      .click();
    await expect(
      page.getByRole("heading", { name: "Signed out", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Main navigation" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("alert").filter({ hasText: /could not clear saved/i }),
    ).toBeVisible();
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
    await expect(page).toHaveURL(/\/platform\?section=account$/);
    expect(endedSessionChecks).toBe(0);
    expect(revocations).toBe(1);
    for (const [keyIndex, key] of cleanupKeys.entries())
      expect(
        await page.evaluate(
          (candidate) => sessionStorage.getItem(candidate),
          key,
        ),
      ).toBe(keyIndex === index ? "Owned retained draft" : null);
    await page.evaluate(() =>
      (
        window as unknown as Window & { restoreCleanupStorage: () => void }
      ).restoreCleanupStorage(),
    );
    await page.getByRole("button", { name: "Retry clearing drafts" }).click();
    await expect(page).toHaveURL(/\/login$/);
    for (const key of cleanupKeys)
      expect(
        await page.evaluate(
          (candidate) => sessionStorage.getItem(candidate),
          key,
        ),
      ).toBeNull();
    expect(revocations).toBe(1);
  });
}

test("failed current-session revocation keeps drafts active and restores focus after its destructive dialog", async ({
  page,
}) => {
  await page.route("**/api/auth/sessions**", async (route) => {
    if (route.request().method() === "GET")
      await route.fulfill({ json: [currentSession] });
    else await route.fulfill({ status: 503, json: { detail: "Unavailable" } });
  });
  await openAccount(page);
  const trigger = page
    .getByRole("listitem")
    .filter({ hasText: "Current session" })
    .getByRole("button", { name: "End session" });
  await expect(trigger).toBeEnabled();
  await page.evaluate((keys) => {
    for (const key of keys)
      sessionStorage.setItem(key, "Retained before rejection");
  }, cleanupKeys);
  await trigger.click();
  const dialog = page.getByRole("alertdialog", {
    name: "Confirm account action",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "End this session and sign out", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Session changes are temporarily unavailable." }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
  for (const key of cleanupKeys)
    expect(
      await page.evaluate(
        (candidate) => sessionStorage.getItem(candidate),
        key,
      ),
    ).toBe("Retained before rejection");
});

test("Account explains its mixed sources and associates password validation with both controls", async ({
  page,
}) => {
  await page.route("**/api/auth/sessions", (route) =>
    route.fulfill({ json: [currentSession] }),
  );
  let changes = 0;
  await page.route("**/api/auth/password/change", (route) => {
    changes += 1;
    return route.fulfill({ status: 403, json: { detail: "Rejected" } });
  });
  await openAccount(page);
  await expect(
    page.getByRole("note", { name: "Account data", exact: true }),
  ).toContainText(
    "Password, device sessions, and theme use your signed-in account",
  );
  await expect(
    page.getByRole("button", { name: "Review sign-out", exact: true }),
  ).toHaveCount(0);
  const current = page.getByLabel("Current password", { exact: true });
  const next = page.getByLabel("New password", { exact: true });
  await current.fill("current test password");
  await next.fill("short");
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Use 12 to 128 characters." }),
  ).toBeVisible();
  await expect(next).toHaveAttribute("aria-invalid", "true");
  await expect(next).toHaveAttribute("aria-describedby", "new-password-error");
  await expect(current).toHaveAttribute("aria-invalid", "false");
  expect(await current.getAttribute("aria-describedby")).toBeNull();
  expect(changes).toBe(0);
  await next.fill("new test password 123");
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "The current password was not accepted." }),
  ).toBeVisible();
  await expect(current).toHaveAttribute("aria-invalid", "true");
  await expect(current).toHaveAttribute(
    "aria-describedby",
    "current-password-error",
  );
  await expect(next).toHaveAttribute("aria-invalid", "false");
  await expect(next).toHaveAttribute(
    "aria-describedby",
    "new-password-guidance",
  );
  await expect(current).toHaveValue("");
  await expect(next).toHaveValue("");
  await expect(
    page.getByText("Use 12 to 128 characters.", {
      exact: true,
    }),
  ).toHaveCount(1);
  expect(changes).toBe(1);
});

test.describe("organization-local device session dates", () => {
  test.use({ locale: "en-US", timezoneId: "America/Los_Angeles" });

  test("uses the organization's locale and timezone for session timestamps", async ({
    page,
  }) => {
    await page.route("**/api/auth/sessions", (route) =>
      route.fulfill({ json: [currentSession] }),
    );
    await openAccount(page);

    const browserSettings = await page.evaluate(() => {
      const { locale, timeZone } = new Intl.DateTimeFormat().resolvedOptions();
      return { locale, timeZone };
    });
    expect(browserSettings).toEqual({
      locale: "en-US",
      timeZone: "America/Los_Angeles",
    });

    const current = page
      .getByRole("listitem")
      .filter({ hasText: "Current session" });
    await expect(current).toContainText("Last active 1 Oct 2026, 10:00");
    await expect(
      current.getByText("Chrome on macOS", { exact: true }),
    ).toHaveAttribute("title", currentUserAgent);
  });
});

test("keeps session controls usable while organization date settings load", async ({
  page,
}) => {
  await page.route("**/api/auth/sessions", (route) =>
    route.fulfill({ json: [currentSession] }),
  );
  let releaseWorkspace: (() => void) | undefined;
  const workspaceGate = new Promise<void>((resolve) => {
    releaseWorkspace = resolve;
  });
  await openAccount(page, async (route) => {
    await workspaceGate;
    await route.fulfill({ json: workspaceSettings });
  });

  try {
    const current = page
      .getByRole("listitem")
      .filter({ hasText: "Current session" });
    await expect(current).toContainText(
      "Last active Loading organization date settings…",
    );
    await expect(
      current.getByRole("button", { name: "End session" }),
    ).toBeEnabled();
    releaseWorkspace?.();
    await expect(current).toContainText("Last active 1 Oct 2026, 10:00");
  } finally {
    releaseWorkspace?.();
  }
});

test("retries failed organization date settings without disabling session controls", async ({
  page,
}) => {
  await page.route("**/api/auth/sessions", (route) =>
    route.fulfill({ json: [currentSession] }),
  );
  let workspaceRetryAllowed = false;
  await openAccount(page, async (route) => {
    if (!workspaceRetryAllowed) {
      await route.fulfill({ status: 503, json: { detail: "Unavailable" } });
      return;
    }
    await route.fulfill({ json: workspaceSettings });
  });
  const current = page
    .getByRole("listitem")
    .filter({ hasText: "Current session" });
  await expect(
    page.getByRole("alert").filter({
      hasText:
        "Organization date settings could not be loaded. Retry to format session times.",
    }),
  ).toBeVisible();
  await expect(current).toContainText("Last active Date settings unavailable");
  await expect(
    current.getByRole("button", { name: "End session" }),
  ).toBeEnabled();
  workspaceRetryAllowed = true;
  await page.getByRole("button", { name: "Retry date settings" }).click();
  await expect(current).toContainText("Last active 1 Oct 2026, 10:00");
});
