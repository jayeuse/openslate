import type { Page } from "./test";
import { isEventStream, signedInAs } from "./test";
import { wirePagination } from "../../helpers/pagination";
import { wireBoard } from "../../helpers/wire";

// The Board shell's API, mocked for HTTP specs: an authorized administrator,
// two Boards, and empty posts and events. A spec registers its own
// narrower `page.route` after this one; later routes win.

export const boardId = "00000000-0000-4000-8000-000000000011";
export const userId = "00000000-0000-4000-8000-000000000012";
export const board = wireBoard({
  id: boardId,
  name: "Live operations board",
  description: "Current authorized workspace content",
  level: "manage",
  created_at: "2026-09-23T00:00:00Z",
  updated_at: "2026-09-23T00:00:00Z",
});
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
    isEventStream(route)
      ? route.fallback()
      : route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Not available in this route test" }),
        }),
  );
  await signedInAs(page, { id: userId, role: "admin" });
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        display_name: "OpenSlate",
        mark: "OS",
        logo_file_id: null,
        revision: 1,
        today: "2026-09-25",
        week_start: "monday",
        locale: "en-US",
        timezone: "UTC",
        purge_enabled: true,
      }),
    }),
  );
  await page.route("**/api/views/data-sources**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [],
        pagination: wirePagination({ limit: 25, count: 0, total: 0 }),
      }),
    }),
  );
  await page.route("**/api/boards**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const reply = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "/api/boards")
      return reply(200, {
        items: [visibleBoard, otherBoard],
        pagination: wirePagination({ limit: 25, count: 2, total: 2 }),
      });
    if (path === `/api/boards/${boardId}/my-access`) return reply(200, access);
    if (path === `/api/boards/${boardId}/events/occurrences`)
      return reply(200, {
        items: [],
        pagination: wirePagination({ limit: 100, count: 0, total: 0 }),
        board_revision: 1,
      });
    if (path === `/api/boards/${boardId}/post-authors`) {
      const ids = url.searchParams.getAll("ids");
      const items =
        ids.length === 0 || ids.includes(userId)
          ? [{ id: userId, label: "Current user" }]
          : [];
      return reply(200, {
        items,
        pagination: wirePagination({
          limit: Number(url.searchParams.get("limit") ?? 25),
          offset: Number(url.searchParams.get("offset") ?? 0),
          count: items.length,
          total: items.length,
        }),
      });
    }
    if (path === `/api/boards/${boardId}/posts`)
      return reply(200, {
        items: [],
        pagination: wirePagination({ limit: 25, count: 0, total: 0 }),
        board_revision: 1,
      });
    if (path === `/api/boards/${boardId}/files`)
      return reply(200, {
        items: [],
        pagination: wirePagination({ limit: 25, count: 0, total: 0 }),
      });
    if (path === `/api/boards/${boardId}`)
      return isAllowed()
        ? reply(200, visibleBoard)
        : reply(404, { detail: "Board not found" });
    if (path === `/api/boards/${otherBoard.id}`) return reply(200, otherBoard);
    return reply(404, { detail: "Not available in this route test" });
  });
}
