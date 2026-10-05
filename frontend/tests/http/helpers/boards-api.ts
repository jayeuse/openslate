import type { Page } from "./test";

// The Board shell's API, mocked for HTTP specs: an authorized administrator,
// two Boards, and empty posts, events and widgets. A spec registers its own
// narrower `page.route` after this one; later routes win.

export const boardId = "00000000-0000-4000-8000-000000000011";
export const userId = "00000000-0000-4000-8000-000000000012";
export const board = {
  id: boardId,
  scope: "project",
  department_id: null,
  name: "Live operations board",
  description: "Current authorized workspace content",
  status: "active",
  revision: 1,
  level: "manage",
  created_at: "2026-09-23T00:00:00Z",
  updated_at: "2026-09-23T00:00:00Z",
};
export const otherBoard = {
  ...board,
  id: "00000000-0000-4000-8000-000000000013",
  name: "Second live board",
  description: "Another authorized Board",
};

export const managerAccess = {
  level: "manage",
  read: true,
  write: true,
  manage: true,
};
export const authorAccess = {
  level: "write",
  read: true,
  write: true,
  manage: false,
};
export const readerAccess = {
  level: "read",
  read: true,
  write: false,
  manage: false,
};

export async function installBoardApi(
  page: Page,
  isAllowed: () => boolean,
  access = managerAccess,
) {
  const visibleBoard = { ...board, level: access.level };
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Not available in this route test" }),
    }),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { id: userId, role: "admin", access: [] } }),
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
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        today: "2026-09-25",
        week_start: "monday",
        purge_enabled: true,
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
    if (path === "/api/boards")
      return reply(200, {
        items: [visibleBoard, otherBoard],
        pagination: {
          limit: 25,
          offset: 0,
          count: 2,
          total: 2,
          has_more: false,
        },
      });
    if (path === `/api/boards/${boardId}/my-access`) return reply(200, access);
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
    if (path === `/api/boards/${boardId}/post-authors`)
      return reply(200, [{ id: userId, label: "Current user" }]);
    if (path === `/api/boards/${boardId}/posts`)
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
    if (path === `/api/boards/${boardId}/widgets`)
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
        ? reply(200, visibleBoard)
        : reply(404, { detail: "Board not found" });
    if (path === `/api/boards/${otherBoard.id}`) return reply(200, otherBoard);
    return reply(404, { detail: "Not available in this route test" });
  });
}
