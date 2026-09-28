import { expect, test, type Page } from "./helpers/test";

import { DAY, ids, mockAccessApi } from "./helpers/access-api";

// The People tab against the mocked Access API (see helpers/access-api.ts).

const mockPeopleApi = (page: Page) => mockAccessApi(page);

function panel(page: Page, name: string) {
  return page.getByRole("dialog", { name });
}

async function openPerson(page: Page, name: string) {
  await page
    .getByRole("table", { name: "People" })
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await expect(panel(page, name)).toBeVisible();
}

test("the directory shows role, status, groups and derived departments, and searches", async ({
  page,
}) => {
  await mockPeopleApi(page);
  await page.goto("/access?view=people");

  const table = page.getByRole("table", { name: "People" });
  const ben = table.getByRole("row", { name: /Ben Cruz/ });
  await expect(ben).toContainText("Member");
  await expect(ben).toContainText("Active");
  await expect(ben).toContainText("Finance readers, Inventory clerks");
  await expect(ben).toContainText("Finance, Inventory");

  const ana = table.getByRole("row", { name: /Ana Santos/ });
  await expect(ana).toContainText("Guest");
  await expect(ana).toContainText(/Ends /);
  await expect(table.getByRole("row", { name: /cy/ })).toContainText("Pending");
  await expect(table.getByRole("row", { name: /Rosa Reyes/ })).toContainText(
    "All departments",
  );

  await page.getByRole("searchbox", { name: "Search people" }).fill("clerk");
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("row", { name: /Ben Cruz/ })).toBeVisible();
});

test("a person link opens their panel, and the old identities link still works", async ({
  page,
}) => {
  await mockPeopleApi(page);
  await page.goto(`/access?view=people&user=${ids.ben}`);
  await expect(panel(page, "Ben Cruz")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(panel(page, "Ben Cruz")).toBeHidden();
  await expect(page).toHaveURL(/\/access\?view=people$/);

  await page.goto(`/access?view=identities&user=${ids.ana}`);
  // The open panel hides the page from the accessibility tree.
  await expect(page.locator('[data-slot="page-title"]')).toHaveText("People");
  await expect(panel(page, "Ana Santos")).toBeVisible();
});

test("the whole row opens a person, and the name reads as body text, not a link", async ({
  page,
}) => {
  await mockPeopleApi(page);
  await page.goto("/access?view=people");
  const row = page
    .getByRole("table", { name: "People" })
    .getByRole("row", { name: /Ben Cruz/ });
  const name = row.getByText("Ben Cruz", { exact: true });
  await name.hover();
  const ink = await name.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, underline: style.textDecorationLine };
  });
  const email = await row
    .getByText("ben@example.com")
    .evaluate((element) => getComputedStyle(element).color);
  expect(ink).toEqual({ color: email, underline: "none" });

  // The open button's hit area covers the row, so click by position.
  await row.getByText("ben@example.com").click({ force: true });
  await expect(panel(page, "Ben Cruz")).toBeVisible();
});

test("a group chip opens that group's members", async ({ page }) => {
  await mockPeopleApi(page);
  await page.goto(`/access?view=people&user=${ids.ben}`);
  await panel(page, "Ben Cruz")
    .getByRole("list", { name: "Groups" })
    .getByRole("link", { name: "Finance readers" })
    .click();

  await expect(page).toHaveURL(
    new RegExp(`/access\\?view=groups&group=${ids.readers}&tab=members$`),
  );
  const sheet = page.getByRole("dialog", { name: "Finance readers" });
  await expect(sheet.getByRole("tab", { name: "Members" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(page).toHaveURL(/\/access\?view=groups$/);
});

test("inviting a member sends the chosen groups", async ({ page }) => {
  const api = await mockPeopleApi(page);
  await page.goto("/access?view=people");

  await page.getByRole("button", { name: "Invite person" }).click();
  const dialog = page.getByRole("dialog", { name: "Invite a person" });
  await dialog.getByLabel("Email").fill("eve.stone@example.com");
  await expect(dialog.getByLabel("Username")).toHaveValue("eve_stone");
  await dialog.getByLabel("Name", { exact: true }).fill("Eve Stone");
  await dialog.getByRole("checkbox", { name: "Finance readers" }).click();
  await dialog.getByRole("button", { name: "Send invitation" }).click();

  await expect(dialog).toBeHidden();
  expect(api.sent("POST", "/api/auth/invitations")[0]?.body).toEqual({
    email: "eve.stone@example.com",
    username: "eve_stone",
    role: "member",
    display_name: "Eve Stone",
    group_ids: [ids.readers],
  });
  await expect(
    page.getByRole("table", { name: "People" }).getByRole("row", {
      name: /eve_stone/,
    }),
  ).toContainText("Pending");
});

test("a guest invitation needs a sponsor and starts from the workspace guest length", async ({
  page,
}) => {
  const api = await mockPeopleApi(page);
  await page.goto("/access?view=people");

  await page.getByRole("button", { name: "Invite person" }).click();
  const dialog = page.getByRole("dialog", { name: "Invite a person" });
  await dialog.getByLabel("Email").fill("gus@example.com");
  await dialog.getByLabel("Role").selectOption("guest");
  const days = dialog.getByLabel("Access length in days");
  await expect(days).toHaveValue("45");

  await dialog.getByRole("button", { name: "Send invitation" }).click();
  await expect(dialog.getByText("Choose a sponsor.")).toBeVisible();
  expect(api.sent("POST", "/api/auth/invitations")).toHaveLength(0);

  await days.fill("400");
  await dialog.getByLabel("Sponsor").selectOption({ label: "Ben Cruz" });
  await dialog.getByRole("button", { name: "Send invitation" }).click();
  await expect(
    dialog.getByText("Enter a whole number from 1 to 365."),
  ).toBeVisible();

  await days.fill("45");
  const before = Date.now();
  await dialog.getByRole("button", { name: "Send invitation" }).click();
  await expect(dialog).toBeHidden();
  const body = api.sent("POST", "/api/auth/invitations")[0]?.body as {
    role: string;
    sponsor_user_id: string;
    expires_at: string;
    group_ids?: string[];
  };
  expect(body).toMatchObject({ role: "guest", sponsor_user_id: ids.ben });
  const expires = Date.parse(body.expires_at) - before;
  expect(expires).toBeGreaterThan(45 * DAY - 60_000);
  expect(expires).toBeLessThan(45 * DAY + 60_000);
});

test("a role change that meets a newer save asks which value to keep", async ({
  page,
}) => {
  const api = await mockPeopleApi(page);
  await page.goto(`/access?view=people&user=${ids.ben}`);
  const sheet = panel(page, "Ben Cruz");

  await sheet.getByLabel("Role").selectOption("admin");
  await sheet.getByLabel("Job title").fill("Lead");
  // Someone else renamed the job title after this panel opened.
  const ben = api.users.get(ids.ben);
  if (ben) api.users.set(ids.ben, { ...ben, job_title: "Manager" });
  await sheet.getByRole("button", { name: "Save changes" }).click();

  const conflict = page.getByRole("dialog", { name: "This person changed" });
  await expect(conflict).toContainText("Manager");
  await expect(conflict).toContainText("Lead");
  expect(api.sent("PATCH", `/api/users/${ids.ben}`)).toHaveLength(0);
  await conflict.getByRole("button", { name: "Use draft" }).click();
  await conflict.getByRole("button", { name: "Continue" }).click();

  await expect(conflict).toBeHidden();
  expect(api.sent("PATCH", `/api/users/${ids.ben}`)[0]?.body).toEqual({
    job_title: "Lead",
    role: "admin",
  });
  await expect(
    sheet.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
});

test("a save refused as stale re-reads the person before asking again", async ({
  page,
}) => {
  const api = await mockPeopleApi(page);
  let refused = false;
  api.on("PATCH", `/api/users/${ids.ben}`, async (route) => {
    if (refused) return "next";
    refused = true;
    // The server saw a newer version: someone set another job title.
    const ben = api.users.get(ids.ben);
    if (ben) api.users.set(ids.ben, { ...ben, job_title: "Manager" });
    await route.fulfill({
      status: 412,
      json: { detail: "Precondition failed" },
    });
  });
  await page.goto(`/access?view=people&user=${ids.ben}`);
  const sheet = panel(page, "Ben Cruz");
  await sheet.getByLabel("Job title").fill("Lead");
  await sheet.getByRole("button", { name: "Save changes" }).click();

  const conflict = page.getByRole("dialog", { name: "This person changed" });
  await expect(conflict).toContainText("Manager");
  await conflict.getByRole("button", { name: "Keep current" }).click();
  await conflict.getByRole("button", { name: "Continue" }).click();
  await expect(conflict).toBeHidden();
  // Keeping the saved value leaves nothing to send.
  expect(api.sent("PATCH", `/api/users/${ids.ben}`)).toHaveLength(1);
  await expect(sheet.getByLabel("Job title")).toHaveValue("Manager");
});

test("disabling sends the status and a refusal shows the server's reason", async ({
  page,
}) => {
  const api = await mockPeopleApi(page);
  api.on("PATCH", `/api/users/${ids.dee}`, (route) =>
    route.fulfill({
      status: 409,
      json: { detail: "At least one active administrator must remain" },
    }),
  );
  await page.goto(`/access?view=people&user=${ids.ben}`);
  const sheet = panel(page, "Ben Cruz");
  await sheet.getByRole("button", { name: "Disable" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Disable Ben Cruz?" });
  await confirm.getByRole("button", { name: "Disable" }).click();
  await expect(confirm).toBeHidden();
  expect(api.sent("PATCH", `/api/users/${ids.ben}`)[0]?.body).toEqual({
    status: "disabled",
  });
  await expect(sheet.getByRole("button", { name: "Enable" })).toBeVisible();
  await sheet.getByRole("button", { name: "Close" }).click();

  await openPerson(page, "Dee Lim");
  await panel(page, "Dee Lim").getByRole("button", { name: "Disable" }).click();
  const refused = page.getByRole("alertdialog", { name: "Disable Dee Lim?" });
  await refused.getByRole("button", { name: "Disable" }).click();
  await expect(refused.getByRole("alert")).toContainText(
    "At least one active administrator must remain.",
  );
});

test("the signed-in administrator cannot disable or delete themselves", async ({
  page,
}) => {
  await mockPeopleApi(page);
  await page.goto(`/access?view=people&user=${ids.rosa}`);
  const sheet = panel(page, "Rosa Reyes");
  await expect(sheet).toContainText("This is your account.");
  await expect(sheet.getByRole("button", { name: "Disable" })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await expect(sheet).toContainText("are not members of groups");
});

test("sessions can be signed out one at a time or everywhere", async ({
  page,
}) => {
  const api = await mockPeopleApi(page);
  await page.goto(`/access?view=people&user=${ids.ben}`);
  const sheet = panel(page, "Ben Cruz");
  await sheet.getByRole("tab", { name: "Sessions" }).click();
  const list = sheet.getByRole("list", { name: "Sessions" });
  await expect(list.getByRole("listitem")).toHaveCount(2);

  await list.getByRole("button", { name: /Sign out Laptop browser/ }).click();
  await page
    .getByRole("alertdialog", { name: "Sign out this session?" })
    .getByRole("button", { name: "Sign out" })
    .click();
  await expect
    .poll(
      () =>
        api.sent("DELETE", `/api/users/${ids.ben}/sessions/${ids.laptop}`)
          .length,
    )
    .toBe(1);

  await sheet.getByRole("button", { name: "Sign out everywhere" }).click();
  await page
    .getByRole("alertdialog", { name: "Sign out everywhere?" })
    .getByRole("button", { name: "Sign out" })
    .click();
  await expect
    .poll(() => api.sent("DELETE", `/api/users/${ids.ben}/sessions`).length)
    .toBe(1);
});

test("the access panel names the level and its groups, full access for administrators, and the guest limit", async ({
  page,
}) => {
  await mockPeopleApi(page);
  await page.goto(`/access?view=people&user=${ids.ben}`);
  let sheet = panel(page, "Ben Cruz");
  await sheet.getByRole("tab", { name: "Access" }).click();
  const entries = sheet.getByRole("list", { name: "Access by department" });
  await expect(entries.getByRole("listitem")).toHaveCount(1);
  await expect(entries).toContainText("Inventory");
  await expect(entries).toContainText("Prices");
  await expect(entries).toContainText("Write");
  await expect(entries).toContainText("From Inventory clerks (Write)");
  await sheet.getByRole("button", { name: "Close" }).click();

  await openPerson(page, "Ana Santos");
  sheet = panel(page, "Ana Santos");
  await sheet.getByRole("tab", { name: "Access" }).click();
  await expect(
    sheet.getByRole("list", { name: "Access by department" }),
  ).toContainText("All modules");
  await expect(sheet.getByText("Guest limit")).toBeVisible();
  await expect(sheet).toContainText("Guests can only read.");
  await sheet.getByRole("button", { name: "Close" }).click();

  await openPerson(page, "Dee Lim");
  sheet = panel(page, "Dee Lim");
  await sheet.getByRole("tab", { name: "Access" }).click();
  await expect(sheet.getByText("Full access", { exact: true })).toBeVisible();
});

test("a deleted person shows no access and offers a restore", async ({
  page,
}) => {
  const api = await mockPeopleApi(page);
  await page.goto(`/access?view=people&user=${ids.eli}`);
  const sheet = panel(page, "Eli Tan");
  await expect(sheet.getByText("Deleted", { exact: true })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Restore" })).toBeVisible();
  await sheet.getByRole("tab", { name: "Access" }).click();
  await expect(sheet).toContainText("Deleted people have no access.");
  expect(api.sent("GET", `/api/users/${ids.eli}/access`)).toHaveLength(0);
});

test("unsaved details warn before a reload, survive it, and ask before they are discarded", async ({
  page,
}) => {
  await mockPeopleApi(page);
  await page.goto(`/access?view=people&user=${ids.ben}`);
  const details = panel(page, "Ben Cruz").getByRole("tab", {
    name: "Details",
  });
  await expect(details).toHaveAccessibleName("Details");
  await panel(page, "Ben Cruz").getByLabel("Job title").fill("Team lead");
  await expect(details).toHaveAccessibleName(/^Details\s*, unsaved changes$/);

  // A reload or tab close gets the browser's warning while the draft is open.
  const warns = () =>
    page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
  expect(await warns()).toBe(true);
  await page.reload();
  const sheet = panel(page, "Ben Cruz");
  await expect(sheet.getByLabel("Job title")).toHaveValue("Team lead");

  // Closing the panel, by button or Escape, asks first.
  await sheet.getByRole("button", { name: "Close" }).click();
  const discard = page.getByRole("alertdialog", {
    name: "Discard unsaved changes?",
  });
  await discard.getByRole("button", { name: "Keep editing" }).click();
  await expect(sheet.getByLabel("Job title")).toHaveValue("Team lead");
  await page.keyboard.press("Escape");
  await discard.getByRole("button", { name: "Discard changes" }).click();
  await expect(sheet).toBeHidden();
  expect(await warns()).toBe(false);

  // The discarded draft does not come back.
  await openPerson(page, "Ben Cruz");
  await expect(panel(page, "Ben Cruz").getByLabel("Job title")).toHaveValue(
    "Clerk",
  );
});

test("a save that got no answer is held for review instead of being sent again", async ({
  page,
}) => {
  const api = await mockPeopleApi(page);
  api.on("PATCH", `/api/users/${ids.ben}`, (route) => route.abort());
  await page.goto(`/access?view=people&user=${ids.ben}`);
  let sheet = panel(page, "Ben Cruz");
  await sheet.getByLabel("Job title").fill("Team lead");
  await sheet.getByRole("button", { name: "Save changes" }).click();

  await expect(sheet.getByRole("alert")).toContainText(
    "This change to the person may have completed.",
  );
  // The request may still land, so this tab cannot clear it yet.
  await expect(
    sheet.getByRole("button", { name: "Reload Access to review" }),
  ).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Save changes" })).toHaveCount(
    0,
  );

  await page.reload();
  sheet = panel(page, "Ben Cruz");
  await expect(
    sheet.getByRole("region", { name: "Saved person draft" }),
  ).toContainText("Team lead");
  await sheet.getByRole("button", { name: "Discard after review" }).click();
  await expect(sheet.getByLabel("Job title")).toHaveValue("Clerk");
  expect(api.sent("PATCH", `/api/users/${ids.ben}`)).toHaveLength(1);
});

test("the directory offers a retry after a failed load and explains a refusal", async ({
  page,
}) => {
  const api = await mockPeopleApi(page);
  let failing = true;
  api.on("GET", "/api/users", async (route) => {
    if (!failing) return "next";
    await route.fulfill({ status: 500, json: { detail: "boom" } });
  });
  await page.goto("/access?view=people");
  const failed = page.getByRole("alert").filter({
    hasText: "People could not be loaded",
  });
  await expect(failed).toBeVisible();
  await expect(failed).not.toContainText("boom");
  failing = false;
  await failed.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.getByRole("table", { name: "People" }).getByRole("row", {
      name: /Ben Cruz/,
    }),
  ).toBeVisible();

  api.on("GET", "/api/users", (route) =>
    route.fulfill({ status: 403, json: { detail: "Forbidden" } }),
  );
  await page.reload();
  await expect(
    page.getByText("Only administrators can see people"),
  ).toBeVisible();
});

test("closing an invitation with details asks before discarding them", async ({
  page,
}) => {
  const api = await mockPeopleApi(page);
  await page.goto("/access?view=people");
  await page.getByRole("button", { name: "Invite person" }).click();
  const dialog = page.getByRole("dialog", { name: "Invite a person" });
  await dialog.getByLabel("Email").fill("zed@example.com");

  await page.keyboard.press("Escape");
  const discard = page.getByRole("alertdialog", {
    name: "Discard this invitation?",
  });
  await discard.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog.getByLabel("Email")).toHaveValue("zed@example.com");

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await discard.getByRole("button", { name: "Discard changes" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Invite person" }).click();
  await expect(dialog.getByLabel("Email")).toHaveValue("");
  expect(api.sent("POST", "/api/auth/invitations")).toHaveLength(0);
});

for (const width of [1440, 390])
  test(`the People tab fits a ${width}px screen without sideways scrolling`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width > 400 ? 900 : 844 });
    await mockPeopleApi(page);
    await page.goto(`/access?view=people`);
    await expect(page.getByText("5 people")).toBeVisible();
    const fits = () =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      );
    expect(await fits()).toBe(true);

    await page
      .getByRole("button", { name: /^Ben Cruz/ })
      .filter({ visible: true })
      .click();
    const sheet = panel(page, "Ben Cruz");
    await expect(sheet).toBeVisible();
    const box = await sheet.boundingBox();
    if (width === 390) expect(box?.width).toBeCloseTo(390, 0);
    else expect(box?.width).toBeLessThan(width / 2);
    expect(await fits()).toBe(true);
  });
