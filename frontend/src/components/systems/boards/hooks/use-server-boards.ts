"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Route } from "next";
import { z } from "zod";
import { ApiError } from "@/lib/api";
import {
  getBoardPersonalState,
  listBoards,
  readBoard,
  setBoardFavorite,
  setBoardHome,
  type BoardManagementBoard,
  type BoardManagementPage,
  type BoardPersonalState,
} from "../adapters/board-management-api";

const uuidSchema = z.string().uuid();
const SECTIONS = ["overview", "calendar", "announcements"] as const;
export type BoardSection = (typeof SECTIONS)[number];
export type BoardListStatus = "active" | "archived" | "all";
export type BoardRoute =
  | { kind: "none"; section: BoardSection | null }
  | { kind: "board"; boardId: string; section: BoardSection | null }
  | { kind: "invalid-board"; section: BoardSection | null };
export type BoardCandidate = {
  id: string;
  source: "explicit" | "home" | "list";
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

export function chooseBoardCandidate(
  route: BoardRoute,
  boards: readonly { id: string; status: "active" | "archived" }[],
  homeBoardId: string | null,
  rejectedHomeId: string | null,
): BoardCandidate | null {
  if (route.kind === "invalid-board") return null;
  if (route.kind === "board") return { id: route.boardId, source: "explicit" };
  if (homeBoardId && homeBoardId !== rejectedHomeId)
    return { id: homeBoardId, source: "home" };
  const firstActive = boards.find((board) => board.status === "active");
  return firstActive ? { id: firstActive.id, source: "list" } : null;
}

export function resolveBoardSection(
  route: BoardRoute,
  board: { defaultSection: BoardSection } | null,
): BoardSection {
  return route.section ?? board?.defaultSection ?? "overview";
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

function invalidateBoardResourceAccess<L, P, D>(
  sequences: { list: SequenceRef; personal: SequenceRef; detail: SequenceRef },
  setters: {
    list: ResourceSetter<L>;
    personal: ResourceSetter<P>;
    detail: ResourceSetter<D>;
  },
): void {
  const listSequence = ++sequences.list.current;
  const personalSequence = ++sequences.personal.current;
  const detailSequence = ++sequences.detail.current;
  setters.list((current) => ({
    ...current,
    sequence: listSequence,
    data: null,
    status: "error",
    error: "Board access changed. Refresh the Board list.",
  }));
  setters.personal((current) => ({
    ...current,
    sequence: personalSequence,
    data: null,
    status: "error",
    error: "Board preferences are unavailable. Retry to refresh them.",
  }));
  setters.detail((current) => ({
    ...current,
    sequence: detailSequence,
    data: null,
    status: "error",
    error: "Board unavailable. Choose another Board or retry.",
  }));
}

export function invalidateBoardResourcesIfAuthorizationDenied<L, P, D>(
  error: unknown,
  sequences: { list: SequenceRef; personal: SequenceRef; detail: SequenceRef },
  setters: {
    list: ResourceSetter<L>;
    personal: ResourceSetter<P>;
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
  departmentId: string | null = null,
  favoritesOnly = false,
): string {
  return JSON.stringify([
    status,
    offset,
    search ?? "",
    departmentId ?? "",
    favoritesOnly,
  ]);
}

export function useServerBoardsResource(
  route: BoardRoute,
  status: BoardListStatus,
  offset: number,
  search: string | null,
  departmentId: string | null,
  favoritesOnly: boolean,
) {
  const [list, setList] =
    useState<ResourceState<BoardManagementPage>>(emptyResource);
  const [personal, setPersonal] =
    useState<ResourceState<BoardPersonalState>>(emptyResource);
  const [detail, setDetail] =
    useState<ResourceState<BoardManagementBoard>>(emptyResource);
  const [rejectedHomeId, setRejectedHomeId] = useState<string | null>(null);
  const [listRetry, setListRetry] = useState(0);
  const [personalRetry, setPersonalRetry] = useState(0);
  const [detailRetry, setDetailRetry] = useState(0);
  const [preferencePending, setPreferencePending] = useState(false);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const listSequence = useRef(0);
  const personalSequence = useRef(0);
  const detailSequence = useRef(0);
  const pendingPreference = useRef(false);
  const mounted = useRef(false);

  const invalidateAccess = useCallback((error: unknown) => {
    return invalidateBoardResourcesIfAuthorizationDenied(
      error,
      {
        list: listSequence,
        personal: personalSequence,
        detail: detailSequence,
      },
      { list: setList, personal: setPersonal, detail: setDetail },
    );
  }, []);

  const revokeAccess = useCallback(() => {
    invalidateBoardResourceAccess(
      {
        list: listSequence,
        personal: personalSequence,
        detail: detailSequence,
      },
      { list: setList, personal: setPersonal, detail: setDetail },
    );
  }, []);

  const applyBoardMutation = useCallback((board: BoardManagementBoard) => {
    const sequence = ++detailSequence.current;
    setDetail((current) =>
      applyBoardMutationToDetail(current, board, sequence),
    );
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const listKey = boardListKey(
    status,
    offset,
    search,
    departmentId,
    favoritesOnly,
  );
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
      ...(departmentId ? { departmentId } : {}),
      favoritesOnly,
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
  }, [
    listKey,
    status,
    offset,
    search,
    departmentId,
    favoritesOnly,
    listRetry,
    invalidateAccess,
  ]);

  useEffect(() => {
    const sequence = ++personalSequence.current;
    setPersonal((current) =>
      transitionResource(current, {
        type: "begin",
        key: "personal",
        sequence,
      }),
    );
    void getBoardPersonalState()
      .then((data) => {
        if (sequence !== personalSequence.current) return;
        setPersonal((current) =>
          transitionResource(current, {
            type: "resolve",
            key: "personal",
            sequence,
            data,
          }),
        );
      })
      .catch((error: unknown) => {
        if (sequence !== personalSequence.current) return;
        if (invalidateAccess(error)) return;
        const denied = accessDenied(error);
        setPersonal((current) =>
          transitionResource(current, {
            type: "reject",
            key: "personal",
            sequence,
            error:
              "Board preferences could not be loaded. Retry to refresh them.",
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
      personalSequence.current += 1;
    };
  }, [personalRetry, invalidateAccess]);

  const personalResolved =
    personal.data !== null ||
    (personal.status !== "idle" && personal.status !== "loading");
  const listItems = list.key === listKey ? (list.data?.items ?? []) : [];
  const candidate =
    route.kind === "none" && !personalResolved
      ? null
      : chooseBoardCandidate(
          route,
          listItems,
          personal.data?.homeBoardId ?? null,
          rejectedHomeId,
        );
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
        if (candidateSource === "home" && data.status !== "active") {
          setRejectedHomeId(candidateId);
          return;
        }
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
        if (
          candidateSource === "home" &&
          error instanceof ApiError &&
          error.status === 404
        ) {
          setRejectedHomeId(candidateId);
          return;
        }
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
    setRejectedHomeId(null);
    setListRetry((value) => value + 1);
    setPersonalRetry((value) => value + 1);
    setDetailRetry((value) => value + 1);
  }, []);

  const updatePersonal = useCallback(
    async (
      targetBoardId: string | null,
      operation: () => Promise<BoardPersonalState>,
    ): Promise<boolean> => {
      if (pendingPreference.current) return false;
      pendingPreference.current = true;
      setPreferencePending(true);
      setPreferenceError(null);
      const sequence = ++personalSequence.current;
      setPersonal((current) =>
        transitionResource(current, {
          type: "begin",
          key: "personal",
          sequence,
        }),
      );
      try {
        const data = await operation();
        if (mounted.current && sequence === personalSequence.current) {
          setPersonal((current) =>
            transitionResource(current, {
              type: "resolve",
              key: "personal",
              sequence,
              data,
            }),
          );
        }
        return true;
      } catch (error) {
        if (mounted.current && sequence === personalSequence.current) {
          const denied = accessDenied(error);
          const globallyDenied = invalidateAccess(error);
          if (!globallyDenied) {
            setPersonal((current) =>
              transitionResource(current, {
                type: "reject",
                key: "personal",
                sequence,
                error: "Board preferences could not be saved. Try again.",
                denied,
              }),
            );
          }
          setPreferenceError(
            "Board preferences could not be saved. Try again.",
          );
          if (denied && !globallyDenied && targetBoardId) {
            const detailRequest = ++detailSequence.current;
            setDetail((current) =>
              current.key === targetBoardId
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
        }
        return false;
      } finally {
        pendingPreference.current = false;
        if (mounted.current) setPreferencePending(false);
      }
    },
    [invalidateAccess],
  );

  const saveFavorite = useCallback(
    async (boardId: string, favorite: boolean) => {
      const saved = await updatePersonal(boardId, () =>
        setBoardFavorite(boardId, favorite),
      );
      if (saved && mounted.current) setListRetry((value) => value + 1);
      return saved;
    },
    [updatePersonal],
  );
  const saveHome = useCallback(
    (boardId: string | null) =>
      updatePersonal(boardId, () => setBoardHome(boardId)),
    [updatePersonal],
  );

  return {
    list,
    personal,
    detail,
    candidate,
    selectedBoard:
      candidateId && detail.key === candidateId ? detail.data : null,
    listItems,
    preferencePending,
    preferenceError,
    applyBoardMutation,
    refresh,
    revokeAccess,
    saveFavorite,
    saveHome,
  };
}
