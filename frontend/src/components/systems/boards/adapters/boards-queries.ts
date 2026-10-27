import { queryOptions } from "@tanstack/react-query";
import { boardsNavigationKey } from "@/components/boards-navigation-model";
import { listBoards } from "./board-management-api";

/** The most boards one page holds; the sidebar lists the first page. */
export const BOARDS_NAVIGATION_LIMIT = 100;

/**
 * The active boards by name: the Boards page picks the board it opens from
 * them, and the sidebar lists the project boards (BR2). One read serves both.
 */
export const boardsNavigationOptions = () =>
  queryOptions({
    queryKey: boardsNavigationKey(),
    queryFn: () =>
      listBoards({ status: "active", limit: BOARDS_NAVIGATION_LIMIT }),
  });

/** All boards (BR3): one page of the boards a person reads, by status and search. */
export const boardDirectoryOptions = (
  status: "active" | "archived",
  search: string,
) =>
  queryOptions({
    queryKey: ["boards", "directory", status, search] as const,
    queryFn: () =>
      listBoards({
        status,
        limit: BOARDS_NAVIGATION_LIMIT,
        ...(search ? { search } : {}),
      }),
  });
