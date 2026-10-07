import { expect, test, type Page } from "./helpers/test";

import { DAY, group, ids, mockAccessApi, person } from "./helpers/access-api";

// The Overview tab against the mocked Access API (see helpers/access-api.ts).
// People: Rosa and Dee (administrators), Ana (guest ending in 5 days, in a
// group), Ben (member, in groups), Cy (pending, in no group) and Eli
// (deleted). Workspace invitation settings: 7 and 45 days, revision 3.

const empty = "00000000-0000-4000-8000-0000000000a3";

function card(page: Page, title: string) {
  return page.getByRole("region", { name: title, exact: true });
}

test("health cards count what needs attention and open the filtered list", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  api.groups.set(empty, group(empty, "New hires", [], []));
  await page.goto("/access?view=overview");

  await expect(card(page, "Administrators")).toContainText("2");
  await expect(card(page, "Administrators")).not.toContainText("Review");
  await expect(card(page, "People without a group")).toContainText("1");
  await expect(card(page, "Groups without access")).toContainText("1");
  await expect(card(page, "Groups without members")).toContainText("1");
  await expect(card(page, "Access ending soon")).toContainText("1");
  await expect(card(page, "Pending invitations")).toContainText("1");

  await card(page, "People without a group")
    .getByRole("link", { name: "Show these people" })
    .click();
  await expect(page).toHaveURL(/view=people&group=none/);
  const people = page.getByRole("table", { name: "People" });
  await expect(people.getByRole("row")).toHaveCount(2);
  await expect(people.getByRole("row", { name: /cy/ })).toBeVisible();

  await page.goto("/access?view=overview");
  await card(page, "Groups without access")
    .getByRole("link", { name: "Show these groups" })
    .click();
  await expect(page).toHaveURL(/view=groups&filter=no-access/);
  const groups = page.getByRole("table", { name: "Groups" });
  await expect(groups.getByRole("row")).toHaveCount(2);
  await expect(groups.getByRole("row", { name: /New hires/ })).toBeVisible();

  await page.goto("/access?view=overview");
  await card(page, "Access ending soon")
    .getByRole("link", { name: "Show these guests" })
    .click();
  await expect(
    page.getByRole("table", { name: "People" }).getByRole("row"),
  ).toHaveCount(2);
  await expect(
    page.getByRole("table", { name: "People" }).getByRole("row", {
      name: /Ana Santos/,
    }),
  ).toBeVisible();
});

test("a single active administrator is flagged", async ({ page }) => {
  const api = await mockAccessApi(page);
  const dee = api.users.get(ids.dee);
  if (dee) api.users.set(ids.dee, { ...dee, status: "disabled" });
  await page.goto("/access?view=overview");
  const admins = card(page, "Administrators");
  await expect(admins).toContainText("1");
  await expect(admins).toContainText("Review");
  await expect(admins).toContainText("Make a second person an administrator");
});

test("invitation settings save only the changed value with the revision", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  await page.goto("/access?view=overview");
  const settings = card(page, "Invitation settings");
  const expiry = settings.getByLabel("Invitation link works for (days)");
  const guest = settings.getByLabel("Guest access length (days)");
  await expect(expiry).toHaveValue("7");
  await expect(guest).toHaveValue("45");
  const save = settings.getByRole("button", { name: "Save settings" });
  await expect(save).toBeDisabled();

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

test("a save against a newer revision shows the new values and can be sent again", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  await page.goto("/access?view=overview");
  const settings = card(page, "Invitation settings");
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

for (const width of [1440, 390])
  test(`the Overview tab fits a ${width}px screen without sideways scrolling`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width > 400 ? 900 : 844 });
    await mockAccessApi(page);
    await page.goto("/access?view=overview");
    await expect(card(page, "Pending invitations")).toContainText("1");
    await expect(
      card(page, "Invitation settings").getByLabel(
        "Guest access length (days)",
      ),
    ).toHaveValue("45");
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

test("13b: organization MFA summary keeps known absence separate from unknown and links to the same population", async ({
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
  const mfa = card(page, "Administrator MFA");
  await expect(
    mfa.getByText("1 without verified MFA", { exact: true }),
  ).toBeVisible();
  await expect(mfa.getByText("1 unknown", { exact: true })).toBeVisible();
  await mfa
    .getByRole("link", {
      name: "Show administrators without verified MFA",
      exact: true,
    })
    .click();
  const people = page.getByRole("table", { name: "People", exact: true });
  await expect(people.getByRole("row")).toHaveCount(2);
  await expect(people.getByRole("row", { name: /Rosa Reyes/ })).toBeVisible();
  await expect.poll(() => api.listReads.at(-1)?.get("mfa")).toBe("without");
  await page.goto("/access?view=overview");
  await card(page, "Administrator MFA")
    .getByRole("link", {
      name: "Show administrators with unknown MFA",
      exact: true,
    })
    .click();
  await expect(people.getByRole("row")).toHaveCount(2);
  await expect(people.getByRole("row", { name: /Dee Lim/ })).toBeVisible();
  await expect.poll(() => api.listReads.at(-1)?.get("mfa")).toBe("unknown");
});

test("13b: unavailable monitoring summary never manufactures zero and explicit Retry recovers", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  // The recovery counters describe this same organization-wide population.
  for (let index = 0; index < 5; index += 1) {
    const id = `00000000-0000-4000-8000-${String(930 + index).padStart(12, "0")}`;
    api.users.set(
      id,
      person({ id, username: `monitor${index}`, role: "admin" }),
    );
    if (index < 4)
      api.monitoring.set(id, {
        active_session_count: 0,
        mfa_verified_totp: false,
        mfa_observed_at: "2026-10-01T00:00:00Z",
      });
  }
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let unavailable = true;
  api.on("GET", "/api/users/summary", async (route) => {
    await gate;
    if (unavailable)
      await route.fulfill({
        status: 503,
        json: { detail: "Private failure canary" },
      });
    else
      await route.fulfill({
        json: {
          admins_without_mfa: 4,
          admins_mfa_unknown: 2,
          no_recorded_sign_in: 9,
          inactive_people: 0,
          as_of: "2026-10-07T00:00:00Z",
          inactive_days: 30,
        },
      });
  });
  await page.goto("/access?view=overview");
  await expect(
    page.getByText("Loading MFA observations…", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/0 without verified MFA|0 unknown/)).toHaveCount(
    0,
  );
  release?.();
  const mfa = card(page, "Administrator MFA");
  await expect(mfa).toContainText("MFA observations could not be loaded.");
  await expect(mfa).not.toContainText("Private failure canary");
  await expect(mfa.getByRole("link")).toHaveCount(0);
  for (const title of ["No recorded sign-in", "Known inactive people"]) {
    await expect(card(page, title).getByRole("alert")).toHaveAttribute(
      "data-variant",
      "destructive",
    );
    await expect(card(page, title).getByText("0", { exact: true })).toHaveCount(
      0,
    );
    await expect(card(page, title).getByRole("link")).toHaveCount(0);
    await expect(card(page, title)).not.toContainText("Private failure canary");
  }
  unavailable = false;
  await mfa
    .getByRole("button", { name: "Retry MFA observations", exact: true })
    .click();
  await expect(
    mfa.getByText("4 without verified MFA", { exact: true }),
  ).toBeVisible();
  await expect(mfa.getByText("2 unknown", { exact: true })).toBeVisible();
  await expect(
    card(page, "No recorded sign-in").getByText("9", { exact: true }),
  ).toBeVisible();
  await expect(
    card(page, "Known inactive people").getByText("0", { exact: true }),
  ).toBeVisible();
});

test("13b: history summary counts the full eligible population and drilldowns filter before page totals", async ({
  page,
}) => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  const api = await mockAccessApi(page, { now });
  api.users.clear();
  api.monitoring.clear();
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
    const id = `00000000-0000-4000-8000-${String(950 + index).padStart(12, "0")}`;
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
    const id = `00000000-0000-4000-8000-${String(980 + index).padStart(12, "0")}`;
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
    const id = `00000000-0000-4000-8000-${String(990 + index).padStart(12, "0")}`;
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
  await expect(
    card(page, "No recorded sign-in").getByText("12", { exact: true }),
  ).toBeVisible();
  await expect(
    card(page, "Known inactive people").getByText("3", { exact: true }),
  ).toBeVisible();
  const asOfDate = await page.evaluate(
    (timestamp) =>
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(timestamp),
    now,
  );
  await expect(
    page.getByText(/as of/i).filter({ hasText: asOfDate }).first(),
  ).toBeVisible();
  await card(page, "No recorded sign-in")
    .getByRole("link", { name: "Show these people", exact: true })
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
  await expect(
    people.getByRole("row", { name: /No history 11/ }),
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
  await card(page, "Known inactive people")
    .getByRole("link", { name: "Show these people", exact: true })
    .click();
  await expect(page).toHaveURL(/history=inactive/);
  await expect(page).toHaveURL(/inactive_days=30/);
  await expect(
    page.getByText("Showing 1–3 of 3", { exact: true }),
  ).toBeVisible();
  await expect(people.getByRole("row")).toHaveCount(4);
  await expect(people).not.toContainText(/No history|excluded|rosa@example/);
  await expect
    .poll(() => Object.fromEntries(api.listReads.at(-1) ?? []))
    .toMatchObject({ history: "inactive", inactive_days: "30", offset: "0" });
});

test("13b: inactivity days validate drafts, reach the API and isolate cached summaries by applied N", async ({
  page,
}) => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  const api = await mockAccessApi(page, { now });
  api.users.clear();
  api.monitoring.clear();
  // Independent expected populations:30→2,60→1,1→3,3650→0; null is separate.
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
  await page.goto("/access?view=overview");
  const inactive = card(page, "Known inactive people");
  const days = inactive.getByLabel("Inactive for (days)", { exact: true });
  const apply = inactive.getByRole("button", {
    name: "Apply inactivity period",
    exact: true,
  });
  await expect(days).toHaveValue("30");
  await expect(inactive.getByText("2", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      api.summaryQueries.some((query) => query.get("inactive_days") === "30"),
    )
    .toBe(true);
  const beforeInvalidDrafts = api.summaryQueries.length;

  for (const value of ["", "0", "3651", "1.5", "-1"]) {
    await days.fill(value);
    await apply.click();
    await expect(days).toHaveAttribute("aria-invalid", "true");
    await expect(
      inactive.getByText(
        /Enter (the number of days|a whole number from 1 to 3650)\./,
      ),
    ).toBeVisible();
    await expect(inactive.getByText("2", { exact: true })).toBeVisible();
    expect(api.summaryQueries).toHaveLength(beforeInvalidDrafts);
  }

  await days.fill("60");
  await apply.click();
  await expect(inactive.getByText("1", { exact: true })).toBeVisible();
  await expect(days).not.toHaveAttribute("aria-invalid", "true");
  await expect(inactive).toContainText("60 days");
  await expect
    .poll(() => api.summaryQueries.at(-1)?.get("inactive_days"))
    .toBe("60");
  await days.fill("30");
  await apply.click();
  await expect(inactive.getByText("2", { exact: true })).toBeVisible();
  await expect(inactive).toContainText("30 days");

  await days.fill("1");
  await days.press("Enter");
  await expect(inactive.getByText("3", { exact: true })).toBeVisible();
  await expect
    .poll(() => api.summaryQueries.at(-1)?.get("inactive_days"))
    .toBe("1");
  await days.fill("3650");
  await apply.click();
  await expect(inactive.getByText("0", { exact: true })).toBeVisible();
  await expect(inactive.getByRole("link")).toHaveCount(0);
  await expect
    .poll(() => api.summaryQueries.at(-1)?.get("inactive_days"))
    .toBe("3650");
});
