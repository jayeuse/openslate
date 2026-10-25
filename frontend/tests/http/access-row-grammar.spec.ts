import {
  expect,
  expectNoHorizontalScroll,
  expectNoPageScroll,
  heldResponse,
  test,
  type Locator,
  type Page,
} from "./helpers/test";
import { mockManageSecurity } from "./helpers/manage-security";
import {
  addPeople,
  fixtureId,
  group,
  ids,
  mockAccessApi,
} from "./helpers/access-api";

// Access rows, toolbars and controls: one slim row grammar for People,
// Groups and Sessions, status quick filters with counts, filters kept in the
// URL, slim controls from 1280 px, and a page that stays still on desktop.

const peopleTable = (page: Page) =>
  page.getByRole("table", { name: "People", exact: true });
const peopleRow = (page: Page, name: string) =>
  peopleTable(page).getByRole("row").filter({ hasText: name });

async function height(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The element has no box");
  return Math.round(box.height);
}

/**
 * Nothing between the table and the shell overflows, so only the table
 * container can scroll. Returns the overflowing ancestors, if any.
 */
async function overflowingAncestors(page: Page, table: string) {
  return page.evaluate((name) => {
    const scroller = document
      .querySelector(`table[aria-label="${name}"]`)
      ?.closest('[data-slot="table-container"]');
    const main = document.getElementById("main-content");
    if (!scroller || !main) return ["no table or main region"];
    const overflowing: string[] = [];
    for (
      let node = scroller.parentElement;
      node && node !== main.parentElement;
      node = node.parentElement
    )
      if (node.scrollHeight > node.clientHeight + 1)
        overflowing.push(`${node.tagName}.${node.className}`.slice(0, 80));
    return overflowing;
  }, table);
}

async function headers(table: Locator): Promise<string[]> {
  return (await table.getByRole("columnheader").allInnerTexts()).map((text) =>
    text.trim(),
  );
}

test("a People row opens from one target and reads on one 40 px line", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockAccessApi(page);
  await page.goto("/access?view=people");
  const ben = peopleRow(page, "Ben Cruz");
  // One open target: no hover card, no second link, no visible "Manage".
  await expect(ben.getByRole("button")).toHaveCount(1);
  const open = ben.getByRole("button", {
    name: "Manage Ben Cruz",
    exact: true,
  });
  await expect(open).toHaveAccessibleDescription("ben@example.com");
  await expect(ben.getByRole("link")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Person card/ })).toHaveCount(
    0,
  );
  await expect(ben).not.toContainText("Manage");
  await expect(ben.locator('[data-slot="avatar"]')).toHaveCount(1);
  // Name and email share one line.
  const name = await ben.getByText("Ben Cruz", { exact: true }).boundingBox();
  const email = await ben
    .getByText("ben@example.com", { exact: true })
    .boundingBox();
  expect(Math.abs((name?.y ?? 0) - (email?.y ?? 100))).toBeLessThan(4);
  for (const row of await peopleTable(page)
    .locator('[data-slot="table-body"] tr')
    .all())
    expect(await height(row)).toBe(40);
  expect(await headers(peopleTable(page))).toEqual([
    "Person",
    "Role",
    "Status",
    "Groups",
    "Departments",
    "Two-step",
    "Last active",
  ]);
  // From 1280 to 1439 px Departments gives its room to names.
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect
    .poll(() => headers(peopleTable(page)))
    .toEqual(["Person", "Role", "Status", "Groups", "Two-step", "Last active"]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(ben).toContainText("Off");
  await expect(peopleRow(page, "Rosa Reyes")).toContainText("On");
  await expect(peopleRow(page, "Ana Santos")).toContainText(
    /Ends in \d+ days?/,
  );
  // The whole row is the target, and the open person's row stays selected.
  const lastCell = await ben.getByRole("cell").last().boundingBox();
  await page.mouse.click(
    (lastCell?.x ?? 0) + (lastCell?.width ?? 0) / 2,
    (lastCell?.y ?? 0) + (lastCell?.height ?? 0) / 2,
  );
  await expect(
    page.getByRole("dialog", { name: "Ben Cruz", exact: true }),
  ).toBeVisible();
  // The open sheet hides the table from the accessibility tree.
  await expect(
    page
      .locator('table[aria-label="People"] tbody tr')
      .filter({ hasText: "Ben Cruz" }),
  ).toHaveAttribute("data-state", "selected");
});

test("People keeps four columns on a tablet and two-line rows on a phone", async ({
  page,
}) => {
  await mockAccessApi(page);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/access?view=people");
  await expect(peopleRow(page, "Ben Cruz")).toBeVisible();
  expect(await headers(peopleTable(page))).toEqual([
    "Person",
    "Role",
    "Status",
    "Last active",
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  const list = page.getByRole("list", { name: "People", exact: true });
  const ben = list.getByRole("listitem").filter({ hasText: "Ben Cruz" });
  await expect(ben).toContainText("ben@example.com");
  await expect(
    ben.getByRole("button", { name: "Manage Ben Cruz", exact: true }),
  ).toBeVisible();
  for (const item of await list.getByRole("listitem").all())
    expect(await height(item)).toBeGreaterThanOrEqual(56);
  await expectNoHorizontalScroll(page);
});

test("from 1280 px People, Groups and Security stay still and only the table scrolls", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  addPeople(api, 30, 700);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/access?view=people");
  await page
    .getByRole("combobox", { name: "Rows per page", exact: true })
    .first()
    .selectOption("25");
  await expect(
    peopleTable(page).locator('[data-slot="table-body"] tr'),
  ).toHaveCount(25);
  // At least 14 whole rows fit above the table footer at 1440×900.
  const fitting = await page.evaluate(() => {
    const table = document.querySelector('table[aria-label="People"]');
    const scroller = table?.closest('[data-slot="table-container"]');
    if (!scroller) return 0;
    const bottom = scroller.getBoundingClientRect().bottom;
    return [...table!.querySelectorAll("tbody tr")].filter(
      (row) => row.getBoundingClientRect().bottom <= bottom + 0.5,
    ).length;
  });
  expect(fitting).toBeGreaterThanOrEqual(14);
  expect(fitting).toBeLessThan(25);
  expect(await overflowingAncestors(page, "People")).toEqual([]);
  await expectNoPageScroll(page);
  await peopleRow(page, "Ben Cruz")
    .getByRole("button", { name: "Manage Ben Cruz", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Ben Cruz", exact: true }),
  ).toBeVisible();
  await expectNoPageScroll(page);
  await page.keyboard.press("Escape");

  for (const size of [
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(size);
    for (const [view, heading] of [
      ["people", "People"],
      ["groups", "Groups"],
    ] as const) {
      await page.goto(`/access?view=${view}`);
      await expect(
        page.getByRole("heading", { level: 1, name: heading }),
      ).toBeVisible();
      await expect(
        page.getByRole("table", { name: heading, exact: true }),
      ).toBeVisible();
      expect(await overflowingAncestors(page, heading)).toEqual([]);
      await expectNoPageScroll(page);
    }
  }
});

test("Security stays still from 1280 px and its sessions use the slim rows", async ({
  page,
}) => {
  await mockManageSecurity(page);
  for (const size of [
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(size);
    await page.goto("/access?view=security");
    const sessions = page.getByRole("table", { name: "Sessions", exact: true });
    await expect(sessions.locator("tbody tr").first()).toBeVisible();
    expect(await overflowingAncestors(page, "Sessions")).toEqual([]);
    await expectNoPageScroll(page);
    for (const row of await sessions.locator("tbody tr").all())
      expect(await height(row)).toBe(40);
  }
});

test("Groups use the slim rows and show Description only when a group has one", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/access?view=groups");
  const table = page.getByRole("table", { name: "Groups", exact: true });
  await expect(table.getByRole("row")).toHaveCount(3);
  // One open target per row, named like People rows.
  await expect(
    table.getByRole("button", { name: "Manage Inventory clerks", exact: true }),
  ).toBeVisible();
  expect(await headers(table)).not.toContain("Description");
  for (const row of await table.locator("tbody tr").all())
    expect(await height(row)).toBe(40);
  const readers = api.groups.get(ids.readers);
  if (readers)
    api.groups.set(ids.readers, {
      ...readers,
      description: "Month-end close",
    });
  await page.reload();
  await expect(table.getByRole("row")).toHaveCount(3);
  expect(await headers(table)).toContain("Description");
  await expect(
    table.getByRole("row").filter({ hasText: "Finance readers" }),
  ).toContainText("Month-end close");

  // On a phone a group reads on two lines, however many departments it
  // reaches.
  const wide = fixtureId(330);
  api.groups.set(
    wide,
    group(
      wide,
      "Year-end auditors",
      [ids.ana],
      [
        { department_id: ids.inventory, module_id: null, level: "read" },
        { department_id: ids.inventory, module_id: ids.prices, level: "write" },
        { department_id: ids.finance, module_id: null, level: "manage" },
        { department_id: fixtureId(331), module_id: null, level: "read" },
      ],
    ),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const list = page.getByRole("list", { name: "Groups", exact: true });
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await expect(
    list.getByRole("listitem").filter({ hasText: "Year-end auditors" }),
  ).toContainText("3 departments");
  for (const item of await list.getByRole("listitem").all())
    expect(await height(item)).toBeLessThanOrEqual(64);
});

test("status quick filters show counts, filter the directory and survive a reload", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/access?view=people");
  const status = page.getByRole("group", { name: "Status", exact: true });
  for (const name of [
    "All 5",
    "Active 4",
    "Invited 1",
    "Ending soon 1",
    "Disabled 0",
  ])
    await expect(
      status.getByRole("button", { name, exact: true }),
    ).toBeVisible();
  await expect(status.getByRole("button", { name: "All 5" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // One one-row total per status, read once.
  expect(api.countReads.map((query) => query.get("status"))).toEqual(
    expect.arrayContaining([null, "active", "pending", "ending", "disabled"]),
  );
  expect(api.countReads).toHaveLength(5);

  await status.getByRole("button", { name: "Invited 1", exact: true }).click();
  await expect(page).toHaveURL(/status=pending/);
  await expect(peopleTable(page).locator("tbody tr")).toHaveCount(1);
  await expect.poll(() => api.listReads.at(-1)?.get("status")).toBe("pending");
  await page.reload();
  await expect(
    page
      .getByRole("group", { name: "Status", exact: true })
      .getByRole("button", { name: "Invited 1", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(peopleTable(page).locator("tbody tr")).toHaveCount(1);
  expect(api.countReads).toHaveLength(10);
});

test("the inactivity history filter lives in People and its period stays in the URL", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/access?view=people");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  const filters = page.getByRole("dialog", { name: "Filters", exact: true });
  await filters
    .getByLabel("Activity", { exact: true })
    .selectOption("inactive");
  const days = filters.getByLabel("Inactive for (days)", { exact: true });
  await expect(days).toHaveValue("30");
  await days.fill("45");
  await expect(page).toHaveURL(/history=inactive/);
  await expect(page).toHaveURL(/inactive_days=45/);
  await expect(
    page.getByRole("group", { name: "Active filters", exact: true }),
  ).toContainText("Activity: Inactive 45 days");
  await expect
    .poll(() => Object.fromEntries(api.listReads.at(-1) ?? []))
    .toMatchObject({ history: "inactive", inactive_days: "45" });
  await days.fill("0");
  await expect(days).toHaveAccessibleDescription(/whole number from 1/i);
  await expect(page).toHaveURL(/inactive_days=45/);
  await page.reload();
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await expect(page.getByLabel("Activity", { exact: true })).toHaveValue(
    "inactive",
  );
  await expect(
    page.getByLabel("Inactive for (days)", { exact: true }),
  ).toHaveValue("45");
  // The Overview no longer holds the period form.
  await page.goto("/access?view=overview");
  await expect(page.getByRole("heading", { name: "Who's here" })).toBeVisible();
  await expect(page.getByLabel("Inactive for (days)")).toHaveCount(0);
});

test("Access controls are 32 px from 1280 px and keep the 44 px floor on a phone", async ({
  page,
}) => {
  await mockAccessApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/access?view=people");
  const search = page.getByRole("searchbox", { name: "Search people" });
  const invite = page.getByRole("button", { name: "Invite person" });
  const segment = page
    .getByRole("group", { name: "Status", exact: true })
    .getByRole("button", { name: /^All/ });
  expect(await height(search)).toBe(32);
  expect(await height(invite)).toBe(32);
  expect(await height(segment)).toBe(28);
  await expect(
    page
      .getByRole("region", { name: "Search people controls" })
      .getByText("Search", { exact: true }),
  ).toHaveCSS("font-size", "12px");
  await peopleRow(page, "Ben Cruz")
    .getByRole("button", { name: "Manage Ben Cruz", exact: true })
    .click();
  const sheet = page.getByRole("dialog", { name: "Ben Cruz", exact: true });
  // Measure after the sheet has slid in.
  await sheet.evaluate((element) =>
    Promise.all(
      element.getAnimations({ subtree: true }).map((item) => item.finished),
    ),
  );
  const name = sheet.getByLabel("Name", { exact: true });
  expect(await height(name)).toBe(32);
  // Details reads as label-left rows on wide screens.
  const label = await sheet.getByText("Name", { exact: true }).boundingBox();
  const field = await name.boundingBox();
  expect((label?.x ?? 0) + (label?.width ?? 0)).toBeLessThanOrEqual(
    field?.x ?? 0,
  );
  expect(Math.abs((label?.y ?? 0) - (field?.y ?? 0))).toBeLessThan(16);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await height(name)).toBeGreaterThanOrEqual(44);
  const stackedLabel = await sheet
    .getByText("Name", { exact: true })
    .boundingBox();
  const stackedField = await name.boundingBox();
  expect(
    (stackedLabel?.y ?? 0) + (stackedLabel?.height ?? 0),
  ).toBeLessThanOrEqual(stackedField?.y ?? 0);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  expect(await height(search)).toBeGreaterThanOrEqual(44);
  expect(await height(invite)).toBeGreaterThanOrEqual(44);
});

test("a sheet keeps its header, tabs and Close in place while its body scrolls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 720 });
  await mockAccessApi(page);
  await page.goto(`/access?view=people&user=${ids.ben}`);
  const sheet = page.getByRole("dialog", { name: "Ben Cruz", exact: true });
  await expect(
    sheet.getByRole("region", { name: "Recorded activity" }),
  ).toBeVisible();
  await sheet.evaluate((element) =>
    Promise.all(
      element.getAnimations({ subtree: true }).map((item) => item.finished),
    ),
  );
  const fixed = [
    sheet.getByRole("heading", { name: "Ben Cruz", exact: true }),
    sheet.getByRole("tablist", { name: "Person", exact: true }),
    sheet.getByRole("button", { name: "Close", exact: true }),
  ];
  const before = await Promise.all(fixed.map((item) => item.boundingBox()));
  const scrolled = await sheet.getByRole("tabpanel").evaluate((panel) => {
    panel.scrollTop = panel.scrollHeight;
    return panel.scrollTop;
  });
  expect(scrolled).toBeGreaterThan(0);
  expect(await Promise.all(fixed.map((item) => item.boundingBox()))).toEqual(
    before,
  );
});

test("keyboard focus never hides under the sticky table head", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  addPeople(api, 30, 700);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/access?view=people");
  await page
    .getByRole("combobox", { name: "Rows per page", exact: true })
    .selectOption("25");
  const buttons = peopleTable(page).getByRole("button", { name: /^Manage / });
  await expect(buttons).toHaveCount(25);
  await buttons.last().focus();
  const hidden: string[] = [];
  for (let step = 0; step < 24; step += 1) {
    await page.keyboard.press("Shift+Tab");
    const state = await page.evaluate(() => {
      const focused = document.activeElement;
      const head = document
        .querySelector('table[aria-label="People"] thead')
        ?.getBoundingClientRect();
      const row = focused?.closest("tr")?.getBoundingClientRect();
      return {
        name: focused?.getAttribute("aria-label") ?? "",
        covered: row && head ? row.top < head.bottom - 0.5 : false,
      };
    });
    if (state.covered) hidden.push(state.name);
  }
  expect(hidden).toEqual([]);
});

test("a look's table head band wins over the Access sticky head", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockAccessApi(page);
  await page.goto("/access?view=people");
  await expect(peopleRow(page, "Ben Cruz")).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "stockroom";
  });
  const colors = await page.evaluate(() => {
    const head = document.querySelector(
      'table[aria-label="People"] [data-slot="table-head"]',
    )!;
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--sr-steel-lite)";
    document.body.append(probe);
    const band = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      head: getComputedStyle(head).backgroundColor,
      band,
      sticky: getComputedStyle(head).position,
    };
  });
  expect(colors.head).toBe(colors.band);
  expect(colors.sticky).toBe("sticky");
});

test("the People table frame does not move when its rows arrive", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  const gate = heldResponse();
  api.on("GET", "/api/users", async (route) => {
    if (new URL(route.request().url()).searchParams.get("limit") === "1")
      return "next" as const;
    gate.enter();
    await gate.released;
    return "next" as const;
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/access?view=people");
  await gate.entered;
  const frame = page
    .locator('[data-slot="loading-region"][aria-busy="true"] .bg-card')
    .first();
  const loading = await frame.boundingBox();
  gate.release();
  await expect(peopleRow(page, "Ben Cruz")).toBeVisible();
  const loaded = await page
    .locator('table[aria-label="People"]')
    .locator("xpath=ancestor::div[contains(@class,'bg-card')][1]")
    .boundingBox();
  expect(loaded?.y).toBeCloseTo(loading?.y ?? 0, 0);
  expect(loaded?.height).toBeCloseTo(loading?.height ?? 0, 0);
});

test("Sessions use list rows on phones and size Sort to its longest option", async ({
  page,
}) => {
  await mockManageSecurity(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/access?view=security");
  const list = page.getByRole("list", { name: "Sessions", exact: true });
  await expect(list.getByRole("listitem").first()).toBeVisible();
  for (const item of await list.getByRole("listitem").all())
    expect(await height(item)).toBeGreaterThanOrEqual(56);
  const end = page.getByRole("button", {
    name: "End session for Eli, Mobile Chrome",
    exact: true,
  });
  expect(await height(end)).toBeGreaterThanOrEqual(44);
  // Sort moves into the filters on a phone.
  await expect(
    page.getByRole("combobox", { name: "Sort sessions", exact: true }),
  ).toBeHidden();
  await expectNoHorizontalScroll(page);

  await page.setViewportSize({ width: 1440, height: 900 });
  const sort = page.getByRole("combobox", {
    name: "Sort sessions",
    exact: true,
  });
  await expect(sort).toBeVisible();
  const fits = await sort.evaluate((select) => {
    const element = select as HTMLSelectElement;
    const style = getComputedStyle(element);
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = style.font;
    const widest = Math.max(
      ...[...element.options].map(
        (option) => context.measureText(option.text).width,
      ),
    );
    const room =
      element.clientWidth -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight);
    return room >= widest - 0.5;
  });
  expect(fits).toBe(true);
});

test("the People Sort select has the field edge of the other selects", async ({
  page,
}) => {
  await mockAccessApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/access?view=people");
  const skin = (select: Locator) =>
    select.evaluate((element) => {
      const style = getComputedStyle(element);
      return [
        style.borderTopColor,
        style.borderTopWidth,
        style.borderBottomColor,
        style.borderBottomWidth,
        style.backgroundColor,
      ];
    });
  const sort = page.getByRole("combobox", { name: "Sort", exact: true });
  await expect(sort).toBeVisible();
  // "Sort:" stays as its visible label.
  await expect(page.getByText("Sort:", { exact: true })).toBeVisible();
  expect(await skin(sort)).toEqual(
    await skin(
      page.getByRole("combobox", { name: "Rows per page", exact: true }),
    ),
  );
  // Every select keeps room for its chevron in every look: the chevron
  // starts after the end of the select's text box.
  const crowded = () =>
    page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '.access-ui [data-slot="native-select-wrapper"]',
        ),
      ]
        .filter((wrapper) => wrapper.offsetParent !== null)
        .map((wrapper) => {
          const select = wrapper.querySelector("select")!;
          const icon = wrapper.querySelector(
            '[data-slot="native-select-icon"]',
          )!;
          const style = getComputedStyle(select);
          const textEnd =
            select.getBoundingClientRect().right -
            parseFloat(style.borderRightWidth) -
            parseFloat(style.paddingRight);
          return {
            name:
              select.getAttribute("aria-label") ??
              select.labels?.[0]?.textContent?.trim(),
            crowded: icon.getBoundingClientRect().left < textEnd - 0.5,
          };
        }),
    );
  for (const look of ["slate", "whiteboard", "triplicate", "stockroom"]) {
    await page.evaluate((theme) => {
      if (theme === "slate") delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = theme;
    }, look);
    const selects = await crowded();
    expect(
      selects.map((select) => select.name),
      look,
    ).toEqual(["Sort", "Rows per page"]);
    expect(
      selects.filter((select) => select.crowded),
      look,
    ).toEqual([]);
  }
});

test("below 1280 px the page title scrolls away with the content", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  addPeople(api, 30, 700);
  for (const size of [
    { width: 390, height: 844 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(size);
    await page.goto("/access?view=people");
    const title = page.getByRole("heading", { level: 1, name: "People" });
    await expect(title).toBeInViewport();
    await page
      .getByRole("combobox", { name: "Rows per page", exact: true })
      .first()
      .selectOption("25");
    const rows =
      size.width < 768
        ? page
            .getByRole("list", { name: "People", exact: true })
            .getByRole("listitem")
        : peopleTable(page).locator('[data-slot="table-body"] tr');
    await expect(rows).toHaveCount(25);
    await rows.last().scrollIntoViewIfNeeded();
    await expect(title).not.toBeInViewport();
    await expectNoPageScroll(page);
  }
});

test("the People toolbar keeps one row at 1280 px", async ({ page }) => {
  // Three-digit counts make the status filters as wide as a real directory.
  const api = await mockAccessApi(page);
  addPeople(api, 120, 700);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/access?view=people");
  const controls = page.getByRole("region", {
    name: "Search people controls",
    exact: true,
  });
  const parts = [
    controls.getByRole("searchbox", { name: "Search people" }),
    controls.getByRole("group", { name: "Status", exact: true }),
    controls.getByRole("button", { name: "Filters", exact: true }),
    controls.getByRole("combobox", { name: "Sort", exact: true }),
  ];
  const boxes = await Promise.all(parts.map((part) => part.boundingBox()));
  const centers = boxes.map((box) => (box?.y ?? 0) + (box?.height ?? 0) / 2);
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(4);
  // Nothing is pushed past the edge of the screen.
  for (const box of boxes)
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(1280);
  await expect(
    controls.getByRole("button", { name: /^All 125/ }),
  ).toBeVisible();
});
