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
  // Organization reads the server workspace; without an answer the panel moves
  // between loading and error, so two looks could be captured in different states.
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        id: "00000000-0000-4000-8000-000000000077",
        display_name: "Riverside Services",
        legal_name: null,
        description: null,
        contact_email: null,
        contact_phone: null,
        postal_address: null,
        logo_file_id: null,
        timezone: "Asia/Manila",
        locale: "en-PH",
        mark: "RS",
        currency: "PHP",
        week_start: "monday",
        business_hours: "09:00–18:00",
        invitation_expiry_days: 7,
        guest_duration_days: 30,
        revision: 4,
        created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-09-01T00:00:00Z",
        today: "2026-09-01",
      },
    }),
  );
}

// Themes change look only. Compare the persistent shell and page, excluding
// Next's changing script payloads and the session curtain outside the shell.
// The Access entry appears only after `/api/auth/me` answers with the default
// administrator, so wait for it before each snapshot to compare settled shells.
async function snapshot(page: Page) {
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: /^Access/ }),
  ).toBeVisible();
  return page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    if (!shell) throw new Error("Workspace shell is unavailable");
    return {
      elements: shell.querySelectorAll("*").length,
      text: shell.textContent,
    };
  });
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
