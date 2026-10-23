import {
  expect,
  expectNoHorizontalScroll,
  expectNoPageScroll,
  test,
  type Page,
} from "./helpers/test";
import { ids, mockAccessApi } from "./helpers/access-api";

// The Access filters: a quiet Filters button opens a popover of label-left
// fields that apply as they are chosen, the rare statuses sit under the
// status strip's More menu, and active filters show as removable chips that
// stay in the URL.

const peopleTable = (page: Page) =>
  page.getByRole("table", { name: "People", exact: true });
const filtersButton = (page: Page) =>
  page.getByRole("button", { name: "Filters", exact: true });
const filtersDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Filters", exact: true });
const activeFilters = (page: Page) =>
  page.getByRole("group", { name: "Active filters", exact: true });

test("the Filters popover applies a searched group at once, keeps the page still, and closes back to its button", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/access?view=people");
  const table = peopleTable(page);
  await expect(table.locator("tbody tr")).toHaveCount(5);
  const before = await table.boundingBox();

  await filtersButton(page).click();
  const dialog = filtersDialog(page);
  await expect(dialog).toBeVisible();
  // A pointer open leaves focus on the button; Tab enters the first row.
  await expect(filtersButton(page)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByLabel("Role", { exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(filtersButton(page)).toBeFocused();
  await filtersButton(page).click();
  await expect(dialog).toBeVisible();
  // A popover over the table: nothing moves and the page stays still.
  expect((await table.boundingBox())?.y).toBe(before?.y);
  await expectNoPageScroll(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoPageScroll(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  const box = await dialog.boundingBox();
  expect((box?.x ?? -1) >= 0).toBe(true);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(1280);
  // Label-left rows: the label sits beside its field, not above it.
  const roleLabel = await dialog
    .getByText("Role", { exact: true })
    .boundingBox();
  const role = await dialog.getByLabel("Role", { exact: true }).boundingBox();
  expect((role?.x ?? 0) > (roleLabel?.x ?? 0) + (roleLabel?.width ?? 0)).toBe(
    true,
  );
  // Group and Department search inside their own dropdowns.
  await expect(page.getByRole("searchbox", { name: /filters$/ })).toHaveCount(
    0,
  );
  await expect(dialog.getByLabel("Status", { exact: true })).toHaveCount(0);

  await dialog.getByRole("combobox", { name: "Group", exact: true }).click();
  const groupSearch = page.getByRole("combobox", {
    name: "Search group",
    exact: true,
  });
  // The dropdown's own search box takes the slim 32 px size from 1280 px.
  expect(Math.round((await groupSearch.boundingBox())?.height ?? 0)).toBe(32);
  await groupSearch.fill("fin");
  await expect(page.getByRole("option", { name: /Inventory/ })).toHaveCount(0);
  await page.getByRole("option", { name: /Finance readers/ }).click();
  // Choosing in the dropdown applies the filter and keeps the popover open.
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`group=${ids.readers}`));
  await expect
    .poll(() => api.listReads.at(-1)?.get("group_id"))
    .toBe(ids.readers);
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(
    activeFilters(page).getByRole("button", {
      name: "Remove Group filter",
      exact: true,
    }),
  ).toBeVisible();
  await expect(activeFilters(page)).toContainText("Group: Finance readers");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(filtersButton(page)).toBeFocused();
  await expect(filtersButton(page)).toContainText("1");

  await filtersButton(page).click();
  await expect(filtersDialog(page)).toBeVisible();
  await page.getByRole("heading", { name: "People", exact: true }).click();
  await expect(filtersDialog(page)).toHaveCount(0);
  await expect(filtersButton(page)).toBeFocused();
});

test("rare statuses sit under the strip's More menu, which shows the chosen one", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/access?view=people");
  const status = page.getByRole("group", { name: "Status", exact: true });
  const filtersAt = (await filtersButton(page).boundingBox())?.x;
  await status
    .getByRole("button", { name: "More statuses", exact: true })
    .click();
  for (const name of ["Expired", "Deleted", "Everyone"])
    await expect(page.getByRole("menuitemradio", { name })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  await page.getByRole("menuitemradio", { name: "Deleted" }).click();

  await expect(page).toHaveURL(/status=deleted/);
  await expect.poll(() => api.listReads.at(-1)?.get("deleted")).toBe("only");
  await expect(peopleTable(page).locator("tbody tr")).toHaveCount(1);
  await expect(peopleTable(page)).toContainText("Eli Tan");
  // The strip shows the rare status as its selected item; no toggle is on.
  await expect(
    status.getByRole("button", { name: "Status: Deleted", exact: true }),
  ).toBeVisible();
  await expect(status.locator('[aria-pressed="true"]')).toHaveCount(0);
  // Choosing a rare status moves nothing after the strip (within a pixel:
  // the pressed weight leaves All for More).
  expect(
    Math.abs(
      ((await filtersButton(page).boundingBox())?.x ?? 0) - (filtersAt ?? 0),
    ),
  ).toBeLessThan(1);
  await status
    .getByRole("button", { name: "Status: Deleted", exact: true })
    .click();
  await expect(
    page.getByRole("menuitemradio", { name: "Deleted" }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  // Status is never a chip and never counts on the Filters button.
  await expect(activeFilters(page)).toHaveCount(0);
  await expect(filtersButton(page)).not.toContainText(/\d/);

  await status.getByRole("button", { name: /^All/ }).click();
  await expect(page).not.toHaveURL(/status=/);
  await expect(
    status.getByRole("button", { name: "More statuses", exact: true }),
  ).toBeVisible();
});

test("an Overview link lands as chips that each clear their own filter and survive a reload", async ({
  page,
}) => {
  const api = await mockAccessApi(page);
  api.monitoring.set(ids.rosa, {
    active_session_count: 1,
    mfa_verified_totp: false,
    mfa_observed_at: "2026-10-01T00:00:00Z",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/access?view=overview");
  await page
    .getByRole("link", {
      name: "Show administrators without two-step verification",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/role=admin/);
  await expect(page).toHaveURL(/mfa=without/);
  const chips = activeFilters(page);
  await expect(chips).toContainText("Showing");
  await expect(chips).toContainText("Role: Administrator");
  // The two-step filter finds administrators only, and its chip says so.
  await expect(chips).toContainText("Two-step: Off (administrators)");
  await expect(filtersButton(page)).toContainText("2");
  await expect(filtersButton(page)).toHaveAccessibleDescription(
    "2 active filters",
  );

  await chips
    .getByRole("button", { name: "Remove Two-step filter", exact: true })
    .click();
  await expect(page).not.toHaveURL(/mfa=/);
  await expect(page).toHaveURL(/role=admin/);
  // The last chip's focus moves back to the chip before it.
  await expect(
    chips.getByRole("button", { name: "Remove Role filter", exact: true }),
  ).toBeFocused();
  await expect.poll(() => api.listReads.at(-1)?.get("mfa")).toBeNull();
  await page.reload();
  await expect(activeFilters(page)).toContainText("Role: Administrator");
  await expect(activeFilters(page)).not.toContainText("Two-step");

  await activeFilters(page)
    .getByRole("button", { name: "Clear all", exact: true })
    .click();
  // No filter, no row: the chips take no space when nothing is active.
  await expect(activeFilters(page)).toHaveCount(0);
  await expect(filtersButton(page)).toBeFocused();
  await expect(page).not.toHaveURL(/role=/);
  await expect(peopleTable(page).locator("tbody tr")).toHaveCount(5);
});

test("removing a chip hands focus to the next chip, then to the Filters button", async ({
  page,
}) => {
  await mockAccessApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    "/access?view=people&role=member&mfa=unknown&history=no-recorded-sign-in",
  );
  const chips = activeFilters(page);
  const remove = (label: string) =>
    chips.getByRole("button", { name: `Remove ${label} filter`, exact: true });
  await remove("Role").click();
  await expect(remove("Two-step")).toBeFocused();
  await remove("Two-step").click();
  await expect(remove("Activity")).toBeFocused();
  await remove("Activity").click();
  await expect(chips).toHaveCount(0);
  await expect(filtersButton(page)).toBeFocused();
});

test("on a phone the Filters open as a full-width bottom sheet with 44 px targets", async ({
  page,
}) => {
  await mockAccessApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/access?view=people&role=guest");
  await filtersButton(page).click();
  const sheet = filtersDialog(page);
  await expect(sheet).toBeVisible();
  const box = await sheet.boundingBox();
  expect(Math.round(box?.width ?? 0)).toBe(390);
  expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(844);
  for (const control of [
    sheet.getByLabel("Role", { exact: true }),
    sheet.getByRole("combobox", { name: "Group", exact: true }),
    sheet.getByRole("button", { name: "Clear all", exact: true }),
  ])
    expect(Math.round((await control.boundingBox())?.height ?? 0)).toBe(44);
  await sheet.getByLabel("Role", { exact: true }).selectOption("all");
  await expect(page).not.toHaveURL(/role=/);
  // The group search opens over the modal sheet and its choice applies.
  await sheet.getByRole("combobox", { name: "Group", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Search group", exact: true })
    .fill("fin");
  await page.getByRole("option", { name: /Finance readers/ }).click();
  await expect(sheet).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`group=${ids.readers}`));
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(filtersButton(page)).toBeFocused();
  await expectNoHorizontalScroll(page);
});
