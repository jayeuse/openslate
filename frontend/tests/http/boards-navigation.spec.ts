import { expect, test, type Page } from "./helpers/test";

const boardId = "00000000-0000-4000-8000-000000000021";
const userId = "00000000-0000-4000-8000-000000000022";
const board = {
  id: boardId,
  scope: "project",
  department_id: null,
  name: "Authorized operations",
  description: null,
  status: "active",
  revision: 1,
  level: "read",
  created_at: "2026-09-23T00:00:00Z",
  updated_at: "2026-09-23T00:00:00Z",
};

async function installServerBoards(page: Page) {
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        display_name: "OpenSlate",
        mark: "OS",
        logo_file_id: null,
        revision: 1,
        today: "2026-09-23",
        week_start: "monday",
        locale: "en-US",
        timezone: "UTC",
      }),
    }),
  );
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user_id: userId,
        setup_required: false,
      }),
    }),
  );
  await page.route("**/api/boards**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const reply = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "/api/boards")
      return reply(200, {
        items: [board],
        pagination: {
          limit: 25,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
      });
    if (path === `/api/boards/${boardId}`) return reply(200, board);
    if (path === `/api/boards/${boardId}/my-access`)
      return reply(200, {
        level: "read",
        read: true,
        write: false,
        manage: false,
      });
    if (path === `/api/boards/${boardId}/post-authors`) return reply(200, []);
    return reply(404, { detail: "Content route unavailable" });
  });
}

test("legacy sample Board URL cannot reveal browser-local Board content", async ({
  page,
}) => {
  await installServerBoards(page);
  await page.goto("/boards?board=sample-board-organization&section=overview");

  await expect(
    page.getByText(
      /This Board may have been removed or your account may not have access/,
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Organization board" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Manage board" })).toHaveCount(
    0,
  );
});

test("Board content sections stay on the authorized UUID and fail closed when content APIs are unavailable", async ({
  page,
}) => {
  await installServerBoards(page);
  await page.goto(`/boards?board=${boardId}&section=calendar`);

  await expect(page.getByRole("heading", { name: board.name })).toBeVisible();
  await expect(
    page.getByText(
      "No events are shown. Retry or ask a Board manager to check your access.",
    ),
  ).toBeVisible();
  await expect(page.getByText("Manager-visible event")).toHaveCount(0);

  await page
    .getByRole("navigation", { name: "Main navigation", exact: true })
    .getByRole("link", { name: "Posts", exact: true })
    .click();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/boards" &&
      url.searchParams.get("board") === boardId &&
      url.searchParams.get("section") === "posts",
  );
  await expect(
    page.getByText(
      "No post content is shown. Retry or ask a Board manager to check your access.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Manager-visible post" }),
  ).toHaveCount(0);
});

/**
 * Holds the Board list request until the test releases it, with the page's
 * timers on a paused clock, so the skeleton delay and minimum are exact.
 */
async function openBoardsWithHeldList(page: Page) {
  await installServerBoards(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/boards**", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/boards") await held;
    await route.fallback();
  });
  await page.clock.install({ time: new Date("2026-09-27T09:00:00Z") });
  await page.clock.pauseAt(new Date("2026-09-27T09:00:01Z"));
  await page.goto("/boards");
  await expect(
    page.getByRole("heading", { level: 1, name: "Boards" }),
  ).toBeVisible();
  const region = page.locator('[data-slot="loading-region"]');
  await expect(region).toHaveAttribute("aria-busy", "true");
  return {
    region,
    label: page.getByRole("status").filter({ hasText: "Loading Boards" }),
    release,
  };
}

test("a slow Board list shows its skeleton only after 300ms, and for at least 300ms", async ({
  page,
}) => {
  const { region, label, release } = await openBoardsWithHeldList(page);
  // The loading shell never shows sample Board content.
  const loadingHtml = await page.locator("main").innerHTML();
  expect(loadingHtml).not.toContain("Organization board");
  expect(loadingHtml).not.toContain("sample-board");

  await page.clock.runFor(250);
  await expect(label).toHaveCount(0);
  await page.clock.runFor(100);
  await expect(label).toHaveCount(1);

  // The list arrives 50ms after the skeleton shows; the skeleton stays to 300ms.
  await page.clock.runFor(50);
  const listed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/boards",
  );
  release();
  await listed;
  await page.clock.runFor(100);
  await expect(label).toHaveCount(1);
  // The frame already names the Board; the region still holds its skeleton.
  await expect(region).toHaveAttribute("aria-busy", "true");
  await page.clock.runFor(200);
  await expect
    .poll(
      async () => {
        await page.clock.runFor(1);
        return region.getAttribute("aria-busy");
      },
      { intervals: [50] },
    )
    .toBe("false");
  await expect(
    region.getByRole("region", { name: "Record summaries" }),
  ).toBeVisible();
  await expect(label).toHaveCount(0);
});

test("a Board list that arrives within 300ms never shows the skeleton", async ({
  page,
}) => {
  const { region, label, release } = await openBoardsWithHeldList(page);
  await page.clock.runFor(200);
  release();
  await expect(page.getByRole("heading", { name: board.name })).toBeVisible();
  await expect(region).toHaveAttribute("aria-busy", "false");
  await page.clock.runFor(1_000);
  await expect(label).toHaveCount(0);
});
