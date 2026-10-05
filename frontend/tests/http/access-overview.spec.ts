import { expect, test, type Page } from "./helpers/test";

import { group, ids, mockAccessApi } from "./helpers/access-api";

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
