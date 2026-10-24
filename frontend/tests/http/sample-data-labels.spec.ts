import { expect, signedInAs, test, type Page } from "./helpers/test";
import { wirePagination } from "../helpers/pagination";
import { installCommsLiveApi } from "./helpers/comms-live-api";

async function openSignedIn(page: Page, path: string) {
  await signedInAs(page, {
    id: "00000000-0000-4000-8000-000000000101",
    role: "admin",
  });
  await page.goto(path);
}

test("OpenComms shows server conversations without an example-data label", async ({
  page,
}) => {
  const server = await installCommsLiveApi(page, {
    userId: "00000000-0000-4000-8000-000000000101",
  });
  try {
    await openSignedIn(page, "/comms");
    await expect(
      page.getByText("Live message 59", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("note", { name: "Example data", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("status", {
        name: "Conversation connection",
        exact: true,
      }),
    ).toContainText("Live");
  } finally {
    server.close();
  }
});

test("Manage Organization shows no data-source or example-data label", async ({
  page,
}) => {
  await openSignedIn(page, "/manage?view=organization");
  await expect(
    page.getByText("Make this workspace feel like your organization.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("note", { name: "Example data" })).toHaveCount(0);
  await expect(
    page.getByRole("note", { name: "Organization data" }),
  ).toHaveCount(0);
});

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
