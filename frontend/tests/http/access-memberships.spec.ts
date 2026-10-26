import {
  authMeBody,
  expect,
  heldResponse,
  recheckSession,
  test,
  type Locator,
  type Page,
  isSidebarDepartmentRead,
} from "./helpers/test";
import { applyAppearancePreferences } from "../../src/lib/appearance-preferences";
import {
  created,
  fixtureId,
  group,
  ids,
  listPage,
  mockAccessApi,
  openAdvanced,
  person,
} from "./helpers/access-api";

// People shows the Departments column from 1440px (DESIGN.md, Access rows).
test.use({ viewport: { width: 1440, height: 900 } });

const membershipId = (index: number) => fixtureId(80_000 + index);

async function membershipsFixture(page: Page, count: number) {
  const api = await mockAccessApi(page);
  api.groups.clear();
  for (let index = 0; index < 110; index += 1) {
    const id = membershipId(index);
    api.groups.set(id, group(id, `A unrelated ${index}`, [ids.cy], []));
  }
  for (let index = 0; index < count; index += 1) {
    const id = membershipId(200 + index);
    api.groups.set(
      id,
      group(
        id,
        `Z membership ${String(index).padStart(2, "0")}`,
        [ids.ben],
        [],
      ),
    );
  }
  const reads: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      ["/api/access/groups", "/api/departments"].includes(url.pathname) &&
      !isSidebarDepartmentRead(url)
    )
      reads.push(url);
  });
  return { api, reads };
}

function peopleRow(page: Page, name = "Ben Cruz") {
  return page
    .getByRole("table", { name: "People", exact: true })
    .getByRole("row")
    .filter({ hasText: name });
}

/** A held response that also reports when the held route has finished. */
function readGate() {
  let complete!: () => void;
  const completed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return { ...heldResponse(), completed, complete: () => complete() };
}

async function disableBen(page: Page) {
  const sheet = page.getByRole("dialog", { name: "Ben Cruz", exact: true });
  await openAdvanced(sheet);
  await sheet.getByRole("button", { name: "Disable", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Disable Ben Cruz?",
    exact: true,
  });
  await confirmation
    .getByRole("button", { name: "Disable", exact: true })
    .click();
  await expect(confirmation).toBeHidden();
  await expect(
    sheet.getByRole("button", { name: "Enable", exact: true }),
  ).toBeVisible();
  return sheet;
}

/**
 * Opens a person's sheet from the directory. A 40px row shows the first group
 * and "+n"; the sheet's Groups section lists the loaded page and continues it.
 */
async function openGroups(page: Page, name = "Ben Cruz") {
  await page
    .getByRole("button", { name: `Manage ${name}`, exact: true })
    .click();
  const sheet = page.getByRole("dialog", { name, exact: true });
  await expect(sheet).toBeVisible();
  return sheet.getByRole("region", { name: "Groups", exact: true });
}

async function column(row: Locator, name: string) {
  const table = row.page().getByRole("table", { name: "People", exact: true });
  const index = await table
    .getByRole("columnheader", { name, exact: true })
    .evaluate((header) => (header as HTMLTableCellElement).cellIndex);
  return row.getByRole("cell").nth(index);
}

test("People memberships include no-access groups beyond the global first hundred without crawling", async ({
  page,
}) => {
  const { reads } = await membershipsFixture(page, 2);
  await page.goto("/access?view=people");
  const groups = await column(peopleRow(page), "Groups");
  await expect(groups).toContainText("Z membership 00");
  await expect(groups).toContainText("+1 more group");
  await expect(groups).not.toContainText("None");
  await expect(peopleRow(page, "Rosa Reyes")).toContainText("Not needed");
  expect(
    reads.some((url) => url.searchParams.get("member_id") === ids.ben),
  ).toBe(true);
  expect(reads.every((url) => url.searchParams.get("offset") === "0")).toBe(
    true,
  );
  expect(
    reads.every((url) => Number(url.searchParams.get("limit")) <= 25),
  ).toBe(true);
});

test("People memberships disclose a partial page and continue only after the person requests more", async ({
  page,
}) => {
  const { reads } = await membershipsFixture(page, 27);
  await page.goto("/access?view=people");
  await expect(await column(peopleRow(page), "Groups")).toContainText(
    "Z membership 00+26 more groups",
  );
  const groups = await openGroups(page);
  await expect(groups).toContainText("Z membership 24");
  await expect(groups).not.toContainText("Z membership 25");
  await expect(groups).toContainText("25 of 27 groups");
  expect(
    reads.filter(
      (url) =>
        url.searchParams.get("member_id") === ids.ben &&
        Number(url.searchParams.get("offset")) > 0,
    ),
  ).toHaveLength(0);
  await groups
    .getByRole("button", { name: "Load more groups", exact: true })
    .click();
  await expect(groups).toContainText("Z membership 26");
  await expect(
    groups.getByRole("button", { name: "Load more groups" }),
  ).toHaveCount(0);
  expect(
    reads
      .filter((url) => url.searchParams.get("member_id") === ids.ben)
      .map((url) => url.searchParams.get("offset")),
  ).toEqual(["0", "25"]);
});

test("People membership continuation failure retains the partial disclosure and retries the requested page", async ({
  page,
}) => {
  const { api } = await membershipsFixture(page, 27);
  let unavailable = true;
  api.on("GET", "/api/access/groups", (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (
      query.get("member_id") === ids.ben &&
      query.get("offset") === "25" &&
      unavailable
    )
      return route.fulfill({ status: 503, json: { detail: "Unavailable" } });
    return "next";
  });
  await page.goto("/access?view=people");
  const groups = await openGroups(page);
  await expect(groups).toContainText("25 of 27 groups");
  await groups
    .getByRole("button", { name: "Load more groups", exact: true })
    .click();
  await expect(groups.getByRole("alert")).toBeVisible();
  await expect(groups).toContainText("Z membership 00");
  await expect(groups).toContainText("25 of 27 groups");
  unavailable = false;
  await groups
    .getByRole("button", { name: "Load more groups", exact: true })
    .click();
  await expect(groups).toContainText("Z membership 26");
  await expect(groups.getByRole("alert")).toHaveCount(0);
});

test("People membership refusal survives a cached directory remount until a fresh Retry", async ({
  page,
}) => {
  const { api, reads } = await membershipsFixture(page, 27);
  let denied = false;
  api.on("GET", "/api/access/groups", (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("member_id") === ids.ben && denied)
      return route.fulfill({ status: 403, json: { detail: "Forbidden" } });
    return "next";
  });
  await page.goto("/access?view=people");
  let groups = await openGroups(page);
  await expect(groups).toContainText("Z membership 00");
  denied = true;
  await groups
    .getByRole("button", { name: "Load more groups", exact: true })
    .click();
  await expect(groups.getByRole("alert")).toBeVisible();
  await expect(groups).not.toContainText("Z membership 00");
  await expect(groups).not.toContainText("Not in any group yet");
  denied = false;
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Groups", exact: true }).click();
  await page.getByRole("link", { name: "People", exact: true }).click();
  groups = await openGroups(page);
  await expect(groups.getByRole("alert")).toBeVisible();
  await expect(groups).not.toContainText("Z membership 00");
  const freshReads = reads.filter(
    (url) => url.searchParams.get("member_id") === ids.ben,
  ).length;
  await groups
    .getByRole("button", { name: "Retry groups", exact: true })
    .click();
  await expect(groups).toContainText("Z membership 00");
  expect(
    reads.filter((url) => url.searchParams.get("member_id") === ids.ben).length,
  ).toBeGreaterThan(freshReads);
  await expect(groups).toContainText("25 of 27 groups");
});

test("People membership cache is replaced when the verified account changes", async ({
  page,
}) => {
  const { api } = await membershipsFixture(page, 2);
  let signedInId = ids.rosa;
  api.on("GET", "/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user_id: signedInId,
        setup_required: false,
        default_organization_blocked: null,
      },
    }),
  );
  api.on("GET", "/api/auth/me", (route) =>
    route.fulfill({
      json: authMeBody({
        id: signedInId,
        role: "admin",
        access: [],
        default_organization_blocked: null,
      }),
    }),
  );
  await page.goto("/access?view=people");
  const groups = await column(peopleRow(page), "Groups");
  await expect(groups).toContainText("Z membership 00");
  for (const [id, item] of api.groups)
    if (item.member_ids.includes(ids.ben))
      api.groups.set(id, {
        ...item,
        name: item.name.replace("Z membership", "New account group"),
      });
  signedInId = ids.dee;
  await recheckSession(page);
  await expect(groups).toContainText("New account group 00");
  await expect(groups).not.toContainText("Z membership");
});

test("People department reach is explicitly partial until the shared membership continuation completes", async ({
  page,
}) => {
  const { api } = await membershipsFixture(page, 27);
  const lastGroup = membershipId(226);
  api.groups.set(
    lastGroup,
    group(
      lastGroup,
      "Z membership 26",
      [ids.ben],
      [
        {
          department_id: membershipId(400),
          department_name: "Beyond-catalog department",
          module_id: null,
          level: "read",
        },
      ],
    ),
  );
  await page.goto("/access?view=people");
  const departments = await column(peopleRow(page), "Departments");
  await expect(await column(peopleRow(page), "Groups")).toContainText(
    "+26 more groups",
  );
  await expect(departments).toContainText("Departments not fully loaded");
  await expect(departments).not.toContainText("None");
  const groups = await openGroups(page);
  const reach = page
    .getByRole("dialog", { name: "Ben Cruz", exact: true })
    .getByRole("region", { name: "Recorded activity", exact: true })
    .getByRole("definition")
    .first();
  await expect(groups).toContainText("25 of 27 groups");
  await expect(reach).toContainText("Departments not fully loaded");
  await groups
    .getByRole("button", { name: "Load more groups", exact: true })
    .click();
  await expect(reach).toHaveText("Beyond-catalog department");
  await expect(groups).toContainText("Z membership 26");
  expect(api.sent("GET", `/api/departments/${membershipId(400)}`)).toHaveLength(
    0,
  );
});

// Membership reads skip only administrators (use-people-memberships.ts), so
// pending, disabled and expired people take the same branch; disabled stands
// for them. A deleted person changes the directory query (status=deleted).
for (const state of ["disabled", "deleted"] as const)
  test(`People preserve assigned department reach for ${state} people`, async ({
    page,
  }) => {
    const { api } = await membershipsFixture(page, 1);
    const ben = api.users.get(ids.ben)!;
    api.users.set(ids.ben, {
      ...ben,
      status: state === "disabled" ? state : "active",
      expires_at: null,
      is_deleted: state === "deleted",
      deleted_at: state === "deleted" ? created : null,
    });
    const assigned = membershipId(200);
    api.groups.set(
      assigned,
      group(
        assigned,
        "Z membership 00",
        [ids.ben],
        [
          {
            department_id: membershipId(401),
            department_name: "Assigned department",
            module_id: null,
            level: "read",
          },
        ],
      ),
    );
    await page.goto(
      `/access?view=people&status=${state === "deleted" ? "deleted" : "all"}`,
    );
    const departments = await column(peopleRow(page), "Departments");
    await expect(departments).toContainText("Assigned department");
    expect(api.sent("GET", `/api/users/${ids.ben}/access`)).toHaveLength(0);
  });

test("the offpage selected person shares membership continuation with their directory row", async ({
  page,
}) => {
  const { api, reads } = await membershipsFixture(page, 27);
  for (let index = 0; index < 30; index += 1) {
    const id = membershipId(500 + index);
    api.users.set(
      id,
      person({
        id,
        username: `a-first-${index}`,
        display_name: `A first ${index}`,
      }),
    );
  }
  await page.goto(`/access?view=people&user=${ids.ben}`);
  const sheet = page.getByRole("dialog", { name: "Ben Cruz", exact: true });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("25 of 27 groups");
  await expect(sheet).not.toContainText("Not in any group yet");
  await sheet
    .getByRole("button", { name: "Load more groups", exact: true })
    .click();
  await expect(
    sheet.getByRole("link", { name: "Z membership 26", exact: true }),
  ).toBeVisible();
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "Search people", exact: true })
    .fill("Ben Cruz");
  const groups = await column(peopleRow(page), "Groups");
  await expect(groups).toContainText("Z membership 00+26 more groups");
  expect(
    reads
      .filter((url) => url.searchParams.get("member_id") === ids.ben)
      .map((url) => url.searchParams.get("offset")),
  ).toEqual(["0", "25"]);
});

for (const target of ["complete panel", "partial directory"] as const)
  test(`retained ${target} memberships recover a failed first-page refresh`, async ({
    page,
  }) => {
    const count = target === "complete panel" ? 2 : 27;
    const { api, reads } = await membershipsFixture(page, count);
    let failing = false;
    api.on("GET", "/api/access/groups", (route) => {
      const query = new URL(route.request().url()).searchParams;
      if (
        failing &&
        query.get("member_id") === ids.ben &&
        query.get("offset") === "0"
      )
        return route.fulfill({ status: 503, json: { detail: "Unavailable" } });
      return "next";
    });
    await page.goto(`/access?view=people&user=${ids.ben}`);
    const sheet = page.getByRole("dialog", { name: "Ben Cruz", exact: true });
    await expect(
      sheet.getByRole("link", { name: "Z membership 00", exact: true }),
    ).toBeVisible();
    if (target === "complete panel")
      await sheet
        .getByLabel("Job title", { exact: true })
        .fill("Unsubmitted draft title");
    failing = true;
    await disableBen(page);
    await expect(
      sheet
        .getByRole("alert")
        .filter({ hasText: "Groups could not be loaded" }),
    ).toBeVisible();
    let region: Locator = sheet;
    if (target === "partial directory") {
      await sheet.getByRole("button", { name: "Close", exact: true }).click();
      region = await column(peopleRow(page), "Groups");
      await expect(region).toContainText("+26 more groups");
    }
    await expect(region).toContainText("Z membership 00");
    await expect(
      region.getByRole("button", { name: "Retry groups", exact: true }),
    ).toBeVisible();
    const beforeRetry = reads.filter(
      (url) => url.searchParams.get("member_id") === ids.ben,
    ).length;
    failing = false;
    await region
      .getByRole("button", { name: "Retry groups", exact: true })
      .click();
    await expect(region.getByRole("alert")).toHaveCount(0);
    await expect(region).toContainText("Z membership 00");
    expect(
      reads
        .filter((url) => url.searchParams.get("member_id") === ids.ben)
        .slice(beforeRetry)
        .map((url) => url.searchParams.get("offset")),
    ).toEqual(["0"]);
    expect(api.sent("PATCH", `/api/users/${ids.ben}`)).toHaveLength(1);
    expect(api.sent("PATCH", `/api/users/${ids.ben}`)[0]?.body).toEqual({
      status: "disabled",
    });
    if (target === "complete panel")
      await expect(sheet.getByLabel("Job title", { exact: true })).toHaveValue(
        "Unsubmitted draft title",
      );
    else await expect(region).toContainText("+26 more groups");
  });

test("membership loading cancels a held continuation when its person leaves the directory", async ({
  page,
}) => {
  const { api } = await membershipsFixture(page, 27);
  const held = readGate();
  api.on("GET", "/api/access/groups", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.searchParams.get("member_id") !== ids.ben ||
      url.searchParams.get("offset") !== "25"
    )
      return "next";
    const snapshot = listPage(
      [...api.groups.values()].filter((item) =>
        item.member_ids.includes(ids.ben),
      ),
      url,
    );
    held.enter();
    await held.released;
    try {
      await route.fulfill({ json: snapshot });
    } finally {
      held.complete();
    }
  });
  await page.goto("/access?view=people");
  let groups = await openGroups(page);
  await expect(groups).toContainText("25 of 27 groups");
  await groups
    .getByRole("button", { name: "Load more groups", exact: true })
    .click();
  await held.entered;
  // Closing the sheet keeps the continuation; leaving the directory ends it.
  await page.keyboard.press("Escape");
  try {
    const failed = page.waitForEvent("requestfailed", {
      predicate: (request) => {
        const url = new URL(request.url());
        return (
          url.pathname === "/api/access/groups" &&
          url.searchParams.get("member_id") === ids.ben &&
          url.searchParams.get("offset") === "25"
        );
      },
    });
    await page
      .getByRole("searchbox", { name: "Search people", exact: true })
      .fill("cy");
    await expect(peopleRow(page, "cy")).toBeVisible();
    await expect(peopleRow(page)).toHaveCount(0);
    await failed;
  } finally {
    held.release();
    await held.completed;
  }
  await page
    .getByRole("searchbox", { name: "Search people", exact: true })
    .fill("Ben Cruz");
  groups = await openGroups(page);
  await expect(groups).toContainText("25 of 27 groups");
  await expect(groups).not.toContainText("Z membership 26");
  await expect(
    groups.getByRole("button", { name: "Load more groups", exact: true }),
  ).toBeEnabled();
});

test("membership loading discards a held extension after an accepted action replaces the first read", async ({
  page,
}) => {
  const { api } = await membershipsFixture(page, 27);
  const held = readGate();
  let holdOnce = true;
  api.on("GET", "/api/access/groups", async (route) => {
    const url = new URL(route.request().url());
    if (
      !holdOnce ||
      url.searchParams.get("member_id") !== ids.ben ||
      url.searchParams.get("offset") !== "25"
    )
      return "next";
    holdOnce = false;
    const snapshot = listPage(
      [...api.groups.values()].filter((item) =>
        item.member_ids.includes(ids.ben),
      ),
      url,
    );
    held.enter();
    await held.released;
    try {
      await route.fulfill({ json: snapshot });
    } finally {
      held.complete();
    }
  });
  await page.goto(`/access?view=people&user=${ids.ben}`);
  const sheet = page.getByRole("dialog", { name: "Ben Cruz", exact: true });
  await expect(sheet).toContainText("25 of 27 groups");
  await sheet
    .getByRole("button", { name: "Load more groups", exact: true })
    .click();
  await held.entered;
  try {
    for (const [id, item] of api.groups)
      if (item.member_ids.includes(ids.ben)) api.groups.delete(id);
    for (let index = 0; index < 27; index += 1) {
      const id = membershipId(700 + index);
      api.groups.set(
        id,
        group(
          id,
          `Fresh membership ${String(index).padStart(2, "0")}`,
          [ids.ben],
          [],
        ),
      );
    }
    await disableBen(page);
    await expect(
      sheet.getByRole("link", { name: "Fresh membership 00", exact: true }),
    ).toBeVisible();
  } finally {
    held.release();
    await held.completed;
  }
  await expect(
    sheet.getByRole("button", { name: "Load more groups", exact: true }),
  ).toBeEnabled();
  await expect(sheet).toContainText("25 of 27 groups");
  await expect(
    sheet.getByRole("link", { name: "Z membership 26", exact: true }),
  ).toHaveCount(0);
  await sheet
    .getByRole("button", { name: "Load more groups", exact: true })
    .click();
  await expect(
    sheet.getByRole("link", { name: "Fresh membership 26", exact: true }),
  ).toBeVisible();
});

test("an older membership Retry cannot clear a newer continuation refusal", async ({
  page,
}) => {
  const { api } = await membershipsFixture(page, 27);
  const held = readGate();
  let firstBen = true;
  let holdBen = true;
  let refuseCyMore = true;
  api.on("GET", "/api/access/groups", async (route) => {
    const url = new URL(route.request().url());
    const query = url.searchParams;
    if (query.get("member_id") === ids.ben && query.get("offset") === "0") {
      if (firstBen) {
        firstBen = false;
        return route.fulfill({ status: 503, json: { detail: "Unavailable" } });
      }
      if (holdBen) {
        holdBen = false;
        const snapshot = listPage(
          [...api.groups.values()].filter((item) =>
            item.member_ids.includes(ids.ben),
          ),
          url,
        );
        held.enter();
        await held.released;
        try {
          await route.fulfill({ json: snapshot });
        } finally {
          held.complete();
        }
        return;
      }
    }
    if (
      refuseCyMore &&
      query.get("member_id") === ids.cy &&
      query.get("offset") === "25"
    )
      return route.fulfill({ status: 403, json: { detail: "Forbidden" } });
    return "next";
  });
  await page.goto("/access?view=people");
  const benGroups = await column(peopleRow(page), "Groups");
  const cyGroups = await column(peopleRow(page, "cy"), "Groups");
  await expect(
    benGroups.getByRole("button", { name: "Retry groups", exact: true }),
  ).toBeVisible();
  await expect(cyGroups).toContainText("A unrelated 0+109 more groups");
  const cyRefresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/access/groups" &&
      url.searchParams.get("member_id") === ids.cy &&
      url.searchParams.get("offset") === "0"
    );
  });
  await benGroups
    .getByRole("button", { name: "Retry groups", exact: true })
    .click();
  await held.entered;
  try {
    await (await cyRefresh).finished();
    const cySheetGroups = await openGroups(page, "cy");
    await cySheetGroups
      .getByRole("button", { name: "Load more groups", exact: true })
      .click();
    await expect(cySheetGroups.getByRole("alert")).toContainText(
      "Groups are unavailable",
    );
    await expect(cySheetGroups).not.toContainText("A unrelated 0");
    await page.keyboard.press("Escape");
    await expect(cySheetGroups).toBeHidden();
  } finally {
    held.release();
    await held.completed;
  }
  await expect(
    benGroups.getByRole("button", { name: "Retry groups", exact: true }),
  ).toBeEnabled();
  await expect(benGroups.getByRole("alert")).toContainText(
    "Groups are unavailable",
  );
  await expect(benGroups).not.toContainText("Z membership 00");
  await expect(cyGroups).not.toContainText("A unrelated 0");
  refuseCyMore = false;
  await benGroups
    .getByRole("button", { name: "Retry groups", exact: true })
    .click();
  await expect(benGroups).toContainText("Z membership 00");
  await expect(cyGroups).toContainText("A unrelated 0");
});

for (const mode of ["light", "dark"] as const) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`membership matrix: partial row at ${viewport.width} px in ${mode}`, async ({
      page,
    }) => {
      const { api } = await membershipsFixture(page, 27);
      const lastGroup = membershipId(226);
      api.groups.set(
        lastGroup,
        group(
          lastGroup,
          "Z membership 26",
          [ids.ben],
          [
            {
              department_id: membershipId(400),
              department_name: "Beyond-catalog department",
              module_id: null,
              level: "read",
            },
          ],
        ),
      );
      await page.goto("/access?view=people");
      const groups = await column(peopleRow(page), "Groups");
      const departments = await column(peopleRow(page), "Departments");
      await expect(groups).toContainText("+26 more groups");
      await expect(departments).toContainText("Departments not fully loaded");
      await expect(departments).not.toContainText("None");
      await page.evaluate(applyAppearancePreferences, {
        mode,
        reduceMotion: true,
      });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.setViewportSize(viewport);
      // The row keeps one line; the sheet discloses the partial page.
      const sheetGroups = await openGroups(page);
      const sheet = page.getByRole("dialog", { name: "Ben Cruz", exact: true });
      const more = sheetGroups.getByRole("button", {
        name: "Load more groups",
        exact: true,
      });
      await more.scrollIntoViewIfNeeded();
      await expect(more).toBeVisible();
      await expect(sheetGroups).toContainText("25 of 27 groups");
      await expect(
        sheet.getByRole("region", { name: "Recorded activity", exact: true }),
      ).toContainText("Departments not fully loaded");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    });

    test(`membership matrix: completed offpage sheet at ${viewport.width} px in ${mode}`, async ({
      page,
    }) => {
      const { api } = await membershipsFixture(page, 27);
      for (let index = 0; index < 30; index += 1) {
        const id = membershipId(500 + index);
        api.users.set(
          id,
          person({
            id,
            username: `a-first-${index}`,
            display_name: `A first ${index}`,
          }),
        );
      }
      await page.goto(`/access?view=people&user=${ids.ben}`);
      const sheet = page.getByRole("dialog", { name: "Ben Cruz", exact: true });
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText("25 of 27 groups");
      await expect(sheet).not.toContainText("Not in any group yet");
      await sheet
        .getByRole("button", { name: "Load more groups", exact: true })
        .click();
      await expect(
        sheet.getByRole("link", { name: "Z membership 26", exact: true }),
      ).toBeVisible();
      await page.evaluate(applyAppearancePreferences, {
        mode,
        reduceMotion: true,
      });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.setViewportSize(viewport);
      const lastGroup = sheet.getByRole("link", {
        name: "Z membership 26",
        exact: true,
      });
      await lastGroup.scrollIntoViewIfNeeded();
      await expect(lastGroup).toBeInViewport();
      await expect(
        sheet.getByRole("button", { name: "Load more groups", exact: true }),
      ).toHaveCount(0);
      expect(
        await sheet.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    });
  }
}
