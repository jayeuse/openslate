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

// A Board directory for the sidebar, header and All boards journeys: the
// Company board, the Sales department's board, two active project boards and
// an archived one, with Sales readable in the sidebar (one module). Install it
// after `installBoardApi`; it answers every Board read itself.
export const directoryIds = {
  company: "00000000-0000-4000-8000-000000000031",
  sales: "00000000-0000-4000-8000-000000000032",
  fleet: "00000000-0000-4000-8000-000000000033",
  renewal: "00000000-0000-4000-8000-000000000034",
  launch: "00000000-0000-4000-8000-000000000035",
  salesDepartment: "00000000-0000-4000-8000-0000000d0001",
  financeDepartment: "00000000-0000-4000-8000-0000000d0002",
  contacts: "00000000-0000-4000-8000-0000000d0011",
};

const stamp = "2026-09-23T00:00:00Z";
const directoryBoard = (
  id: string,
  name: string,
  scope: "company" | "department" | "project",
  level: "read" | "write" | "manage",
  extra: { department_id?: string; status?: "active" | "archived" } = {},
) =>
  wireBoard({
    id,
    name,
    description: null,
    scope,
    level,
    created_at: stamp,
    updated_at: stamp,
    ...extra,
  });

export function directoryBoards(level: "read" | "write" | "manage") {
  return [
    directoryBoard(directoryIds.company, "Company", "company", level),
    directoryBoard(directoryIds.sales, "Sales", "department", level, {
      department_id: directoryIds.salesDepartment,
    }),
    directoryBoard(directoryIds.fleet, "Fleet Reliability", "project", level),
    directoryBoard(directoryIds.renewal, "Customer Renewal", "project", level),
    directoryBoard(directoryIds.launch, "Spring Launch", "project", level, {
      status: "archived",
    }),
  ];
}

export type BoardDirectory = {
  boards: ReturnType<typeof directoryBoards>;
  /** Published posts per Board id. */
  posts: Record<string, unknown[]>;
  /** Every `/api/boards` list query, as its search string. */
  listQueries: string[];
  /** Every Board detail read, by id. */
  detailReads: string[];
};

export async function installBoardDirectory(
  page: Page,
  options: {
    level?: "read" | "write" | "manage";
    posts?: Record<string, unknown[]>;
  } = {},
): Promise<BoardDirectory> {
  const level = options.level ?? "manage";
  const directory: BoardDirectory = {
    boards: directoryBoards(level),
    posts: options.posts ?? {},
    listQueries: [],
    detailReads: [],
  };
  const access = {
    read: readerAccess,
    write: authorAccess,
    manage: managerAccess,
  }[level];
  const listPage = (items: unknown[], limit: number, offset = 0) => ({
    items,
    pagination: wirePagination({
      limit,
      offset,
      count: items.length,
      total: items.length,
    }),
  });
  await page.route(
    (url) => url.pathname === "/api/departments",
    (route) =>
      route.fulfill({
        json: listPage(
          [
            ["Sales", directoryIds.salesDepartment],
            ["Finance", directoryIds.financeDepartment],
          ].map(([name, id]) => ({
            id,
            department_name: name,
            created_at: stamp,
            updated_at: stamp,
            deleted_at: null,
            is_deleted: false,
            performed_by: null,
          })),
          100,
        ),
      }),
  );
  await page.route(
    (url) => url.pathname === "/api/views/data-sources",
    (route) =>
      route.fulfill({
        json: listPage(
          [
            {
              id: directoryIds.contacts,
              name: "Contacts",
              department_id: directoryIds.salesDepartment,
              title_field_id: null,
            },
          ],
          100,
        ),
      }),
  );
  await page.route("**/api/boards**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/boards" && route.request().method() === "GET") {
      directory.listQueries.push(url.search);
      const status = url.searchParams.get("status") ?? "active";
      const scope = url.searchParams.get("scope");
      const department = url.searchParams.get("department_id");
      const search = url.searchParams.get("search")?.toLowerCase();
      const limit = Number(url.searchParams.get("limit") ?? 25);
      const items = directory.boards
        .filter((entry) => status === "all" || entry.status === status)
        .filter((entry) => !scope || entry.scope === scope)
        .filter((entry) => !department || entry.department_id === department)
        .filter((entry) => !search || entry.name.toLowerCase().includes(search))
        .sort((a, b) => a.name.localeCompare(b.name));
      return route.fulfill({ json: listPage(items, limit) });
    }
    const match = /^\/api\/boards\/([^/]+)(\/.*)?$/.exec(path);
    const entry = directory.boards.find(
      (candidate) => candidate.id === match?.[1],
    );
    if (!match || !entry) return route.fallback();
    const rest = match[2] ?? "";
    if (rest === "") {
      directory.detailReads.push(entry.id);
      return route.fulfill({ json: entry });
    }
    if (rest === "/my-access") return route.fulfill({ json: access });
    if (rest === "/posts") {
      const view = url.searchParams.get("view");
      const items =
        view === "published" ? (directory.posts[entry.id] ?? []) : [];
      return route.fulfill({
        json: { ...listPage(items, 25), board_revision: 1 },
      });
    }
    if (rest === "/events/occurrences")
      return route.fulfill({
        json: { ...listPage([], 100), board_revision: 1 },
      });
    if (rest === "/post-authors" || rest === "/files")
      return route.fulfill({ json: listPage([], 25) });
    return route.fallback();
  });
  return directory;
}
