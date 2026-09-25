import { expect, test, type Page } from "@playwright/test";

const boardId = "00000000-0000-4000-8000-000000000021";
const userId = "00000000-0000-4000-8000-000000000022";
const board = {
  id: boardId,
  owner_id: userId,
  department_id: null,
  name: "Authorized operations",
  description: null,
  status: "active",
  default_section: "calendar",
  revision: 1,
  created_at: "2026-09-23T00:00:00Z",
  updated_at: "2026-09-23T00:00:00Z",
};

async function installServerBoards(page: Page) {
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ today: "2026-09-23" }),
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
    if (path === "/api/boards/personal")
      return reply(200, { favorite_board_ids: [], home_board_id: null });
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
      return reply(200, { view: true, edit: true, manage: true });
    if (path === `/api/boards/${boardId}/announcement-authors`)
      return reply(200, []);
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
    .getByRole("button", { name: "Announcements", exact: true })
    .click();
  await expect(page).toHaveURL(
    `/boards?board=${boardId}&section=announcements`,
  );
  await expect(
    page.getByText(
      "No announcement content is shown. Retry or ask a Board manager to check your access.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Manager-visible announcement" }),
  ).toHaveCount(0);
});
