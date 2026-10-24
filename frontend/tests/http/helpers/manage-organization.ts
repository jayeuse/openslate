import { expect, type Page } from "./test";

/** The closed optional Profile block on Manage › Organization (MD4). */
export const organizationProfile = (page: Page) =>
  page
    .getByRole("region", { name: "Organization settings", exact: true })
    .getByRole("button", { name: /^Profile/ });

/**
 * Opens the Profile block before a journey edits its fields. The block
 * remembers its state for the viewer, so a reload can find it open already.
 */
export async function openProfile(page: Page) {
  const block = organizationProfile(page);
  await expect(block).toBeVisible();
  if ((await block.getAttribute("aria-expanded")) !== "true")
    await block.click();
  await expect(block).toHaveAttribute("aria-expanded", "true");
}
