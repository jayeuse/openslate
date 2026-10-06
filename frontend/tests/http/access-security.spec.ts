import { expect, test } from "./helpers/test";
import { mockManageSecurity } from "./helpers/manage-security";
import {
  concealMfaTestCredentials,
  deferredMfaResponse,
  mockMfa,
  mfaUserA,
  mfaUserB,
} from "./helpers/mfa";
import type { Page } from "./helpers/test";
import { accessDraftStorageKey } from "../../src/components/systems/access/state/draft-journal-storage";

test.use({ trace: "off", screenshot: "off", video: "off" });
test.afterEach(async ({ page }) => {
  await concealMfaTestCredentials(page);
});

async function openLiveMfa(page: Page) {
  await page.goto("/access?view=security");
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
  const cleanupNotice = page
    .getByRole("alert")
    .filter({ hasText: "unfinished authenticator could not be removed" });
  await expect(cleanupNotice).toHaveAttribute("data-variant", "destructive");
  expect(
    await cleanupNotice.evaluate(
      (element) => getComputedStyle(element).position,
    ),
  ).toBe("static");
  await expect(
    page.getByRole("img", { name: "Authenticator QR code" }),
  ).toHaveCount(0);
  state.cleanupFailure = 0;
  await page
    .getByRole("button", { name: "Retry cleanup", exact: true })
    .click();
  await expect.poll(() => state.actors.get(mfaUserA)?.factors.length).toBe(0);
  await page.getByRole("button", { name: /^Notifications(?:,|$)/ }).click();
  await page.getByRole("link", { name: "View all", exact: true }).click();
  await expect(page).toHaveURL(/\/platform\?section=notifications$/);
  await expect(
    page.getByRole("heading", { name: "Platform", exact: true }),
  ).toBeVisible();
  const manageGroup = page.getByRole("button", { name: "Access", exact: true });
  if ((await manageGroup.getAttribute("aria-expanded")) !== "true")
    await manageGroup.click();
  await page.getByRole("link", { name: "Security", exact: true }).click();
  await expect(page).toHaveURL(/\/access\?view=security$/);
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
    name: "Access",
    exact: true,
  });
  if ((await manageReturn.getAttribute("aria-expanded")) !== "true")
    await manageReturn.click();
  await page.getByRole("link", { name: "Security", exact: true }).click();
  await expect(page).toHaveURL(/\/access\?view=security$/);
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
    isRequired: () => policy.policy.mfa_require_admin,
  });
  const dialog = await openLiveMfa(page);
  await dialog
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  await expect(
    dialog.getByRole("img", { name: "Authenticator QR code" }),
  ).toBeVisible();
  policy.policy.mfa_require_admin = true;
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
  policy.policy.mfa_require_admin = false;
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
    .getByRole("checkbox", {
      name: "Require MFA for administrators",
      exact: true,
    })
    .check();
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
    page.getByRole("heading", { level: 1, name: "Security" }),
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
  await page.goto("/access?view=security");
  await expect(
    page.getByRole("heading", { level: 1, name: "Security" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Security", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  const manageNavigation = page.getByRole("button", {
    name: "Manage",
    exact: true,
  });
  if ((await manageNavigation.getAttribute("aria-expanded")) !== "true")
    await manageNavigation.click();
  await expect(
    page.getByRole("link", { name: "Backup", exact: true }),
  ).toHaveAttribute("href", "/manage?view=backup");
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
    .getByLabel("Minimum password length", { exact: true })
    .fill("20");
  await policy
    .getByRole("checkbox", {
      name: "Require uppercase and lowercase letters",
      exact: true,
    })
    .uncheck();
  await policy
    .getByLabel("IP address or CIDR", { exact: true })
    .fill("127.0.0.1");
  await policy
    .getByRole("button", { name: "Add address", exact: true })
    .click();
  await policy
    .getByLabel("IP address or CIDR", { exact: true })
    .fill("192.0.2.0/24");
  await policy
    .getByRole("button", { name: "Add address", exact: true })
    .click();
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
  await page.goto("/access?view=security");
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
  await page.getByLabel("Rows per page", { exact: true }).selectOption("10");
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
  await page.getByRole("button", { name: "Access", exact: true }).click();
  await page.getByRole("link", { name: "Security", exact: true }).click();
  const leave = page.getByRole("alertdialog", {
    name: "Discard unsaved Manage changes?",
    exact: true,
  });
  await expect(leave).toBeVisible();
  await leave
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  await expect(
    page.getByLabel("Organization name", { exact: true }),
  ).toHaveValue("Unfinished organization edit");
  await page.getByRole("link", { name: "Security", exact: true }).click();
  await leave
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const policy = page.getByRole("dialog", {
    name: "Account policy",
    exact: true,
  });
  await policy
    .getByLabel("Session timeout", { exact: true })
    .selectOption("30 minutes");
  const threshold = policy.getByLabel("Failed attempts before lockout", {
    exact: true,
  });
  await threshold.fill("4");
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
  await expect(threshold).toHaveValue("4");
  expect(state.policy.session_timeout_minutes).toBe(60);
  state.policyWriteFailure = { status: 409, code: "ip_lockout" };
  const address = policy.getByLabel("IP address or CIDR", { exact: true });
  await address.fill("192.0.2.0/24");
  await policy
    .getByRole("button", { name: "Add address", exact: true })
    .click();
  await save.click();
  await expect(policy).toContainText(
    "The IP allow list would block your current address",
  );
  await expect(
    policy.getByRole("button", { name: "Remove 192.0.2.0/24", exact: true }),
  ).toBeVisible();
  state.policyWriteFailure = { status: 422, code: "validation_error" };
  await policy
    .getByRole("button", { name: "Remove 192.0.2.0/24", exact: true })
    .click();
  await address.fill("198.51.100.0/24");
  await policy
    .getByRole("button", { name: "Add address", exact: true })
    .click();
  await save.click();
  await expect(policy).toContainText(
    "Check the policy values and IP addresses",
  );
  await expect(
    policy.getByRole("button", { name: "Remove 198.51.100.0/24", exact: true }),
  ).toBeVisible();
  state.policyWriteFailure = { status: 503, code: "unavailable" };
  await policy
    .getByRole("button", { name: "Remove 198.51.100.0/24", exact: true })
    .click();
  await address.fill("127.0.0.1/32");
  await policy
    .getByRole("button", { name: "Add address", exact: true })
    .click();
  await save.click();
  await expect(policy).toContainText("The policy could not be saved");
  await expect(threshold).toHaveValue("4");
  await expect(save).toBeEnabled();
  state.policyWriteFailure = null;
  await save.click();
  await expect(save).toBeDisabled();
  expect(state.policy.revision).toBe(3);
  expect(state.writes.at(-1)?.body).toMatchObject({
    revision: 2,
    login_failed_attempt_threshold: 4,
  });
  await policy.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await expect(
    page.getByLabel("Organization name", { exact: true }),
  ).toHaveValue("Harbor School");
  expect(state.workspaceReads).toBeGreaterThan(1);
});

test("12b: independent roles and numeric limits save only changed keys, including false zero and Off", async ({
  page,
}) => {
  const state = await mockManageSecurity(page);
  await mockMfa(page);
  await page.goto("/access?view=security");
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const policy = page.getByRole("dialog", {
    name: "Account policy",
    exact: true,
  });
  const save = policy.getByRole("button", {
    name: "Save settings",
    exact: true,
  });
  const lifetime = policy.getByLabel("Total session lifetime", { exact: true });
  const cap = policy.getByLabel("Concurrent session limit", { exact: true });
  const admin = policy.getByRole("checkbox", {
    name: "Require MFA for administrators",
    exact: true,
  });
  const member = policy.getByRole("checkbox", {
    name: "Require MFA for members",
    exact: true,
  });
  const guest = policy.getByRole("checkbox", {
    name: "Require MFA for guests",
    exact: true,
  });
  const grace = policy.getByLabel("Enrollment grace (days)", { exact: true });
  await expect(lifetime).toHaveValue("Off");
  await expect(cap).toHaveValue("Off");
  await member.check();
  await member.uncheck();
  await expect(save).toBeDisabled();
  await lifetime.selectOption("Set a limit");
  await policy.getByLabel("Lifetime (minutes)", { exact: true }).fill("43200");
  await cap.selectOption("Set a limit");
  await policy.getByLabel("Maximum sessions", { exact: true }).fill("100");
  await expect(policy).toContainText("Applies when sign-in completes.");
  await admin.check();
  await guest.check();
  await grace.fill("30");
  await policy
    .getByLabel("Failed attempts before lockout", { exact: true })
    .fill("1");
  await policy
    .getByLabel("Attempt window (minutes)", { exact: true })
    .fill("1440");
  await policy
    .getByLabel("Lockout duration (minutes)", { exact: true })
    .fill("1440");
  await save.click();
  await expect(save).toBeDisabled();
  expect(state.writes.at(-1)?.body).toEqual({
    revision: 1,
    session_absolute_lifetime_minutes: 43200,
    session_concurrent_limit: 100,
    mfa_require_admin: true,
    mfa_require_guest: true,
    mfa_grace_days: 30,
    login_failed_attempt_threshold: 1,
    login_window_minutes: 1440,
    login_cooldown_minutes: 1440,
  });
  await page.reload();
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await expect(
    policy.getByLabel("Lifetime (minutes)", { exact: true }),
  ).toHaveValue("43200");
  await expect(
    policy.getByLabel("Maximum sessions", { exact: true }),
  ).toHaveValue("100");
  await expect(admin).toBeChecked();
  await expect(member).not.toBeChecked();
  await expect(guest).toBeChecked();
  await expect(grace).toHaveValue("30");
  await admin.uncheck();
  await guest.uncheck();
  await grace.fill("0");
  await lifetime.selectOption("Off");
  await cap.selectOption("Off");
  await save.click();
  await expect(save).toBeDisabled();
  expect(state.writes.at(-1)?.body).toEqual({
    revision: 2,
    session_absolute_lifetime_minutes: null,
    session_concurrent_limit: null,
    mfa_require_admin: false,
    mfa_require_guest: false,
    mfa_grace_days: 0,
  });
  await page.reload();
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await expect(lifetime).toHaveValue("Off");
  await expect(cap).toHaveValue("Off");
  await expect(admin).not.toBeChecked();
  await expect(guest).not.toBeChecked();
  await expect(grace).toHaveValue("0");
  await expect(
    policy.getByLabel("Failed attempts before lockout", { exact: true }),
  ).toHaveValue("1");
  await expect(save).toBeDisabled();
});

test("12b: numeric bounds and whole numbers retain invalid drafts without a request or page error", async ({
  page,
}) => {
  const state = await mockManageSecurity(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/access?view=security");
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const policy = page.getByRole("dialog", {
    name: "Account policy",
    exact: true,
  });
  const save = policy.getByRole("button", {
    name: "Save settings",
    exact: true,
  });
  await policy
    .getByLabel("Total session lifetime", { exact: true })
    .selectOption("Set a limit");
  await save.click();
  await expect(
    policy.getByLabel("Lifetime (minutes)", { exact: true }),
  ).toHaveAttribute("aria-invalid", "true");
  await policy
    .getByLabel("Concurrent session limit", { exact: true })
    .selectOption("Set a limit");
  const cases = [
    ["Lifetime (minutes)", "43201", "1"],
    ["Maximum sessions", "101", "1"],
    ["Enrollment grace (days)", "-1", "0"],
    ["Failed attempts before lockout", "0", "100"],
    ["Attempt window (minutes)", "1441", "1"],
    ["Lockout duration (minutes)", "1.5", "1"],
  ] as const;
  for (const [label, invalid] of cases)
    await policy.getByLabel(label, { exact: true }).fill(invalid);
  await save.click();
  for (const [label, invalid] of cases) {
    await expect(policy.getByLabel(label, { exact: true })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(policy.getByLabel(label, { exact: true })).toHaveValue(
      invalid,
    );
  }
  await policy
    .getByLabel("Lockout duration (minutes)", { exact: true })
    .fill("1e2");
  await save.click();
  await expect(
    policy.getByLabel("Lockout duration (minutes)", { exact: true }),
  ).toHaveAttribute("aria-invalid", "true");
  expect(state.writes).toEqual([]);
  expect(pageErrors).toEqual([]);
  for (const [label, , valid] of cases)
    await policy.getByLabel(label, { exact: true }).fill(valid);
  await save.click();
  await expect(save).toBeDisabled();
  expect(state.writes.at(-1)?.body).toEqual({
    revision: 1,
    session_absolute_lifetime_minutes: 1,
    session_concurrent_limit: 1,
    login_failed_attempt_threshold: 100,
    login_window_minutes: 1,
    login_cooldown_minutes: 1,
  });
  expect(pageErrors).toEqual([]);
});

test("12b: a refused all-role MFA save retains the future draft and offers current Manage MFA before retry", async ({
  page,
}) => {
  const state = await mockManageSecurity(page);
  const identity = await mockMfa(page);
  state.policyWriteFailure = { status: 409, code: "mfa_enrollment_required" };
  await page.goto("/access?view=security");
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const policy = page.getByRole("dialog", {
    name: "Account policy",
    exact: true,
  });
  const roles = ["administrators", "members", "guests"] as const;
  for (const role of roles)
    await policy
      .getByRole("checkbox", { name: `Require MFA for ${role}`, exact: true })
      .check();
  await policy.getByLabel("Enrollment grace (days)", { exact: true }).fill("7");
  const save = policy.getByRole("button", {
    name: "Save settings",
    exact: true,
  });
  await save.click();
  await expect(policy.getByRole("alert")).toContainText(
    "Set up and verify an authenticator before requiring MFA for all roles",
  );
  await expect(save).toBeEnabled();
  for (const role of roles)
    await expect(
      policy.getByRole("checkbox", {
        name: `Require MFA for ${role}`,
        exact: true,
      }),
    ).toBeChecked();
  await expect(
    policy.getByLabel("Enrollment grace (days)", { exact: true }),
  ).toHaveValue("7");
  expect(state.policy).toMatchObject({
    mfa_require_admin: false,
    mfa_require_member: false,
    mfa_require_guest: false,
  });
  await policy.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Security" }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Session verification", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  for (const role of roles)
    await expect(
      policy.getByRole("checkbox", {
        name: `Require MFA for ${role}`,
        exact: true,
      }),
    ).toBeChecked();
  const actor = identity.actors.get(mfaUserA)!;
  actor.assurance = "aal2";
  actor.factors.push({
    id: "00000000-0000-4000-8000-000000000771",
    factor_type: "totp",
    status: "verified",
  });
  await policy.getByRole("button", { name: "Manage MFA", exact: true }).click();
  const mfa = page.getByRole("dialog", { name: "MFA enrollment", exact: true });
  await expect(mfa).toContainText("Authenticator verified");
  await mfa.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  for (const role of roles)
    await expect(
      policy.getByRole("checkbox", {
        name: `Require MFA for ${role}`,
        exact: true,
      }),
    ).toBeChecked();
  state.policyWriteFailure = null;
  await save.click();
  await expect(save).toBeDisabled();
  expect(state.writes.at(-1)?.body).toEqual({
    revision: 1,
    mfa_require_admin: true,
    mfa_require_member: true,
    mfa_require_guest: true,
    mfa_grace_days: 7,
  });
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
  await page.goto("/access?view=security");
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
  await page.clock.fastForward(31_000);
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page
    .getByRole("alertdialog", { name: "Discard unsaved changes?", exact: true })
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
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
    await page.getByRole("link", { name: "Security", exact: true }).click();
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
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.getByRole("link", { name: "Security", exact: true }).click();
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
  await page.getByRole("button", { name: /^Notifications(?:,|$)/ }).click();
  await page.getByRole("link", { name: "View all", exact: true }).click();
  await expect(page).toHaveURL(/\/platform/);
  const manageGroup = page.getByRole("button", { name: "Access", exact: true });
  if ((await manageGroup.getAttribute("aria-expanded")) !== "true")
    await manageGroup.click();
  await page.getByRole("link", { name: "Security", exact: true }).click();
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
  await page.goto("/access?view=security");
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

test("legacy Manage Security opens Access Security and Backup has no privileged security reads", async ({
  page,
}) => {
  const state = await mockManageSecurity(page);
  await page.goto("/manage?view=security");
  await expect(page).toHaveURL(/\/access\?view=security$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Security", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Sessions", exact: true }),
  ).toBeVisible();
  expect(state.policyReads).toBeGreaterThan(0);
  const policyReads = state.policyReads;
  const sessionReads = state.sessionReads.length;
  const manage = page.getByRole("button", { name: "Manage", exact: true });
  if ((await manage.getAttribute("aria-expanded")) !== "true")
    await manage.click();
  await page.getByRole("link", { name: "Backup", exact: true }).click();
  await expect(page).toHaveURL(/\/manage\?view=backup$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Backup", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit policy", exact: true }),
  ).toHaveCount(0);
  expect(state.policyReads).toBe(policyReads);
  expect(state.sessionReads).toHaveLength(sessionReads);
  await expect(
    page.getByRole("link", { name: "Sign-in & security", exact: true }),
  ).toHaveAttribute("href", "/access?view=security");
});

test("Access policy leave keeps edits until explicit Discard and preserves Organization privacy fields", async ({
  page,
}) => {
  const state = await mockManageSecurity(page);
  await page.goto("/access?view=security");
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const policy = page.getByRole("dialog", {
    name: "Account policy",
    exact: true,
  });
  await policy
    .getByLabel("Session timeout", { exact: true })
    .selectOption("30 minutes");
  await policy.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("link", { name: "People", exact: true }).click();
  const leave = page.getByRole("alertdialog", {
    name: "Discard unsaved changes?",
    exact: true,
  });
  await expect(leave).toBeVisible();
  await leave
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  await expect(page).toHaveURL(/view=security$/);
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await expect(
    policy.getByLabel("Session timeout", { exact: true }),
  ).toHaveValue("30 minutes");
  await policy.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("link", { name: "People", exact: true }).click();
  await leave
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(page).toHaveURL(/view=people$/);
  await page.getByRole("link", { name: "Security", exact: true }).click();
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await expect(
    policy.getByLabel("Session timeout", { exact: true }),
  ).toHaveValue("60 minutes");
  expect(state.writes).toEqual([]);
});

test("an older background policy read cannot overwrite the accepted Save", async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockManageSecurity(page);
  await page.goto("/manage?view=security");
  await expect(
    page.getByRole("table", { name: "Sessions", exact: true }),
  ).toBeVisible();
  let finish = () => {};
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let armed = false;
  const held = deferredMfaResponse();
  await page.route("**/api/workspace/security", async (route) => {
    if (armed && route.request().method() === "GET") {
      armed = false;
      const snapshot = {
        ...state.policy,
        ip_allow_list: [...state.policy.ip_allow_list],
      };
      const request = route.request();
      page.on("requestfinished", (value) => {
        if (value === request) finish();
      });
      page.on("requestfailed", (value) => {
        if (value === request) finish();
      });
      held.start();
      await held.waiting;
      await route.fulfill({ json: snapshot });
      return;
    }
    await route.fallback();
  });
  const manage = page.getByRole("button", { name: "Manage", exact: true });
  if ((await manage.getAttribute("aria-expanded")) !== "true")
    await manage.click();
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await expect(
    page.getByLabel("Organization name", { exact: true }),
  ).toBeVisible();
  await page.clock.fastForward(31_000);
  armed = true;
  const access = page.getByRole("button", { name: "Access", exact: true });
  if ((await access.getAttribute("aria-expanded")) !== "true")
    await access.click();
  await page
    .getByRole("link", { name: /^Security(?: & recovery)?$/, exact: true })
    .click();
  await held.begun;
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const policy = page.getByRole("dialog", {
    name: "Account policy",
    exact: true,
  });
  const timeout = policy.getByLabel("Session timeout", { exact: true });
  await timeout.selectOption("30 minutes");
  await policy
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    policy.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeDisabled();
  expect(state.policy.session_timeout_minutes).toBe(30);
  held.release();
  await completed;
  await page.clock.runFor(1);
  await expect(timeout).toHaveValue("30 minutes");
  await expect(
    policy.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeDisabled();
});

// A refusal applies to previously admitted privileged facts, not just a spinner.
test("a refused policy reread conceals cached sessions until their own fresh Retry", async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockManageSecurity(page);
  await page.goto("/access?view=security");
  const table = page.getByRole("table", { name: "Sessions", exact: true });
  await expect(table).toBeVisible();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.clock.fastForward(31_000);
  state.policyReadStatus = 403;
  await page.getByRole("link", { name: "Security", exact: true }).click();
  await expect(
    page.getByText("Account policy unavailable", { exact: true }),
  ).toBeVisible();
  await expect(table).toHaveCount(0);
  await expect(
    page.getByText("Only administrators can review sessions.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Retry sessions", exact: true })
    .click();
  await expect(table).toBeVisible();
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Account policy", exact: true })
      .getByLabel("Session timeout", { exact: true }),
  ).toHaveCount(0);
});

test("a failed background session reread retains rows while disabling session-ending actions", async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockManageSecurity(page);
  await page.goto("/access?view=security");
  const table = page.getByRole("table", { name: "Sessions", exact: true });
  await expect(table).toBeVisible();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.clock.fastForward(31_000);
  let releaseRead = () => {};
  let signalRead = () => {};
  const released = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const started = new Promise<void>((resolve) => {
    signalRead = resolve;
  });
  let holdNextRead = true;
  await page.route("**/api/auth/admin-sessions**", async (route) => {
    if (holdNextRead && route.request().method() === "GET") {
      holdNextRead = false;
      signalRead();
      await released;
    }
    await route.fallback();
  });
  state.sessionReadStatus = 503;
  try {
    await page.getByRole("link", { name: "Security", exact: true }).click();
    await started;
    await page
      .getByRole("button", { name: "End session for Eli", exact: true })
      .click();
    const confirmation = page.getByRole("alertdialog", {
      name: "End session",
      exact: true,
    });
    await expect(confirmation).toContainText("Eli");
    releaseRead();
    await expect(
      page.getByText("Sessions could not be loaded.", { exact: true }),
    ).toBeVisible();
    await expect(
      confirmation.getByRole("button", {
        name: "Confirm end session",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      confirmation.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeEnabled();
    await confirmation
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
  } finally {
    releaseRead();
  }
  await expect(table).toBeVisible();
  await expect(
    page.getByRole("button", { name: "End session for Eli", exact: true }),
  ).toBeDisabled();
  expect(state.writes).toEqual([]);
  state.sessionReadStatus = 200;
  await page
    .getByRole("button", { name: "Retry sessions", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "End session for Eli", exact: true }),
  ).toBeEnabled();
});

// Preservation proof for the relocated owner's existing account/command guards.
test("a same-account curtain preserves the Access policy draft until fresh role admission", async ({
  page,
}) => {
  const security = await mockManageSecurity(page);
  const identity = await mockMfa(page);
  await page.goto("/access?view=security");
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const policy = page.getByRole("dialog", {
    name: "Account policy",
    exact: true,
  });
  const timeout = policy.getByLabel("Session timeout", { exact: true });
  await timeout.selectOption("30 minutes");
  const recheck = deferredMfaResponse();
  identity.holdSession = recheck;
  try {
    await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
    await recheck.begun;
    const curtain = page.getByRole("dialog", {
      name: "Session verification",
      exact: true,
    });
    await expect(curtain).toBeVisible();
    await expect(policy).toBeHidden();
    expect(security.writes).toEqual([]);
    recheck.release();
    await expect(curtain).toBeHidden();
    await expect(timeout).toHaveValue("30 minutes");
    await expect(
      policy.getByRole("button", { name: "Save settings", exact: true }),
    ).toBeEnabled();
    expect(security.writes).toEqual([]);
  } finally {
    recheck.release();
  }
});

test("a late prior-account policy response cannot replace the new owner's draft or pending command", async ({
  page,
}) => {
  const security = await mockManageSecurity(page);
  const identity = await mockMfa(page);
  await page.route("**/api/users/me/preferences", (route) =>
    route.fulfill({
      json: {
        user_id: identity.userId,
        theme: "system",
        appearance: { motion: "system", keyboard_shortcuts: true },
      },
    }),
  );
  const oldWrite = deferredMfaResponse();
  const newWrite = deferredMfaResponse();
  let writeCount = 0;
  await page.route("**/api/workspace/security", async (route) => {
    if (route.request().method() === "GET") {
      await route.fallback();
      return;
    }
    const patch = route.request().postDataJSON() as {
      session_timeout_minutes: number;
      revision: number;
    };
    writeCount += 1;
    const hold = writeCount === 1 ? oldWrite : newWrite;
    const response = {
      ...security.policy,
      session_timeout_minutes: patch.session_timeout_minutes,
      revision: patch.revision + 1,
    };
    Object.assign(security.policy, response);
    security.workspace.revision = response.revision;
    hold.start();
    await hold.waiting;
    await route.fulfill({ json: response });
  });
  await page.goto("/access?view=security");
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const policy = page.getByRole("dialog", {
    name: "Account policy",
    exact: true,
  });
  const timeout = policy.getByLabel("Session timeout", { exact: true });
  await timeout.selectOption("30 minutes");
  await policy
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  try {
    await oldWrite.begun;
    await expect(
      policy.getByRole("button", { name: "Close", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(policy).toBeVisible();
    // A later authoritative organization revision belongs to the fresh read.
    security.policy.session_timeout_minutes = 480;
    security.policy.revision = 3;
    identity.userId = mfaUserB;
    await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
    await expect(policy).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Edit policy", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "Edit policy", exact: true })
      .click();
    await expect(timeout).toHaveValue("8 hours");
    await timeout.selectOption("15 minutes");
    await policy
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await newWrite.begun;
    oldWrite.release();
    await expect(timeout).toHaveValue("15 minutes");
    await expect(
      policy.getByRole("button", { name: "Save settings", exact: true }),
    ).toBeDisabled();
    await expect(
      policy.getByRole("button", { name: "Close", exact: true }),
    ).toBeDisabled();
    newWrite.release();
    await expect(
      policy.getByRole("button", { name: "Close", exact: true }),
    ).toBeEnabled();
    await expect(timeout).toHaveValue("15 minutes");
    expect(writeCount).toBe(2);
  } finally {
    oldWrite.release();
    newWrite.release();
  }
});

test("dismissing self MFA releases ownership of a later gate enrollment on Back", async ({
  page,
}, testInfo) => {
  const state = await mockMfa(page);
  const observation = {
    phase: "setup",
    selfCancelled: false,
    gateEnrollmentReached: false,
    backReached: false,
    gateFactorCountBeforeBack: 0,
    gateFactorCountAfterBack: 0,
    deleteCallsBeforeBack: 0,
    deleteCallsAfterBack: 0,
    sameFactorSurvives: false,
    qrVisibleAfterBack: false,
    finalPath: "",
  };
  let gateFactorId = "";
  try {
    await page.goto("/access?view=overview");
    await expect(
      page.getByRole("heading", { name: "Access overview", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Security", exact: true }).click();
    await expect(page).toHaveURL(/\/access\?view=security$/);
    await page
      .getByRole("button", { name: "Edit policy", exact: true })
      .click();
    await page.getByRole("button", { name: "Manage MFA", exact: true }).click();
    const self = page.getByRole("dialog", {
      name: "MFA enrollment",
      exact: true,
    });
    await expect(
      self.getByRole("button", { name: "Set up authenticator", exact: true }),
    ).toBeVisible();
    await self.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(self).toBeHidden();
    expect(state.actors.get(mfaUserA)?.factors).toHaveLength(0);
    observation.selfCancelled = true;
    observation.phase = "self-closed";

    state.actors.get(mfaUserA)!.policyRequired = true;
    await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
    await expect(
      page.getByRole("heading", {
        name: "Complete multi-factor authentication",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Set up authenticator", exact: true })
      .click();
    const qr = page.getByRole("img", {
      name: "Authenticator QR code",
      exact: true,
    });
    await expect(qr).toBeVisible();
    expect(state.actors.get(mfaUserA)?.factors).toHaveLength(1);
    gateFactorId = state.actors.get(mfaUserA)!.factors[0]!.id;
    observation.gateEnrollmentReached = true;
    observation.gateFactorCountBeforeBack = 1;
    observation.deleteCallsBeforeBack = state.calls.filter(
      (call) => call.method === "DELETE",
    ).length;
    observation.phase = "gate-enrolled";

    await page.goBack();
    await expect(page).toHaveURL(/\/access\?view=overview$/);
    observation.backReached = true;
    observation.phase = "back-reached";
    await expect(
      page.getByRole("heading", {
        name: "Complete multi-factor authentication",
        exact: true,
      }),
    ).toBeVisible();
    await expect(qr).toBeVisible();
    expect(state.actors.get(mfaUserA)?.factors).toHaveLength(1);
    expect(state.actors.get(mfaUserA)?.factors[0]?.id).toBe(gateFactorId);
    expect(state.calls.filter((call) => call.method === "DELETE")).toHaveLength(
      observation.deleteCallsBeforeBack,
    );
    observation.phase = "survived";
  } finally {
    observation.gateFactorCountAfterBack =
      state.actors.get(mfaUserA)?.factors.length ?? 0;
    observation.sameFactorSurvives =
      state.actors
        .get(mfaUserA)
        ?.factors.some((factor) => factor.id === gateFactorId) ?? false;
    observation.deleteCallsAfterBack = state.calls.filter(
      (call) => call.method === "DELETE",
    ).length;
    observation.qrVisibleAfterBack = await page
      .getByRole("img", { name: "Authenticator QR code", exact: true })
      .isVisible();
    observation.finalPath =
      new URL(page.url()).pathname + new URL(page.url()).search;
    await testInfo.attach("MFA ownership observations", {
      body: JSON.stringify(observation, null, 2),
      contentType: "application/json",
    });
  }
});

test("custom password rules and address chips save explicitly and reload independent values", async ({
  page,
}) => {
  const state = await mockManageSecurity(page);
  Object.assign(state.policy, {
    password_min_length: 13,
    password_require_mixed_case: false,
    password_require_number: true,
  });
  await page.goto("/access?view=security");
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const policy = page.getByRole("dialog", {
    name: "Account policy",
    exact: true,
  });
  const minimum = policy.getByLabel("Minimum password length", { exact: true });
  const mixed = policy.getByRole("checkbox", {
    name: "Require uppercase and lowercase letters",
    exact: true,
  });
  const number = policy.getByRole("checkbox", {
    name: "Require a number",
    exact: true,
  });
  const save = policy.getByRole("button", {
    name: "Save settings",
    exact: true,
  });
  await expect(minimum).toHaveValue("13");
  await expect(mixed).not.toBeChecked();
  await expect(number).toBeChecked();
  await expect(policy).toContainText("when a password is next set or changed");
  expect(state.callerReads).toBe(0);
  await minimum.fill("17");
  await minimum.fill("13");
  await expect(save).toBeDisabled();
  const entry = policy.getByLabel("IP address or CIDR", { exact: true });
  await entry.fill("::1");
  await entry.press("Enter");
  await policy.getByRole("button", { name: "Remove ::1", exact: true }).click();
  await expect(save).toBeDisabled();
  await minimum.fill("17");
  await mixed.check();
  await number.uncheck();
  await entry.fill("192.0.2.0/24");
  await policy
    .getByRole("button", { name: "Add address", exact: true })
    .click();
  const useAddress = policy.getByRole("button", {
    name: "Use my address",
    exact: true,
  });
  await useAddress.click();
  await expect(
    policy.getByRole("button", { name: "Remove 127.0.0.1", exact: true }),
  ).toBeVisible();
  await useAddress.click();
  await expect(
    policy.getByRole("button", { name: "Remove 127.0.0.1", exact: true }),
  ).toHaveCount(1);
  expect(state.callerReads).toBe(2);
  expect(state.writes).toEqual([]);
  await save.click();
  await expect(save).toBeDisabled();
  expect(state.policy).toMatchObject({
    password_min_length: 17,
    password_require_mixed_case: true,
    password_require_number: false,
    ip_allow_list: ["192.0.2.0/24", "127.0.0.1/32"],
  });
  await page.reload();
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await expect(minimum).toHaveValue("17");
  await expect(mixed).toBeChecked();
  await expect(number).not.toBeChecked();
  await expect(
    policy.getByRole("button", { name: "Remove 127.0.0.1/32", exact: true }),
  ).toBeVisible();
  await useAddress.click();
  await expect(
    policy.getByRole("button", { name: "Remove 127.0.0.1", exact: true }),
  ).toHaveCount(0);
  await expect(save).toBeDisabled();
  state.callerAddress = "::ffff:7f00:1";
  await useAddress.click();
  await expect(
    policy.getByRole("button", { name: "Remove ::ffff:7f00:1", exact: true }),
  ).toHaveCount(0);
  await expect(save).toBeDisabled();
});

test("invalid local policy and unavailable caller address retain the draft without writes or page errors", async ({
  page,
}) => {
  const state = await mockManageSecurity(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/access?view=security");
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const policy = page.getByRole("dialog", {
    name: "Account policy",
    exact: true,
  });
  const minimum = policy.getByLabel("Minimum password length", { exact: true });
  const save = policy.getByRole("button", {
    name: "Save settings",
    exact: true,
  });
  await minimum.fill("11");
  await save.click();
  await expect(minimum).toHaveAttribute("aria-invalid", "true");
  await expect(policy).toContainText("whole number from 12 to 128");
  await expect(minimum).toHaveValue("11");
  const entry = policy.getByLabel("IP address or CIDR", { exact: true });
  await entry.fill("invalid-range");
  await policy
    .getByRole("button", { name: "Add address", exact: true })
    .click();
  await expect(entry).toHaveAttribute("aria-invalid", "true");
  await expect(policy).toContainText("valid IP address or CIDR range");
  state.callerReadStatus = 503;
  await policy
    .getByRole("button", { name: "Use my address", exact: true })
    .click();
  await expect(policy).toContainText(
    "Your current address could not be loaded",
  );
  await expect(minimum).toHaveValue("11");
  await expect(entry).toHaveValue("invalid-range");
  expect(state.writes).toEqual([]);
  expect(pageErrors).toEqual([]);
  await policy
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(minimum).toHaveValue("12");
  await expect(entry).toHaveValue("");
  await expect(save).toBeDisabled();
});

for (const transition of ["same-account curtain", "new account"] as const) {
  test(`a late caller address cannot edit the draft after ${transition}`, async ({
    page,
  }) => {
    const security = await mockManageSecurity(page);
    const identity = await mockMfa(page);
    await page.route("**/api/users/me/preferences", (route) =>
      route.fulfill({
        json: {
          user_id: identity.userId,
          theme: "system",
          appearance: { motion: "system", keyboard_shortcuts: true },
        },
      }),
    );
    const held = deferredMfaResponse();
    let returned = () => {};
    const responseReturned = new Promise<void>((resolve) => {
      returned = resolve;
    });
    await page.route("**/api/workspace/security/caller-ip", async (route) => {
      held.start();
      await held.waiting;
      try {
        await route.fulfill({ json: { address: "192.0.2.90" } });
      } finally {
        returned();
      }
    });
    await page.goto("/access?view=security");
    await page
      .getByRole("button", { name: "Edit policy", exact: true })
      .click();
    const policy = page.getByRole("dialog", {
      name: "Account policy",
      exact: true,
    });
    const minimum = policy.getByLabel("Minimum password length", {
      exact: true,
    });
    await minimum.fill("17");
    await policy
      .getByRole("button", { name: "Use my address", exact: true })
      .click();
    await held.begun;
    const recheck = deferredMfaResponse();
    identity.holdSession = recheck;
    if (transition === "new account") identity.userId = mfaUserB;
    try {
      await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
      await recheck.begun;
      await expect(policy).toBeHidden();
      recheck.release();
      await expect(
        page.getByRole("dialog", { name: "Session verification", exact: true }),
      ).toBeHidden();
      if (transition === "new account") {
        await page
          .getByRole("button", { name: "Edit policy", exact: true })
          .click();
        await expect(minimum).toHaveValue("12");
        await minimum.fill("23");
      } else await expect(minimum).toHaveValue("17");
      held.release();
      await responseReturned;
      await expect(
        policy.getByRole("button", { name: "Use my address", exact: true }),
      ).toBeEnabled();
      await expect(
        policy.getByRole("button", { name: "Remove 192.0.2.90", exact: true }),
      ).toHaveCount(0);
      await expect(minimum).toHaveValue(
        transition === "new account" ? "23" : "17",
      );
      expect(security.writes).toEqual([]);
    } finally {
      recheck.release();
      held.release();
    }
  });
}
