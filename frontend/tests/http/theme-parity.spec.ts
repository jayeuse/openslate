import { expect, test, type Page } from "./helpers/test";

async function signIn(page: Page) {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user_id: "00000000-0000-4000-8000-000000000101",
        setup_required: false,
      },
    }),
  );
}

// Themes change look only. textContent ignores CSS text-transform, so it
// compares the words in the DOM rather than how a theme displays them.
async function snapshot(page: Page) {
  return page.evaluate(() => ({
    elements: document.body.querySelectorAll("*").length,
    text: document.body.textContent,
  }));
}

const THEMES = [
  { name: "Whiteboard", id: "whiteboard", font: /Atkinson/ },
  { name: "Triplicate", id: "triplicate", font: /Archivo/ },
  { name: "Stockroom", id: "stockroom", font: /Archivo/ },
] as const;

test("each organization look keeps the same words and structure", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/manage?view=organization");
  const look = page.getByRole("radiogroup", { name: "Organization look" });
  await expect(look.getByRole("radio", { name: /^Slate/ })).toBeChecked();
  const slate = await snapshot(page);

  for (const theme of THEMES) {
    // People click the tile; the radio inside it is visually hidden.
    await look.locator("label").filter({ hasText: theme.name }).click();
    await expect(
      look.getByRole("radio", { name: new RegExp(`^${theme.name}`) }),
    ).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme.id);
    expect(await snapshot(page), theme.id).toEqual(slate);
    const bodyFont = await page.evaluate(
      () => getComputedStyle(document.body).fontFamily,
    );
    expect(bodyFont, theme.id).toMatch(theme.font);
  }

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "stockroom");
  await expect(look.getByRole("radio", { name: /^Stockroom/ })).toBeChecked();

  await look.locator("label").filter({ hasText: "Slate" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
});
