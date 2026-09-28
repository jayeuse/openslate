"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";
import { listBoardPosts } from "../adapters/board-posts-api";
import type {
  BoardPostListOptions,
  BoardPostPage,
} from "../adapters/board-posts-api";
import {
  listBoardPostAuthors,
  type BoardPostAuthorChoice,
} from "../adapters/board-post-author-api";

export type PostAuthorsState = {
  key: string | null;
  sequence: number;
  data: BoardPostAuthorChoice[] | null;
  status: "idle" | "loading" | "ready" | "error" | "denied";
  error: string | null;
};

export type PostAuthorsEvent =
  | { type: "begin"; key: string; sequence: number }
  | {
      type: "resolve";
      key: string;
      sequence: number;
      data: BoardPostAuthorChoice[];
    }
  | {
      type: "reject";
      key: string;
      sequence: number;
      error: string;
      retain: boolean;
      denied: boolean;
    };

export const initialPostAuthorsState: PostAuthorsState = {
  key: null,
  sequence: 0,
  data: null,
  status: "idle",
  error: null,
};

export function transitionPostAuthors(
  state: PostAuthorsState,
  event: PostAuthorsEvent,
): PostAuthorsState {
  if (event.type === "begin")
    return {
      key: event.key,
      sequence: event.sequence,
      data: state.key === event.key ? state.data : null,
      status: "loading",
      error: null,
    };
  if (state.key !== event.key || state.sequence !== event.sequence)
    return state;
  if (event.type === "resolve")
    return { ...state, data: event.data, status: "ready", error: null };
  const data = event.retain && !event.denied ? state.data : null;
  return {
    ...state,
    data,
    status: event.denied ? "denied" : data ? "ready" : "error",
    error: event.error,
  };
}

export function visiblePostAuthorId(
  selectedId: string | null,
  choices: readonly BoardPostAuthorChoice[] | null,
): string | null {
  return selectedId && choices?.some((choice) => choice.id === selectedId)
    ? selectedId
    : null;
}

export function postAuthorChoiceFailure(error: unknown): {
  error: string;
  retain: boolean;
  denied: boolean;
} {
  const denied =
    error instanceof ApiError && [401, 403, 404].includes(error.status);
  const transient =
    error instanceof TypeError ||
    (error instanceof ApiError &&
      (error.status >= 500 || error.status === 408 || error.status === 429));
  return denied
    ? {
        error: "Author choices unavailable. Check your access or retry.",
        retain: false,
        denied: true,
      }
    : transient
      ? {
          error:
            "Could not refresh author choices. Showing the last loaded options.",
          retain: true,
          denied: false,
        }
      : {
          error: "Author choices unavailable. Retry.",
          retain: false,
          denied: false,
        };
}

export function useServerBoardPostAuthors(boardId: string, refreshKey: number) {
  const actorId = useVerifiedWorkspaceUserId();
  const [state, setState] = useState<PostAuthorsState>(initialPostAuthorsState);
  const [retryKey, setRetryKey] = useState(0);
  const sequence = useRef(0);
  const key = JSON.stringify([boardId, actorId]);

  useEffect(() => {
    const request = ++sequence.current;
    setState((current) =>
      transitionPostAuthors(current, {
        type: "begin",
        key,
        sequence: request,
      }),
    );
    void listBoardPostAuthors(boardId)
      .then((data) => {
        if (request !== sequence.current) return;
        setState((current) =>
          transitionPostAuthors(current, {
            type: "resolve",
            key,
            sequence: request,
            data,
          }),
        );
      })
      .catch((error: unknown) => {
        if (request !== sequence.current) return;
        setState((current) =>
          transitionPostAuthors(current, {
            type: "reject",
            key,
            sequence: request,
            ...postAuthorChoiceFailure(error),
          }),
        );
      });
    return () => {
      sequence.current += 1;
    };
  }, [actorId, boardId, key, refreshKey, retryKey]);

  return {
    state:
      state.key === key
        ? state
        : {
            ...initialPostAuthorsState,
            key,
            status: "loading" as const,
          },
    retry: () => setRetryKey((value) => value + 1),
  };
}

export type PublishedPostSort = "newest" | "oldest" | "title";
export type PostFeedQueryOptions = {
  limit: number;
  sortBy: NonNullable<BoardPostListOptions["sortBy"]>;
  sortOrder: NonNullable<BoardPostListOptions["sortOrder"]>;
};

export const defaultPostFeedQuery: PostFeedQueryOptions = {
  limit: 25,
  sortBy: "updated_at",
  sortOrder: "desc",
};

export function postFeedQueryForSort(
  sort: PublishedPostSort,
): Pick<PostFeedQueryOptions, "sortBy" | "sortOrder"> {
  switch (sort) {
    case "newest":
      return { sortBy: "updated_at", sortOrder: "desc" };
    case "oldest":
      return { sortBy: "updated_at", sortOrder: "asc" };
    case "title":
      return { sortBy: "title", sortOrder: "asc" };
  }
}

export type PostFeedState = {
  key: string | null;
  sequence: number;
  data: BoardPostPage | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
};

export type PostFeedEvent =
  | { type: "begin"; key: string; sequence: number }
  | {
      type: "resolve";
      key: string;
      sequence: number;
      data: BoardPostPage;
    }
  | {
      type: "reject";
      key: string;
      sequence: number;
      error: string;
      retain: boolean;
    };

export function postFeedFailure(error: unknown): {
  error: string;
  retain: boolean;
} {
  const transient =
    error instanceof TypeError ||
    (error instanceof ApiError &&
      (error.status >= 500 || error.status === 408 || error.status === 429));
  return transient
    ? { error: "Could not refresh posts. Try again.", retain: true }
    : {
        error: "Posts unavailable. Check your access or try again.",
        retain: false,
      };
}

export function transitionPostFeed(
  state: PostFeedState,
  event: PostFeedEvent,
): PostFeedState {
  if (event.type === "begin")
    return {
      key: event.key,
      sequence: event.sequence,
      data: state.key === event.key ? state.data : null,
      status: "loading",
      error: null,
    };
  if (state.key !== event.key || state.sequence !== event.sequence)
    return state;
  if (event.type === "resolve")
    return { ...state, data: event.data, status: "ready", error: null };
  const data = event.retain ? state.data : null;
  return {
    ...state,
    data,
    status: data ? "ready" : "error",
    error: event.error,
  };
}

const initialState: PostFeedState = {
  key: null,
  sequence: 0,
  data: null,
  status: "idle",
  error: null,
};

export function postFeedKey(
  boardId: string,
  offset: number,
  actorId: string,
  appliedSearch = "",
  authorId: string | null = null,
  options: PostFeedQueryOptions = defaultPostFeedQuery,
): string {
  return JSON.stringify([
    boardId,
    actorId,
    offset,
    normalizePublishedPostSearch(appliedSearch),
    authorId,
    options.limit,
    options.sortBy,
    options.sortOrder,
  ]);
}

export function normalizePublishedPostSearch(draft: string): string {
  return draft.slice(0, 100).trim();
}

export async function loadPublishedPostFeed(
  boardId: string,
  offset: number,
  appliedSearch = "",
  authorId: string | null = null,
  options: PostFeedQueryOptions = defaultPostFeedQuery,
): Promise<BoardPostPage> {
  return listBoardPosts(boardId, {
    view: "published",
    limit: options.limit,
    offset,
    sortBy: options.sortBy,
    sortOrder: options.sortOrder,
    search: normalizePublishedPostSearch(appliedSearch) || undefined,
    authorId: authorId ?? undefined,
  });
}

export function useServerBoardPosts(
  boardId: string,
  offset: number,
  refreshKey: number,
  appliedSearch = "",
  authorId: string | null = null,
  enabled = true,
  options: PostFeedQueryOptions = defaultPostFeedQuery,
) {
  const actorId = useVerifiedWorkspaceUserId();
  const [state, setState] = useState<PostFeedState>(initialState);
  const [retryKey, setRetryKey] = useState(0);
  const sequence = useRef(0);
  const normalizedSearch = normalizePublishedPostSearch(appliedSearch);
  const key = postFeedKey(
    boardId,
    offset,
    actorId,
    normalizedSearch,
    authorId,
    options,
  );

  useEffect(() => {
    if (!enabled) {
      sequence.current += 1;
      setState(initialState);
      return;
    }
    const request = ++sequence.current;
    setState((current) =>
      transitionPostFeed(current, {
        type: "begin",
        key,
        sequence: request,
      }),
    );
    void loadPublishedPostFeed(
      boardId,
      offset,
      normalizedSearch,
      authorId,
      options,
    )
      .then((page) => {
        if (request !== sequence.current) return;
        setState((current) =>
          transitionPostFeed(current, {
            type: "resolve",
            key,
            sequence: request,
            data: page,
          }),
        );
      })
      .catch((error: unknown) => {
        if (request !== sequence.current) return;
        setState((current) =>
          transitionPostFeed(current, {
            type: "reject",
            key,
            sequence: request,
            ...postFeedFailure(error),
          }),
        );
      });
    return () => {
      sequence.current += 1;
    };
  }, [
    actorId,
    authorId,
    boardId,
    enabled,
    key,
    normalizedSearch,
    offset,
    refreshKey,
    retryKey,
    options.limit,
    options.sortBy,
    options.sortOrder,
  ]);

  return {
    state: !enabled
      ? initialState
      : state.key === key
        ? state
        : { ...initialState, key, status: "loading" as const },
    retry: () => setRetryKey((value) => value + 1),
  };
}
