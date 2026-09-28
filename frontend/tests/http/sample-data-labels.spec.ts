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

const sampleSurfaces = [
  { path: "/comms", says: "Conversations here are examples." },
  { path: "/manage?view=organization", says: "Settings here are examples." },
  { path: "/manage?view=audit", says: "Audit entries here are examples." },
  {
    path: "/platform?section=search",
    says: "Records, files, and people here are examples.",
  },
  {
    path: "/platform?section=files",
    says: "Records, files, and people here are examples.",
  },
];

for (const surface of sampleSurfaces) {
  test(`${surface.path} labels its sample data once`, async ({ page }) => {
    await openSignedIn(page, surface.path);
    const note = page.getByRole("note", { name: "Example data" });
    await expect(note).toHaveCount(1);
    await expect(note).toContainText("Example");
    await expect(note).toContainText(surface.says);
    await expect(note).toContainText("Changes last until you close this tab.");
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
