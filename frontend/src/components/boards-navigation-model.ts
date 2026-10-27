/**
 * Boards in the sidebar and the breadcrumb (docs/specs/boards-relayout.md,
 * BR1–BR5, BR41, BR47). A department's board is its Announcements row in the
 * department group; the Boards group holds Company, the active project boards
 * and All boards. The shell reads only the address and the board list the
 * Boards page (or the sidebar's lazy reader) caches under
 * `boardsNavigationKey`, so this module carries no reads and no schemas.
 */

/** The board list the sidebar shows: active boards by name, one page. */
export const boardsNavigationKey = () => ["boards", "navigation"] as const;

/** The open board, as the Boards page last read it. */
export const boardsDetailKey = (boardId: string) =>
  ["boards", "detail", boardId] as const;

export type NavigationBoard = {
  id: string;
  scope: "company" | "department" | "project";
  departmentId: string | null;
  name: string;
  status: "active" | "archived";
};

export type BoardsPlace =
  | { kind: "company" }
  | { kind: "department"; departmentId: string }
  | { kind: "board"; boardId: string }
  | { kind: "all" }
  | { kind: "my-calendar" };

export type BoardsNavigationRow = {
  id: string;
  label: string;
  href: string;
  active: boolean;
};

export const companyBoardHref = "/boards";
export const allBoardsHref = "/boards?section=all";
export const myCalendarHref = "/boards?section=my-calendar";

/** A department's board (BR41): the address names the department. */
export function announcementsHref(departmentId: string): string {
  return `/boards?department=${encodeURIComponent(departmentId)}`;
}

export function projectBoardHref(boardId: string): string {
  return `/boards?board=${encodeURIComponent(boardId)}`;
}

/** Which Boards place an address shows, or null outside `/boards`. */
export function boardsPlace(
  pathname: string,
  params: URLSearchParams,
): BoardsPlace | null {
  if (pathname !== "/boards") return null;
  const department = params.get("department");
  const board = params.get("board");
  if (department) return { kind: "department", departmentId: department };
  if (board) return { kind: "board", boardId: board };
  if (params.get("section") === "all") return { kind: "all" };
  if (params.get("section") === "my-calendar") return { kind: "my-calendar" };
  return { kind: "company" };
}

/** The department whose Announcements an address shows. */
export function currentAnnouncementsDepartmentId(
  pathname: string,
  params: URLSearchParams,
): string | null {
  const place = boardsPlace(pathname, params);
  return place?.kind === "department" ? place.departmentId : null;
}

function isCompany(
  place: BoardsPlace | null,
  boards: readonly NavigationBoard[] | undefined,
): boolean {
  if (place?.kind === "company") return true;
  if (place?.kind !== "board") return false;
  return Boolean(
    boards?.some(
      (board) => board.id === place.boardId && board.scope === "company",
    ),
  );
}

/**
 * The Boards group (BR2): My calendar, Company, the active project boards by
 * name, All boards.
 */
export function boardsGroupRows(
  place: BoardsPlace | null,
  boards: readonly NavigationBoard[] | undefined,
): BoardsNavigationRow[] {
  const projects = (boards ?? [])
    .filter((board) => board.scope === "project" && board.status === "active")
    .sort((a, b) => a.name.localeCompare(b.name));
  return [
    {
      id: "my-calendar",
      label: "My calendar",
      href: myCalendarHref,
      active: place?.kind === "my-calendar",
    },
    {
      id: "company",
      label: "Company",
      href: companyBoardHref,
      active: isCompany(place, boards),
    },
    ...projects.map((board) => ({
      id: board.id,
      label: board.name,
      href: projectBoardHref(board.id),
      active: place?.kind === "board" && place.boardId === board.id,
    })),
    {
      id: "all",
      label: "All boards",
      href: allBoardsHref,
      active: place?.kind === "all",
    },
  ];
}

/**
 * "Sales › Announcements", "Boards › Company", "Boards › <project>",
 * "Boards › My calendar", "Boards › All boards" (BR4). A name the caches do not hold yet reads
 * "Board" or leaves the department out; it never shows an id.
 */
export function boardsLocation(
  place: BoardsPlace,
  boards: readonly NavigationBoard[],
  departments: readonly { id: string; name: string }[],
): { parent: string | null; current: string } {
  if (place.kind === "department")
    return {
      parent:
        departments.find((entry) => entry.id === place.departmentId)?.name ??
        null,
      current: "Announcements",
    };
  if (place.kind === "all") return { parent: "Boards", current: "All boards" };
  if (place.kind === "my-calendar")
    return { parent: "Boards", current: "My calendar" };
  if (isCompany(place, boards)) return { parent: "Boards", current: "Company" };
  const board =
    place.kind === "board"
      ? boards.find((entry) => entry.id === place.boardId)
      : undefined;
  return { parent: "Boards", current: board?.name ?? "Board" };
}
