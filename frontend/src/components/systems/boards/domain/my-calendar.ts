import type { BoardAccessLevel } from "../adapters/board-management-api";
import type { BoardMyAccess } from "../adapters/board-tools-api";
import type { CalendarReadStatus } from "../hooks/use-board-calendar-data";

/**
 * My calendar's board calendars (BR22, BR52, BR53): one per board the window
 * read covered, named as the board's page is, with the person's level from
 * the board list and the read's own status for that board.
 */

export type OccurrenceBoardStatus =
  "ok" | "candidate_limit" | "occurrence_limit" | "unavailable";

type Scope = "company" | "department" | "project";

export type MyCalendarBoard = {
  id: string;
  /** The board's calendar in the list, as on its own Calendar tab. */
  calendarId: string;
  /** The board's page title ("Sales announcements"). */
  name: string;
  /** Who reads it, for the Board field's consequence line ("Sales"). */
  ownerName: string;
  scope: Scope | null;
  departmentId: string | null;
  /** The person's level from the board list; null until the list names it. */
  level: BoardAccessLevel | null;
  revision: number | null;
  status: CalendarReadStatus;
};

const SCOPE_ORDER: Record<Scope, number> = {
  company: 0,
  department: 1,
  project: 2,
};

/** A capped board shows "Too many events to show"; a refused one, "not loaded". */
export function occurrenceReadStatus(
  status: OccurrenceBoardStatus,
): CalendarReadStatus {
  if (status === "ok") return "ready";
  if (status === "unavailable") return "error";
  return "limited";
}

/**
 * The rows come from the read's `boards` (the boards it covered); the board
 * list adds names and levels, an item's board mark names a board the list
 * does not hold yet, and a board nobody named reads "Board".
 */
export function myCalendarBoards(
  states: readonly {
    boardId: string;
    revision: number | null;
    status: OccurrenceBoardStatus;
  }[],
  listed: readonly {
    id: string;
    name: string;
    scope: Scope;
    departmentId: string | null;
    level: BoardAccessLevel;
  }[],
  marks: readonly {
    id: string;
    name: string;
    scope: Scope;
    departmentId: string | null;
  }[],
  departmentOrder: (departmentId: string) => number | null,
): MyCalendarBoard[] {
  const rows = states.map((state): MyCalendarBoard => {
    const listing = listed.find((board) => board.id === state.boardId);
    const mark = listing ?? marks.find((board) => board.id === state.boardId);
    return {
      id: state.boardId,
      calendarId: `board:${state.boardId}`,
      // The short name, as the sidebar shows it: the list is already
      // titled "Board calendars".
      name: mark ? (mark.scope === "company" ? "Company" : mark.name) : "Board",
      ownerName: mark ? mark.name : "this board",
      scope: mark?.scope ?? null,
      departmentId: mark?.departmentId ?? null,
      level: listing?.level ?? null,
      revision: state.revision,
      status: occurrenceReadStatus(state.status),
    };
  });
  const order = (row: MyCalendarBoard) =>
    row.departmentId ? (departmentOrder(row.departmentId) ?? 1e6) : 0;
  return rows.sort(
    (left, right) =>
      (left.scope ? SCOPE_ORDER[left.scope] : 3) -
        (right.scope ? SCOPE_ORDER[right.scope] : 3) ||
      order(left) - order(right) ||
      left.name.localeCompare(right.name),
  );
}

/** The person posts (and adds events) where their level is Post or Manager. */
export function postableBoards(
  boards: readonly MyCalendarBoard[],
): MyCalendarBoard[] {
  return boards.filter(
    (board) => board.level === "write" || board.level === "manage",
  );
}

/** The Board field's consequence line (BR35). */
export function boardConsequence(board: { ownerName: string }): string {
  return `Everyone who reads ${board.ownerName} sees this event.`;
}

/** The person's access on a board from its list level, as `my-access` reports it. */
export function boardAccessFromLevel(
  level: BoardAccessLevel | null,
): BoardMyAccess | null {
  if (level === null) return null;
  return {
    level,
    view: true,
    edit: level !== "read",
    manage: level === "manage",
  };
}
