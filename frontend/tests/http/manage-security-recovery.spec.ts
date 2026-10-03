import { expect, test } from "./helpers/test";
import { mockManageSecurity } from "./helpers/manage-security";
import { backupRun, mockManageBackups } from "./helpers/manage-backups";
import { sendOpenViewEvent } from "./helpers/openview-event-source";
import {
  concealMfaTestCredentials,
  deferredMfaResponse,
  mockMfa,
  mfaUserA,
} from "./helpers/mfa";
import type { Page } from "./helpers/test";
import { accessDraftStorageKey } from "../../src/components/systems/access/state/draft-journal-storage";

test.use({ trace: "off", screenshot: "off", video: "off" });
test.afterEach(async ({ page }) => {
  await concealMfaTestCredentials(page);
});

async function openLiveMfa(page: Page) {
  await page.goto("/manage?view=security");
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await page.getByRole("button", { name: "Manage MFA", exact: true }).click();
  return page.getByRole("dialog", { name: "MFA enrollment", exact: true });
}

test("MFA enrollment verifies the provider factor, retries invalid codes, and removal signs out", async ({
  page,
}) => {
  const state = await mockMfa(page);
  state.statusFailure = 503;
  const dialog = await openLiveMfa(page);
  await expect(dialog.getByRole("alert")).toContainText("could not load");
  state.statusFailure = 0;
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  await expect(
    dialog.getByRole("img", { name: "Authenticator QR code" }),
  ).toBeVisible();
  state.invalidVerifyAttempts = 1;
  await dialog.getByLabel("Verification code", { exact: true }).fill("111111");
  await dialog
    .getByRole("button", { name: "Verify code", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("not accepted");
  expect(state.actors.get(mfaUserA)?.factors[0]?.status).toBe("unverified");
  await dialog.getByLabel("Verification code", { exact: true }).fill("222222");
  await dialog
    .getByRole("button", { name: "Verify code", exact: true })
    .click();
  await expect(dialog).toContainText("Authenticator verified");
  await expect(
    dialog.getByRole("img", { name: "Authenticator QR code" }),
  ).toHaveCount(0);
  expect(state.actors.get(mfaUserA)?.assurance).toBe("aal2");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await page.getByRole("button", { name: "Manage MFA", exact: true }).click();
  await expect(dialog).toContainText("Authenticator verified");
  await dialog
    .getByRole("button", { name: "Remove authenticator", exact: true })
    .click();
  await page.evaluate(
    (key) => {
      sessionStorage.setItem(key, "Controlled private draft");
      const target = window as typeof window & {
        restoreMfaStorage?: () => void;
      };
      const remove = Storage.prototype.removeItem;
      target.restoreMfaStorage = () => {
        Storage.prototype.removeItem = remove;
      };
      Storage.prototype.removeItem = () => {
        throw new Error("Controlled browser storage failure");
      };
    },
    accessDraftStorageKey(mfaUserA, "identity"),
  );
  await dialog
    .getByRole("button", { name: "Confirm removal", exact: true })
    .click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "could not clear saved Access drafts" }),
  ).toBeVisible();
  await page.evaluate(() => {
    (
      window as typeof window & { restoreMfaStorage?: () => void }
    ).restoreMfaStorage?.();
  });
  await page
    .getByRole("button", { name: "Retry session check", exact: true })
    .click();
  await expect(page).toHaveURL(/\/login$/);
  expect(state.authenticated).toBe(false);
});

test("Cancel and route leave clean only the pending MFA factor, with truthful cleanup retry", async ({
  page,
}) => {
  const state = await mockMfa(page);
  const pending = deferredMfaResponse();
  state.holdEnroll = pending;
  let dialog = await openLiveMfa(page);
  await dialog
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  await pending.begun;
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  pending.release();
  await expect.poll(() => state.actors.get(mfaUserA)?.factors.length).toBe(0);
  expect(state.authenticated).toBe(true);
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await page.getByRole("button", { name: "Manage MFA", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  await expect(
    dialog.getByRole("img", { name: "Authenticator QR code" }),
  ).toBeVisible();
  state.cleanupFailure = 503;
  await page.keyboard.press("Escape");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "unfinished authenticator could not be removed" }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Authenticator QR code" }),
  ).toHaveCount(0);
  state.cleanupFailure = 0;
  await page
    .getByRole("button", { name: "Retry cleanup", exact: true })
    .click();
  await expect.poll(() => state.actors.get(mfaUserA)?.factors.length).toBe(0);
  await page.getByRole("link", { name: "Notifications", exact: true }).click();
  await expect(page).toHaveURL(/\/platform\?section=notifications$/);
  await expect(
    page.getByRole("heading", { name: "Platform", exact: true }),
  ).toBeVisible();
  const manageGroup = page.getByRole("button", { name: "Manage", exact: true });
  if ((await manageGroup.getAttribute("aria-expanded")) !== "true")
    await manageGroup.click();
  await page
    .getByRole("link", { name: "Security & recovery", exact: true })
    .click();
  await expect(page).toHaveURL(/\/manage\?view=security$/);
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await page.getByRole("button", { name: "Manage MFA", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "MFA enrollment", exact: true });
  const leaving = deferredMfaResponse();
  state.holdEnroll = leaving;
  await dialog
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  await leaving.begun;
  await page.goBack();
  await expect(page).toHaveURL(/\/platform\?section=notifications$/);
  await expect(
    page.getByRole("heading", { name: "Platform", exact: true }),
  ).toBeVisible();
  leaving.release();
  await expect.poll(() => state.actors.get(mfaUserA)?.factors.length).toBe(0);

  const manageReturn = page.getByRole("button", {
    name: "Manage",
    exact: true,
  });
  if ((await manageReturn.getAttribute("aria-expanded")) !== "true")
    await manageReturn.click();
  await page
    .getByRole("link", { name: "Security & recovery", exact: true })
    .click();
  await expect(page).toHaveURL(/\/manage\?view=security$/);
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await page.getByRole("button", { name: "Manage MFA", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  await expect(
    dialog.getByRole("img", { name: "Authenticator QR code" }),
  ).toBeVisible();
  const racedFactor = state.actors.get(mfaUserA)!.factors[0]!.id;
  const verification = deferredMfaResponse();
  state.holdVerify = verification;
  await dialog.getByLabel("Verification code", { exact: true }).fill("222222");
  await dialog
    .getByRole("button", { name: "Verify code", exact: true })
    .click();
  await verification.begun;
  const staleCleanup = deferredMfaResponse();
  state.holdStatus = staleCleanup;
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await staleCleanup.begun;
  verification.release();
  await expect
    .poll(() => state.actors.get(mfaUserA)?.factors[0]?.status)
    .toBe("verified");
  staleCleanup.release();
  await expect
    .poll(
      () =>
        state.calls.filter(
          (call) =>
            call.method === "DELETE" &&
            call.path === `/auth/mfa/factors/${racedFactor}`,
        ).length,
    )
    .toBe(1);
  expect(
    state.actors
      .get(mfaUserA)
      ?.factors.find((factor) => factor.id === racedFactor)?.status,
  ).toBe("verified");
  expect(state.authenticated).toBe(true);
});

test("saving required MFA immediately gates protected interaction and resumes the same enrollment", async ({
  page,
}) => {
  const policy = await mockManageSecurity(page);
  const state = await mockMfa(page, {
    isRequired: () => policy.policy.mfa_policy === "admins",
  });
  const dialog = await openLiveMfa(page);
  await dialog
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  await expect(
    dialog.getByRole("img", { name: "Authenticator QR code" }),
  ).toBeVisible();
  policy.policy.mfa_policy = "admins";
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  const resumedGate = page.getByRole("dialog", {
    name: "Session verification",
    exact: true,
  });
  await expect(
    resumedGate.getByRole("img", { name: "Authenticator QR code" }),
  ).toBeVisible();
  expect(
    state.calls.filter(
      (call) => call.method === "POST" && call.path === "/auth/mfa/factors",
    ),
  ).toHaveLength(1);
  policy.policy.mfa_policy = "optional";
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  await expect(
    dialog.getByRole("img", { name: "Authenticator QR code" }),
  ).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("blur")));
  await expect(
    page.getByRole("img", { name: "Authenticator QR code" }),
  ).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  await expect(
    dialog.getByRole("img", { name: "Authenticator QR code" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => state.actors.get(mfaUserA)?.factors.length).toBe(0);
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const edit = page.getByRole("dialog", {
    name: "Account policy",
    exact: true,
  });
  await edit
    .getByLabel("Two-factor authentication", { exact: true })
    .selectOption("Required for administrators");
  await edit
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  const gate = page.getByRole("dialog", {
    name: "Session verification",
    exact: true,
  });
  await expect(
    gate.getByRole("heading", { name: "Complete multi-factor authentication" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 1, name: "Security & recovery" }),
  ).toHaveCount(0);
  await gate
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  await expect(
    gate.getByRole("img", { name: "Authenticator QR code" }),
  ).toBeVisible();
  expect(state.actors.get(mfaUserA)?.factors).toHaveLength(1);
});

test("accepted MFA verification remains truthful when the following settings read fails", async ({
  page,
}) => {
  const state = await mockMfa(page);
  const dialog = await openLiveMfa(page);
  await dialog
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  await expect(
    dialog.getByRole("img", { name: "Authenticator QR code" }),
  ).toBeVisible();
  state.statusFailure = 503;
  await dialog.getByLabel("Verification code", { exact: true }).fill("222222");
  await dialog
    .getByRole("button", { name: "Verify code", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Verification succeeded",
  );
  await expect(
    dialog.getByRole("img", { name: "Authenticator QR code" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Session verification", exact: true }),
  ).toBeHidden();
  state.statusFailure = 0;
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog).toContainText("Authenticator verified");
});

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user_id: "00000000-0000-4000-8000-000000000001",
        setup_required: false,
      },
    }),
  );
  await mockManageSecurity(page);
});

test("Security and recovery keeps policy drafts and protects the current session", async ({
  page,
}) => {
  const state = await mockManageSecurity(page);
  await mockMfa(page);
  await page.goto("/manage?view=security");
  await expect(
    page.getByRole("heading", { level: 1, name: "Security & recovery" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Security & recovery", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("link", { name: "Backup", exact: true }),
  ).toHaveCount(0);
  const sessions = page.getByRole("table", { name: "Sessions", exact: true });
  await expect(sessions.locator("tbody tr")).toHaveCount(4);
  const pages = page.getByRole("navigation", { name: "Session pages" });
  await pages.getByRole("button", { name: "Go to next page" }).click();
  await expect(pages.locator('[aria-current="page"]')).toHaveAttribute(
    "aria-label",
    "Page 2 of 2",
  );
  await page
    .getByRole("searchbox", { name: "Search sessions", exact: true })
    .fill("Eli");
  await expect(pages.locator('[aria-current="page"]')).toHaveAttribute(
    "aria-label",
    "Page 1 of 1",
  );
  const endEli = page.getByRole("button", {
    name: "End session for Eli",
    exact: true,
  });
  await endEli.click();
  let confirmation = page.getByRole("alertdialog", {
    name: "End session",
    exact: true,
  });
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(endEli).toBeVisible();
  expect(state.writes).toEqual([]);
  await endEli.click();
  await confirmation
    .getByRole("button", { name: "Confirm end session", exact: true })
    .click();
  await expect(endEli).toHaveCount(0);
  expect(state.writes).toEqual([
    {
      path: "/users/00000000-0000-4000-8000-000000000002/sessions/00000000-0000-4000-8000-000000000102",
      body: null,
    },
  ]);
  await page
    .getByRole("searchbox", { name: "Search sessions", exact: true })
    .fill("");

  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const policy = page.getByRole("dialog", {
    name: "Account policy",
    exact: true,
  });
  await policy
    .getByLabel("Session timeout", { exact: true })
    .selectOption("30 minutes");
  await policy.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("tab", { name: /Backups/ }).click();
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await expect(
    policy.getByLabel("Session timeout", { exact: true }),
  ).toHaveValue("30 minutes");
  const saveSettings = policy.getByRole("button", {
    name: "Save settings",
    exact: true,
  });
  await expect(saveSettings).toBeEnabled();
  await policy
    .getByLabel("Password policy", { exact: true })
    .selectOption("20-character passphrase");
  await policy
    .getByLabel("IP allow list", { exact: true })
    .fill("127.0.0.1, 192.0.2.0/24");
  await saveSettings.click();
  await expect(
    policy.getByRole("button", { name: "Discard changes", exact: true }),
  ).toBeDisabled();
  await expect(saveSettings).toBeDisabled();
  expect(state.policy).toMatchObject({
    session_timeout_minutes: 30,
    password_min_length: 20,
    password_require_mixed_case: false,
    password_require_number: false,
    ip_allow_list: ["127.0.0.1/32", "192.0.2.0/24"],
  });
  expect(state.writes[1]?.body).toMatchObject({
    ip_allow_list: ["127.0.0.1", "192.0.2.0/24"],
  });
  await policy.getByRole("button", { name: "Manage MFA", exact: true }).click();
  const mfa = page.getByRole("dialog", { name: "MFA enrollment", exact: true });
  await expect(mfa).toContainText("Authenticator app");
  await page.keyboard.press("Escape");
  await expect(mfa).toBeHidden();
  await page.reload();
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await expect(
    policy.getByLabel("Session timeout", { exact: true }),
  ).toHaveValue("30 minutes");
  await policy.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("tab", { name: /Sessions/ }).click();
  await page
    .getByRole("button", { name: "End all remote sessions", exact: true })
    .click();
  confirmation = page.getByRole("alertdialog", {
    name: "End all remote sessions",
    exact: true,
  });
  await expect(confirmation).toContainText("Your current session stays active");
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  expect(state.sessions).toHaveLength(6);
  await page
    .getByRole("button", { name: "End all remote sessions", exact: true })
    .click();
  await confirmation
    .getByRole("button", {
      name: "Confirm end all remote sessions",
      exact: true,
    })
    .click();
  await expect(sessions.locator("tbody tr")).toHaveCount(1);
  await expect(
    sessions.getByText("Current session", { exact: true }),
  ).toBeVisible();
  await expect(
    sessions.getByRole("button", { name: /End session/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "End all remote sessions", exact: true }),
  ).toBeDisabled();
  expect(state.writes.map((write) => write.path)).toEqual([
    "/users/00000000-0000-4000-8000-000000000002/sessions/00000000-0000-4000-8000-000000000102",
    "/workspace/security",
    "/auth/admin-sessions",
  ]);
});

test("Session search, filters and sorting use the full server collection", async ({
  page,
}) => {
  const state = await mockManageSecurity(page);
  await page.goto("/manage?view=security");
  const table = page.getByRole("table", { name: "Sessions", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await expect(
    table.getByRole("columnheader", { name: "Location", exact: true }),
  ).toHaveCount(0);
  await expect(
    table.getByRole("columnheader", { name: "Last refreshed", exact: true }),
  ).toBeVisible();
  const search = page.getByRole("searchbox", {
    name: "Search sessions",
    exact: true,
  });
  await search.fill("Rhea");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table).toContainText("Unknown · Unknown");
  await search.fill("");
  await page.getByRole("button", { name: "More filters", exact: true }).click();
  await page
    .getByLabel("Session device", { exact: true })
    .selectOption("Unknown");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table).toContainText("Rhea");
  await page.getByLabel("Session device", { exact: true }).selectOption("all");
  await page
    .getByLabel("Session status", { exact: true })
    .selectOption("remote");
  await page
    .getByLabel("Sort sessions", { exact: true })
    .selectOption("person-desc");
  await expect(table.locator("tbody tr").first()).toContainText("Tomas");
  await page
    .getByRole("tabpanel", { name: /Sessions/ })
    .getByLabel("Rows per page", { exact: true })
    .selectOption("10");
  await expect(table.locator("tbody tr")).toHaveCount(6);
  expect(
    state.sessionReads.some((query) => query.get("search") === "Rhea"),
  ).toBe(true);
  expect(
    state.sessionReads.some((query) => query.get("device") === "Unknown"),
  ).toBe(true);
  expect(state.sessionReads.at(-1)?.get("status")).toBe("remote");
  expect(state.sessionReads.at(-1)?.get("sort_by")).toBe("person_name");
  expect(state.sessionReads.at(-1)?.get("sort_order")).toBe("desc");
  expect(state.sessionReads.at(-1)?.get("limit")).toBe("10");
});

test("Policy conflicts and rejected IP restrictions retain drafts and organization edits", async ({
  page,
}) => {
  const state = await mockManageSecurity(page);
  await page.goto("/manage?view=organization");
  await page
    .getByLabel("Organization name", { exact: true })
    .fill("Unfinished organization edit");
  await page
    .getByRole("link", { name: "Security & recovery", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const policy = page.getByRole("dialog", {
    name: "Account policy",
    exact: true,
  });
  await policy
    .getByLabel("Session timeout", { exact: true })
    .selectOption("30 minutes");
  state.policy.revision = 2;
  state.workspace.revision = 2;
  const save = policy.getByRole("button", {
    name: "Save settings",
    exact: true,
  });
  await save.click();
  await expect(policy).toContainText("Policy changed since you opened it");
  await expect(
    policy.getByLabel("Session timeout", { exact: true }),
  ).toHaveValue("30 minutes");
  expect(state.policy.session_timeout_minutes).toBe(60);
  state.policyWriteFailure = { status: 409, code: "ip_lockout" };
  await policy
    .getByLabel("IP allow list", { exact: true })
    .fill("192.0.2.0/24");
  await save.click();
  await expect(policy).toContainText(
    "The IP allow list would block your current address",
  );
  await expect(policy.getByLabel("IP allow list", { exact: true })).toHaveValue(
    "192.0.2.0/24",
  );
  state.policyWriteFailure = { status: 422, code: "validation_error" };
  await policy
    .getByLabel("IP allow list", { exact: true })
    .fill("invalid-range");
  await save.click();
  await expect(policy).toContainText(
    "Check the policy values and IP addresses",
  );
  await expect(policy.getByLabel("IP allow list", { exact: true })).toHaveValue(
    "invalid-range",
  );
  state.policyWriteFailure = { status: 503, code: "unavailable" };
  await policy
    .getByLabel("IP allow list", { exact: true })
    .fill("127.0.0.1/32");
  await save.click();
  await expect(policy).toContainText("The policy could not be saved");
  await expect(save).toBeEnabled();
  state.policyWriteFailure = null;
  await save.click();
  await expect(save).toBeDisabled();
  expect(state.policy.revision).toBe(3);
  await policy.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await expect(
    page.getByLabel("Organization name", { exact: true }),
  ).toHaveValue("Unfinished organization edit");
  expect(state.workspaceReads).toBeGreaterThan(1);
});

test("Security reads show recovery and denial without sample sessions", async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockManageSecurity(page);
  state.sessionReadStatus = 503;
  state.policyReadStatus = 503;
  await page.route("**/api/notifications**", (route) =>
    route.fulfill({
      status: 503,
      json: {
        detail: "Notifications unavailable in this controlled navigation",
      },
    }),
  );
  await page.route("**/api/events", (route) => route.fulfill({ status: 503 }));
  await page.goto("/manage?view=security");
  await expect(
    page.getByText("Sessions could not be loaded.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Sessions", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "End all remote sessions", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const policy = page.getByRole("dialog", {
    name: "Account policy",
    exact: true,
  });
  await expect(
    policy.getByLabel("Session timeout", { exact: true }),
  ).toHaveCount(0);
  state.policyReadStatus = 200;
  await policy
    .getByRole("button", { name: "Retry account policy", exact: true })
    .click();
  await expect(
    policy.getByLabel("Session timeout", { exact: true }),
  ).toHaveValue("60 minutes");
  state.policyReadStatus = 403;
  state.policy.revision = 2;
  state.workspace.revision = 2;
  await policy
    .getByLabel("Session timeout", { exact: true })
    .selectOption("30 minutes");
  await policy
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    policy.getByText("Only administrators can review account policy.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    policy.getByLabel("Session timeout", { exact: true }),
  ).toHaveCount(0);
  await policy.getByRole("button", { name: "Close", exact: true }).click();
  state.sessionReadStatus = 200;
  await page
    .getByRole("button", { name: "Retry sessions", exact: true })
    .click();
  await expect(
    page
      .getByRole("table", { name: "Sessions", exact: true })
      .locator("tbody tr"),
  ).toHaveCount(4);
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await page
    .getByLabel("Organization name", { exact: true })
    .fill("Draft retained during refusal");
  await page.clock.fastForward(31_000);
  let releaseBackgroundRead = () => {};
  let signalBackgroundRead = () => {};
  const backgroundReleased = new Promise<void>((resolve) => {
    releaseBackgroundRead = resolve;
  });
  const backgroundStarted = new Promise<void>((resolve) => {
    signalBackgroundRead = resolve;
  });
  let holdNextRead = true;
  await page.route("**/api/auth/admin-sessions**", async (route) => {
    if (holdNextRead && route.request().method() === "GET") {
      holdNextRead = false;
      signalBackgroundRead();
      await backgroundReleased;
    }
    await route.fallback();
  });
  state.sessionReadStatus = 403;
  try {
    await page
      .getByRole("link", { name: "Security & recovery", exact: true })
      .click();
    await backgroundStarted;
    await page
      .getByRole("button", { name: "End session for Eli", exact: true })
      .click();
    const sessionConfirmation = page.getByRole("alertdialog", {
      name: "End session",
      exact: true,
    });
    await expect(sessionConfirmation).toContainText("Eli");
    releaseBackgroundRead();
    await expect(
      page.getByText("Only administrators can review sessions.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(sessionConfirmation).toBeHidden();
  } finally {
    releaseBackgroundRead();
  }
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await expect(
    page.getByLabel("Organization name", { exact: true }),
  ).toHaveValue("Draft retained during refusal");
  await page
    .getByRole("link", { name: "Security & recovery", exact: true })
    .click();
  await page
    .getByRole("searchbox", { name: "Search sessions", exact: true })
    .fill("Mara");
  await expect(
    page.getByText("Only administrators can review sessions.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Sessions", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("searchbox", { name: "Search sessions", exact: true })
    .fill("");
  await expect(
    page.getByRole("table", { name: "Sessions", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Notifications", exact: true }).click();
  // The organization draft above is unsaved, so leaving Manage asks first.
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Discard changes" })
    .click();
  await expect(page).toHaveURL(/\/platform/);
  const manageGroup = page.getByRole("button", { name: "Manage", exact: true });
  if ((await manageGroup.getAttribute("aria-expanded")) !== "true")
    await manageGroup.click();
  await page
    .getByRole("link", { name: "Security & recovery", exact: true })
    .click();
  await expect(
    page.getByText("Only administrators can review sessions.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Sessions", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await expect(
    policy.getByText("Only administrators can review account policy.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    policy.getByLabel("Session timeout", { exact: true }),
  ).toHaveCount(0);
  state.policyReadStatus = 200;
  await policy
    .getByRole("button", { name: "Retry account policy", exact: true })
    .click();
  await expect(
    policy.getByLabel("Session timeout", { exact: true }),
  ).toHaveValue("60 minutes");
  await policy.getByRole("button", { name: "Close", exact: true }).click();
  state.sessionReadStatus = 200;
  await page
    .getByRole("button", { name: "Retry sessions", exact: true })
    .click();
  await expect(
    page
      .getByRole("table", { name: "Sessions", exact: true })
      .locator("tbody tr"),
  ).toHaveCount(4);
});

test("Rejected session ending keeps the row and permits retry", async ({
  page,
}) => {
  const state = await mockManageSecurity(page);
  state.sessionWriteStatus = 503;
  await page.goto("/manage?view=security");
  const end = page.getByRole("button", {
    name: "End session for Eli",
    exact: true,
  });
  await end.click();
  const confirmation = page.getByRole("alertdialog", {
    name: "End session",
    exact: true,
  });
  await confirmation
    .getByRole("button", { name: "Confirm end session", exact: true })
    .click();
  await expect(confirmation).toContainText("The session could not be ended");
  expect(state.sessions).toHaveLength(7);
  state.sessionWriteStatus = 204;
  await confirmation
    .getByRole("button", { name: "Confirm end session", exact: true })
    .click();
  await expect(confirmation).toBeHidden();
  await expect(end).toHaveCount(0);
});

test("Back up now queues real history, cancels without writes, and preserves policy drafts", async ({
  page,
}) => {
  const security = await mockManageSecurity(page);
  const backup = await mockManageBackups(page);
  await page.goto("/manage?view=backup");
  const table = page.getByRole("table", {
    name: "Backup history",
    exact: true,
  });
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const policy = page.getByRole("dialog", {
    name: "Account policy",
    exact: true,
  });
  await policy
    .getByLabel("Session timeout", { exact: true })
    .selectOption("30 minutes");
  await policy.getByRole("button", { name: "Close", exact: true }).click();

  const opener = page.getByRole("button", { name: "Back up now", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Back up now", exact: true });
  await dialog
    .getByLabel("Backup name", { exact: true })
    .fill("Cancelled backup");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  expect(backup.queueRequests).toEqual([]);

  await opener.click();
  await dialog
    .getByLabel("Backup name", { exact: true })
    .fill("Working recovery point");
  await dialog
    .getByRole("button", { name: "Back up now", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await page
    .getByRole("button", {
      name: "Inspect Working recovery point",
      exact: true,
    })
    .click();
  const inspector = page.getByRole("region", {
    name: "Selected backup",
    exact: true,
  });
  await expect(inspector.getByText("Queued", { exact: true })).toBeVisible();
  await expect(inspector).toContainText("Not verified");
  await expect(
    inspector.getByRole("link", { name: "Restore procedure" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/jayeuse/openslate/blob/main/infra/supabase/RESTORE.md",
  );
  await expect(
    page.getByRole("button", {
      name: /Restore snapshot|Compare with current|Snapshot actions|Simulate scheduled backup/,
    }),
  ).toHaveCount(0);
  expect(backup.queueRequests).toHaveLength(1);
  expect(backup.queueRequests[0]?.name).toBe("Working recovery point");
  expect(backup.queueRequests[0]?.key).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
  expect(backup.runs[0]).toMatchObject({
    name: "Working recovery point",
    state: "queued",
    snapshot_id: null,
    verified_at: null,
  });
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await expect(
    policy.getByLabel("Session timeout", { exact: true }),
  ).toHaveValue("30 minutes");
  expect(security.writes).toEqual([]);
  expect(security.policy.session_timeout_minutes).toBe(60);
  await policy.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Inspect Working recovery point",
      exact: true,
    }),
  ).toBeVisible();
});

test("Backup schedule saves revisioned real policy and keeps cancelled drafts without simulation", async ({
  page,
}) => {
  await mockManageSecurity(page);
  const backup = await mockManageBackups(page);
  await page.goto("/manage?view=security");
  await page
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Backup schedule",
    exact: true,
  });
  const schedule = dialog.getByLabel("Backup schedule", { exact: true });
  const retention = dialog.getByLabel("Retention period", { exact: true });
  await expect(schedule).toHaveValue("disabled");
  await schedule.selectOption("weekly");
  await retention.selectOption("90");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  expect(backup.patches).toEqual([]);
  await page
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  await expect(schedule).toHaveValue("weekly");
  await dialog
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(schedule).toHaveValue("disabled");
  await expect(retention).toHaveValue("30");
  await schedule.selectOption("weekly");
  await retention.selectOption("90");
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Discard changes", exact: true }),
  ).toBeDisabled();
  expect(backup.patches).toEqual([
    { revision: 1, schedule: "weekly", retention_days: 90 },
  ]);
  await schedule.selectOption("daily");
  backup.policy.timezone = "UTC";
  await sendOpenViewEvent(page, "invalidate", { entity: "workspace_profiles" });
  await expect(dialog).toContainText("UTC");
  await expect(schedule).toHaveValue("daily");
  await expect(
    dialog.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: "Review latest policy", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(dialog).toContainText("UTC");
  await expect(dialog).toContainText(
    "Saving this policy does not install a host runner",
  );
  await expect(
    dialog.getByRole("button", {
      name: /Simulate|Preview retention candidates/,
    }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await page
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  await expect(schedule).toHaveValue("weekly");
  await expect(retention).toHaveValue("90");
});

test("Backup server paging and filters clear selection without slicing the returned page", async ({
  page,
}) => {
  await mockManageSecurity(page);
  const backup = await mockManageBackups(page);
  backup.runs = backup.runs.map((run, index) => ({
    ...run,
    installation: index === 1 ? "previous" : "current",
    state: "queued",
    started_at: null,
    finished_at: null,
    reconciled_at: null,
    snapshot_id: null,
    manifest_sha256: null,
    verified_at: null,
  }));
  await page.goto("/manage?view=backup");
  const table = page.getByRole("table", {
    name: "Backup history",
    exact: true,
  });
  const inspector = page.getByRole("region", {
    name: "Selected backup",
    exact: true,
  });
  await page.getByRole("button", { name: "More filters" }).click();
  await page.getByLabel("Status", { exact: true }).selectOption("queued");
  await page.getByRole("button", { name: "More filters" }).click();
  await page
    .getByRole("button", { name: "Inspect Backup 1", exact: true })
    .click();
  await expect(inspector).toBeVisible();
  await page
    .getByRole("navigation", { name: "Backup pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Inspect Backup 6", exact: true }),
  ).toBeVisible();
  await expect(inspector).toHaveCount(0);
  expect(backup.historyReads.at(-1)?.get("offset")).toBe("4");
  backup.runs = backup.runs.map((run, index) =>
    index < 2 ? run : backupRun(index + 1),
  );
  await sendOpenViewEvent(page, "invalidate", { entity: "backup_runs" });
  await expect(
    page.getByText("Showing 1–2 of 2", { exact: true }),
  ).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Inspect Backup 1", exact: true }),
  ).toBeVisible();
  await expect(inspector).toHaveCount(0);
  expect(backup.historyReads.at(-1)?.get("offset")).toBe("0");
  expect(backup.historyReads.at(-1)?.get("limit")).toBe("4");
  expect(backup.historyReads.at(-1)?.get("state")).toBe("queued");
  expect(backup.runs).toHaveLength(6);
  await page.getByRole("button", { name: "More filters" }).click();
  await page.getByLabel("Status", { exact: true }).selectOption("all");
  await page.getByRole("button", { name: "More filters" }).click();
  await page
    .getByRole("searchbox", { name: "Search backups" })
    .fill("Backup 6");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  expect(backup.historyReads.at(-1)?.get("offset")).toBe("0");
  await page.getByRole("searchbox", { name: "Search backups" }).fill("");
  await page
    .getByRole("tabpanel", { name: /Backups/ })
    .getByLabel("Rows per page")
    .selectOption("10");
  await expect(table.locator("tbody tr")).toHaveCount(6);
  await page
    .getByRole("button", { name: "Inspect Backup 2", exact: true })
    .click();
  await expect(inspector).toContainText("Previous installation");
  await page.getByLabel("Sort backups").selectOption("name");
  await expect(inspector).toHaveCount(0);
  await page.getByRole("button", { name: "More filters" }).click();
  await page
    .getByLabel("Installation", { exact: true })
    .selectOption("previous");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  expect(backup.historyReads.at(-1)?.get("installation")).toBe("previous");
  expect(backup.historyReads.at(-1)?.get("deleted")).toBe("exclude");
  expect(backup.historyReads.at(-1)?.has("schedule")).toBe(false);
});

test("Backup failure and denial never expose sample policy or cached history as accepted reads", async ({
  page,
}) => {
  await mockManageSecurity(page);
  const backup = await mockManageBackups(page);
  backup.statusReadStatus = 503;
  backup.historyReadStatus = 503;
  await page.goto("/manage?view=backup");
  await expect(
    page.getByText("Backup policy could not be loaded.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Backup history could not be loaded.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Back up now", exact: true }),
  ).toBeDisabled();
  backup.statusReadStatus = 200;
  backup.historyReadStatus = 200;
  await page
    .getByRole("button", { name: "Retry backup policy", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Retry backup history", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Inspect Backup 1", exact: true }),
  ).toBeVisible();
  backup.historyReadStatus = 403;
  await sendOpenViewEvent(page, "invalidate", { entity: "backup_runs" });
  await expect(
    page.getByText("Only administrators can review backups.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inspect Backup 1", exact: true }),
  ).toHaveCount(0);
  backup.historyReadStatus = 200;
  await page
    .getByRole("button", { name: "Retry backup history", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Inspect Backup 1", exact: true }),
  ).toBeVisible();
  backup.malformedStatus = true;
  await sendOpenViewEvent(page, "invalidate", { entity: "backup_policies" });
  await expect(
    page.getByText("Backup policy could not be loaded.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Back up now", exact: true }),
  ).toBeDisabled();
  expect(backup.patches).toEqual([]);
  expect(backup.queueRequests).toEqual([]);
});

test("Backup conflict retains a draft and queue retry reuses the accepted request after an uncertain outcome", async ({
  page,
}) => {
  await mockManageSecurity(page);
  const backup = await mockManageBackups(page);
  await page.goto("/manage?view=backup");
  await page
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  const policy = page.getByRole("dialog", {
    name: "Backup schedule",
    exact: true,
  });
  await policy
    .getByLabel("Backup schedule", { exact: true })
    .selectOption("daily");
  backup.policy.revision = 2;
  backup.policy.schedule = "weekly";
  backup.policy.retention_days = 90;
  await sendOpenViewEvent(page, "invalidate", { entity: "backup_policies" });
  await expect(policy).toContainText(
    "Backup policy changed. Your draft is still here",
  );
  await expect(
    policy.getByLabel("Backup schedule", { exact: true }),
  ).toHaveValue("daily");
  await expect(
    policy.getByLabel("Retention period", { exact: true }),
  ).toHaveValue("30");
  await expect(
    policy.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeDisabled();
  expect(backup.patches).toEqual([]);
  await policy
    .getByRole("button", { name: "Review latest policy", exact: true })
    .click();
  await expect(
    policy.getByLabel("Retention period", { exact: true }),
  ).toHaveValue("90");
  await expect(
    policy.getByLabel("Backup schedule", { exact: true }),
  ).toHaveValue("daily");
  await policy
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    policy.getByRole("button", { name: "Discard changes", exact: true }),
  ).toBeDisabled();
  await policy
    .getByLabel("Retention period", { exact: true })
    .selectOption("7");
  backup.policy.revision = 4;
  await policy
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(policy).toContainText(
    "Backup policy changed. Your draft is still here",
  );
  await expect(
    policy.getByLabel("Retention period", { exact: true }),
  ).toHaveValue("7");
  await expect(
    policy.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeDisabled();
  await policy
    .getByRole("button", { name: "Review latest policy", exact: true })
    .click();
  await policy
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    policy.getByRole("button", { name: "Discard changes", exact: true }),
  ).toBeDisabled();
  expect(backup.patches).toEqual([
    { revision: 2, schedule: "daily" },
    { revision: 3, retention_days: 7 },
    { revision: 4, retention_days: 7 },
  ]);
  await policy.getByRole("button", { name: "Close", exact: true }).click();
  backup.queueFailureAfterCommit = true;
  await page.getByRole("button", { name: "Back up now", exact: true }).click();
  const queue = page.getByRole("dialog", { name: "Back up now", exact: true });
  await queue
    .getByLabel("Backup name", { exact: true })
    .fill("One recovery point");
  await queue.getByRole("button", { name: "Back up now", exact: true }).click();
  await expect(queue).toContainText("could not be confirmed");
  await expect(queue.getByLabel("Backup name", { exact: true })).toHaveValue(
    "One recovery point",
  );
  await queue.getByRole("button", { name: "Back up now", exact: true }).click();
  await expect(queue).toBeHidden();
  expect(backup.queueRequests).toHaveLength(2);
  expect(backup.queueRequests[0]?.key).toBe(backup.queueRequests[1]?.key);
  expect(
    backup.runs.filter((run) => run.name === "One recovery point"),
  ).toHaveLength(1);
});

test("Backup pending submission blocks duplicate and route leave, then events refresh truthful recovery state", async ({
  page,
}) => {
  await mockManageSecurity(page);
  const backup = await mockManageBackups(page);
  let release!: () => void;
  backup.holdWrite = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.goto("/manage?view=backup");
  await page.getByRole("button", { name: "Back up now", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Back up now", exact: true });
  await dialog.getByLabel("Backup name", { exact: true }).fill("Held request");
  const submit = dialog.getByRole("button", {
    name: "Back up now",
    exact: true,
  });
  await submit.click();
  await expect(
    dialog.getByRole("button", { name: "Queueing…", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  // The modal makes navigation inert; invoke the existing link to prove its
  // pending guard also rejects a navigation request behind that modal.
  await page.evaluate(() => {
    document
      .querySelector<HTMLAnchorElement>('a[href="/manage?view=organization"]')
      ?.click();
  });
  await expect(page).toHaveURL(/view=backup/);
  expect(backup.queueRequests).toHaveLength(1);
  release();
  await expect(dialog).toBeHidden();
  backup.runs[0] = {
    ...backup.runs[0]!,
    state: "failed",
    started_at: "2026-10-08T12:01:00Z",
    finished_at: "2026-10-08T12:04:00Z",
    failure_code: "restart_failed",
    snapshot_id: "b".repeat(64),
    manifest_sha256: "b".repeat(64),
    verified_at: "2026-10-08T12:03:00Z",
  };
  backup.runner.state = "recovery_required";
  await sendOpenViewEvent(page, "invalidate", { entity: "backup_runs" });
  await expect(
    page.getByText("Operator recovery required", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Inspect Held request", exact: true })
    .click();
  const inspector = page.getByRole("region", {
    name: "Selected backup",
    exact: true,
  });
  await expect(inspector).toContainText("Verified");
  await expect(inspector).toContainText("Not reconciled");
  await expect(inspector).toContainText("Services did not restart");
  await expect(inspector.getByText("Completed", { exact: true })).toHaveCount(
    0,
  );
});
