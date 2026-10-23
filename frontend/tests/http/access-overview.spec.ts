import {
  expect,
  expectNoHorizontalScroll,
  expectNoPageScroll,
  heldResponse,
  test,
  type Locator,
  type Page,
} from "./helpers/test";

import {
  adminSession,
  at,
  created,
  DAY,
  fixtureId,
  group,
  ids,
  listPage,
  MINUTE,
  mockAccessApi,
  person,
  signInEvent,
  type Api,
} from "./helpers/access-api";

// The Overview dashboard against the mocked Access API (see
// helpers/access-api.ts). People: Rosa (the viewer) and Dee
// (administrators), Ana (guest ending in 5 days, in a group), Ben (member,
// in groups), Cy (pending, in no group) and Eli (deleted).

const empty = "00000000-0000-4000-8000-0000000000a3";

function block(page: Page, title: string) {
  return page.getByRole("region", { name: title, exact: true });
}
function attention(page: Page) {
  return block(page, "Needs attention");
}
/** A panel foot's parts sit on one line (the department count is short). */
async function expectFootOnOneLine(panel: Locator) {
  const foot = panel.locator("> div").last();
  expect(
    await foot.evaluate(
      (node) =>
        new Set(
          [...node.children].map((child) =>
            Math.round(child.getBoundingClientRect().top),
          ),
        ).size,
    ),
  ).toBe(1);
}
function activeFilters(page: Page) {
  return page.getByRole("group", { name: "Active filters", exact: true });
}

/** Active people by last sign-in: one in each window, one never. */
function seedActivity(api: Api) {
  const fay = fixtureId(310);
  api.users.set(
    fay,
    person({ id: fay, username: "fay", display_name: "Fay Ong" }),
  );
  const seen = (ago: number) => ({
    active_session_count: 0,
    mfa_verified_totp: true,
    mfa_observed_at: at(-ago),
    last_sign_in_at: at(-ago),
    last_active_at: at(-ago),
  });
  api.monitoring.set(ids.rosa, seen(DAY / 24));
  api.monitoring.set(ids.ben, seen(3 * DAY));
  api.monitoring.set(fay, seen(10 * DAY));
  api.monitoring.set(ids.dee, seen(40 * DAY));
  // Ana is active and never signed in; Cy is invited.
  api.adminSessions = [adminSession(0, ids.rosa, "Rosa Reyes")];
}

test("Who's here counts people by last sign-in and its legend opens the matching lists", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  seedActivity(api);
  // A disabled person is not in the bar, and the total says so.
  const gus = fixtureId(311);
  api.users.set(
    gus,
    person({
      id: gus,
      username: "gus",
      display_name: "Gus Lee",
      status: "disabled",
    }),
  );
  await page.goto("/access?view=overview");
  const who = block(page, "Who's here");

  await expect(who).toContainText(
    "1 signed in now · 1 in the last day · 2 in the last 7 days, of 6 people",
  );
  await expect(who).toContainText("of 6 people · 1 disabled not counted");
  await expect(
    who.getByRole("img", {
      name: "6 people by last sign-in: Now 1, Under a day 0, 1–7 days 1, 7–30 days 1, Older 1, Never signed in 1, Invited 1",
      exact: true,
    }),
  ).toBeVisible();
  // The people signed in now, the viewer as "You".
  const roster = who.getByRole("list", { name: "Signed in now", exact: true });
  await expect(roster.getByRole("link")).toHaveCount(1);
  await expect(
    roster.getByRole("link", { name: "You", exact: true }),
  ).toHaveAttribute("href", `/access?view=people&user=${ids.rosa}`);
  // "As of" shows once, beside Who's here.
  await expect(page.getByText(/^As of /)).toHaveCount(1);
  await expect(who.getByText(/^As of /)).toBeVisible();
  const legend = who.getByRole("list", { name: "Last sign-in", exact: true });
  await expect(legend.getByRole("listitem")).toHaveText([
    "Now 1",
    "Under a day 0",
    "1–7 days 1",
    "7–30 days 1",
    "Older 1",
    "Never signed in 1",
    "Invited 1",
  ]);
  // No People filter matches an activity window, so those stay text.
  await expect(legend.getByRole("link")).toHaveText([
    "Now 1",
    "Older 1",
    "Never signed in 1",
    "Invited 1",
  ]);

  await legend
    .getByRole("link", { name: "Never signed in 1", exact: true })
    .click();
  await expect(page).toHaveURL(/view=people&history=no-recorded-sign-in/);
  await expect(activeFilters(page)).toContainText(
    "Activity: No recorded sign-in",
  );
  const people = page.getByRole("table", { name: "People", exact: true });
  await expect(people.getByRole("row", { name: /Ana Santos/ })).toBeVisible();

  await page.goBack();
  await legend.getByRole("link", { name: "Older 1", exact: true }).click();
  await expect(page).toHaveURL(/history=inactive&inactive_days=30/);
  await expect(activeFilters(page)).toContainText("Activity: Inactive 30 days");
  await expect(people.getByRole("row", { name: /Dee Lim/ })).toBeVisible();

  await page.goBack();
  await legend.getByRole("link", { name: "Invited 1", exact: true }).click();
  await expect(page).toHaveURL(/view=people&status=pending/);
  await expect(people.getByRole("row")).toHaveCount(2);

  await page.goBack();
  await legend.getByRole("link", { name: "Now 1", exact: true }).click();
  await expect(page).toHaveURL(/view=security/);
});

test("on a phone the more-signed-in link is a full target in the avatar row", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await mockAccessApi(page);
  api.adminSessions = [
    adminSession(0, ids.rosa, "Rosa Reyes"),
    adminSession(1, ids.ben, "Ben Cruz"),
    adminSession(2, ids.ana, "Ana Santos"),
    adminSession(3, ids.dee, "Dee Lim"),
  ];
  await page.goto("/access?view=overview");
  const roster = block(page, "Who's here").getByRole("list", {
    name: "Signed in now",
    exact: true,
  });
  const more = roster.getByRole("link", {
    name: "2 more signed in: open Security",
    exact: true,
  });
  const box = await more.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
  // It sits on the avatars' line.
  const chip = await roster.getByRole("link").first().boundingBox();
  expect(
    Math.abs(
      (box?.y ?? 0) +
        (box?.height ?? 0) / 2 -
        ((chip?.y ?? 0) + (chip?.height ?? 0) / 2),
    ),
  ).toBeLessThan(1);
  await expectNoHorizontalScroll(page);
});

test("a cold Overview makes one read per block count and a revisit reads nothing", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  const accessReads = () =>
    api.calls.filter(
      (call) =>
        call.method === "GET" &&
        /^\/api\/(users|access|departments|auth\/admin-sessions|security-events)(\/|$)/.test(
          call.path,
        ) &&
        // The shell reads the viewer's preferences; they are not Access reads.
        !call.path.endsWith("/preferences"),
    );
  await page.goto("/access?view=overview");
  await expect(
    block(page, "Access by department").getByRole("link", {
      name: /^Inventory/,
    }),
  ).toBeVisible();
  await expect(
    block(page, "Recent sign-ins").getByRole("listitem"),
  ).toHaveCount(4);
  await expect(attention(page).getByRole("listitem").first()).toBeVisible();
  await expect(block(page, "Who's here")).toContainText("signed in now");
  // Summaries for 1, 7 and 30 days; six one-row user counts; groups twice
  // counted and once listed; the department catalog; one bounded guest
  // read (the Read cap); sessions; two event reads; and one lookup of the
  // people the feed and the roster name.
  await expect.poll(() => accessReads().length).toBe(18);
  expect(
    accessReads().filter((call) =>
      /^\/api\/users\/[0-9a-f-]{36}/.test(call.path),
    ),
  ).toEqual([]);

  const settled = accessReads().length;
  const sidebar = page.getByRole("navigation", { name: "Main navigation" });
  await sidebar.getByRole("link", { name: "People", exact: true }).click();
  await expect(page.getByRole("table", { name: "People" })).toBeVisible();
  const afterPeople = accessReads().length;
  await sidebar.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(
    block(page, "Access by department").getByRole("link", {
      name: /^Inventory/,
    }),
  ).toBeVisible();
  expect(accessReads().length).toBe(afterPeople);
  expect(afterPeople).toBeGreaterThan(settled);
});

test("Recent sign-ins show sign-in results newest first and link to all security events", async ({
  page,
}) => {
  await mockAccessApi(page);
  await page.goto("/access?view=overview");
  const feed = block(page, "Recent sign-ins");
  // A failed sign-in names no person; its address does. The enrolment
  // event is not a sign-in and stays out.
  await expect(feed.getByRole("listitem")).toHaveText([
    /You.*198\.51\.100\.7.*Signed in$/,
    /Unknown account.*203\.0\.113\.9.*Failed$/,
    /Ben Cruz.*198\.51\.100\.7.*Signed in$/,
    /Ana Santos.*Address not recorded.*Locked$/,
  ]);
  await expect(
    feed.getByRole("link", { name: "All security events", exact: true }),
  ).toHaveAttribute("href", "/manage?view=audit&audit=security-events");
});

test("an older sign-in shows its day above its time and keeps the row height", async ({
  page,
}) => {
  // Friday 23 October 2026, 18:00 UTC, the zone these pages show.
  await page.clock.setFixedTime(new Date("2026-10-23T18:00:00Z"));
  const api = await mockAccessApi(page);
  api.securityEvents = [
    ["2026-10-23T17:00:00Z", "198.51.100.1"],
    ["2026-10-22T16:12:00Z", "198.51.100.2"],
    ["2026-10-20T16:12:00Z", "198.51.100.3"],
    ["2026-10-12T16:12:00Z", "198.51.100.4"],
  ].map(([occurred_at, ip_address], index) =>
    signInEvent(200 + index, 0, { occurred_at, metadata: { ip_address } }),
  );
  for (const [width, height, rowHeight] of [
    [1280, 720, 40],
    [390, 844, 52],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/access?view=overview");
    const rows = block(page, "Recent sign-ins")
      .getByRole("list", { name: "Sign-ins", exact: true })
      .getByRole("listitem");
    await expect(rows).toHaveCount(4);
    // Today shows its time alone; older rows read day, then time.
    await expect(rows.nth(0).locator("time")).toHaveText(/^5:00\sPM$/);
    await expect(rows.nth(1).locator("time")).toHaveText(
      /^Yesterday 4:12\sPM$/,
    );
    await expect(rows.nth(2).locator("time")).toHaveText(/^Tue 4:12\sPM$/);
    await expect(rows.nth(3).locator("time")).toHaveText(/^Oct 12 4:12\sPM$/);
    // The two lines fit the row: every row keeps the one-line height.
    for (const row of await rows.all())
      expect(Math.round((await row.boundingBox())?.height ?? 0)).toBe(
        rowHeight,
      );
  }
});

test("Recent sign-ins show the rows that fit and page by time through every sign-in once", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await mockAccessApi(page);
  // 40 sign-ins a minute apart, each from its own address; every fifth is a
  // lockout, so lockouts sit between sign-ins; one is Ben's.
  api.securityEvents = Array.from({ length: 40 }, (_, index) =>
    signInEvent(100 + index, -(index + 1) * MINUTE, {
      metadata: { ip_address: `198.51.100.${index + 1}` },
      ...(index % 5 === 4
        ? { event_type: "identity.lockout", outcome: "denied" as const }
        : {}),
      ...(index === 20 ? { actor_id: ids.ben, subject_id: ids.ben } : {}),
    }),
  );
  const addresses = api.securityEvents.map(
    (event) => event.metadata.ip_address,
  );
  const eventReads = () =>
    api.calls.filter(
      (call) => call.method === "GET" && call.path === "/api/security-events",
    ).length;
  await page.goto("/access?view=overview");
  const feed = block(page, "Recent sign-ins");
  const rows = feed
    .getByRole("list", { name: "Sign-ins", exact: true })
    .getByRole("listitem");
  const shown = async () => rows.allTextContents();
  const addressOf = (text: string) => text.match(/198\.51\.100\.\d+/)?.[0];
  const older = feed.getByRole("button", {
    name: "Older sign-ins",
    exact: true,
  });
  const newer = feed.getByRole("button", {
    name: "Newer sign-ins",
    exact: true,
  });
  await expect(rows.first()).toContainText(/198\.51\.100\.1(?!\d)/);

  // Exactly the rows that fit: the body does not scroll, and no other row
  // would fit below the last one.
  const fit = await feed.locator("[data-overview-body]").evaluate((body) => {
    const list = body.querySelector("ul");
    return {
      scrolls: body.scrollHeight > body.clientHeight + 1,
      roomLeft: body.clientHeight - (list?.offsetHeight ?? 0),
    };
  });
  expect(fit.scrolls).toBe(false);
  expect(fit.roomLeft).toBeGreaterThanOrEqual(0);
  expect(fit.roomLeft).toBeLessThan(40);

  // The range names the times of the oldest and the newest row shown.
  const times = await rows.locator("time").allTextContents();
  await expect(feed.getByText(`${times.at(-1)} – ${times[0]}`)).toBeVisible();
  await expect(newer).toHaveAttribute("aria-disabled", "true");
  await expect(newer).toHaveAccessibleDescription(
    "These are the newest sign-ins.",
  );

  // Older until the end: each turn reads the two event lists once.
  const pages = [await shown()];
  for (let turn = 0; turn < addresses.length; turn += 1) {
    if ((await older.getAttribute("aria-disabled")) === "true") break;
    const reads = eventReads();
    const previous = pages.at(-1);
    await older.click();
    await expect.poll(shown).not.toEqual(previous);
    // Focus stays on the button, also when it reaches the end.
    await expect(older).toBeFocused();
    pages.push(await shown());
    expect(eventReads() - reads).toBe(2);
  }
  expect(pages.length).toBeGreaterThanOrEqual(3);
  expect(pages.flat().map(addressOf)).toEqual(addresses);
  for (const rowsOfPage of pages.slice(0, -1))
    expect(rowsOfPage).toHaveLength(pages[0].length);
  // Ben's name arrives with his page, never "Former member".
  expect(pages.flat().filter((text) => text.includes("Ben Cruz"))).toEqual([
    expect.stringContaining("198.51.100.21"),
  ]);
  await expect(older).toHaveAccessibleDescription("No older sign-ins.");

  // Newer returns the same pages in reverse, with no new event reads beyond
  // the two lists per turn.
  const back = [pages.at(-1)];
  while ((await newer.getAttribute("aria-disabled")) !== "true") {
    const reads = eventReads();
    const previous = back.at(-1);
    await newer.click();
    await expect.poll(shown).not.toEqual(previous);
    await expect(newer).toBeFocused();
    back.push(await shown());
    expect(eventReads() - reads).toBe(2);
    if (back.length > pages.length) break;
  }
  expect(back.reverse()).toEqual(pages);

  // A taller window fits more rows, with no new read.
  const reads = eventReads();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(() => rows.count()).toBeGreaterThan(pages[0].length);
  expect(eventReads()).toBe(reads);
});

test("Needs attention fades its lower edge while more items wait below and keeps two department rows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const api = await mockAccessApi(page);
  api.groups.set(empty, group(empty, "New hires", [], []));
  api.monitoring.set(ids.rosa, {
    active_session_count: 1,
    mfa_verified_totp: false,
    mfa_observed_at: "2026-10-01T00:00:00Z",
  });
  api.monitoring.set(ids.dee, {
    active_session_count: 0,
    mfa_verified_totp: null,
    mfa_observed_at: null,
  });
  await page.goto("/access?view=overview");
  const panel = attention(page);
  await expect(panel.getByRole("listitem")).toHaveCount(7);
  await expect(
    panel.getByRole("heading", { name: "Needs attention" }),
  ).toBeVisible();
  await expect(panel).toContainText(/Needs attention\s*7/);
  const body = panel.locator("[data-overview-body]");
  const fade = () =>
    body.evaluate((node) => getComputedStyle(node).maskImage !== "none");
  await expect.poll(fade).toBe(true);
  // An edge shadow along the body's bottom shows the cue even over blank
  // space; it is a layer after the body, not part of the faded content.
  const edge = panel.locator("[data-overview-body] + .access-scroll-edge");
  await expect(edge).toHaveCount(1);
  expect(
    await edge.evaluate((node) => getComputedStyle(node).boxShadow),
  ).not.toBe("none");

  const departments = block(page, "Access by department");
  await expect(
    departments.getByRole("heading", { name: "Access by department" }),
  ).toBeInViewport({ ratio: 1 });
  for (const row of [0, 1])
    await expect(departments.getByRole("link").nth(row)).toBeInViewport({
      ratio: 1,
    });
  await expectFootOnOneLine(departments);
  await expectNoPageScroll(page);

  // At the end of the scroll the fade and the edge go, so neither hides the
  // last row.
  await body.evaluate((node) => node.scrollTo({ top: node.scrollHeight }));
  await expect.poll(fade).toBe(false);
  await expect(edge).toHaveCount(0);
  await expect(panel.getByText(/^All clear/)).toBeInViewport({ ratio: 1 });
});

test("from 768 px tall a usual Needs attention stays whole beside two department rows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await mockAccessApi(page);
  await page.goto("/access?view=overview");
  const panel = attention(page);
  await expect(panel.getByRole("listitem")).toHaveCount(4);
  await expect(panel.getByText(/^All clear/)).toBeInViewport({ ratio: 1 });
  await expect(panel.locator(".access-scroll-edge")).toHaveCount(0);
  const departments = block(page, "Access by department");
  for (const row of [0, 1])
    await expect(departments.getByRole("link").nth(row)).toBeInViewport({
      ratio: 1,
    });
  await expectFootOnOneLine(departments);
  await expectNoPageScroll(page);
});

test("Access by department counts the rows shown, fades while more are below, and keeps the catalog order", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await mockAccessApi(page);
  const names = [
    "Inventory",
    "Finance",
    "Sales",
    "Purchasing",
    "Warehouse",
    "Logistics",
    "Quality",
    "Maintenance",
    "Human resources",
    "Payroll",
    "Legal",
    "Marketing",
    "Support",
    "Research",
  ];
  const catalog = names.map((name, index) => ({
    id:
      index === 0
        ? ids.inventory
        : index === 1
          ? ids.finance
          : fixtureId(3000 + index),
    department_name: name,
    created_at: created,
    updated_at: created,
    deleted_at: null,
    is_deleted: false,
    performed_by: ids.rosa,
  }));
  api.on("GET", "/api/departments", (route) =>
    route.fulfill({ json: listPage(catalog, new URL(route.request().url())) }),
  );
  await page.goto("/access?view=overview");
  const departments = block(page, "Access by department");
  const rows = departments.getByRole("link");
  await expect(rows).toHaveCount(14);
  await expect(rows).toHaveText(names.map((name) => new RegExp(`^${name}`)));

  // The count names the rows that fit in full.
  const body = departments.locator("[data-overview-body]");
  const fitting = await body.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return [...node.querySelectorAll("li")].filter(
      (row) => row.getBoundingClientRect().bottom <= box.bottom + 0.5,
    ).length;
  });
  expect(fitting).toBeGreaterThanOrEqual(2);
  expect(fitting).toBeLessThan(14);
  await expect(departments).toContainText(`${fitting} of 14 shown`);
  await expect(
    departments.locator("[data-overview-body] + .access-scroll-edge"),
  ).toHaveCount(1);
  const fade = () =>
    body.evaluate((node) => getComputedStyle(node).maskImage !== "none");
  await expect.poll(fade).toBe(true);

  // A keyboard-focused row is never under the fade.
  await rows.nth(fitting - 1).focus();
  await page.keyboard.press("Tab");
  await expect(rows.nth(fitting)).toBeFocused();
  await expect.poll(fade).toBe(false);
  // The focused row scrolled into the body in full. The grid gives the
  // body a fractional height while scroll offsets are whole pixels, so up
  // to 1px may stay out of reach; that is the tolerance.
  const inBody = (row: number) =>
    body.evaluate((node, index) => {
      const box = node.getBoundingClientRect();
      const link = node.querySelectorAll("a")[index].getBoundingClientRect();
      return link.top >= box.top - 1 && link.bottom <= box.bottom + 1;
    }, row);
  expect(await inBody(fitting)).toBe(true);
  await rows.nth(fitting).blur();

  // At the end the fade goes and the last row shows in full.
  await body.evaluate((node) => node.scrollTo({ top: node.scrollHeight }));
  await expect.poll(fade).toBe(false);
  expect(await inBody(13)).toBe(true);
  await expectNoPageScroll(page);
});

test("an empty or failed sign-in feed says so inside its own panel", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  api.securityEvents = [];
  await page.goto("/access?view=overview");
  await expect(block(page, "Recent sign-ins")).toContainText("No sign-ins yet");

  let unavailable = true;
  api.on("GET", "/api/security-events", async (route) => {
    if (!unavailable) return "next";
    await route.fulfill({
      status: 503,
      json: { detail: "Private failure canary" },
    });
  });
  await page.reload();
  const feed = block(page, "Recent sign-ins");
  await expect(feed.getByRole("alert")).toContainText(
    "Sign-ins could not be loaded.",
  );
  await expect(feed).not.toContainText("Private failure canary");
  // The other blocks keep their content.
  await expect(attention(page).getByRole("listitem").first()).toBeVisible();
  unavailable = false;
  await feed.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(feed).toContainText("No sign-ins yet");
});

test("Needs attention lists only counts above zero, names the rest, and each verb opens the filtered list", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  api.groups.set(empty, group(empty, "New hires", [], []));
  api.monitoring.set(ids.dee, {
    active_session_count: 0,
    mfa_verified_totp: true,
    mfa_observed_at: "2026-10-01T00:00:00Z",
  });
  await page.goto("/access?view=overview");
  const items = attention(page).getByRole("listitem");
  await expect(items).toHaveText([
    /^1 invitation not accepted\s*Review$/,
    /^1 person in no group\s*Add to groups$/,
    /^1 group without access\s*Review$/,
    /^1 group without members\s*Show$/,
    /^1 guest's access ends soon\s*Show$/,
  ]);
  await expect(attention(page)).toContainText(
    "All clear: administrators without two-step.",
  );

  await items
    .getByRole("link", { name: "Add to groups: 1 person in no group" })
    .click();
  await expect(page).toHaveURL(/view=people&group=none/);
  const people = page.getByRole("table", { name: "People" });
  await expect(people.getByRole("row")).toHaveCount(2);
  await expect(people.getByRole("row", { name: /cy/ })).toBeVisible();
  // The link lands as a chip.
  await expect(activeFilters(page)).toContainText("Group: In no group");

  await page.goto("/access?view=overview");
  await items
    .getByRole("link", { name: "Review: 1 group without access" })
    .click();
  await expect(page).toHaveURL(/view=groups&filter=no-access/);
  const groups = page.getByRole("table", { name: "Groups" });
  await expect(groups.getByRole("row")).toHaveCount(2);
  await expect(groups.getByRole("row", { name: /New hires/ })).toBeVisible();
  // Groups use the same chips; removing one clears it from the URL too.
  await expect(activeFilters(page)).toContainText("Show: Without access");
  // The header counts every group; the table footer counts the filter.
  await expect(page.getByText("3 groups", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Showing 1–1 of 1", { exact: true }),
  ).toBeVisible();
  await activeFilters(page)
    .getByRole("button", { name: "Remove Show filter", exact: true })
    .click();
  await expect(page).not.toHaveURL(/filter=/);
  await expect(groups.getByRole("row")).toHaveCount(4);

  await page.goto("/access?view=overview");
  await items
    .getByRole("link", { name: "Show: 1 guest's access ends soon" })
    .click();
  await expect(people.getByRole("row")).toHaveCount(2);
  await expect(people.getByRole("row", { name: /Ana Santos/ })).toBeVisible();
});

test("the last active administrator is flagged first after two-step", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  const dee = api.users.get(ids.dee);
  if (dee) api.users.set(ids.dee, { ...dee, status: "disabled" });
  api.monitoring.set(ids.rosa, {
    active_session_count: 1,
    mfa_verified_totp: false,
    mfa_observed_at: "2026-10-01T00:00:00Z",
  });
  await page.goto("/access?view=overview");
  const items = attention(page).getByRole("listitem");
  await expect(items.nth(0)).toContainText("1 administrator without two-step");
  await expect(items.nth(0)).toHaveAttribute("data-tone", "warn");
  await expect(items.nth(1)).toContainText("1 active administrator");
  await expect(items.nth(1)).toContainText(
    "Make a second person an administrator.",
  );
  await expect(items.nth(1)).toHaveAttribute("data-tone", "warn");
  await items
    .getByRole("link", { name: "Show: 1 active administrator" })
    .click();
  await expect(page).toHaveURL(/role=admin&status=active/);
});

test("two-step attention keeps known absence apart from unknown and links to the same population", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  api.monitoring.set(ids.rosa, {
    active_session_count: 1,
    mfa_verified_totp: false,
    mfa_observed_at: "2026-10-01T00:00:00Z",
  });
  api.monitoring.set(ids.dee, {
    active_session_count: 0,
    mfa_verified_totp: null,
    mfa_observed_at: null,
  });
  await page.goto("/access?view=overview");
  const items = attention(page).getByRole("listitem");
  await items
    .getByRole("link", { name: "Review: 1 administrator without two-step" })
    .click();
  const people = page.getByRole("table", { name: "People", exact: true });
  await expect(people.getByRole("row")).toHaveCount(2);
  await expect(people.getByRole("row", { name: /Rosa Reyes/ })).toBeVisible();
  await expect.poll(() => api.listReads.at(-1)?.get("mfa")).toBe("without");
  await page.goto("/access?view=overview");
  await items
    .getByRole("link", {
      name: "Review: 1 administrator, two-step unknown",
    })
    .click();
  await expect(people.getByRole("row")).toHaveCount(2);
  await expect(people.getByRole("row", { name: /Dee Lim/ })).toBeVisible();
  await expect.poll(() => api.listReads.at(-1)?.get("mfa")).toBe("unknown");
});

test("an unavailable summary never manufactures zero, and Retry recovers each block", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  const gate = heldResponse();
  let unavailable = true;
  api.on("GET", "/api/users/summary", async (route) => {
    await gate.released;
    if (unavailable)
      await route.fulfill({
        status: 503,
        json: { detail: "Private failure canary" },
      });
    else return "next";
  });
  await page.goto("/access?view=overview");
  // The frame comes first: every block's heading, then its own skeleton.
  for (const title of [
    "Who's here",
    "Needs attention",
    "Recent sign-ins",
    "Access by department",
  ])
    await expect(
      page.getByRole("heading", { level: 2, name: title, exact: true }),
    ).toBeVisible();
  await expect(
    page.getByText("Loading who's here…", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/0 signed in now/)).toHaveCount(0);
  gate.release();
  for (const title of ["Who's here", "Needs attention"]) {
    const failed = block(page, title).getByRole("alert");
    await expect(failed).toBeVisible();
    await expect(block(page, title)).not.toContainText(
      "Private failure canary",
    );
    await expect(block(page, title).getByText(/^0\b/)).toHaveCount(0);
  }
  await expect(block(page, "Who's here").getByRole("link")).toHaveCount(0);
  unavailable = false;
  await block(page, "Who's here")
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await expect(block(page, "Who's here")).toContainText("signed in now");
  await expect(attention(page).getByRole("alert")).toHaveCount(0);
  await expect(attention(page).getByRole("listitem").first()).toBeVisible();
});

test("the history windows count the full eligible population and drilldowns filter before page totals", async ({
  page,
}) => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  const api = await mockAccessApi(page, { now });
  api.users.clear();
  api.monitoring.clear();
  api.adminSessions = [];
  const knownAt = new Date(now - 90 * DAY).toISOString();
  api.users.set(
    ids.rosa,
    person({ id: ids.rosa, username: "rosa", role: "admin" }),
  );
  api.monitoring.set(ids.rosa, {
    active_session_count: 1,
    mfa_verified_totp: true,
    mfa_observed_at: knownAt,
    last_sign_in_at: knownAt,
    last_active_at: new Date(now).toISOString(),
  });
  // Twelve eligible null histories exceed one page; they are not inactivity.
  for (let index = 0; index < 12; index += 1) {
    const id = fixtureId(950 + index);
    api.users.set(
      id,
      person({
        id,
        username: `unknown${String(index).padStart(2, "0")}`,
        display_name: `No history ${String(index).padStart(2, "0")}`,
      }),
    );
  }
  for (let index = 0; index < 3; index += 1) {
    const id = fixtureId(980 + index);
    api.users.set(
      id,
      person({
        id,
        username: `known${index}`,
        display_name: `Known inactive ${index}`,
      }),
    );
    api.monitoring.set(id, {
      active_session_count: 0,
      mfa_verified_totp: null,
      mfa_observed_at: null,
      last_sign_in_at: knownAt,
      last_active_at: knownAt,
    });
  }
  for (const [index, fields] of [
    [0, { status: "pending" as const }],
    [1, { status: "disabled" as const }],
    [2, { expires_at: new Date(now - DAY).toISOString() }],
    [3, { is_deleted: true, deleted_at: knownAt }],
  ] as const) {
    const id = fixtureId(990 + index);
    api.users.set(id, person({ id, username: `excluded${index}`, ...fields }));
    api.monitoring.set(id, {
      active_session_count: 0,
      mfa_verified_totp: null,
      mfa_observed_at: null,
      last_sign_in_at: null,
      last_active_at: knownAt,
    });
  }

  await page.goto("/access?view=overview");
  const legend = block(page, "Who's here").getByRole("list", {
    name: "Last sign-in",
    exact: true,
  });
  await expect(
    legend.getByRole("link", { name: "Never signed in 12", exact: true }),
  ).toBeVisible();
  await expect(
    legend.getByRole("link", { name: "Older 3", exact: true }),
  ).toBeVisible();
  const asOf = await page.evaluate(
    (timestamp) =>
      new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(
        timestamp,
      ),
    now,
  );
  await expect(block(page, "Who's here")).toContainText(`As of ${asOf}`);
  await legend
    .getByRole("link", { name: "Never signed in 12", exact: true })
    .click();
  await expect(page).toHaveURL(/history=no-recorded-sign-in/);
  const people = page.getByRole("table", { name: "People", exact: true });
  await expect(people.getByRole("row")).toHaveCount(11);
  await expect(
    page.getByText("Showing 1–10 of 12", { exact: true }),
  ).toBeVisible();
  await expect(people).not.toContainText(/Known inactive|excluded/);
  await page
    .getByRole("navigation", { name: "People pages", exact: true })
    .getByRole("button", { name: "Go to next page", exact: true })
    .click();
  await expect(
    page.getByText("Showing 11–12 of 12", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("searchbox", { name: "Search people", exact: true })
    .fill("No history 11");
  await expect(
    page.getByText("Showing 1–1 of 1", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => Object.fromEntries(api.listReads.at(-1) ?? []))
    .toMatchObject({
      history: "no-recorded-sign-in",
      search: "No history 11",
      offset: "0",
      limit: "10",
    });

  await page.goto("/access?view=overview");
  await legend.getByRole("link", { name: "Older 3", exact: true }).click();
  await expect(page).toHaveURL(/history=inactive/);
  await expect(page).toHaveURL(/inactive_days=30/);
  await expect(
    page.getByText("Showing 1–3 of 3", { exact: true }),
  ).toBeVisible();
  await expect(people).not.toContainText(/No history|excluded|rosa@example/);
  await expect
    .poll(() => Object.fromEntries(api.listReads.at(-1) ?? []))
    .toMatchObject({ history: "inactive", inactive_days: "30", offset: "0" });
});

test("Access by department counts people per department and opens People filtered by it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockAccessApi(page);
  await page.goto("/access?view=overview");
  const departments = block(page, "Access by department");
  // Administrators manage every department and are counted apart.
  await expect(departments).toContainText("2 administrators manage all.");
  await expect(departments.getByRole("link")).toHaveText([
    /^Inventory\s*2/,
    /^Finance\s*1/,
  ]);
  await expect(
    departments.getByRole("link", {
      // Ana is a guest: the group gives Write, she counts at Read.
      name: "Inventory, 2 people with access: 1 Read, 1 Write, 0 Manage",
      exact: true,
    }),
  ).toBeVisible();
  await expect(departments).toContainText(/Read\s*Write\s*Manage/);
  await expect(departments).toContainText("All 2 shown");
  await departments.getByRole("link", { name: /^Finance/ }).click();
  await expect(page).toHaveURL(
    new RegExp(`view=people&department=${ids.finance}`),
  );
  await expect(activeFilters(page)).toContainText("Department: Finance");
  const people = page.getByRole("table", { name: "People" });
  await expect(people.getByRole("row")).toHaveCount(2);
  await expect(people.getByRole("row", { name: /Ben Cruz/ })).toBeVisible();
});

test("Overview counts use bounded filtered totals beyond the first page and say when access counts are partial", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  api.groups.clear();
  for (let index = 0; index < 121; index++) {
    api.groups.set(
      fixtureId(500 + index),
      group(fixtureId(500 + index), `Empty ${index}`, [], []),
    );
    api.users.set(
      fixtureId(2000 + index),
      person({ id: fixtureId(2000 + index), username: `unassigned${index}` }),
    );
  }
  await page.goto("/access?view=overview");
  const items = attention(page).getByRole("listitem");
  await expect(items.filter({ hasText: "groups without access" })).toHaveText(
    /^121 groups without access/,
  );
  await expect(items.filter({ hasText: "groups without members" })).toHaveText(
    /^121 groups without members/,
  );
  await expect(items.filter({ hasText: "in no group" })).toHaveText(
    /^124 people in no group/,
  );
  await expect(block(page, "Access by department")).toContainText(
    "Counts from the first 100 of 121 groups.",
  );
  // Counts are one-row totals; the group list is one bounded page; the
  // only ID lookup names the feed and the roster.
  const users = api.calls.filter(
    (call) => call.method === "GET" && call.path === "/api/users",
  );
  const counts = [...api.countReads];
  expect(counts.length).toBeGreaterThan(0);
  expect(
    counts.every(
      (query) => query.get("limit") === "1" && query.get("offset") === "0",
    ),
  ).toBe(true);
  // Two list reads: the ID lookup and one bounded page of guests.
  expect(users.length - counts.length).toBe(2);
  expect(
    api.listReads.map((query) =>
      query.getAll("ids").length
        ? "ids"
        : `${query.get("role")}:${query.get("limit")}`,
    ),
  ).toEqual(expect.arrayContaining(["ids", "guest:100"]));
  expect(api.listReads).toHaveLength(2);
  const groupLists = api.calls
    .filter(
      (call) => call.method === "GET" && call.path === "/api/access/groups",
    )
    .map((call) => call.path);
  expect(groupLists).toHaveLength(3);
});

test("the Overview is a still page from 1280 px and stacks for a phone", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  seedActivity(api);
  for (const size of [
    { width: 1280, height: 720 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(size);
    await page.goto("/access?view=overview");
    await expect(
      block(page, "Access by department").getByRole("link", {
        name: /^Inventory/,
      }),
    ).toBeVisible();
    await expect(attention(page).getByRole("listitem").first()).toBeVisible();
    await expectNoPageScroll(page);
    // From 768 px tall Needs attention stays whole; below that its body
    // may scroll. The feed and departments always may.
    if (size.height < 768) continue;
    const clipped = await attention(page).evaluate(
      (panel) =>
        [panel, ...panel.querySelectorAll("*")].filter(
          (node) => node.scrollHeight > node.clientHeight + 1,
        ).length,
    );
    expect(clipped).toBe(0);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/access?view=overview");
  await expect(attention(page).getByRole("listitem").first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  const tops: number[] = [];
  // On a phone what needs attention comes before the sign-in feed.
  for (const title of [
    "Who's here",
    "Needs attention",
    "Recent sign-ins",
    "Access by department",
  ]) {
    const box = await block(page, title).boundingBox();
    tops.push(box?.y ?? -1);
  }
  expect([...tops].sort((left, right) => left - right)).toEqual(tops);
});

test("the Overview header has one primary action and no Security shortcut", async ({
  page,
}) => {
  await mockAccessApi(page);
  await page.goto("/access?view=overview");
  await expect(
    page.getByRole("heading", { level: 1, name: "Access overview" }),
  ).toBeVisible();
  const main = page.getByRole("main");
  await expect(
    main.getByRole("link", { name: "Security", exact: true }),
  ).toHaveCount(0);
  await expect(
    main.getByRole("heading", { name: "Invitation settings" }),
  ).toHaveCount(0);
  await expect(
    main.getByRole("button", { name: "Invite person", exact: true }),
  ).toHaveAttribute("data-variant", "default");
  await expect(
    main.getByRole("button", { name: "Create group", exact: true }),
  ).not.toHaveAttribute("data-variant", "default");

  await main
    .getByRole("button", { name: "Invite person", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Invite a person" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await main.getByRole("button", { name: "Create group", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Create a group" }),
  ).toBeVisible();
});

test("invitation settings open from People and save only the changed value with the revision", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  await page.goto("/access?view=people");
  await page
    .getByRole("button", { name: "Invitation settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: "Invitation settings",
    exact: true,
  });
  const expiry = settings.getByLabel("Invitation link works for (days)");
  const guest = settings.getByLabel("Guest access length (days)");
  await expect(expiry).toHaveValue("7");
  await expect(guest).toHaveValue("45");
  const save = settings.getByRole("button", { name: "Save settings" });
  await expect(save).toBeDisabled();
  await expect(save).toHaveAccessibleDescription("No changes to save.");
  // Enter in a field with nothing changed sends nothing.
  await guest.press("Enter");
  await expect(settings).toBeVisible();
  expect(api.sent("PATCH", "/api/workspace")).toHaveLength(0);

  await guest.fill("0");
  await save.click();
  await expect(
    settings.getByText("Enter a whole number from 1 to 365."),
  ).toBeVisible();
  expect(api.sent("PATCH", "/api/workspace")).toHaveLength(0);

  await guest.fill("60");
  await save.click();
  await expect(save).toBeDisabled();
  expect(api.sent("PATCH", "/api/workspace")[0]?.body).toEqual({
    revision: 3,
    guest_duration_days: 60,
  });
  await expect(guest).toHaveValue("60");
});

test("a settings save against a newer revision shows the new values and can be sent again", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
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
  // Another administrator changed the invitation length meanwhile.
  api.workspace = {
    ...api.workspace,
    invitation_expiry_days: 10,
    revision: 4,
  };

  await guest.fill("30");
  await settings.getByRole("button", { name: "Save settings" }).click();
  const notice = settings.getByRole("alert").filter({
    hasText: "Someone else changed these settings",
  });
  await expect(notice).toContainText("invitation links work for 10 days");
  await expect(notice).toHaveAttribute("data-variant", "destructive");
  await expect(guest).toHaveValue("30");

  await settings.getByRole("button", { name: "Save again" }).click();
  await expect(notice).toBeHidden();
  const patches = api.sent("PATCH", "/api/workspace");
  expect(patches.map((call) => call.body)).toEqual([
    { revision: 3, guest_duration_days: 30 },
    { revision: 4, guest_duration_days: 30 },
  ]);
  expect(api.workspace).toMatchObject({
    invitation_expiry_days: 10,
    guest_duration_days: 30,
  });
});
