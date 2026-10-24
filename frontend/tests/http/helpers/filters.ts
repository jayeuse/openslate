import { expect, type Locator, type Page } from "./test";

/**
 * Opens the Filters popover of a toolbar in the Access grammar (DESIGN.md,
 * Filters) and returns it. `within` narrows the button when a page shows
 * more than one toolbar.
 */
export async function openFilters(
  page: Page,
  within: Page | Locator = page,
): Promise<Locator> {
  await within.getByRole("button", { name: "Filters", exact: true }).click();
  const popover = page.getByRole("dialog", { name: "Filters", exact: true });
  await expect(popover).toBeVisible();
  return popover;
}

/**
 * Types a calendar day ("2026-09-04") into a Filters date field, the
 * browser's own date input in the slim field skin (MD16).
 */
export async function enterDay(
  page: Page,
  label: string,
  day: string,
): Promise<void> {
  await page
    .getByRole("dialog", { name: "Filters", exact: true })
    .getByLabel(label, { exact: true })
    .fill(day);
}
