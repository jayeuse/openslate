import { expect, test, type Page } from "./helpers/test";

import {
  group,
  ids,
  listPage,
  mockAccessApi,
  person,
  type AccessEntry,
} from "./helpers/access-api";

// The Groups tab against the mocked Access API (see helpers/access-api.ts):
// Inventory clerks (Ana, Ben; Inventory write) and Finance readers (Ben;
// Finance read). Prices is a module of Inventory.

const empty = "00000000-0000-4000-8000-0000000000a3";
const wide = "00000000-0000-4000-8000-0000000000a4";
const gone = "00000000-0000-4000-8000-0000000000d9";

function panel(page: Page, name: string) {
  return page.getByRole("dialog", { name, exact: true });
}

async function openGroup(page: Page, name: string) {
  await page
    .getByRole("table", { name: "Groups" })
    .getByRole("button", { name })
    .click();
  await expect(panel(page, name)).toBeVisible();
}

const byKey = (entries: AccessEntry[]) =>
  [...entries].sort((left, right) =>
    `${left.department_id}:${left.module_id}`.localeCompare(
      `${right.department_id}:${right.module_id}`,
    ),
  );

test("the list shows members and the departments each group reaches, and searches", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  api.groups.set(wide, {
    ...group(
      wide,
      "Auditors",
      [ids.ana],
      [
        { department_id: ids.inventory, module_id: ids.prices, level: "read" },
        { department_id: ids.finance, module_id: null, level: "read" },
        { department_id: gone, module_id: null, level: "read" },
      ],
    ),
    description: "Year-end review",
  });
  await page.goto("/access?view=groups");

  const table = page.getByRole("table", { name: "Groups" });
  await expect(page.getByText("3 groups")).toBeVisible();
  const clerks = table.getByRole("row", { name: /Inventory clerks/ });
  await expect(clerks).toContainText("2");
  await expect(clerks).toContainText("Inventory · Write");
  const auditors = table.getByRole("row", { name: /Auditors/ });
  await expect(auditors).toContainText("Year-end review");
  await expect(auditors).toContainText("Finance · Read");
  await expect(auditors).toContainText("Inventory · 1 module");
  await expect(auditors).toContainText("+1 more");

  await page.getByRole("searchbox", { name: "Search groups" }).fill("finance");
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(clerks).toBeHidden();

  // A click anywhere on the row opens the group.
  await page.getByRole("searchbox", { name: "Search groups" }).fill("");
  // The open button's hit area covers the row, so click by position.
  await clerks.getByText("Inventory · Write").click({ force: true });
  await expect(panel(page, "Inventory clerks")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`group=${ids.clerks}`));
});

test("an Overview link opens the list filtered to groups without access", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  api.groups.set(empty, group(empty, "New hires", [], []));
  await page.goto("/access?view=groups&filter=no-access");
  const table = page.getByRole("table", { name: "Groups" });
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("row", { name: /New hires/ })).toContainText(
    "No access",
  );
});

test("creating a group sends its first members and opens its access", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  await page.goto("/access?view=groups");
  await page.getByRole("button", { name: "Create group" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create a group" });

  await dialog.getByRole("button", { name: "Create group" }).click();
  await expect(dialog.getByText("Enter a name.")).toBeVisible();

  await dialog.getByLabel("Name").fill("Night shift");
  await dialog.getByLabel("Description").fill("Weekend stock counts");
  // Administrators are never offered: they have access everywhere.
  await expect(
    dialog.getByRole("button", { name: "Add Rosa Reyes" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Add Ben Cruz" }).click();
  await dialog.getByRole("button", { name: "Create group" }).click();

  await expect(dialog).toBeHidden();
  expect(api.sent("POST", "/api/access/groups")[0]?.body).toEqual({
    name: "Night shift",
    description: "Weekend stock counts",
    member_ids: [ids.ben],
  });
  const sheet = panel(page, "Night shift");
  await expect(sheet.getByRole("tab", { name: "Access" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(sheet.getByText("No access yet.")).toBeVisible();
});

test("a rename that meets a newer save asks which name to keep", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  let refused = false;
  api.on("PATCH", `/api/access/groups/${ids.clerks}`, async (route) => {
    if (refused) return "next";
    refused = true;
    // Someone renamed the group after this save read it.
    const clerks = api.groups.get(ids.clerks);
    if (clerks)
      api.groups.set(ids.clerks, {
        ...clerks,
        name: "Warehouse clerks",
        revision: clerks.revision + 1,
      });
    await route.fulfill({ status: 412, json: { detail: "Resource changed" } });
  });
  await page.goto(`/access?view=groups&group=${ids.clerks}`);
  const sheet = panel(page, "Inventory clerks");
  await sheet.getByLabel("Name").fill("Stock clerks");
  await sheet.getByRole("button", { name: "Save details" }).click();

  const conflict = page.getByRole("dialog", { name: "This group changed" });
  await expect(conflict).toContainText("Warehouse clerks");
  await expect(conflict).toContainText("Stock clerks");
  await conflict.getByRole("button", { name: "Use draft" }).click();
  await conflict.getByRole("button", { name: "Continue" }).click();

  await expect(conflict).toBeHidden();
  const patches = api.sent("PATCH", `/api/access/groups/${ids.clerks}`);
  expect(patches).toHaveLength(2);
  expect(patches[1]?.body).toEqual({ name: "Stock clerks" });
  expect(api.groups.get(ids.clerks)?.name).toBe("Stock clerks");
  await expect(
    page.getByRole("dialog", { name: "Stock clerks" }).getByRole("button", {
      name: "Save details",
    }),
  ).toBeDisabled();
});

test("an administrator replaces members from the directory, merged onto newer members", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  await page.goto(`/access?view=groups&group=${ids.readers}`);
  const sheet = panel(page, "Finance readers");
  await sheet.getByRole("tab", { name: "Members" }).click();
  const members = sheet.getByRole("list", { name: "Members" });
  await expect(members).toContainText("Ben Cruz");

  const announcement = sheet.getByRole("status");
  await sheet.getByRole("button", { name: "Add Ana Santos" }).click();
  // Focus stays in the picker, and the change is announced.
  await expect(
    sheet.getByRole("searchbox", { name: "Search people to add" }),
  ).toBeFocused();
  await expect(announcement).toHaveText(
    "Ana Santos added. Save members to apply.",
  );
  await sheet.getByRole("button", { name: "Remove Ben Cruz" }).click();
  await expect(
    sheet.getByRole("button", { name: "Remove Ana Santos" }),
  ).toBeFocused();
  await expect(announcement).toHaveText(
    "Ben Cruz removed. Save members to apply.",
  );
  await sheet.getByRole("button", { name: "Remove Ana Santos" }).click();
  await expect(
    sheet.getByRole("searchbox", { name: "Search people to add" }),
  ).toBeFocused();
  await sheet.getByRole("button", { name: "Add Ana Santos" }).click();
  // Someone else added Cy meanwhile; the save keeps that change.
  const readers = api.groups.get(ids.readers);
  if (readers)
    api.groups.set(ids.readers, {
      ...readers,
      member_ids: [ids.ben, ids.cy],
      revision: readers.revision + 1,
    });
  await sheet.getByRole("button", { name: "Save members" }).click();

  await expect(
    sheet.getByRole("button", { name: "Save members" }),
  ).toBeDisabled();
  const put = api.sent("PUT", `/api/access/groups/${ids.readers}/members`);
  expect(put).toHaveLength(1);
  expect(
    [...((put[0]?.body as { member_ids: string[] }).member_ids ?? [])].sort(),
  ).toEqual([ids.ana, ids.cy].sort());
  expect(api.sent("GET", "/api/access/member-candidates")).toHaveLength(0);
});

test("a department manager changes members only, from the candidates list", async ({
  page,
}) => {
  const api = await mockAccessApi(page, {
    identity: {
      id: ids.ben,
      role: "member",
      access: [
        { department_id: ids.inventory, module_id: null, level: "manage" },
      ],
    },
  });
  api.on("GET", "/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user_id: ids.ben,
        setup_required: false,
      },
    }),
  );
  // The backend lists only the groups this manager may change.
  api.on("GET", "/api/access/groups", (route) =>
    route.fulfill({
      json: listPage(
        [api.groups.get(ids.clerks)].filter((item) => item !== undefined),
        new URL(route.request().url()),
      ),
    }),
  );
  await page.goto("/access?view=groups");
  await expect(page.getByRole("button", { name: "Create group" })).toHaveCount(
    0,
  );
  await openGroup(page, "Inventory clerks");
  const sheet = panel(page, "Inventory clerks");

  await expect(sheet.getByRole("tab", { name: "Members" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await sheet.getByRole("button", { name: "Add cy" }).click();
  await sheet.getByRole("button", { name: "Save members" }).click();
  await expect(
    sheet.getByRole("button", { name: "Save members" }),
  ).toBeDisabled();
  expect(
    api.sent("PUT", `/api/access/groups/${ids.clerks}/members`)[0]?.body,
  ).toEqual({ member_ids: [ids.ana, ids.ben, ids.cy] });

  await sheet.getByRole("tab", { name: "Details" }).click();
  await expect(sheet.getByRole("textbox", { name: "Name" })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Delete group" })).toHaveCount(
    0,
  );
  await sheet.getByRole("tab", { name: "Access" }).click();
  await expect(sheet.getByText("Inventory · Write")).toBeVisible();
  await expect(sheet.getByRole("combobox")).toHaveCount(0);
  expect(api.sent("GET", "/api/users")).toHaveLength(0);
  expect(
    api.sent("GET", "/api/access/member-candidates").length,
  ).toBeGreaterThan(0);
});

test("the access editor sends every department and module level as one replacement", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  await page.goto(`/access?view=groups&group=${ids.readers}`);
  const sheet = panel(page, "Finance readers");
  await sheet.getByRole("tab", { name: "Access" }).click();

  await sheet.getByLabel("Inventory level").selectOption("write");
  await sheet.getByRole("button", { name: "Modules in Inventory" }).click();
  const prices = sheet.getByLabel("Prices level");
  await expect(prices).toHaveValue("");
  await expect(prices.locator("option").first()).toHaveText(
    "Same as department (Write)",
  );
  await prices.selectOption("read");
  await sheet.getByLabel("Finance level").selectOption("");

  const summary = sheet.getByRole("region", { name: "This group gives" });
  await expect(summary).toContainText("Inventory · Write + 1 module");
  await expect(summary).toContainText("Prices · Read");
  await expect(summary).not.toContainText("Finance");

  await sheet.getByRole("button", { name: "Save access" }).click();
  await expect(
    sheet.getByRole("button", { name: "Save access" }),
  ).toBeDisabled();
  const put = api.sent("PUT", `/api/access/groups/${ids.readers}/access`);
  expect(put).toHaveLength(1);
  expect(byKey((put[0]?.body as { access: AccessEntry[] }).access)).toEqual(
    byKey([
      { department_id: ids.inventory, module_id: null, level: "write" },
      { department_id: ids.inventory, module_id: ids.prices, level: "read" },
    ]),
  );
});

test("a group with members cannot be deleted; an empty one can", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  api.groups.set(empty, group(empty, "New hires", [], []));
  await page.goto(`/access?view=groups&group=${ids.clerks}`);
  let sheet = panel(page, "Inventory clerks");
  // A group with members offers the way to empty it, not a delete.
  await expect(sheet.getByRole("button", { name: "Delete group" })).toHaveCount(
    0,
  );
  await sheet.getByRole("button", { name: "Go to Members" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(sheet.getByRole("tab", { name: "Members" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await sheet.getByRole("button", { name: "Close" }).click();

  await openGroup(page, "New hires");
  sheet = panel(page, "New hires");
  await sheet.getByRole("button", { name: "Delete group" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete New hires?" });
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(confirm).toBeHidden();
  await expect(sheet).toBeHidden();
  expect(api.sent("DELETE", `/api/access/groups/${empty}`)).toHaveLength(1);
  expect(api.sent("DELETE", `/api/access/groups/${ids.clerks}`)).toHaveLength(
    0,
  );
  await expect(
    page.getByRole("table", { name: "Groups" }).getByRole("row", {
      name: /New hires/,
    }),
  ).toHaveCount(0);
});

test("an unsaved group draft survives a reload and asks before it is discarded", async ({
  page,
}) => {
  await mockAccessApi(page);
  await page.goto(`/access?view=groups&group=${ids.clerks}`);
  await panel(page, "Inventory clerks")
    .getByLabel("Description")
    .fill("Counts and prices");
  await page.reload();
  const sheet = panel(page, "Inventory clerks");
  await expect(sheet.getByLabel("Description")).toHaveValue(
    "Counts and prices",
  );

  await page.keyboard.press("Escape");
  const discard = page.getByRole("alertdialog", {
    name: "Discard unsaved changes?",
  });
  await discard.getByRole("button", { name: "Discard changes" }).click();
  await expect(sheet).toBeHidden();
  await openGroup(page, "Inventory clerks");
  await expect(
    panel(page, "Inventory clerks").getByLabel("Description"),
  ).toHaveValue("");
});

test("a member save that got no answer is held for review, and the other drafts come back", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  api.on("PUT", `/api/access/groups/${ids.readers}/members`, (route) =>
    route.abort(),
  );
  await page.goto(`/access?view=groups&group=${ids.readers}`);
  let sheet = panel(page, "Finance readers");
  await sheet.getByLabel("Description").fill("Month-end close");
  await sheet.getByRole("tab", { name: "Members" }).click();
  await sheet.getByRole("button", { name: "Add Ana Santos" }).click();
  await sheet.getByRole("button", { name: "Save members" }).click();

  await expect(sheet.getByRole("alert")).toContainText(
    "This change to the group may have completed.",
  );
  await expect(
    sheet.getByRole("button", { name: "Reload Access to review" }),
  ).toBeVisible();

  await page.reload();
  sheet = panel(page, "Finance readers");
  await expect(
    sheet.getByRole("region", { name: "Saved group draft" }),
  ).toContainText("Ana Santos");
  await sheet.getByRole("button", { name: "Discard after review" }).click();
  await expect(sheet.getByLabel("Description")).toHaveValue("Month-end close");
  await sheet.getByRole("tab", { name: "Members" }).click();
  await expect(sheet.getByRole("list", { name: "Members" })).not.toContainText(
    "Ana Santos",
  );
  expect(
    api.sent("PUT", `/api/access/groups/${ids.readers}/members`),
  ).toHaveLength(1);
});

test("the list offers a retry after a failed load and explains a refusal", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  let fail = true;
  api.on("GET", "/api/access/groups", (route) =>
    fail
      ? route.fulfill({ status: 500, json: { detail: "Unavailable" } })
      : "next",
  );
  await page.goto("/access?view=groups");
  await expect(page.getByText("Groups could not be loaded")).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("2 groups")).toBeVisible();

  api.on("GET", "/api/access/groups", (route) =>
    route.fulfill({ status: 403, json: { detail: "Forbidden" } }),
  );
  await page.reload();
  await expect(page.getByText("You cannot see groups")).toBeVisible();
});

for (const width of [1440, 390])
  test(`the Groups tab and its access editor fit a ${width}px screen`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width > 400 ? 900 : 844 });
    await mockAccessApi(page);
    await page.goto("/access?view=groups");
    await expect(page.getByText("2 groups")).toBeVisible();
    const fits = () =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      );
    expect(await fits()).toBe(true);

    await page
      .getByRole("button", { name: /^Inventory clerks/ })
      .filter({ visible: true })
      .click();
    const sheet = panel(page, "Inventory clerks");
    await sheet.getByRole("tab", { name: "Access" }).click();
    await sheet.getByRole("button", { name: "Modules in Inventory" }).click();
    await expect(sheet.getByLabel("Prices level")).toBeVisible();
    const box = await sheet.boundingBox();
    if (width === 390) expect(box?.width).toBeCloseTo(390, 0);
    else expect(box?.width).toBeLessThan(width / 2);
    expect(
      await sheet.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    expect(await fits()).toBe(true);
  });

test("13b: group members retain the complete later-page catalog and refresh paged membership after Save", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  for (let index = 0; index < 105; index += 1) {
    const id = `00000000-0000-4000-8000-${String(700 + index).padStart(12, "0")}`;
    api.users.set(
      id,
      person({ id, username: `later${String(index).padStart(3, "0")}` }),
    );
  }
  const late = "00000000-0000-4000-8000-000000000999";
  api.users.set(
    late,
    person({ id: late, username: "zzz_member", display_name: "Zzz Member" }),
  );
  await page.goto(`/access?view=people&group=${ids.readers}`);
  await expect(
    page.getByRole("table", { name: "People", exact: true }).getByRole("row"),
  ).toHaveCount(2);
  await page.getByRole("link", { name: "Groups", exact: true }).click();
  await openGroup(page, "Finance readers");
  const sheet = panel(page, "Finance readers");
  await sheet.getByRole("tab", { name: "Members", exact: true }).click();
  await sheet
    .getByRole("searchbox", { name: "Search people to add", exact: true })
    .fill("Zzz Member");
  await sheet
    .getByRole("button", { name: "Add Zzz Member", exact: true })
    .click();
  await sheet
    .getByRole("button", { name: "Save members", exact: true })
    .click();
  await expect(
    sheet.getByRole("button", { name: "Save members", exact: true }),
  ).toBeDisabled();
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("link", { name: "People", exact: true }).click();
  await expect(page).toHaveURL(/\/access\?view=people(?:&|$)/);
  const people = page.getByRole("table", { name: "People", exact: true });
  await expect(people).toBeVisible();
  await page.getByRole("button", { name: "More filters", exact: true }).click();
  await page.getByLabel("Group", { exact: true }).selectOption(ids.readers);
  await expect(people.getByRole("row", { name: /Zzz Member/ })).toBeVisible();
  expect(
    api.sent("PUT", `/api/access/groups/${ids.readers}/members`)[0]?.body,
  ).toMatchObject({ member_ids: [ids.ben, late] });
});
