"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Route } from "next";
import { z } from "zod";
import { ApiError } from "@/lib/api";
import {
  listBoards,
  readBoard,
  type BoardManagementBoard,
  type BoardManagementPage,
  type BoardScope,
} from "../adapters/board-management-api";

const uuidSchema = z.string().uuid();
const SECTIONS = ["overview", "calendar", "posts"] as const;
export type BoardSection = (typeof SECTIONS)[number];
export type BoardListStatus = "active" | "archived" | "all";
export type BoardRoute =
  | { kind: "none"; section: BoardSection | null }
  | { kind: "board"; boardId: string; section: BoardSection | null }
  | { kind: "invalid-board"; section: BoardSection | null };
export type BoardCandidate = {
  id: string;
  source: "explicit" | "list";
};

export function parseBoardRoute(search: string): BoardRoute {
  const params = new URLSearchParams(search);
  const sections = params.getAll("section");
  const section =
    sections.length === 1 && SECTIONS.includes(sections[0] as BoardSection)
      ? (sections[0] as BoardSection)
      : null;
  const boards = params.getAll("board");
  if (boards.length === 0) return { kind: "none", section };
  if (boards.length !== 1 || !uuidSchema.safeParse(boards[0]).success)
    return { kind: "invalid-board", section };
  return { kind: "board", boardId: boards[0], section };
}

/**
 * Opens the Board in the address, else the company Board, else the first
 * active Board in the list.
 */
export function chooseBoardCandidate(
  route: BoardRoute,
  boards: readonly {
    id: string;
    scope: BoardScope;
    status: "active" | "archived";
  }[],
): BoardCandidate | null {
  if (route.kind === "invalid-board") return null;
  if (route.kind === "board") return { id: route.boardId, source: "explicit" };
  const active = boards.filter((board) => board.status === "active");
  const first =
    active.find((board) => board.scope === "company") ?? active[0] ?? null;
  return first ? { id: first.id, source: "list" } : null;
}

export function resolveBoardSection(route: BoardRoute): BoardSection {
  return route.section ?? "overview";
}

export function boardUrl(boardId: string, section: BoardSection): Route {
  const id = uuidSchema.parse(boardId);
  return `/boards?board=${encodeURIComponent(id)}&section=${section}` as Route;
}

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
    error: "Board access changed. Refresh the Board list.",
  }));
  setters.detail((current) => ({
    ...current,
    sequence: detailSequence,
    data: null,
    status: "error",
    error: "Board unavailable. Choose another Board or retry.",
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

export function boardListKey(
  status: BoardListStatus,
  offset: number,
  search: string | null,
  scope: BoardScope | null = null,
): string {
  return JSON.stringify([status, offset, search ?? "", scope ?? ""]);
}

export function useServerBoardsResource(
  route: BoardRoute,
  status: BoardListStatus,
  offset: number,
  search: string | null,
  scope: BoardScope | null,
) {
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

  const listKey = boardListKey(status, offset, search, scope);
  useEffect(() => {
    const sequence = ++listSequence.current;
    setList((current) =>
      transitionResource(current, { type: "begin", key: listKey, sequence }),
    );
    void listBoards({
      status,
      limit: 25,
      offset,
      ...(search ? { search } : {}),
      ...(scope ? { scope } : {}),
    })
      .then((data) => {
        if (sequence !== listSequence.current) return;
        setList((current) =>
          transitionResource(current, {
            type: "resolve",
            key: listKey,
            sequence,
            data,
          }),
        );
      })
      .catch((error: unknown) => {
        if (sequence !== listSequence.current) return;
        if (invalidateAccess(error)) return;
        const denied = accessDenied(error);
        setList((current) =>
          transitionResource(current, {
            type: "reject",
            key: listKey,
            sequence,
            error: "Could not refresh Boards. Try again.",
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
                  error: "Board unavailable. Choose another Board or retry.",
                }
              : current,
          );
        }
      });
    return () => {
      listSequence.current += 1;
    };
  }, [listKey, status, offset, search, scope, listRetry, invalidateAccess]);

  const listItems = list.key === listKey ? (list.data?.items ?? []) : [];
  const candidate = chooseBoardCandidate(route, listItems);
  const candidateId = candidate?.id ?? null;
  const candidateSource = candidate?.source ?? null;

  useEffect(() => {
    if (!candidateId || !candidateSource) {
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
        if (invalidateAccess(error)) return;
        if (accessDenied(error)) {
          setList((current) =>
            current.data?.items.some((board) => board.id === candidateId)
              ? {
                  ...current,
                  data: null,
                  status: "error",
                  error: "Board access changed. Refresh the Board list.",
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
              ? "Board unavailable. Choose another Board or retry."
              : "Could not refresh this Board. Try again.",
            denied: accessDenied(error),
          }),
        );
      });
    return () => {
      detailSequence.current += 1;
    };
  }, [candidateId, candidateSource, detailRetry, invalidateAccess]);

  const refresh = useCallback(() => {
    setListRetry((value) => value + 1);
    setDetailRetry((value) => value + 1);
  }, []);

  return {
    list,
    detail,
    candidate,
    selectedBoard:
      candidateId && detail.key === candidateId ? detail.data : null,
    listItems,
    applyBoardMutation,
    refresh,
    revokeAccess,
  };
}
