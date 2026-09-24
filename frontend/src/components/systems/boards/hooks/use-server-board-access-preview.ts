"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import {
  getBoardAccessPreview,
  listBoardPreviewUsers,
  type BoardAccessPreview,
  type BoardPreviewUser,
  type BoardToolsPage,
} from "../adapters/board-tools-api";

const PAGE_SIZE = 25;

export type AccessPreviewState = {
  key: string | null;
  sequence: number;
  data: BoardAccessPreview | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
};

export type AccessPreviewEvent =
  | { type: "begin"; key: string; sequence: number }
  | { type: "resolve"; key: string; sequence: number; data: BoardAccessPreview }
  | { type: "reject"; key: string; sequence: number; error: string };

const emptyPreview: AccessPreviewState = {
  key: null,
  sequence: 0,
  data: null,
  status: "idle",
  error: null,
};

function isAccessDenied(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

export function transitionAccessPreview(
  state: AccessPreviewState,
  event: AccessPreviewEvent,
): AccessPreviewState {
  if (event.type === "begin")
    return {
      key: event.key,
      sequence: event.sequence,
      data: null,
      status: "loading",
      error: null,
    };
  if (state.key !== event.key || state.sequence !== event.sequence)
    return state;
  if (event.type === "resolve")
    return { ...state, data: event.data, status: "ready", error: null };
  return { ...state, data: null, status: "error", error: event.error };
}

type ReadState<T> = {
  key: string | null;
  status: "loading" | "ready" | "error";
  data: T | null;
  error: string | null;
};

export type BoardPreviewEligibility = {
  key: string | null;
  status: "loading" | "ready" | "error";
  error: string | null;
};

export type BoardPreviewEligibilityEvent =
  | { type: "begin"; key: string }
  | {
      type: "chooser-resolved";
      key: string;
      page: BoardToolsPage<BoardPreviewUser>;
    }
  | { type: "reject"; key: string; error: string };

export function transitionBoardPreviewEligibility(
  state: BoardPreviewEligibility,
  event: BoardPreviewEligibilityEvent,
): BoardPreviewEligibility {
  if (event.type === "begin")
    return { key: event.key, status: "loading", error: null };
  if (state.key !== event.key) return state;
  if (event.type === "chooser-resolved")
    return { key: event.key, status: "ready", error: null };
  return { key: event.key, status: "error", error: event.error };
}

type SelectedUser = {
  listKey: string;
  user: BoardPreviewUser;
  selection: number;
};

export function useServerBoardAccessPreview(
  boardId: string,
  refreshKey: number,
) {
  const [accessRetry, setAccessRetry] = useState(0);
  const [listRetry, setListRetry] = useState(0);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [selectedState, setSelectedState] = useState<SelectedUser | null>(null);
  const [accessState, setAccessState] = useState<BoardPreviewEligibility>({
    key: null,
    status: "loading",
    error: null,
  });
  const [usersState, setUsersState] = useState<
    ReadState<BoardToolsPage<BoardPreviewUser>>
  >({ key: null, status: "loading", data: null, error: null });
  const [previewState, setPreviewState] = useState(emptyPreview);
  const previewSequence = useRef(0);
  const selectionSequence = useRef(0);

  const accessKey = `${boardId}:${refreshKey}:${accessRetry}`;
  const access = accessState.key === accessKey ? accessState : null;
  const listKey = JSON.stringify([accessKey, search, offset, listRetry]);
  const canPreview = access?.status === "ready";
  const users = canPreview && usersState.key === listKey ? usersState : null;
  const page = users?.data;
  const selected =
    page && selectedState?.listKey === listKey
      ? (page.items.find((user) => user.id === selectedState.user.id) ?? null)
      : null;
  const previewKey =
    selected && selectedState
      ? JSON.stringify([listKey, selected.id, selectedState.selection])
      : null;
  const preview = previewState.key === previewKey ? previewState : emptyPreview;

  useEffect(() => {
    let active = true;
    setPreviewState(emptyPreview);
    setAccessState((current) =>
      current.key === accessKey
        ? current
        : transitionBoardPreviewEligibility(current, {
            type: "begin",
            key: accessKey,
          }),
    );
    setUsersState({ key: listKey, status: "loading", data: null, error: null });
    void listBoardPreviewUsers(boardId, {
      limit: PAGE_SIZE,
      offset,
      sortBy: "username",
      sortOrder: "asc",
      ...(search ? { search } : {}),
    })
      .then((data) => {
        if (active) {
          setUsersState({ key: listKey, status: "ready", data, error: null });
          setAccessState((current) =>
            transitionBoardPreviewEligibility(current, {
              type: "chooser-resolved",
              key: accessKey,
              page: data,
            }),
          );
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (isAccessDenied(error)) {
          setAccessState((current) =>
            transitionBoardPreviewEligibility(current, {
              type: "reject",
              key: accessKey,
              error:
                "Board access preview is unavailable. Refresh Board access.",
            }),
          );
          setUsersState({
            key: listKey,
            status: "error",
            data: null,
            error: null,
          });
          setPreviewState(emptyPreview);
          return;
        }
        setAccessState((current) =>
          current.key === accessKey && current.status === "ready"
            ? current
            : transitionBoardPreviewEligibility(current, {
                type: "reject",
                key: accessKey,
                error: "Could not check Board access. Refresh Board access.",
              }),
        );
        setUsersState({
          key: listKey,
          status: "error",
          data: null,
          error: "Could not load active people. Try again.",
        });
      });
    return () => {
      active = false;
    };
  }, [accessKey, boardId, listKey, offset, search]);

  useEffect(() => {
    if (!selected || !previewKey) return;
    let active = true;
    const sequence = ++previewSequence.current;
    setPreviewState((current) =>
      transitionAccessPreview(current, {
        type: "begin",
        key: previewKey,
        sequence,
      }),
    );
    void getBoardAccessPreview(boardId, selected.id)
      .then((data) => {
        if (!active) return;
        setPreviewState((current) =>
          transitionAccessPreview(current, {
            type: "resolve",
            key: previewKey,
            sequence,
            data,
          }),
        );
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (isAccessDenied(error)) {
          setAccessState((current) =>
            transitionBoardPreviewEligibility(current, {
              type: "reject",
              key: accessKey,
              error:
                "Board access preview is unavailable. Refresh Board access.",
            }),
          );
          setUsersState({
            key: listKey,
            status: "error",
            data: null,
            error: null,
          });
        }
        setPreviewState((current) =>
          transitionAccessPreview(current, {
            type: "reject",
            key: previewKey,
            sequence,
            error: isAccessDenied(error)
              ? "Board access preview is unavailable. Refresh Board access."
              : "Could not preview this person's Board access. Try again.",
          }),
        );
      });
    return () => {
      active = false;
    };
  }, [accessKey, boardId, listKey, previewKey, previewRetry, selected]);

  function submitSearch() {
    setSearch(searchInput.trim());
    setOffset(0);
    setSelectedState(null);
    setPreviewState(emptyPreview);
    setListRetry((value) => value + 1);
  }

  function chooseUser(userId: string) {
    const user = page?.items.find((item) => item.id === userId);
    setPreviewState(emptyPreview);
    setSelectedState(
      user ? { listKey, user, selection: ++selectionSequence.current } : null,
    );
  }

  function previousPage() {
    setSelectedState(null);
    setPreviewState(emptyPreview);
    setOffset((value) => Math.max(0, value - PAGE_SIZE));
  }

  function nextPage() {
    if (!page?.pagination.hasMore) return;
    setSelectedState(null);
    setPreviewState(emptyPreview);
    setOffset((value) => value + PAGE_SIZE);
  }

  return {
    access,
    canPreview,
    users,
    page,
    selected,
    preview,
    search,
    searchInput,
    setSearchInput,
    offset,
    submitSearch,
    chooseUser,
    previousPage,
    nextPage,
    retryAccess: () => setAccessRetry((value) => value + 1),
    retryUsers: () => setListRetry((value) => value + 1),
    retryPreview: () => setPreviewRetry((value) => value + 1),
  };
}
