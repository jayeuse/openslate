import { expect, signedInAs, test, type Page } from "./helpers/test";
import { wirePagination } from "../helpers/pagination";

async function openSignedIn(page: Page, path: string) {
  await signedInAs(page, {
    id: "00000000-0000-4000-8000-000000000101",
    role: "admin",
  });
  await page.goto(path);
}

const surfaces = [
  { path: "/comms", says: "Conversations here are examples.", temporary: true },
  {
    path: "/manage?view=organization",
    says: "Settings save to the organization.",
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

test("Platform search describes readable workspace content and its empty prompts", async ({
  page,
}) => {
  await openSignedIn(page, "/platform?section=search");
  await expect(
    page.getByRole("searchbox", { name: "Search workspace", exact: true }),
  ).toBeVisible();
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
});

test("Platform Files keeps the legacy file link and opens an empty department library", async ({
  page,
}) => {
  await page.route(
    (url) => url.pathname === "/api/departments",
    (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            json: {
              items: [],
              pagination: wirePagination({ limit: 100, count: 0, total: 0 }),
            },
          })
        : route.fallback(),
  );
  await openSignedIn(
    page,
    "/platform?section=files&file=sample-file-checklist",
  );
  await expect(page).toHaveURL(
    /\/platform\?section=files&file=sample-file-checklist$/,
  );
  await expect(
    page.getByRole("heading", { name: "Department file library", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Department", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("No departments are available to you.", { exact: true }),
  ).toBeVisible();
});
