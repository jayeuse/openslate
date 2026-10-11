import { expect, test } from "./helpers/test";

// The unknown-section fallback lives in platformSectionFromSearch
// (platform/page.tsx), which is not exported; this is its only owner until it
// gets an isolated test.
test("an unknown Platform section opens Search", async ({ page }) => {
  await page.goto("/platform?section=records");

  await expect(
    page.getByRole("searchbox", { name: "Search workspace" }),
  ).toBeVisible();
});
