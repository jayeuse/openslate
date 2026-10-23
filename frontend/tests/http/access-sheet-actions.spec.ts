import { expect, heldResponse, test, type Page } from "./helpers/test";

import {
  addPeople,
  created,
  fixtureId,
  ids,
  mockAccessApi,
  openAdvanced,
} from "./helpers/access-api";

// The person and group sheets (docs/specs/access-ui-ux-pass.md, Phase 3):
// lifecycle actions wait in a closed Advanced block, an action names what it
// is doing, Delete and Discard can be undone, disabled controls say why, and
// a person joins or leaves a group from their own sheet. Helpers mock the
// Access API (see helpers/access-api.ts): Inventory clerks (Ana, Ben) and
// Finance readers (Ben).

function sheet(page: Page, name: string) {
  return page.getByRole("dialog", { name, exact: true });
}

function memberIds(body: unknown): string[] {
  return [...(body as { member_ids: string[] }).member_ids].sort();
}

test("lifecycle actions wait in a closed Advanced block, last in Details, and open by keyboard", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  const cy = api.users.get(ids.cy)!;
  api.users.set(ids.cy, { ...cy, invitation_sent_at: created });
  await page.goto(`/access?view=people&user=${ids.cy}`);
  const pending = sheet(page, "cy");
  // A sent invitation keeps its next step in view; revoking it is Advanced.
  await expect(
    pending.getByRole("button", { name: "Resend invitation", exact: true }),
  ).toBeVisible();
  await expect(
    pending.getByRole("button", { name: "Revoke invitation", exact: true }),
  ).toBeHidden();
  await pending.getByRole("button", { name: "Close", exact: true }).click();

  await page.goto(`/access?view=people&user=${ids.ben}`);
  const ben = sheet(page, "Ben Cruz");
  await expect(ben.getByLabel("Job title")).toBeVisible();
  // Nothing to save at rest, so there is no Save or Discard.
  await expect(
    ben.getByRole("button", { name: /^(Save changes|Saving…)$/ }),
  ).toHaveCount(0);
  await expect(
    ben.getByRole("button", { name: "Discard changes", exact: true }),
  ).toHaveCount(0);
  // Closed, Advanced names what it holds.
  const advanced = ben.getByRole("button", { name: /^Advanced/ });
  await expect(advanced).toHaveAccessibleName("Advanced · Disable, Delete");
  await expect(advanced).toHaveAttribute("aria-expanded", "false");
  await expect(
    ben.getByRole("button", { name: "Disable", exact: true }),
  ).toBeHidden();
  const details = ben.getByRole("tabpanel", { name: "Details" });
  expect(
    await details.evaluate(
      (panel) =>
        panel.firstElementChild?.lastElementChild?.getAttribute("data-slot") ??
        null,
    ),
  ).toBe("advanced-section");
  await advanced.focus();
  await page.keyboard.press("Enter");
  await expect(advanced).toHaveAttribute("aria-expanded", "true");
  await expect(
    ben.getByRole("button", { name: "Disable", exact: true }),
  ).toBeVisible();
  await expect(
    ben.getByRole("button", { name: "Delete", exact: true }),
  ).toBeVisible();
  expect(api.calls.filter((call) => call.method !== "GET")).toEqual([]);
});

test("deleting a person closes the sheet and Undo restores them", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  const deletion = heldResponse();
  api.on("DELETE", `/api/users/${ids.ben}`, async () => {
    deletion.enter();
    await deletion.released;
    return "next" as const;
  });
  await page.goto(`/access?view=people&user=${ids.ben}`);
  const ben = sheet(page, "Ben Cruz");
  await openAdvanced(ben);
  await ben.getByRole("button", { name: "Delete", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete Ben Cruz?" });
  await expect(confirm).toContainText("signed out everywhere");
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await deletion.entered;
  await expect(
    confirm.getByRole("button", { name: "Deleting…", exact: true }),
  ).toHaveAttribute("aria-busy", "true");
  deletion.release();

  await expect(ben).toBeHidden();
  await expect(
    page.getByRole("searchbox", { name: "Search people", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByText("Ben Cruz deleted", { exact: true }),
  ).toBeVisible();
  const people = page.getByRole("table", { name: "People", exact: true });
  await expect(
    people.getByRole("button", { name: "Manage Ben Cruz", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    people.getByRole("button", { name: "Manage Ben Cruz", exact: true }),
  ).toBeVisible();
  expect(api.sent("DELETE", `/api/users/${ids.ben}`)).toHaveLength(1);
  expect(api.sent("POST", `/api/users/${ids.ben}/restore`)).toHaveLength(1);
  expect(api.users.get(ids.ben)?.is_deleted).toBe(false);
});

test("Discard in the person and group editors can be undone", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  await page.goto(`/access?view=people&user=${ids.ben}`);
  const ben = sheet(page, "Ben Cruz");
  await ben.getByLabel("Job title").fill("Team lead");
  await ben
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(ben.getByLabel("Job title")).toHaveValue("Clerk");
  // Focus never falls to the sheet: Discard hands it to Undo, Undo to Save,
  // and a save back to the field last edited.
  await expect(
    ben.getByRole("button", { name: "Undo", exact: true }),
  ).toBeFocused();
  await expect(
    ben.getByRole("button", { name: /^(Save changes|Saving…)$/ }),
  ).toHaveCount(0);
  await expect(
    ben.getByRole("status").filter({ hasText: "Changes discarded" }),
  ).toBeVisible();
  await ben.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(ben.getByLabel("Job title")).toHaveValue("Team lead");
  await expect(
    ben.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    ben.getByRole("button", { name: /^(Save changes|Saving…)$/ }),
  ).toHaveCount(0);
  expect(api.sent("PATCH", `/api/users/${ids.ben}`)[0]?.body).toEqual({
    job_title: "Team lead",
  });
  await expect(ben.getByLabel("Job title")).toBeFocused();

  // In a long Members list the Undo takes the sticky bar's place, in reach.
  addPeople(api, 30, 950);
  const crowded = api.groups.get(ids.clerks)!;
  api.groups.set(ids.clerks, {
    ...crowded,
    member_ids: [
      ...crowded.member_ids,
      ...Array.from({ length: 30 }, (_, index) => fixtureId(950 + index)),
    ],
  });
  await page.goto(`/access?view=groups&group=${ids.clerks}&tab=members`);
  const clerks = sheet(page, "Inventory clerks");
  await clerks
    .getByRole("searchbox", { name: "Search people to add", exact: true })
    .fill("cy");
  await clerks.getByRole("button", { name: "Add cy" }).click();
  await clerks
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  const undoMembers = clerks.getByRole("button", { name: "Undo", exact: true });
  await expect(undoMembers).toBeFocused();
  await expect(undoMembers).toBeInViewport();
  await undoMembers.click();
  await expect(
    clerks.getByRole("button", { name: "Save members", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    clerks.getByRole("button", { name: /^(Save members|Saving…)$/ }),
  ).toHaveCount(0);
  // After a Members save, focus returns to the open tab.
  await expect(clerks.getByRole("tab", { name: "Members" })).toBeFocused();

  await page.goto(`/access?view=groups&group=${ids.readers}`);
  const readers = sheet(page, "Finance readers");
  await readers.getByLabel("Description").fill("Month-end close");
  await readers
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(readers.getByLabel("Description")).toHaveValue("");
  await readers.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(readers.getByLabel("Description")).toHaveValue(
    "Month-end close",
  );
  await expect(
    readers.getByRole("button", { name: "Save details", exact: true }),
  ).toBeVisible();
});

test("invitation settings Discard offers Undo", async ({ page }) => {
  await mockAccessApi(page);
  await page.goto("/access?view=people");
  await page
    .getByRole("button", { name: "Invitation settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: "Invitation settings",
    exact: true,
  });
  const guest = settings.getByLabel("Guest access length (days)");
  await expect(guest).toHaveValue("45");
  await guest.fill("60");
  await settings
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  // Discard ends the edit: the dialog closes and Undo opens it again.
  await expect(settings).toBeHidden();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(guest).toHaveValue("60");
  await settings
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await page.getByRole("button", { name: "Invitation settings" }).click();
  await expect(guest).toHaveValue("45");
});

test("controls that wait for a list say why", async ({ page }) => {
  const api = await mockAccessApi(page);
  const people = heldResponse();
  const groups = heldResponse();
  api.on("GET", "/api/users", async (route) => {
    if (new URL(route.request().url()).searchParams.get("limit") === "1")
      return "next" as const;
    people.enter();
    await people.released;
    return "next" as const;
  });
  api.on("GET", "/api/access/groups", async () => {
    groups.enter();
    await groups.released;
    return "next" as const;
  });
  await page.goto("/access?view=people");
  await people.entered;
  const invite = page.getByRole("button", { name: "Invite person" });
  await expect(invite).toHaveAttribute("aria-disabled", "true");
  await expect(invite).toHaveAccessibleDescription("Loading people…");
  people.release();
  await expect(invite).not.toHaveAttribute("aria-disabled", "true");

  await page.goto("/access?view=groups");
  await groups.entered;
  const create = page.getByRole("button", { name: "Create group" });
  await expect(create).toHaveAttribute("aria-disabled", "true");
  await expect(create).toHaveAccessibleDescription("Loading groups…");
  groups.release();
  await expect(create).not.toHaveAttribute("aria-disabled", "true");
});

test("departments carry their marks and levels use the level chip", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  await page.goto(`/access?view=people&user=${ids.ben}`);
  const ben = sheet(page, "Ben Cruz");
  await ben.getByRole("tab", { name: "Access", exact: true }).click();
  const entry = ben
    .getByRole("list", { name: "Access by department" })
    .getByRole("listitem")
    .first();
  await expect(entry.locator('[data-sandbox-part="identity"]')).toHaveCount(1);
  await expect(entry.locator('[data-slot="badge"]').first()).toHaveText(
    "Write",
  );
  await ben.getByRole("button", { name: "Close", exact: true }).click();

  const catalogReads = api.sent("GET", "/api/departments").length;
  await page.goto("/access?view=groups");
  const clerks = page
    .getByRole("table", { name: "Groups", exact: true })
    .getByRole("row", { name: /Inventory clerks/ });
  await expect(clerks).toContainText("Inventory · Write");
  await expect(clerks.locator('[data-sandbox-part="identity"]')).toHaveCount(1);
  await expect(clerks.locator('[data-slot="badge"]')).toHaveText("Write");
  // A cold Groups load reads one first page of the department catalog.
  expect(api.sent("GET", "/api/departments").length - catalogReads).toBe(1);

  await page.goto(`/access?view=groups&group=${ids.readers}&tab=access`);
  const departments = sheet(page, "Finance readers").getByRole("list", {
    name: "Departments",
  });
  await expect(departments.getByRole("listitem")).toHaveCount(2);
  await expect(
    departments.locator('[data-sandbox-part="identity"]'),
  ).toHaveCount(2);
});

test("an administrator adds a person to a group and removes them from the person sheet", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  const adding = heldResponse();
  let holdAdd = true;
  api.on("PUT", `/api/access/groups/${ids.readers}/members`, async () => {
    if (holdAdd) {
      holdAdd = false;
      adding.enter();
      await adding.released;
    }
    return "next" as const;
  });
  await page.goto(`/access?view=people&user=${ids.ana}`);
  const ana = sheet(page, "Ana Santos");
  const groups = ana.getByRole("list", { name: "Groups", exact: true });
  await expect(groups).toContainText("Inventory clerks");
  await expect(ana).not.toContainText("Open a group to change who is in it.");

  await ana.getByRole("button", { name: "Add to group", exact: true }).click();
  const panel = ana.getByRole("group", { name: "Add to group", exact: true });
  await panel.getByRole("combobox", { name: "Group" }).click();
  // A group the person is already in cannot be chosen again.
  await expect(
    page.getByRole("option", { name: /Inventory clerks/ }),
  ).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("option", { name: /Finance readers/ }).click();
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  await adding.entered;
  await expect(
    panel.getByRole("button", { name: "Adding…", exact: true }),
  ).toHaveAttribute("aria-busy", "true");
  adding.release();
  await expect(groups).toContainText("Finance readers");
  await expect(panel).toHaveCount(0);
  const put = api.sent("PUT", `/api/access/groups/${ids.readers}/members`);
  expect(put).toHaveLength(1);
  expect(memberIds(put[0]?.body)).toEqual([ids.ana, ids.ben].sort());

  await groups
    .getByRole("button", { name: "Remove from Finance readers", exact: true })
    .click();
  await expect(groups).not.toContainText("Finance readers");
  expect(
    memberIds(
      api.sent("PUT", `/api/access/groups/${ids.readers}/members`)[1]?.body,
    ),
  ).toEqual([ids.ben]);
  await expect(
    ana.getByRole("button", { name: "Add to group", exact: true }),
  ).toBeFocused();
});

test("an add from the person sheet and a Members tab draft both survive", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  addPeople(api, 1, 900);
  const later = fixtureId(900);
  // Another administrator saves the Members tab between this sheet's read
  // and its write: the add reads the group again and keeps that change.
  let raced = false;
  api.on("PUT", `/api/access/groups/${ids.readers}/members`, async (route) => {
    if (raced) return "next" as const;
    raced = true;
    const readers = api.groups.get(ids.readers)!;
    api.groups.set(ids.readers, {
      ...readers,
      member_ids: [...readers.member_ids, later],
      revision: readers.revision + 1,
    });
    await route.fulfill({ status: 412, json: { detail: "Resource changed" } });
  });

  // This tab first starts a Members draft for the same group.
  await page.goto(`/access?view=groups&group=${ids.readers}&tab=members`);
  const readers = sheet(page, "Finance readers");
  await readers.getByRole("button", { name: "Add cy" }).click();
  await expect(
    readers.getByRole("list", { name: "Members", exact: true }),
  ).toContainText("cy");

  await page.goto(`/access?view=people&user=${ids.ana}`);
  const ana = sheet(page, "Ana Santos");
  await ana.getByRole("button", { name: "Add to group", exact: true }).click();
  const panel = ana.getByRole("group", { name: "Add to group", exact: true });
  await panel.getByRole("combobox", { name: "Group" }).click();
  await page.getByRole("option", { name: /Finance readers/ }).click();
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    ana.getByRole("list", { name: "Groups", exact: true }),
  ).toContainText("Finance readers");
  const puts = api.sent("PUT", `/api/access/groups/${ids.readers}/members`);
  expect(puts).toHaveLength(2);
  expect(memberIds(puts[1]?.body)).toEqual([ids.ana, ids.ben, later].sort());

  // The kept Members draft merges onto the group that now has Ana.
  await page.goto(`/access?view=groups&group=${ids.readers}&tab=members`);
  await sheet(page, "Finance readers")
    .getByRole("button", { name: "Save members", exact: true })
    .click();
  await expect(
    sheet(page, "Finance readers").getByRole("button", {
      name: /^(Save members|Saving…)$/,
    }),
  ).toHaveCount(0);
  const saved = api.sent("PUT", `/api/access/groups/${ids.readers}/members`);
  expect(saved).toHaveLength(3);
  expect(memberIds(saved[2]?.body)).toEqual(
    [ids.ana, ids.ben, ids.cy, later].sort(),
  );
});
