import { expect, test, type Page } from "@playwright/test";

const boardId = "00000000-0000-4000-8000-000000000011";
const userId = "00000000-0000-4000-8000-000000000012";
const audienceRoleId = "00000000-0000-4000-8000-000000000014";
const board = {
  id: boardId,
  owner_id: userId,
  department_id: null,
  name: "Live operations board",
  description: "Current authorized workspace content",
  status: "active",
  default_section: "overview",
  revision: 1,
  created_at: "2026-09-23T00:00:00Z",
  updated_at: "2026-09-23T00:00:00Z",
};
const otherBoard = {
  ...board,
  id: "00000000-0000-4000-8000-000000000013",
  name: "Second live board",
  description: "Another authorized Board",
};

async function installBoardApi(page: Page, isAllowed: () => boolean) {
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
  await page.route("**/api/views/data-sources**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [],
        pagination: {
          limit: 25,
          offset: 0,
          count: 0,
          total: 0,
          has_more: false,
        },
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
        items: [board, otherBoard],
        pagination: {
          limit: 25,
          offset: 0,
          count: 2,
          total: 2,
          has_more: false,
        },
      });
    if (path === `/api/boards/${boardId}/my-access`)
      return reply(200, { view: true, edit: true, manage: true });
    if (path === `/api/boards/${boardId}/content-audience-targets`)
      return reply(200, {
        items: [{ id: audienceRoleId, label: "Operations" }],
        pagination: {
          limit: 25,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
      });
    if (path === `/api/boards/${boardId}/events/occurrences`)
      return reply(200, {
        items: [],
        pagination: {
          limit: 100,
          offset: 0,
          count: 0,
          total: 0,
          has_more: false,
        },
        board_revision: 1,
      });
    if (path === `/api/boards/${boardId}/announcement-authors`)
      return reply(200, [{ id: userId, label: "Current user" }]);
    if (path === `/api/boards/${boardId}/announcements`)
      return reply(200, {
        items: [],
        pagination: {
          limit: 25,
          offset: 0,
          count: 0,
          total: 0,
          has_more: false,
        },
        board_revision: 1,
      });
    if (
      path === `/api/boards/${boardId}/placements` ||
      path === `/api/boards/${boardId}/widgets`
    )
      return reply(200, {
        items: [],
        pagination: {
          limit: 25,
          offset: 0,
          count: 0,
          total: 0,
          has_more: false,
        },
        board_revision: 1,
      });
    if (path === `/api/boards/${boardId}`)
      return isAllowed()
        ? reply(200, board)
        : reply(404, { detail: "Board not found" });
    if (path === `/api/boards/${otherBoard.id}`) return reply(200, otherBoard);
    return reply(404, { detail: "Not available in this route test" });
  });
}

test("visible Boards route opens authorized server Board and keeps section URL", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  await page.goto(`/boards?board=${boardId}&section=overview`);

  await expect(page.getByRole("heading", { name: board.name })).toBeVisible();
  await expect(page.getByText(board.description)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Switch board" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Link a record" })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Reminders and Board files are unavailable"),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await expect(page).toHaveURL(`/boards?board=${boardId}&section=calendar`);
  await expect(page.getByRole("heading", { name: board.name })).toBeVisible();
});

test("visible Boards route clears the last Board when access is revoked", async ({
  page,
}) => {
  let allowed = true;
  await installBoardApi(page, () => allowed);
  await page.goto(`/boards?board=${boardId}&section=overview`);
  await expect(page.getByRole("heading", { name: board.name })).toBeVisible();

  allowed = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText("Board unavailable. Choose another Board or retry."),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: board.name })).toHaveCount(0);
  await expect(page.getByText(board.description)).toHaveCount(0);
});

test("unsaved Event draft asks before changing Board or section", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  await page.goto(`/boards?board=${boardId}&section=calendar`);
  await page.getByRole("button", { name: "New event" }).click();
  await expect(page.getByRole("heading", { name: "New event" })).toBeVisible();

  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page).toHaveURL(`/boards?board=${boardId}&section=calendar`);
  await expect(
    page.getByRole("alertdialog", { name: "Discard unsaved Board changes?" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("heading", { name: "New event" })).toBeVisible();
  await page.getByRole("button", { name: "Switch board" }).click();
  await page.getByRole("combobox", { name: "Board", exact: true }).click();
  await page.getByRole("option", { name: /Second live board/ }).click();
  await expect(page).toHaveURL(`/boards?board=${boardId}&section=calendar`);
  await expect(
    page.getByRole("alertdialog", { name: "Discard unsaved Board changes?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(page).toHaveURL(
    `/boards?board=${otherBoard.id}&section=overview`,
  );
  await expect(page.getByRole("heading", { name: "New event" })).toHaveCount(0);
});

test("unsaved Announcement draft asks before changing Board or section", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  await page.goto(`/boards?board=${boardId}&section=announcements`);
  await page.getByRole("button", { name: "New announcement" }).click();
  await expect(page.getByRole("heading", { name: "New draft" })).toBeVisible();

  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page).toHaveURL(
    `/boards?board=${boardId}&section=announcements`,
  );
  await expect(
    page.getByRole("alertdialog", { name: "Discard unsaved Board changes?" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("heading", { name: "New draft" })).toBeVisible();
  await page.getByRole("button", { name: "Switch board" }).click();
  await page.getByRole("combobox", { name: "Board", exact: true }).click();
  await page.getByRole("option", { name: /Second live board/ }).click();
  await expect(page).toHaveURL(
    `/boards?board=${boardId}&section=announcements`,
  );
  await expect(
    page.getByRole("alertdialog", { name: "Discard unsaved Board changes?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(page).toHaveURL(
    `/boards?board=${otherBoard.id}&section=overview`,
  );
  await expect(page.getByRole("heading", { name: "New draft" })).toHaveCount(0);
});

test("Announcement editor requires a selected active role before saving", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  await page.goto(`/boards?board=${boardId}&section=announcements`);
  await page.getByRole("button", { name: "New announcement" }).click();
  await page.getByLabel("Title", { exact: true }).fill("Operations update");
  await page.getByLabel("Message").fill("Read the latest instructions.");
  await page.getByRole("combobox", { name: "Audience" }).selectOption("role");
  await expect(page.getByRole("button", { name: "Save draft" })).toBeDisabled();
  await page
    .getByRole("combobox", { name: "Role", exact: true })
    .selectOption(audienceRoleId);
  await expect(page.getByRole("button", { name: "Save draft" })).toBeEnabled();
});
