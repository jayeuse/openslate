import {
  expect,
  expectNoHorizontalScroll,
  heldResponse,
  test,
  type Page,
} from "./helpers/test";

import {
  addPeople,
  DAY,
  created,
  ids,
  listPage,
  mockAccessApi,
  openAdvanced,
  person,
} from "./helpers/access-api";

// The People tab against the mocked Access API (see helpers/access-api.ts).

function panel(page: Page, name: string) {
  return page.getByRole("dialog", { name });
}

async function openPerson(page: Page, name: string) {
  await page
    .getByRole("table", { name: "People" })
    .getByRole("button", { name: `Manage ${name}`, exact: true })
    .click();
  await expect(panel(page, name)).toBeVisible();
}

async function recordedTime(page: Page, value: string) {
  return page.evaluate(
    (instant) =>
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(instant)),
    value,
  );
}

/**
 * A recorded fact in the open person sheet's Details tab. The 40px row keeps
 * relative last activity and two-step On or Off; the sheet keeps the
 * recorded times, the session count and the recorded two-step status.
 */
async function expectRecordedFact(
  page: Page,
  name: string,
  label: string,
  expected: string | RegExp,
) {
  const sheet = panel(page, name);
  await sheet.getByRole("tab", { name: "Details", exact: true }).click();
  await expect(
    sheet
      .getByRole("region", { name: "Recorded activity", exact: true })
      .getByText(label, { exact: true })
      .locator("+ dd"),
  ).toHaveText(expected);
}

test("the directory shows role, status, groups and derived departments, and searches", async ({
  page,
}) => {
  // The Departments column shows from 1440px.
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockAccessApi(page);
  await page.goto("/access?view=people");

  const table = page.getByRole("table", { name: "People" });
  const ben = table.getByRole("row", { name: /Ben Cruz/ });
  await expect(ben).toContainText("Member");
  await expect(ben).toContainText("Active");
  await expect(ben).toContainText("Finance readers+1 more group");
  await expect(ben).toContainText("Inventory, Finance");

  const ana = table.getByRole("row", { name: /Ana Santos/ });
  await expect(ana).toContainText("Guest");
  await expect(ana).toContainText(/Ends /);
  await expect(table.getByRole("row", { name: /cy/ })).toContainText("Invited");
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
  await mockAccessApi(page);
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
  await mockAccessApi(page);
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
  const body = await row
    .getByText("Member", { exact: true })
    .evaluate((element) => getComputedStyle(element).color);
  expect(ink).toEqual({ color: body, underline: "none" });

  // The open button's hit area covers the row, so click the row where the
  // email sits; the button receives the click.
  await expect(row).toBeVisible();
  const rowBox = (await row.boundingBox())!;
  const emailBox = (await row.getByText("ben@example.com").boundingBox())!;
  await row.click({
    position: {
      x: emailBox.x - rowBox.x + emailBox.width / 2,
      y: emailBox.y - rowBox.y + emailBox.height / 2,
    },
  });
  await expect(panel(page, "Ben Cruz")).toBeVisible();
});

test("a group chip opens that group's members", async ({ page }) => {
  await mockAccessApi(page);
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
  const api = await mockAccessApi(page);
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
  ).toContainText("Invited");
});

test("the invitation shows the username rule only with a username error", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  await page.goto("/access?view=people");
  await page.getByRole("button", { name: "Invite person" }).click();
  const dialog = page.getByRole("dialog", { name: "Invite a person" });
  const username = dialog.getByLabel("Username");
  await expect(dialog.getByText("Access comes from groups.")).toBeVisible();
  await expect(dialog).not.toContainText("3 to 100 letters");
  await expect(username).toHaveAccessibleDescription("");

  await dialog.getByLabel("Email").fill("eve.stone@example.com");
  await username.fill("e!");
  await dialog.getByRole("button", { name: "Send invitation" }).click();
  await expect(username).toHaveAccessibleDescription(
    "Use 3 to 100 letters, numbers, hyphens, or underscores.",
  );
  await username.fill("");
  await dialog.getByRole("button", { name: "Send invitation" }).click();
  await expect(username).toHaveAccessibleDescription(
    "Enter a username of 3 to 100 letters, numbers, hyphens, or underscores.",
  );
  expect(api.sent("POST", "/api/auth/invitations")).toHaveLength(0);
});

test("an existing account invitation reports in-app delivery without promising email", async ({
  page,
}) => {
  await mockAccessApi(page);
  await page.route("**/api/auth/invitations", async (route) => {
    await route.fulfill({
      status: 201,
      json: {
        user: person({
          id: ids.ben,
          username: "ben",
          email: "ben@example.com",
          status: "pending",
        }),
        delivery: "in_app",
      },
    });
  });
  await page.goto("/access?view=people");
  await page.getByRole("button", { name: "Invite person" }).click();
  const dialog = page.getByRole("dialog", { name: "Invite a person" });
  await dialog.getByLabel("Email").fill("ben@example.com");
  await dialog.getByRole("button", { name: "Send invitation" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText(
      "ben@example.com can accept this invitation when signed in.",
    ),
  ).toBeVisible();
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((mode) => {
        document.documentElement.classList.toggle("dark", mode === "dark");
      }, theme);
      await expectNoHorizontalScroll(page);
      await expect(
        page.getByText(
          "ben@example.com can accept this invitation when signed in.",
        ),
      ).toBeVisible();
      await page.screenshot({
        animations: "disabled",
        path: test
          .info()
          .outputPath(`in-app-invitation-${viewport.width}-${theme}.png`),
      });
    }
  }
});

test("a guest invitation needs a sponsor and starts from the workspace guest length", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
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
  await dialog.getByRole("combobox", { name: "Sponsor", exact: true }).click();
  await page.getByRole("option", { name: "Ben Cruz", exact: true }).click();
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
  const api = await mockAccessApi(page);
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
  // Nothing is left to save, so Save goes.
  await expect(
    sheet.getByRole("button", { name: /^(Save changes|Saving…)$/ }),
  ).toHaveCount(0);
});

test("a save refused as stale re-reads the person before asking again", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
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
  const api = await mockAccessApi(page);
  api.on("PATCH", `/api/users/${ids.dee}`, (route) =>
    route.fulfill({
      status: 409,
      json: { detail: "At least one active administrator must remain" },
    }),
  );
  const disabling = heldResponse();
  api.on("PATCH", `/api/users/${ids.ben}`, async () => {
    disabling.enter();
    await disabling.released;
    return "next" as const;
  });
  await page.goto(`/access?view=people&user=${ids.ben}`);
  const sheet = panel(page, "Ben Cruz");
  await openAdvanced(sheet);
  await sheet.getByRole("button", { name: "Disable" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Disable Ben Cruz?" });
  await confirm.getByRole("button", { name: "Disable" }).click();
  // The dialog names what is running until the server answers.
  await disabling.entered;
  await expect(
    confirm.getByRole("button", { name: "Disabling…", exact: true }),
  ).toHaveAttribute("aria-busy", "true");
  disabling.release();
  await expect(confirm).toBeHidden();
  expect(api.sent("PATCH", `/api/users/${ids.ben}`)[0]?.body).toEqual({
    status: "disabled",
  });
  // Focus lands on the action that replaced Disable.
  await expect(sheet.getByRole("button", { name: "Enable" })).toBeFocused();
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
  await mockAccessApi(page);
  await page.goto(`/access?view=people&user=${ids.rosa}`);
  const sheet = panel(page, "Rosa Reyes");
  await expect(sheet).toContainText("This is your account.");
  await expect(sheet.getByRole("button", { name: "Disable" })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await expect(sheet).toContainText("are not members of groups");
});

test("the access panel names the level and its groups, full access for administrators, and the guest limit", async ({
  page,
}) => {
  await mockAccessApi(page);
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
  const api = await mockAccessApi(page);
  await page.goto(`/access?view=people&user=${ids.eli}`);
  const sheet = panel(page, "Eli Tan");
  await expect(sheet.getByText("Deleted", { exact: true })).toBeVisible();
  await openAdvanced(sheet);
  await expect(sheet.getByRole("button", { name: "Restore" })).toBeVisible();
  await sheet.getByRole("tab", { name: "Access" }).click();
  await expect(sheet).toContainText("Deleted people have no access.");
  expect(api.sent("GET", `/api/users/${ids.eli}/access`)).toHaveLength(0);
});

test("unsaved details warn before a reload, survive it, and ask before they are discarded", async ({
  page,
}) => {
  await mockAccessApi(page);
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
  const api = await mockAccessApi(page);
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
  await expect(
    sheet.getByRole("button", { name: /^(Save changes|Saving…)$/ }),
  ).toHaveCount(0);

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
  const api = await mockAccessApi(page);
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
  const api = await mockAccessApi(page);
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
    await mockAccessApi(page);
    await page.goto(`/access?view=people`);
    await expect(
      page.getByRole("button", { name: /^All\s*5$/ }).first(),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);

    await page
      .getByRole("button", { name: "Manage Ben Cruz", exact: true })
      .filter({ visible: true })
      .click();
    const sheet = panel(page, "Ben Cruz");
    await expect(sheet).toBeVisible();
    const box = await sheet.boundingBox();
    if (width === 390) expect(box?.width).toBeCloseTo(390, 0);
    else expect(box?.width).toBeLessThan(width / 2);
    await expectNoHorizontalScroll(page);
  });

// These HTTP journeys exercise the adopted list boundary and rendered controls.
// Eligibility, provider completeness, and persisted observations are backend proofs.
test("the closed directory requests server pages and searches before paging", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  api.users.clear();
  addPeople(api, 110, 700);
  api.users.set(
    ids.ben,
    person({
      id: ids.ben,
      username: "zzben",
      display_name: "Zzz Ben",
      job_title: "Unique clerk",
    }),
  );
  await page.goto("/access?view=people");
  const table = page.getByRole("table", { name: "People", exact: true });
  await expect(table.getByRole("row")).toHaveCount(11);
  await expect(
    page.getByText("Showing 1–10 of 111", { exact: true }),
  ).toBeVisible();
  expect(
    api.listReads.every(
      (query) => query.get("limit") === "10" && query.get("offset") === "0",
    ),
  ).toBe(true);
  expect(
    api.listReads.some((query) => query.get("deleted") === "include"),
  ).toBe(false);
  await page
    .getByRole("navigation", { name: "People pages", exact: true })
    .getByRole("button", { name: "Go to next page", exact: true })
    .click();
  await expect(
    page.getByText("Showing 11–20 of 111", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => api.listReads.at(-1)?.get("offset")).toBe("10");
  await page
    .getByRole("searchbox", { name: "Search people", exact: true })
    .fill("Unique clerk");
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("row", { name: /Zzz Ben/ })).toBeVisible();
  await expect(
    page.getByText("Showing 1–1 of 1", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => Object.fromEntries(api.listReads.at(-1) ?? []))
    .toMatchObject({ search: "Unique clerk", offset: "0", limit: "10" });
  await page.getByLabel("Rows per page", { exact: true }).selectOption("5");
  await expect.poll(() => api.listReads.at(-1)?.get("limit")).toBe("5");
});

test("combined directory filters and sort aliases reach the server with the matching total", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  addPeople(api, 110, 700);
  for (const [sort, field, order] of [
    ["expiry", "expires_at", "asc"],
    ["newest", "created_at", "desc"],
    ["name", "name", "asc"],
    ["email", "email", "asc"],
  ]) {
    await page.goto(
      `/access?view=people&role=member&status=active&group=${ids.clerks}&department=${ids.finance}&sort=${sort}`,
    );
    const table = page.getByRole("table", { name: "People", exact: true });
    await expect(table.getByRole("row")).toHaveCount(2);
    await expect(table.getByRole("row", { name: /Ben Cruz/ })).toBeVisible();
    await expect
      .poll(() => Object.fromEntries(api.listReads.at(-1) ?? []))
      .toMatchObject({
        role: "member",
        status: "active",
        deleted: "exclude",
        group_id: ids.clerks,
        department_id: ids.finance,
        sort_by: field,
        sort_order: order,
        limit: "10",
        offset: "0",
      });
  }
});

// From 768px the row shows relative last activity (the later of the recorded
// sign-in and activity) and, from 1280px, two-step as On or Off. The person
// sheet keeps the recorded times, the session count and the recorded status.
for (const width of [1440, 390])
  test(`recorded history, two-step verification and active counts remain truthful at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const api = await mockAccessApi(page);
    api.monitoring.set(ids.rosa, {
      active_session_count: 1,
      mfa_verified_totp: true,
      mfa_observed_at: created,
      last_sign_in_at: "2026-09-12T09:15:00Z",
      last_active_at: "2026-10-01T07:45:00Z",
    });
    api.monitoring.set(ids.ben, {
      active_session_count: 2,
      mfa_verified_totp: false,
      mfa_observed_at: created,
      last_sign_in_at: null,
      last_active_at: "2026-10-02T08:30:00Z",
    });
    api.monitoring.set(ids.ana, {
      active_session_count: 0,
      mfa_verified_totp: null,
      mfa_observed_at: null,
      last_sign_in_at: null,
      last_active_at: null,
    });
    await page.goto("/access?view=people");
    if (width === 1440) {
      const row = (name: string) =>
        page
          .getByRole("table", { name: "People", exact: true })
          .getByRole("row")
          .filter({ hasText: name });
      await expect(
        row("Rosa Reyes").getByText("On", { exact: true }),
      ).toBeVisible();
      await expect(
        row("Ben Cruz").getByText("Off", { exact: true }),
      ).toBeVisible();
      await expect(
        row("Ana Santos").getByText("Unknown", { exact: true }),
      ).toBeVisible();
      await expect(row("Rosa Reyes").locator("time")).toHaveAttribute(
        "datetime",
        "2026-10-01T07:45:00Z",
      );
      await expect(row("Ben Cruz").locator("time")).toHaveAttribute(
        "datetime",
        "2026-10-02T08:30:00Z",
      );
      await expect(row("Ana Santos")).toContainText("Not recorded");
    }
    for (const [name, facts] of [
      [
        "Rosa Reyes",
        [
          ["Two-step verification", /^On/],
          ["Active sessions", "1"],
          ["Last sign-in", "2026-09-12T09:15:00Z"],
          ["Last activity", "2026-10-01T07:45:00Z"],
        ],
      ],
      [
        "Ben Cruz",
        [
          ["Two-step verification", /^Off/],
          ["Active sessions", "2"],
          ["Last sign-in", "No recorded sign-in"],
          ["Last activity", "2026-10-02T08:30:00Z"],
        ],
      ],
      [
        "Ana Santos",
        [
          ["Two-step verification", "Unknown"],
          ["Active sessions", "0"],
          ["Last sign-in", "No recorded sign-in"],
          ["Last activity", "No recorded activity"],
        ],
      ],
    ] as const) {
      await page
        .getByRole("button", { name: `Manage ${name}`, exact: true })
        .click();
      for (const [label, expected] of facts)
        await expectRecordedFact(
          page,
          name,
          label,
          typeof expected === "string" && expected.startsWith("2026")
            ? await recordedTime(page, expected)
            : expected,
        );
      await expect(
        panel(page, name).getByRole("region", {
          name: "Recorded activity",
          exact: true,
        }),
      ).toContainText(/Recorded|Unknown/);
      await page.keyboard.press("Escape");
      await expect(panel(page, name)).toBeHidden();
    }
    await expect(page.getByRole("main")).not.toContainText(
      /never signed in|provider live/i,
    );
    await expectNoHorizontalScroll(page);
  });

test("inactivity days validate drafts in the People history filter and reach the directory read", async ({
  page,
}) => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  const api = await mockAccessApi(page, { now });
  api.users.clear();
  api.monitoring.clear();
  // Independent expected populations: 30→2, 60→1, 1→3, 3650→0; null is separate.
  for (const [id, username, age] of [
    [ids.rosa, "recent", 10],
    [ids.ben, "middle", 45],
    [ids.dee, "older", 90],
  ] as const) {
    const recorded = new Date(now - age * DAY).toISOString();
    api.users.set(
      id,
      person({ id, username, role: id === ids.rosa ? "admin" : "member" }),
    );
    api.monitoring.set(id, {
      active_session_count: 0,
      mfa_verified_totp: true,
      mfa_observed_at: recorded,
      last_sign_in_at: recorded,
      last_active_at: recorded,
    });
  }
  api.users.set(ids.ana, person({ id: ids.ana, username: "unknown" }));
  await page.goto("/access?view=people&history=inactive&inactive_days=30");
  const rows = page
    .getByRole("table", { name: "People", exact: true })
    .locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  const days = page.getByLabel("Inactive for (days)", { exact: true });
  await expect(days).toHaveValue("30");
  const beforeInvalidDrafts = api.listReads.length;

  // The isolated inactive-days cases also cover the pure rule.
  for (const [value, message] of [
    ["", "Enter the number of days."],
    ["0", "Enter a whole number from 1 to 3650."],
    ["3651", "Enter a whole number from 1 to 3650."],
    ["1.5", "Enter a whole number from 1 to 3650."],
    ["-1", "Enter a whole number from 1 to 3650."],
  ] as const) {
    await days.fill(value);
    await expect(days).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await expect(rows).toHaveCount(2);
    await expect(page).toHaveURL(/inactive_days=30/);
    expect(api.listReads).toHaveLength(beforeInvalidDrafts);
  }

  for (const [value, count] of [
    ["60", 1],
    ["1", 3],
  ] as const) {
    await days.fill(value);
    await expect(days).not.toHaveAttribute("aria-invalid", "true");
    await expect(rows).toHaveCount(count);
    await expect(page).toHaveURL(new RegExp(`inactive_days=${value}(&|$)`));
    await expect
      .poll(() => api.listReads.at(-1)?.get("inactive_days"))
      .toBe(value);
  }
  await expect(
    page.getByRole("group", { name: "Active filters", exact: true }),
  ).toContainText("Activity: Inactive 1 day");
  // A period read before comes from the cache.
  await days.fill("30");
  await expect(rows).toHaveCount(2);
  await days.fill("3650");
  await expect(page.getByText("No one matches", { exact: true })).toBeVisible();
  await expect
    .poll(() => api.listReads.at(-1)?.get("inactive_days"))
    .toBe("3650");
});

test("offpage deleted deep link survives bounded ID loading and Restore", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  addPeople(api, 110, 700);
  const gate = heldResponse();
  api.on("GET", "/api/users", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("deleted") === "include") await gate.released;
    return "next" as const;
  });
  await page.goto(`/access?view=people&role=guest&user=${ids.eli}`);
  await expect
    .poll(() =>
      api.listReads.some((query) => query.get("deleted") === "include"),
    )
    .toBe(true);
  await expect(page).toHaveURL(new RegExp(`user=${ids.eli}`));
  await expect(panel(page, "Eli Tan")).toBeHidden();
  gate.release();
  const sheet = page.getByRole("dialog", { name: "Eli Tan", exact: true });
  await expect(sheet).toBeVisible();
  expect(api.sent("GET", `/api/users/${ids.eli}`)).toHaveLength(0);
  await expect
    .poll(() =>
      api.listReads.some(
        (query) =>
          query.get("deleted") === "include" &&
          query.getAll("ids").includes(ids.eli) &&
          query.get("offset") === "0",
      ),
    )
    .toBe(true);
  await openAdvanced(sheet);
  await sheet.getByRole("button", { name: "Restore", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Restore Eli Tan?",
    exact: true,
  });
  await confirmation
    .getByRole("button", { name: "Restore", exact: true })
    .click();
  await expect(sheet).toContainText("Disabled");
  await expect(
    sheet.getByRole("button", { name: "Restore", exact: true }),
  ).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`user=${ids.eli}`));
  await page.reload();
  await expect(
    page.getByRole("dialog", { name: "Eli Tan", exact: true }),
  ).toBeVisible();
});

test("an invitation searches later-page sponsor choices without changing base invitation responses", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  addPeople(api, 110, 700);
  const sponsor = "00000000-0000-4000-8000-000000000999";
  api.users.set(
    sponsor,
    person({
      id: sponsor,
      username: "zzz_sponsor",
      display_name: "Zzz Sponsor",
      role: "admin",
    }),
  );
  await page.goto("/access?view=people");
  await expect(
    page.getByRole("table", { name: "People", exact: true }),
  ).toBeVisible();
  expect(
    api.listReads.some((query) => query.get("deleted") === "include"),
  ).toBe(false);
  await page
    .getByRole("button", { name: "Invite person", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Invite a person",
    exact: true,
  });
  await dialog
    .getByLabel("Email", { exact: true })
    .fill("newguest@example.com");
  await dialog.getByLabel("Role", { exact: true }).selectOption("guest");
  await dialog.getByRole("combobox", { name: "Sponsor", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Search sponsor", exact: true })
    .fill("Zzz Sponsor");
  await page.getByRole("option", { name: "Zzz Sponsor", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Send invitation", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(api.sent("POST", "/api/auth/invitations")[0]?.body).toMatchObject({
    role: "guest",
    sponsor_user_id: sponsor,
  });
});

// The other unsupported facts (fractional or missing counts, times that are
// not instants) are the isolated table in isolated/access/directory-list.spec.ts.
test("a malformed monitoring count stays unavailable and a fresh Retry returns supported facts", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  let malformed = true;
  api.on("GET", "/api/users", (route) =>
    malformed
      ? route.fulfill({
          json: listPage(
            [
              {
                ...api.users.get(ids.ben),
                mfa_verified_totp: false,
                mfa_observed_at: created,
                last_active_at: null,
                active_session_count: -1,
                last_sign_in_at: null,
              },
            ],
            new URL(route.request().url()),
          ),
        })
      : "next",
  );
  await page.goto("/access?view=people");
  await expect(
    page.getByRole("alert").filter({ hasText: "People could not be loaded" }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "People", exact: true }),
  ).toHaveCount(0);
  malformed = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page
      .getByRole("table", { name: "People", exact: true })
      .getByRole("row", { name: /Ben Cruz/ }),
  ).toContainText("Off");
});

test("person sessions show sign-in addresses and accepted revocation refreshes the directory count", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await mockAccessApi(page);
  api.sessions.push({
    id: "00000000-0000-4000-8000-0000000000f3",
    created_at: created,
    refreshed_at: created,
    expires_at: "2099-01-01T00:00:00Z",
    user_agent: "Unknown client",
    current: false,
    ip_address: null,
  });
  api.monitoring.set(ids.ben, {
    active_session_count: 3,
    mfa_verified_totp: false,
    mfa_observed_at: created,
    last_sign_in_at: "2026-09-12T09:15:00Z",
    last_active_at: "2026-10-01T07:45:00Z",
  });
  await page.goto(`/access?view=people&user=${ids.ben}`);
  let sheet = panel(page, "Ben Cruz");
  await sheet.getByRole("tab", { name: "Sessions", exact: true }).click();
  const sessions = sheet.getByRole("list", { name: "Sessions", exact: true });
  await expect(sessions).toContainText("Sign-in address: 198.51.100.101");
  await expect(sessions).toContainText("Sign-in address: 2001:db8::102");
  await expect(sessions).toContainText("Sign-in address: Unknown");
  await expect(sessions.getByRole("listitem")).toHaveCount(3);
  await sessions
    .getByRole("button", { name: /^Sign out Laptop browser/ })
    .click();
  await page
    .getByRole("alertdialog", { name: "Sign out this session?" })
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await expect(sessions).not.toContainText("198.51.100.101");
  await expect(sessions).toContainText("Sign-in address: 2001:db8::102");
  expect(
    api.sent("DELETE", `/api/users/${ids.ben}/sessions/${ids.laptop}`),
  ).toHaveLength(1);
  // The recorded session count follows the accepted revocation.
  await expectRecordedFact(page, "Ben Cruz", "Active sessions", "2");
  await expectRecordedFact(
    page,
    "Ben Cruz",
    "Last sign-in",
    await recordedTime(page, "2026-09-12T09:15:00Z"),
  );
  await expectRecordedFact(
    page,
    "Ben Cruz",
    "Last activity",
    await recordedTime(page, "2026-10-01T07:45:00Z"),
  );
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await openPerson(page, "Ben Cruz");
  sheet = panel(page, "Ben Cruz");
  await sheet.getByRole("tab", { name: "Sessions", exact: true }).click();
  await sheet
    .getByRole("button", { name: "Sign out everywhere", exact: true })
    .click();
  await page
    .getByRole("alertdialog", { name: "Sign out everywhere?" })
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await expect(
    sheet.getByRole("list", { name: "Sessions", exact: true }),
  ).toHaveCount(0);
  expect(api.sent("DELETE", `/api/users/${ids.ben}/sessions`)).toHaveLength(1);
  await expectRecordedFact(page, "Ben Cruz", "Active sessions", "0");
  await expectRecordedFact(
    page,
    "Ben Cruz",
    "Last sign-in",
    await recordedTime(page, "2026-09-12T09:15:00Z"),
  );
  await expectRecordedFact(
    page,
    "Ben Cruz",
    "Last activity",
    await recordedTime(page, "2026-10-01T07:45:00Z"),
  );
});

test("an accepted person edit returns an out-of-range last page to current rows", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  api.users.clear();
  addPeople(api, 11, 700);
  let holdLastPage = false;
  const gate = heldResponse();
  api.on("GET", "/api/users", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (
      holdLastPage &&
      query.get("role") === "member" &&
      query.get("offset") === "10"
    )
      await gate.released;
    return "next" as const;
  });
  await page.goto("/access?view=people&role=member");
  await expect(
    page.getByText("Showing 1–10 of 11", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "People pages", exact: true })
    .getByRole("button", { name: "Go to next page", exact: true })
    .click();
  await expect(
    page.getByText("Showing 11–11 of 11", { exact: true }),
  ).toBeVisible();
  await openPerson(page, "Later 010");
  const sheet = panel(page, "Later 010");
  holdLastPage = true;
  await sheet.getByLabel("Role", { exact: true }).selectOption("admin");
  await sheet
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    sheet.getByRole("button", { name: /^(Save changes|Saving…)$/ }),
  ).toHaveCount(0);
  await sheet
    .getByLabel("Job title", { exact: true })
    .fill("Kept while paging adjusts");
  gate.release();
  await expect
    .poll(() =>
      api.listReads
        .filter((query) => query.get("role") === "member")
        .at(-1)
        ?.get("offset"),
    )
    .toBe("0");
  await expect(page).toHaveURL(/user=00000000-0000-4000-8000-000000000710/);
  await expect(sheet.getByLabel("Job title", { exact: true })).toHaveValue(
    "Kept while paging adjusts",
  );
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(
    page.getByText("Showing 1–10 of 10", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "People", exact: true }).getByRole("row"),
  ).toHaveCount(11);
});

for (const failure of [0, 503]) {
  test(`unsent invitation finishes through direct user response with ${failure ? "recoverable failure" : "pending protection"}`, async ({
    page,
  }) => {
    const api = await mockAccessApi(page);
    const path = `/api/auth/invitations/${ids.cy}/reconcile`;
    const held = heldResponse();
    api.on("POST", path, async (route) => {
      await held.released;
      if (failure) {
        await route.fulfill({
          status: failure,
          json: { detail: "Email service unavailable" },
        });
        return;
      }
      const current = api.users.get(ids.cy)!;
      const sent = { ...current, invitation_sent_at: "2035-06-01T00:00:00Z" };
      api.users.set(ids.cy, sent);
      await route.fulfill({ json: sent });
    });
    await page.goto(`/access?view=people&user=${ids.cy}`);
    const sheet = panel(page, "cy");
    await expect(
      sheet.getByRole("button", {
        name: "Finish sending invitation",
        exact: true,
      }),
    ).toBeVisible();
    await sheet
      .getByRole("button", { name: "Finish sending invitation", exact: true })
      .click();
    const confirmation = page.getByRole("alertdialog", {
      name: "Finish sending the invitation?",
      exact: true,
    });
    await expect(confirmation).toContainText("cy@example.com");
    const requested = page.waitForRequest(
      (request) => new URL(request.url()).pathname === path,
    );
    await confirmation
      .getByRole("button", { name: "Finish sending", exact: true })
      .click();
    await requested;
    await expect(
      confirmation.getByRole("button", { name: "Sending…", exact: true }),
    ).toBeDisabled();
    held.release();
    if (failure) {
      await expect(confirmation.getByRole("alert")).toBeVisible();
      await expect(confirmation).toBeVisible();
      expect(api.users.get(ids.cy)?.invitation_sent_at).toBeNull();
      await confirmation
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await expect(
        sheet.getByRole("button", {
          name: "Finish sending invitation",
          exact: true,
        }),
      ).toBeVisible();
    } else {
      await expect(confirmation).toBeHidden();
      await expect(
        sheet.getByRole("button", { name: "Resend invitation", exact: true }),
      ).toBeVisible();
      await openAdvanced(sheet);
      await expect(
        sheet.getByRole("button", { name: "Revoke invitation", exact: true }),
      ).toBeVisible();
      await expect(
        sheet.getByRole("button", {
          name: "Finish sending invitation",
          exact: true,
        }),
      ).toHaveCount(0);
    }
    expect(api.sent("POST", path)).toHaveLength(1);
  });
}

test("reconcile is offered only for nondeleted pending unsent people", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  for (const fields of [
    { id: ids.ben, status: "active" as const, invitation_sent_at: null },
    { id: ids.cy, status: "pending" as const, invitation_sent_at: created },
    {
      id: ids.eli,
      status: "disabled" as const,
      is_deleted: true,
      deleted_at: created,
      invitation_sent_at: null,
    },
  ]) {
    const current = api.users.get(fields.id)!;
    api.users.set(fields.id, { ...current, ...fields });
    await page.goto(`/access?view=people&user=${fields.id}`);
    const sheet = panel(
      page,
      fields.id === ids.ben
        ? "Ben Cruz"
        : fields.id === ids.cy
          ? "cy"
          : "Eli Tan",
    );
    await expect(sheet).toBeVisible();
    // Disable and Restore wait in Advanced; Resend stays in view.
    await openAdvanced(sheet);
    await expect(
      sheet.getByRole("button", {
        name:
          fields.id === ids.ben
            ? "Disable"
            : fields.id === ids.cy
              ? "Resend invitation"
              : "Restore",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Finish sending invitation",
        exact: true,
      }),
    ).toHaveCount(0);
  }
});
