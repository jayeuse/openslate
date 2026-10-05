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
    says: "Settings save to the organization.",
    temporary: false,
  },
  {
    path: "/manage?view=audit",
    says: "Audit entries are loaded from your organization.",
    temporary: false,
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

test("Platform search describes readable workspace content without example claims", async ({
  page,
}) => {
  await openSignedIn(page, "/platform?section=search");
  await expect(
    page.getByRole("searchbox", { name: "Search workspace", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("note", { name: "Example data" })).toHaveCount(0);
  await expect(
    page.getByText("Results include workspace content you can read.", {
      exact: true,
    }),
  ).toBeVisible();
  for (const kind of ["Records", "People", "Posts", "Events"]) {
    const results = page.getByRole("region", {
      name: `${kind} search results`,
      exact: true,
    });
    await expect(results).toContainText(
      `Enter a search to find ${kind.toLowerCase()}.`,
    );
    await expect(results.getByRole("link")).toHaveCount(0);
  }
  for (const kind of ["Conversations", "Files"])
    await expect(
      page.getByRole("region", {
        name: `${kind} search results`,
        exact: true,
      }),
    ).toHaveCount(0);
});

test("Platform notifications contains the connected inbox without sample controls", async ({
  page,
}) => {
  await openSignedIn(page, "/platform?section=notifications");
  await expect(
    page.getByRole("region", { name: "Connected notifications", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("note", { name: "Example data" })).toHaveCount(0);
  for (const name of ["Preview notifications", "Preview preferences"])
    await expect(page.getByRole("heading", { name, exact: true })).toHaveCount(
      0,
    );
  await expect(
    page.getByRole("button", { name: "Simulate record update", exact: true }),
  ).toHaveCount(0);
  for (const name of [
    "Thread reply notifications",
    "Record update notifications",
    "Daily digest",
  ])
    await expect(page.getByRole("switch", { name, exact: true })).toHaveCount(
      0,
    );
});

test("retired File library links return to Search without a fake file tab", async ({
  page,
}) => {
  await openSignedIn(
    page,
    "/platform?section=files&file=sample-file-checklist",
  );
  await expect(
    page.getByRole("searchbox", { name: "Search workspace", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "File library", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("note", { name: "Example data" })).toHaveCount(0);
});
