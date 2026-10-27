"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Route } from "next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { ApiError } from "@/lib/api";
import { boardsDetailKey } from "@/components/boards-navigation-model";
import { useInvalidationRefresh } from "../../shared/adapters/use-invalidation-refresh";
import type { WorkspaceInvalidation } from "../../shared/adapters/invalidation-events";
import {
  listBoards,
  readBoard,
  type BoardManagementBoard,
  type BoardManagementPage,
  type BoardScope,
} from "../adapters/board-management-api";
import { boardsNavigationOptions } from "../adapters/boards-queries";

const uuidSchema = z.string().uuid();
const SECTIONS = ["posts", "calendar", "kanban", "gantt"] as const;
const invalidatesBoardList = (event: WorkspaceInvalidation) =>
  event.type === "invalidate" && event.entity === "boards";
export type BoardSection = (typeof SECTIONS)[number];
/**
 * What a `/boards` address opens (BR9, BR41): Company (no Board in the
 * address), a department's board by its department, a Board by its id, All
 * boards, or My calendar (BR22).
 */
export type BoardRoute =
  | { kind: "none"; section: BoardSection | null }
  | { kind: "board"; boardId: string; section: BoardSection | null }
  | { kind: "department"; departmentId: string; section: BoardSection | null }
  | { kind: "all" }
  | { kind: "my-calendar" }
  | { kind: "invalid-board"; section: BoardSection | null };
export type BoardCandidate = {
  id: string;
  source: "explicit" | "list";
};
type BoardChoice = {
  id: string;
  scope: BoardScope;
  departmentId?: string | null;
  status: "active" | "archived";
};

export function parseBoardRoute(search: string): BoardRoute {
  const params = new URLSearchParams(search);
  const sections = params.getAll("section");
  const section =
    sections.length === 1 && SECTIONS.includes(sections[0] as BoardSection)
      ? (sections[0] as BoardSection)
      : null;
  const boards = params.getAll("board");
  const departments = params.getAll("department");
  if (boards.length === 0 && departments.length === 0)
    return sections.length === 1 && sections[0] === "all"
      ? { kind: "all" }
      : sections.length === 1 && sections[0] === "my-calendar"
        ? { kind: "my-calendar" }
        : { kind: "none", section };
  if (boards.length > 0 && departments.length > 0)
    return { kind: "invalid-board", section };
  if (departments.length > 0)
    return departments.length === 1 &&
      uuidSchema.safeParse(departments[0]).success
      ? { kind: "department", departmentId: departments[0], section }
      : { kind: "invalid-board", section };
  if (boards.length !== 1 || !uuidSchema.safeParse(boards[0]).success)
    return { kind: "invalid-board", section };
  return { kind: "board", boardId: boards[0], section };
}

/**
 * Opens the Board in the address; a department's board from the list (or the
 * Board already open, so an address replace reads nothing); else the company
 * Board, else the first active Board in the list.
 */
export function chooseBoardCandidate(
  route: BoardRoute,
  boards: readonly BoardChoice[],
  open: BoardChoice | null = null,
): BoardCandidate | null {
  if (
    route.kind === "invalid-board" ||
    route.kind === "all" ||
    route.kind === "my-calendar"
  )
    return null;
  if (route.kind === "board") return { id: route.boardId, source: "explicit" };
  if (route.kind === "department") {
    const department = [...(open ? [open] : []), ...boards].find(
      (board) =>
        board.scope === "department" &&
        board.departmentId === route.departmentId,
    );
    return department ? { id: department.id, source: "list" } : null;
  }
  if (open?.scope === "company") return { id: open.id, source: "list" };
  const active = boards.filter((board) => board.status === "active");
  const first =
    active.find((board) => board.scope === "company") ?? active[0] ?? null;
  return first ? { id: first.id, source: "list" } : null;
}

export function resolveBoardSection(route: BoardRoute): BoardSection {
  return route.kind === "all"
    ? "posts"
    : route.kind === "my-calendar"
      ? "calendar"
      : (route.section ?? "posts");
}

export function boardUrl(boardId: string, section: BoardSection): Route {
  const id = uuidSchema.parse(boardId);
  return `/boards?board=${encodeURIComponent(id)}&section=${section}` as Route;
}

/**
 * A Board's one address (BR41): Company has no id, a department's board names
 * its department, any other Board its id. Every other parameter of `search`
 * (a post, an event) is kept after the section.
 */
export function canonicalBoardUrl(
  board: { id: string; scope: BoardScope; departmentId: string | null },
  section: BoardSection,
  search = "",
): Route {
  const params = new URLSearchParams();
  if (board.scope === "department" && board.departmentId)
    params.set("department", board.departmentId);
  else if (board.scope !== "company") params.set("board", board.id);
  params.set("section", section);
  for (const [key, value] of new URLSearchParams(search))
    if (key !== "board" && key !== "department" && key !== "section")
      params.append(key, value);
  return `/boards?${params.toString()}` as Route;
}

/**
 * The one line a refused or unknown board shows (the Same Answer Rule). A
 * detail read that failed with it was refused; any other failure is
 * temporary and may be retried.
 */
export const BOARD_UNAVAILABLE =
  "It may have been removed, or you may not have access.";

export type ResourceState<T> = {
  key: string | null;
  sequence: number;
  data: T | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
};
export type ResourceEvent<T> =
  | { type: "begin"; key: string; sequence: number }
  | { type: "resolve"; key: string; sequence: number; data: T }
  | {
      type: "reject";
      key: string;
      sequence: number;
      error: string;
      denied: boolean;
    };

function emptyResource<T>(): ResourceState<T> {
  return { key: null, sequence: 0, data: null, status: "idle", error: null };
}

export function transitionResource<T>(
  state: ResourceState<T>,
  event: ResourceEvent<T>,
): ResourceState<T> {
  if (event.type === "begin") {
    return {
      key: event.key,
      sequence: event.sequence,
      data: state.key === event.key ? state.data : null,
      status: "loading",
      error: null,
    };
  }
  if (state.key !== event.key || state.sequence !== event.sequence)
    return state;
  if (event.type === "resolve")
    return { ...state, data: event.data, status: "ready", error: null };
  const data = event.denied ? null : state.data;
  return {
    ...state,
    data,
    status: data === null ? "error" : "ready",
    error: event.error,
  };
}

export function applyBoardMutationToDetail(
  state: ResourceState<BoardManagementBoard>,
  board: BoardManagementBoard,
  sequence: number,
): ResourceState<BoardManagementBoard> {
  if (
    state.key !== board.id ||
    state.data?.id !== board.id ||
    board.revision <= state.data.revision
  )
    return state;
  return { key: board.id, sequence, data: board, status: "ready", error: null };
}

function accessDenied(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

function authorizationDenied(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 401 || error.status === 403)
  );
}

type SequenceRef = { current: number };
type ResourceSetter<T> = (
  update: (current: ResourceState<T>) => ResourceState<T>,
) => void;

function invalidateBoardResourceAccess<L, D>(
  sequences: { list: SequenceRef; detail: SequenceRef },
  setters: {
    list: ResourceSetter<L>;
    detail: ResourceSetter<D>;
  },
): void {
  const listSequence = ++sequences.list.current;
  const detailSequence = ++sequences.detail.current;
  setters.list((current) => ({
    ...current,
    sequence: listSequence,
    data: null,
    status: "error",
    error: "Board access changed. Refresh the board list.",
  }));
  setters.detail((current) => ({
    ...current,
    sequence: detailSequence,
    data: null,
    status: "error",
    error: BOARD_UNAVAILABLE,
  }));
}

export function invalidateBoardResourcesIfAuthorizationDenied<L, D>(
  error: unknown,
  sequences: { list: SequenceRef; detail: SequenceRef },
  setters: {
    list: ResourceSetter<L>;
    detail: ResourceSetter<D>;
  },
): boolean {
  if (!authorizationDenied(error)) return false;
  invalidateBoardResourceAccess(sequences, setters);
  return true;
}

const LIST_KEY = "navigation";

export function useServerBoardsResource(route: BoardRoute) {
  const queryClient = useQueryClient();
  const [list, setList] =
    useState<ResourceState<BoardManagementPage>>(emptyResource);
  const [detail, setDetail] =
    useState<ResourceState<BoardManagementBoard>>(emptyResource);
  const [listRetry, setListRetry] = useState(0);
  const [detailRetry, setDetailRetry] = useState(0);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);

  const invalidateAccess = useCallback((error: unknown) => {
    return invalidateBoardResourcesIfAuthorizationDenied(
      error,
      { list: listSequence, detail: detailSequence },
      { list: setList, detail: setDetail },
    );
  }, []);

  const revokeAccess = useCallback(() => {
    invalidateBoardResourceAccess(
      { list: listSequence, detail: detailSequence },
      { list: setList, detail: setDetail },
    );
  }, []);

  const applyBoardMutation = useCallback((board: BoardManagementBoard) => {
    const sequence = ++detailSequence.current;
    setDetail((current) =>
      applyBoardMutationToDetail(current, board, sequence),
    );
  }, []);

  // The active boards by name, through the cache the sidebar reads (BR2), so
  // one read serves both. A first visit takes fresh cached data; a retry or a
  // live change reads again.
  const listLiveKey = useInvalidationRefresh(LIST_KEY, invalidatesBoardList);
  useEffect(() => {
    const sequence = ++listSequence.current;
    setList((current) =>
      transitionResource(current, { type: "begin", key: LIST_KEY, sequence }),
    );
    const options = boardsNavigationOptions();
    void queryClient
      .fetchQuery(
        listRetry + listLiveKey > 0 ? { ...options, staleTime: 0 } : options,
      )
      .then((data) => {
        if (sequence !== listSequence.current) return;
        setList((current) =>
          transitionResource(current, {
            type: "resolve",
            key: LIST_KEY,
            sequence,
            data,
          }),
        );
      })
      .catch((error: unknown) => {
        if (sequence !== listSequence.current) return;
        // The cache keeps the refusal, so the sidebar drops the names too.
        const denied = accessDenied(error);
        if (invalidateAccess(error)) return;
        setList((current) =>
          transitionResource(current, {
            type: "reject",
            key: LIST_KEY,
            sequence,
            error: "Could not refresh boards. Try again.",
            denied,
          }),
        );
        if (denied) {
          const detailRequest = ++detailSequence.current;
          setDetail((current) =>
            current.key
              ? {
                  ...current,
                  sequence: detailRequest,
                  data: null,
                  status: "error",
                  error: BOARD_UNAVAILABLE,
                }
              : current,
          );
        }
      });
    return () => {
      listSequence.current += 1;
    };
  }, [queryClient, listRetry, listLiveKey, invalidateAccess]);

  const listItems = list.data?.items ?? [];
  const listed = chooseBoardCandidate(route, listItems, detail.data);
  // A department's board that is not in the active list (an archived one) is
  // found by one read for that department.
  const departmentId = route.kind === "department" ? route.departmentId : null;
  const lookup = useQuery({
    queryKey: ["boards", "department", departmentId] as const,
    queryFn: () =>
      listBoards({
        scope: "department",
        departmentId: departmentId ?? undefined,
        status: "all",
        limit: 1,
      }),
    enabled: departmentId !== null && listed === null && list.data !== null,
    staleTime: 0,
  });
  const lookedUp =
    departmentId !== null && listed === null
      ? (lookup.data?.items.find(
          (board) => board.departmentId === departmentId,
        ) ?? null)
      : null;
  const candidate: BoardCandidate | null =
    listed ?? (lookedUp ? { id: lookedUp.id, source: "list" } : null);
  const candidateId = candidate?.id ?? null;
  const invalidatesDetail = useCallback(
    (event: WorkspaceInvalidation) =>
      event.type === "invalidate" &&
      event.entity === "boards" &&
      event.boardId === candidateId,
    [candidateId],
  );
  const detailLiveKey = useInvalidationRefresh(candidateId, invalidatesDetail);

  useEffect(() => {
    if (!candidateId) {
      detailSequence.current += 1;
      setDetail(emptyResource());
      return;
    }
    const sequence = ++detailSequence.current;
    setDetail((current) =>
      transitionResource(current, {
        type: "begin",
        key: candidateId,
        sequence,
      }),
    );
    void readBoard(candidateId)
      .then((data) => {
        if (sequence !== detailSequence.current) return;
        // The breadcrumb names the open Board from this cache.
        queryClient.setQueryData(boardsDetailKey(candidateId), data);
        setDetail((current) =>
          transitionResource(current, {
            type: "resolve",
            key: candidateId,
            sequence,
            data,
          }),
        );
      })
      .catch((error: unknown) => {
        if (sequence !== detailSequence.current) return;
        if (accessDenied(error))
          queryClient.removeQueries({
            queryKey: boardsDetailKey(candidateId),
            exact: true,
          });
        if (invalidateAccess(error)) return;
        if (accessDenied(error)) {
          setList((current) =>
            current.data?.items.some((board) => board.id === candidateId)
              ? {
                  ...current,
                  data: null,
                  status: "error",
                  error: "Board access changed. Refresh the board list.",
                }
              : current,
          );
        }
        setDetail((current) =>
          transitionResource(current, {
            type: "reject",
            key: candidateId,
            sequence,
            error: accessDenied(error)
              ? BOARD_UNAVAILABLE
              : "Could not refresh this board. Try again.",
            denied: accessDenied(error),
          }),
        );
      });
    return () => {
      detailSequence.current += 1;
    };
  }, [queryClient, candidateId, detailRetry, detailLiveKey, invalidateAccess]);

  const refresh = useCallback(() => {
    setListRetry((value) => value + 1);
    setDetailRetry((value) => value + 1);
  }, []);

  const departmentMissing =
    departmentId !== null &&
    listed === null &&
    (lookup.isError || (lookup.isSuccess && lookedUp === null));

  return {
    list,
    detail,
    candidate,
    /** A department's address names no Board this person can read. */
    departmentMissing,
    /** The open board's read was refused, so Retry cannot help. */
    detailDenied:
      detail.status === "error" && detail.error === BOARD_UNAVAILABLE,
    selectedBoard:
      candidateId && detail.key === candidateId ? detail.data : null,
    listItems,
    applyBoardMutation,
    refresh,
    revokeAccess,
  };
}
