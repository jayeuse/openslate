import {
  authMeBody,
  defaultOrganization,
  exitGuarded,
  expect,
  heldResponse,
  settleReact,
  test,
  type Page,
} from "./helpers/test";
import { mockManageSecurity } from "./helpers/manage-security";
import {
  created,
  group,
  ids,
  mockAccessApi,
  openAdvanced,
  person,
} from "./helpers/access-api";

// Access never loses an unsaved form or draft without a question, and never
// reports a change that was discarded or made twice (see
// docs/specs/access-ui-ux-pass.md, Phase 1).

const draftPrefix = "openslate.access.draft.v1.";
const emptyGroup = "00000000-0000-4000-8000-0000000000a3";

function sheet(page: Page, name: string) {
  return page.getByRole("dialog", { name, exact: true });
}

function sideLink(page: Page, name: string) {
  return page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name, exact: true });
}

/**
 * Leaves the window and comes back: the shell covers the page and checks
 * the session, then Access reads the signed-in identity again.
 */
async function leaveAndReturn(page: Page) {
  const reread = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/auth/me",
  );
  await page.evaluate(() => {
    window.dispatchEvent(new FocusEvent("blur"));
    window.dispatchEvent(new FocusEvent("focus"));
  });
  await reread;
  await settleReact(page);
}

test("a window return keeps open forms, dialogs, the open tab and filters", async ({
  page,
}) => {
  await mockAccessApi(page);
  await page.goto("/access?view=people");

  const search = page.getByRole("searchbox", { name: "Search people" });
  await search.fill("ben");
  await page.getByRole("button", { name: "Invite person" }).click();
  const invite = page.getByRole("dialog", { name: "Invite a person" });
  await invite.getByLabel("Email").fill("zed@example.com");
  await leaveAndReturn(page);
  await expect(invite.getByLabel("Email")).toHaveValue("zed@example.com");
  await invite.getByLabel("Name", { exact: true }).fill("Zed");
  await expect(invite.getByLabel("Name", { exact: true })).toHaveValue("Zed");
  await invite.getByRole("button", { name: "Cancel" }).click();
  await page
    .getByRole("alertdialog", { name: "Discard this invitation?" })
    .getByRole("button", { name: "Discard changes" })
    .click();
  await expect(search).toHaveValue("ben");

  await page
    .getByRole("table", { name: "People" })
    .getByRole("button", { name: "Manage Ben Cruz", exact: true })
    .click();
  const ben = sheet(page, "Ben Cruz");
  await ben.getByRole("tab", { name: "Sessions" }).click();
  await leaveAndReturn(page);
  await expect(ben.getByRole("tab", { name: "Sessions" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await ben.getByRole("button", { name: "Close" }).click();
  await expect(search).toHaveValue("ben");

  await page.goto("/access?view=groups");
  await page.getByRole("button", { name: "Create group" }).first().click();
  const create = page.getByRole("dialog", { name: "Create a group" });
  await create.getByLabel("Name", { exact: true }).fill("Dispatch");
  await leaveAndReturn(page);
  await expect(create.getByLabel("Name", { exact: true })).toHaveValue(
    "Dispatch",
  );

  await page.goto("/access?view=people");
  await page.getByRole("button", { name: "Invitation settings" }).click();
  const expiry = page
    .getByRole("dialog", { name: "Invitation settings" })
    .getByLabel("Invitation link works for (days)");
  await expiry.fill("9");
  await leaveAndReturn(page);
  await expect(expiry).toHaveValue("9");
});

test("Back and Forward bring back an unsent invitation, a new group and invitation settings", async ({
  page,
}) => {
  await mockAccessApi(page);
  await page.goto("/access?view=overview");
  await sideLink(page, "People").click();
  await expect(page).toHaveURL(/view=people$/);
  await page.getByRole("button", { name: "Invite person" }).click();
  const invite = page.getByRole("dialog", { name: "Invite a person" });
  await invite.getByLabel("Email").fill("zed@example.com");
  await page.goBack();
  await expect(page).toHaveURL(/view=overview$/);
  await page.goForward();
  await expect(invite.getByLabel("Email")).toHaveValue("zed@example.com");
  await invite.getByRole("button", { name: "Cancel" }).click();
  await page
    .getByRole("alertdialog", { name: "Discard this invitation?" })
    .getByRole("button", { name: "Discard changes" })
    .click();
  await expect(invite).toBeHidden();

  await sideLink(page, "Groups").click();
  await expect(page).toHaveURL(/view=groups$/);
  await page.getByRole("button", { name: "Create group" }).first().click();
  const create = page.getByRole("dialog", { name: "Create a group" });
  await create.getByLabel("Name", { exact: true }).fill("Dispatch");
  await page.goBack();
  await expect(page).toHaveURL(/view=people$/);
  // The discarded invitation stays discarded.
  await expect(invite).toBeHidden();
  await page.goForward();
  await expect(create.getByLabel("Name", { exact: true })).toHaveValue(
    "Dispatch",
  );
  await create.getByRole("button", { name: "Cancel" }).click();
  await page
    .getByRole("alertdialog", { name: "Discard this group?" })
    .getByRole("button", { name: "Discard changes" })
    .click();

  await sideLink(page, "People").click();
  await expect(page).toHaveURL(/view=people$/);
  await page.getByRole("button", { name: "Invitation settings" }).click();
  const settings = page.getByRole("dialog", {
    name: "Invitation settings",
    exact: true,
  });
  const expiry = settings.getByLabel("Invitation link works for (days)");
  await expiry.fill("9");
  await page.goBack();
  await expect(page).toHaveURL(/view=groups$/);
  await page.goForward();
  await expect(expiry).toHaveValue("9");
  await expect(
    settings.getByRole("button", { name: "Save settings" }),
  ).toBeEnabled();

  // A kept invitation (or kept settings) does not open over a person the
  // link opens.
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await page.getByRole("button", { name: "Invite person" }).click();
  await invite.getByLabel("Email").fill("kept@example.com");
  await page.goto(`/access?view=people&user=${ids.ben}`);
  await expect(sheet(page, "Ben Cruz")).toBeVisible();
  // A modal hides the others from the accessibility tree, so count the
  // dialogs in the page itself: only the person's sheet is open.
  await expect(page.locator('[role="dialog"]')).toHaveCount(1);
});

test("Discard in a person sheet keeps a hidden account policy draft", async ({
  page,
}) => {
  await mockAccessApi(page);
  const security = await mockManageSecurity(page);
  await page.goto("/access?view=people");
  await sideLink(page, "Security").click();
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const policy = page.getByRole("dialog", { name: "Account policy" });
  await policy
    .getByLabel("Session timeout", { exact: true })
    .selectOption("30 minutes");
  await policy
    .getByRole("button", { name: "Close account policy", exact: true })
    .click();
  // Back has no guard; the policy draft stays with the page.
  await page.goBack();
  await expect(page).toHaveURL(/view=people$/);

  await page
    .getByRole("table", { name: "People" })
    .getByRole("button", { name: "Manage Ben Cruz", exact: true })
    .click();
  const ben = sheet(page, "Ben Cruz");
  await ben.getByLabel("Job title").fill("Team lead");
  await ben.getByRole("button", { name: "Close" }).click();
  await page
    .getByRole("alertdialog", { name: "Discard unsaved changes?" })
    .getByRole("button", { name: "Discard changes" })
    .click();
  await expect(ben).toBeHidden();
  // The policy draft is still unsaved, so leaving the browser still warns.
  expect(await exitGuarded(page)).toBe(true);

  await page.goForward();
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await expect(
    policy.getByLabel("Session timeout", { exact: true }),
  ).toHaveValue("30 minutes");
  expect(security.writes).toEqual([]);
});

test("a save in flight holds Discard, closing and leaving until it ends", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  const personSave = heldResponse();
  api.on("PATCH", `/api/users/${ids.ben}`, async () => {
    personSave.enter();
    await personSave.released;
    return "next" as const;
  });
  await page.goto(`/access?view=people&user=${ids.ben}`);
  const ben = sheet(page, "Ben Cruz");
  await ben.getByLabel("Job title").fill("Team lead");
  await ben.getByRole("button", { name: "Save changes" }).click();
  await personSave.entered;

  // Save names what it is doing and stays busy until the server answers.
  await expect(
    ben.getByRole("button", { name: "Saving…", exact: true }),
  ).toHaveAttribute("aria-busy", "true");
  await expect(
    ben.getByRole("button", { name: "Discard changes" }),
  ).toBeDisabled();
  await ben.getByRole("button", { name: "Close" }).click();
  await expect(
    ben.getByText(
      "Finish the current change before closing or switching tabs.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("alertdialog", { name: "Discard unsaved changes?" }),
  ).toHaveCount(0);

  personSave.release();
  await expect(
    ben.getByRole("button", { name: /^(Save changes|Saving…)$/ }),
  ).toHaveCount(0);
  await expect(ben.getByLabel("Job title")).toHaveValue("Team lead");
  // The finished save wrote no draft back to the journal.
  expect(
    await page.evaluate(
      (prefix) =>
        Object.keys(sessionStorage).filter((key) => key.startsWith(prefix)),
      draftPrefix,
    ),
  ).toEqual([]);

  const groupSave = heldResponse();
  api.on("PUT", `/api/access/groups/${ids.readers}/members`, async () => {
    groupSave.enter();
    await groupSave.released;
    return "next" as const;
  });
  await page.goto(`/access?view=groups&group=${ids.readers}&tab=members`);
  const readers = sheet(page, "Finance readers");
  await readers.getByRole("tab", { name: "Members" }).click();
  await readers
    .getByRole("button", { name: /^Remove Ben Cruz/ })
    .first()
    .click();
  await readers.getByRole("button", { name: "Save members" }).click();
  await groupSave.entered;
  await readers.getByRole("button", { name: "Close" }).click();
  await expect(
    readers.getByText("Finish the current change before closing."),
  ).toBeVisible();
  await expect(
    page.getByRole("alertdialog", { name: "Discard unsaved changes?" }),
  ).toHaveCount(0);
  groupSave.release();
  await expect(
    readers.getByRole("button", { name: /^(Save members|Saving…)$/ }),
  ).toHaveCount(0);
  await readers.getByRole("button", { name: "Close" }).click();
  await expect(readers).toBeHidden();

  const settingsSave = heldResponse();
  api.on("PATCH", "/api/workspace", async () => {
    settingsSave.enter();
    await settingsSave.released;
    return "next" as const;
  });
  await page.goto("/access?view=people");
  await page.getByRole("button", { name: "Invitation settings" }).click();
  const settings = page.getByRole("dialog", {
    name: "Invitation settings",
    exact: true,
  });
  await settings.getByLabel("Invitation link works for (days)").fill("9");
  await settings.getByRole("button", { name: "Save settings" }).click();
  await settingsSave.entered;
  // The settings dialog stays open while its save runs, so the answer
  // lands where the person is.
  await page.keyboard.press("Escape");
  await settleReact(page);
  await expect(settings).toBeVisible();
  await expect(
    settings.getByLabel("Invitation link works for (days)"),
  ).toHaveValue("9");
  settingsSave.release();
  await expect(
    settings.getByRole("button", { name: "Save settings" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
});

/**
 * Signs in to two organizations, then saves a person whose save gets no
 * answer, so the journal keeps a save that may have completed.
 */
async function saveThatMayHaveCompleted(page: Page) {
  const api = await mockAccessApi(page);
  api.on("GET", "/api/auth/me", (route) =>
    route.fulfill({
      json: authMeBody({
        id: ids.rosa,
        role: "admin",
        memberships: [
          { ...defaultOrganization, role: "admin" },
          {
            org_id: "00000000-0000-4000-8000-000000000199",
            name: "Other organization",
            slug: "other",
            role: "admin",
          },
        ],
      }),
    }),
  );
  api.on("PATCH", `/api/users/${ids.ben}`, (route) => route.abort());
  await page.goto(`/access?view=people&user=${ids.ben}`);
  const ben = sheet(page, "Ben Cruz");
  await ben.getByLabel("Job title").fill("Team lead");
  await ben.getByRole("button", { name: "Save changes" }).click();
  await expect(ben.getByRole("alert")).toContainText(
    "This change to the person may have completed.",
  );
  return api;
}

test("a save that may have completed is kept inside Access and asked about before sign-out or an organization switch", async ({
  page,
}) => {
  const api = await saveThatMayHaveCompleted(page);
  const ben = sheet(page, "Ben Cruz");
  // Closing the sheet keeps the save for review when the person opens again.
  await ben.getByRole("button", { name: "Close" }).click();
  await expect(ben).toBeHidden();

  const leave = page.getByRole("alertdialog", {
    name: "Discard unsaved changes?",
  });
  // Inside Access the journal keeps the save, so nothing asks.
  await sideLink(page, "Groups").click();
  await expect(page).toHaveURL(/view=groups$/);
  await expect(leave).toHaveCount(0);
  await sideLink(page, "People").click();
  await expect(page).toHaveURL(/view=people$/);
  const openBen = page
    .getByRole("table", { name: "People" })
    .getByRole("button", { name: "Manage Ben Cruz", exact: true });
  await openBen.click();
  await expect(ben.getByRole("alert")).toContainText(
    "This change to the person may have completed.",
  );
  await ben.getByRole("button", { name: "Close" }).click();
  await expect(ben).toBeHidden();

  // Signing out would clear the journal, so it asks first.
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(leave).toContainText(
    "A change in Access may not have been saved.",
  );
  await leave.getByRole("button", { name: "Keep editing" }).click();
  await expect(leave).toBeHidden();
  await settleReact(page);
  expect(api.sent("POST", "/api/auth/logout")).toHaveLength(0);

  // So does switching to another organization.
  const organization = page.getByRole("button", {
    name: "Organization: OpenSlate",
    exact: true,
  });
  await organization.click();
  await page.getByRole("menuitem", { name: /Other organization/ }).click();
  await expect(leave).toContainText(
    "A change in Access may not have been saved.",
  );
  await leave.getByRole("button", { name: "Keep editing" }).click();
  await expect(leave).toBeHidden();
  await settleReact(page);
  await expect(organization).toBeVisible();
  expect(api.sent("POST", "/api/auth/session/organization")).toHaveLength(0);
  await openBen.click();
  await expect(ben.getByRole("alert")).toContainText(
    "This change to the person may have completed.",
  );
});

test("after leaving Access, sign-out and an organization switch still ask about a save that may have completed", async ({
  page,
}) => {
  const api = await saveThatMayHaveCompleted(page);
  // Another workspace page: the Access guard is no longer mounted.
  await page.goto("/boards");
  await expect(
    page.getByRole("button", { name: "Organization: OpenSlate", exact: true }),
  ).toBeVisible();
  const leave = page.getByRole("alertdialog", {
    name: "Discard unsaved changes?",
  });

  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(leave).toContainText(
    "A change in Access may not have been saved. Leaving this page discards it.",
  );
  await leave.getByRole("button", { name: "Keep editing" }).click();
  await expect(leave).toBeHidden();
  await settleReact(page);
  expect(api.sent("POST", "/api/auth/logout")).toHaveLength(0);

  const organization = page.getByRole("button", {
    name: "Organization: OpenSlate",
    exact: true,
  });
  await organization.click();
  await page.getByRole("menuitem", { name: /Other organization/ }).click();
  await expect(leave).toContainText(
    "A change in Access may not have been saved.",
  );
  await leave.getByRole("button", { name: "Keep editing" }).click();
  await expect(leave).toBeHidden();
  await settleReact(page);
  expect(api.sent("POST", "/api/auth/session/organization")).toHaveLength(0);

  // Discard forgets the save and signs out.
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await leave.getByRole("button", { name: "Discard changes" }).click();
  await expect.poll(() => api.sent("POST", "/api/auth/logout").length).toBe(1);
});

test("a save that fails after the editor closed keeps the draft for the return", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  const save = heldResponse();
  api.on("PATCH", `/api/users/${ids.ben}`, async (route) => {
    save.enter();
    await save.released;
    await route.fulfill({ status: 500, json: { detail: "Unavailable" } });
  });
  await page.goto("/access?view=overview");
  await sideLink(page, "People").click();
  await expect(page).toHaveURL(/view=people$/);
  await page
    .getByRole("table", { name: "People" })
    .getByRole("button", { name: "Manage Ben Cruz", exact: true })
    .click();
  const ben = sheet(page, "Ben Cruz");
  await ben.getByLabel("Job title").fill("Team lead");
  await ben.getByRole("button", { name: "Save changes" }).click();
  await save.entered;

  // Back has no guard: the editor goes away while its save runs.
  await page.goBack();
  await expect(page).toHaveURL(/view=overview$/);
  const answered = page.waitForResponse(
    (response) => response.request().method() === "PATCH",
  );
  save.release();
  await answered;
  await settleReact(page);

  await page.goForward();
  await expect(ben.getByLabel("Job title")).toHaveValue("Team lead");
  await expect(ben.getByRole("tab", { name: /Details/ })).toHaveAccessibleName(
    /unsaved changes/,
  );
});

test("while the role is checked again, open forms cannot send", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  let holding = false;
  let recheck = heldResponse();
  api.on("GET", "/api/auth/me", async () => {
    if (holding) {
      recheck.enter();
      await recheck.released;
    }
    return "next" as const;
  });
  async function returnAndHold() {
    recheck = heldResponse();
    holding = true;
    await page.evaluate(() => {
      window.dispatchEvent(new FocusEvent("blur"));
      window.dispatchEvent(new FocusEvent("focus"));
    });
    await recheck.entered;
  }
  function release() {
    holding = false;
    recheck.release();
  }

  await page.goto("/access?view=people");
  await page.getByRole("button", { name: "Invite person" }).click();
  const invite = page.getByRole("dialog", { name: "Invite a person" });
  await invite.getByLabel("Email").fill("zed@example.com");
  await returnAndHold();
  const send = invite.getByRole("button", { name: "Send invitation" });
  await expect(send).toHaveAttribute("aria-disabled", "true");
  await expect(send).toHaveAccessibleDescription("Checking your access.");
  // Playwright never clicks an aria-disabled control; a keyboard user can
  // still press it.
  await send.focus();
  await page.keyboard.press("Enter");
  await settleReact(page);
  expect(api.sent("POST", "/api/auth/invitations")).toHaveLength(0);
  release();
  await expect(send).not.toHaveAttribute("aria-disabled", "true");
  await invite.getByRole("button", { name: "Cancel" }).click();
  await page
    .getByRole("alertdialog", { name: "Discard this invitation?" })
    .getByRole("button", { name: "Discard changes" })
    .click();

  await page
    .getByRole("table", { name: "People" })
    .getByRole("button", { name: "Manage Ben Cruz", exact: true })
    .click();
  const ben = sheet(page, "Ben Cruz");
  await ben.getByLabel("Job title").fill("Team lead");
  await returnAndHold();
  const saveChanges = ben.getByRole("button", { name: "Save changes" });
  await expect(saveChanges).toHaveAttribute("aria-disabled", "true");
  await saveChanges.focus();
  await page.keyboard.press("Enter");
  await settleReact(page);
  expect(api.sent("PATCH", `/api/users/${ids.ben}`)).toHaveLength(0);
  release();
  await expect(saveChanges).not.toHaveAttribute("aria-disabled", "true");

  // Lifecycle confirmations wait for the check too.
  await ben.getByRole("button", { name: "Discard changes" }).click();
  await openAdvanced(ben);
  for (const action of ["Disable", "Delete"]) {
    await ben.getByRole("button", { name: action, exact: true }).click();
    const confirm = page.getByRole("alertdialog", {
      name: `${action} Ben Cruz?`,
    });
    await returnAndHold();
    const run = confirm.getByRole("button", { name: action, exact: true });
    await expect(run).toHaveAttribute("aria-disabled", "true");
    await expect(run).toHaveAccessibleDescription("Checking your access.");
    await run.focus();
    await page.keyboard.press("Enter");
    await settleReact(page);
    release();
    await expect(run).not.toHaveAttribute("aria-disabled", "true");
    await confirm.getByRole("button", { name: "Cancel" }).click();
  }
  expect(api.calls.filter((call) => call.method !== "GET")).toEqual([]);

  api.groups.set(emptyGroup, group(emptyGroup, "New hires", [], []));
  await page.goto(`/access?view=groups&group=${emptyGroup}`);
  const hires = sheet(page, "New hires");
  await openAdvanced(hires);
  await hires.getByRole("button", { name: "Delete group" }).click();
  const confirmDelete = page.getByRole("alertdialog", {
    name: "Delete New hires?",
  });
  await returnAndHold();
  const deleteGroup = confirmDelete.getByRole("button", {
    name: "Delete",
    exact: true,
  });
  await expect(deleteGroup).toHaveAttribute("aria-disabled", "true");
  await expect(deleteGroup).toHaveAccessibleDescription(
    "Checking your access.",
  );
  await deleteGroup.focus();
  await page.keyboard.press("Enter");
  await settleReact(page);
  release();
  await expect(deleteGroup).not.toHaveAttribute("aria-disabled", "true");
  expect(api.sent("DELETE", `/api/access/groups/${emptyGroup}`)).toHaveLength(
    0,
  );
});

test("changing one's own role asks first and shows the server's refusal beside Role", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  api.on("PATCH", `/api/users/${ids.rosa}`, (route) =>
    route.fulfill({
      status: 409,
      json: { detail: "Cannot remove the last active admin" },
    }),
  );
  await page.goto(`/access?view=people&user=${ids.rosa}`);
  const rosa = sheet(page, "Rosa Reyes");
  const role = rosa.getByLabel("Role");
  await role.selectOption("member");
  await rosa.getByRole("button", { name: "Save changes" }).click();
  const confirm = page.getByRole("alertdialog", {
    name: "Change your own role?",
  });
  await expect(confirm).toContainText("You will lose access to Access.");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  expect(api.sent("PATCH", `/api/users/${ids.rosa}`)).toHaveLength(0);

  await rosa.getByRole("button", { name: "Save changes" }).click();
  await confirm.getByRole("button", { name: "Change my role" }).click();
  await expect(role).toHaveAccessibleDescription(
    /Cannot remove the last active admin\./,
  );
  await expect(role).toHaveAttribute("aria-invalid", "true");
  await expect(role).toBeFocused();
  expect(api.sent("PATCH", `/api/users/${ids.rosa}`)).toHaveLength(1);
});

test("a failed Discard keeps its dialog open and says why", async ({
  page,
}) => {
  await mockAccessApi(page);
  await page.goto(`/access?view=people&user=${ids.ben}`);
  const ben = sheet(page, "Ben Cruz");
  await ben.getByLabel("Job title").fill("Team lead");
  await page.evaluate((prefix) => {
    const setItem = Storage.prototype.setItem;
    const removeItem = Storage.prototype.removeItem;
    (window as Window & { restoreStorage?: () => void }).restoreStorage =
      () => {
        Storage.prototype.setItem = setItem;
        Storage.prototype.removeItem = removeItem;
      };
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith(prefix)) throw new Error("Storage refused");
      return setItem.call(this, key, value);
    };
    Storage.prototype.removeItem = function (key) {
      if (key.startsWith(prefix)) throw new Error("Storage refused");
      return removeItem.call(this, key);
    };
  }, draftPrefix);

  await ben.getByRole("button", { name: "Close" }).click();
  const discard = page.getByRole("alertdialog", {
    name: "Discard unsaved changes?",
  });
  await discard.getByRole("button", { name: "Discard changes" }).click();
  await expect(discard).toContainText(
    "Your draft could not be cleared from this browser. Keep editing, or try again.",
  );
  await expect(discard).not.toContainText("Could not apply the change");
  await discard.getByRole("button", { name: "Keep editing" }).click();
  await expect(ben.getByLabel("Job title")).toHaveValue("Team lead");

  await page.evaluate(() =>
    (window as Window & { restoreStorage?: () => void }).restoreStorage?.(),
  );
  await ben.getByRole("button", { name: "Close" }).click();
  await expect(discard).not.toContainText("could not be cleared");
  await discard.getByRole("button", { name: "Discard changes" }).click();
  await expect(discard).toBeHidden();
  await expect(ben).toBeHidden();
});

test("after a lost answer, Create group opens the group it made instead of a second one", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  const madeId = "00000000-0000-4000-8000-0000000000a9";
  api.on("POST", "/api/access/groups", async (route) => {
    // The server makes the group, and the answer never arrives.
    // Its clock is behind the browser's: created_at is before the request.
    api.groups.set(madeId, {
      ...group(madeId, "Dispatch", [], []),
      created_at: created,
    });
    await route.abort();
  });
  await page.goto("/access?view=groups");
  await page.getByRole("button", { name: "Create group" }).first().click();
  const create = page.getByRole("dialog", { name: "Create a group" });
  await create.getByLabel("Name", { exact: true }).fill("Dispatch");
  await create.getByRole("button", { name: "Create group" }).click();

  await expect(create).toBeHidden();
  await expect(sheet(page, "Dispatch")).toBeVisible();
  await expect(
    page.getByText(
      "Group found. It was created before the connection dropped.",
    ),
  ).toBeVisible();
  expect(api.sent("POST", "/api/access/groups")).toHaveLength(1);
});

test("after a lost answer, Invite opens the pending invitation instead of a conflict", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  const madeId = "00000000-0000-4000-8000-0000000001a9";
  api.on("POST", "/api/auth/invitations", async (route) => {
    // The server makes the invitation, and the answer never arrives.
    api.users.set(
      madeId,
      person({
        id: madeId,
        username: "eve_stone",
        email: "eve.stone@example.com",
        status: "pending",
      }),
    );
    await route.abort();
  });
  await page.goto("/access?view=people");
  await page.getByRole("button", { name: "Invite person" }).click();
  const invite = page.getByRole("dialog", { name: "Invite a person" });
  await invite.getByLabel("Email").fill("eve.stone@example.com");
  await invite.getByRole("button", { name: "Send invitation" }).click();

  await expect(invite).toBeHidden();
  await expect(sheet(page, "eve_stone")).toBeVisible();
  await expect(
    page.getByText(
      "Invitation found. It was sent before the connection dropped.",
    ),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`user=${madeId}`));
  expect(api.sent("POST", "/api/auth/invitations")).toHaveLength(1);
});
