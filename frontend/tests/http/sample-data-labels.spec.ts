import { expect, test, type Page } from "./helpers/test";

async function openSignedIn(page: Page, path: string) {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user_id: "00000000-0000-4000-8000-000000000101",
        setup_required: false,
      },
    }),
  );
  await page.goto(path);
}

const surfaces = [
  { path: "/comms", says: "Conversations here are examples.", temporary: true },
  {
    path: "/manage?view=organization",
    says: "Name, locale and timezone save to the organization. Mark, currency, week start and business hours are examples; their changes last until this tab closes.",
    temporary: false,
  },
  {
    path: "/manage?view=audit",
    says: "Audit entries are loaded from your organization.",
    temporary: false,
  },
  {
    path: "/platform?section=search",
    says: "Records, files, and people here are examples.",
    temporary: true,
  },
  {
    path: "/platform?section=files",
    says: "Records, files, and people here are examples.",
    temporary: true,
  },
];

for (const surface of surfaces) {
  test(`${surface.path} labels its data source once`, async ({ page }) => {
    await openSignedIn(page, surface.path);
    const note = page.getByRole("note", {
      name: surface.temporary ? "Example data" : "Organization data",
    });
    await expect(note).toHaveCount(1);
    await expect(note).toContainText(
      surface.temporary ? "Example" : "Organization",
    );
    await expect(note).toContainText(surface.says);
    if (surface.temporary)
      await expect(note).toContainText(
        "Changes last until you close this tab.",
      );
    else
      await expect(note).not.toContainText(
        "Changes last until you close this tab.",
      );
  });
}

test("Platform notifications label only the sample list", async ({ page }) => {
  await openSignedIn(page, "/platform?section=notifications");
  const note = page.getByRole("note", { name: "Example data" });
  await expect(note).toHaveCount(1);
  await expect(note).toContainText(
    "Preview notifications are examples and are not delivered.",
  );
});
