"use client";

import { useEffect, useRef, useState } from "react";
import { ApiContractError, ApiError } from "@/lib/api";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";
import { listBoardPosts } from "../adapters/board-posts-api";
import type {
  BoardPost,
  BoardPostListOptions,
  BoardPostPage,
} from "../adapters/board-posts-api";
import { postMatchesState, type PostListState } from "../domain/post-list";
import {
  listBoardPostAuthors,
  type BoardPostAuthorChoice,
  type BoardPostAuthorPage,
} from "../adapters/board-post-author-api";

export type PostAuthorsState = {
  key: string | null;
  sequence: number;
  data: BoardPostAuthorChoice[] | null;
  pagination: BoardPostAuthorPage["pagination"] | null;
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
      pagination?: BoardPostAuthorPage["pagination"];
      append?: boolean;
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
  pagination: null,
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
      pagination: state.key === event.key ? state.pagination : null,
      status: "loading",
      error: null,
    };
  if (state.key !== event.key || state.sequence !== event.sequence)
    return state;
  if (event.type === "resolve")
    return {
      ...state,
      data: event.append
        ? [
            ...new Map(
              [...(state.data ?? []), ...event.data].map((choice) => [
                choice.id,
                choice,
              ]),
            ).values(),
          ]
        : event.data,
      pagination: event.pagination ?? null,
      status: "ready",
      error: null,
    };
  const data = event.retain && !event.denied ? state.data : null;
  return {
    ...state,
    data,
    pagination: data ? state.pagination : null,
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

export function postAuthorChoiceFailure(
  error: unknown,
  subject: "choices" | "labels" = "choices",
): {
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
        error: `Author ${subject} unavailable. Check your access or retry.`,
        retain: false,
        denied: true,
      }
    : transient
      ? {
          error: `Could not refresh author ${subject}. Showing the last loaded ${subject === "choices" ? "options" : "labels"}.`,
          retain: true,
          denied: false,
        }
      : {
          error: `Author ${subject} unavailable. Retry.`,
          retain: false,
          denied: false,
        };
}

export function useServerBoardPostAuthors(
  boardId: string,
  refreshKey: number,
  search = "",
) {
  const actorId = useVerifiedWorkspaceUserId();
  const [state, setState] = useState<PostAuthorsState>(initialPostAuthorsState);
  const [retryKey, setRetryKey] = useState(0);
  const [readableKey, setReadableKey] = useState<string | null>(null);
  const [requestedPage, setRequestedPage] = useState<{
    key: string;
    offset: number;
  } | null>(null);
  const sequence = useRef(0);
  const scopeKey = JSON.stringify([boardId, actorId]);
  const key = JSON.stringify([boardId, actorId, search.trim()]);
  const pageKey = `${key}:${refreshKey}:${retryKey}`;
  const offset = requestedPage?.key === pageKey ? requestedPage.offset : 0;

  useEffect(() => {
    const request = ++sequence.current;
    const controller = new AbortController();
    setState((current) =>
      transitionPostAuthors(current, { type: "begin", key, sequence: request }),
    );
    const timer = setTimeout(
      () => {
        void listBoardPostAuthors(boardId, {
          limit: 25,
          offset,
          search,
          signal: controller.signal,
        })
          .then((page) => {
            if (request !== sequence.current || controller.signal.aborted)
              return;
            setReadableKey(scopeKey);
            setState((current) =>
              transitionPostAuthors(current, {
                type: "resolve",
                key,
                sequence: request,
                data: page.items,
                pagination: page.pagination,
                append: offset > 0,
              }),
            );
          })
          .catch((error: unknown) => {
            if (request !== sequence.current || controller.signal.aborted)
              return;
            const failure = postAuthorChoiceFailure(error);
            if (!failure.retain) setReadableKey(null);
            setState((current) =>
              transitionPostAuthors(current, {
                type: "reject",
                key,
                sequence: request,
                ...failure,
              }),
            );
          });
      },
      search ? 200 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
      sequence.current += 1;
    };
  }, [boardId, key, offset, refreshKey, retryKey, scopeKey, search]);

  const visibleState =
    state.key === key
      ? state
      : { ...initialPostAuthorsState, key, status: "loading" as const };
  return {
    state: visibleState,
    readyToRead: readableKey === scopeKey && visibleState.status !== "denied",
    loadingMore: offset > 0 && visibleState.status === "loading",
    retry: () => setRetryKey((value) => value + 1),
    loadMore: () => {
      const page = visibleState.pagination;
      if (visibleState.status === "ready" && page?.hasMore)
        setRequestedPage({ key: pageKey, offset: page.offset + page.count });
    },
  };
}

/** Current post labels are detail reads, independent of the author picker. */
export function useServerBoardPostAuthorLabels(
  boardId: string,
  refreshKey: number,
  authorIds: readonly string[],
  enabled: boolean,
) {
  const actorId = useVerifiedWorkspaceUserId();
  const key = JSON.stringify([boardId, actorId]);
  const idsKey = [...new Set(authorIds)].sort().join(",");
  const [state, setState] = useState<PostAuthorsState>(initialPostAuthorsState);
  const [retryKey, setRetryKey] = useState(0);
  const [refusedKey, setRefusedKey] = useState<string | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    const request = ++sequence.current;
    const controller = new AbortController();
    if (!enabled || !idsKey) {
      setState((current) =>
        current.key === key && current.status === "denied"
          ? current
          : initialPostAuthorsState,
      );
      return () => {
        controller.abort();
        sequence.current += 1;
      };
    }
    setState((current) =>
      transitionPostAuthors(current, { type: "begin", key, sequence: request }),
    );
    const read = async () => {
      const ids = idsKey.split(",");
      const choices: BoardPostAuthorChoice[] = [];
      for (let start = 0; start < ids.length; start += 100) {
        const page = await listBoardPostAuthors(boardId, {
          limit: 100,
          offset: 0,
          ids: ids.slice(start, start + 100),
          signal: controller.signal,
        });
        if (page.pagination.hasMore) throw new ApiContractError();
        choices.push(...page.items);
      }
      return choices;
    };
    void read()
      .then((data) => {
        if (request !== sequence.current || controller.signal.aborted) return;
        setRefusedKey(null);
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
        if (request !== sequence.current || controller.signal.aborted) return;
        const failure = postAuthorChoiceFailure(error, "labels");
        if (failure.denied) setRefusedKey(key);
        setState((current) =>
          transitionPostAuthors(current, {
            type: "reject",
            key,
            sequence: request,
            ...failure,
          }),
        );
      });
    return () => {
      controller.abort();
      sequence.current += 1;
    };
  }, [boardId, enabled, idsKey, key, refreshKey, retryKey]);

  return {
    state: !enabled
      ? initialPostAuthorsState
      : state.key === key
        ? state
        : idsKey
          ? { ...initialPostAuthorsState, key, status: "loading" as const }
          : initialPostAuthorsState,
    denied: refusedKey === key,
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
  state: PostListState = "published",
): string {
  return JSON.stringify([
    boardId,
    actorId,
    state,
    offset,
    normalizePublishedPostSearch(appliedSearch),
    authorId,
    options.limit,
    options.sortBy,
    options.sortOrder,
    state,
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

/** The most posts a board holds (`MAX_POSTS`), so a complete read ends. */
const DRAFT_COLLECTION_LIMIT = 500;
const DRAFT_COLLECTION_PAGE = 100;

/**
 * Scheduled and Drafts share the server's `draft` view, which has no status
 * filter. The complete collection is read (pages of 100, bounded by the
 * board's post limit) and split by status before paging, so each state's
 * totals and pages are its own.
 */
export async function loadDraftCollection(
  boardId: string,
  appliedSearch = "",
  authorId: string | null = null,
  options: Pick<
    PostFeedQueryOptions,
    "sortBy" | "sortOrder"
  > = defaultPostFeedQuery,
): Promise<{ items: BoardPost[]; boardRevision: number }> {
  const items: BoardPost[] = [];
  let boardRevision = 0;
  for (let offset = 0; offset < DRAFT_COLLECTION_LIMIT;) {
    const page = await listBoardPosts(boardId, {
      view: "draft",
      limit: DRAFT_COLLECTION_PAGE,
      offset,
      sortBy: options.sortBy,
      sortOrder: options.sortOrder,
      search: normalizePublishedPostSearch(appliedSearch) || undefined,
      authorId: authorId ?? undefined,
    });
    items.push(...page.items);
    boardRevision = page.boardRevision;
    if (!page.pagination.hasMore || page.pagination.count === 0) break;
    offset += page.pagination.count;
  }
  return { items, boardRevision };
}

/** One page of a complete collection, with the collection's own totals. */
export function pageOfCollection(
  items: readonly BoardPost[],
  boardRevision: number,
  offset: number,
  limit: number,
): BoardPostPage {
  const visible = items.slice(offset, offset + limit);
  return {
    items: visible,
    boardRevision,
    pagination: {
      limit,
      offset,
      count: visible.length,
      total: items.length,
      hasMore: offset + visible.length < items.length,
    },
  };
}

/** The page a list state shows (BR10). */
export async function loadPostList(
  boardId: string,
  state: PostListState,
  offset: number,
  appliedSearch = "",
  authorId: string | null = null,
  options: PostFeedQueryOptions = defaultPostFeedQuery,
): Promise<BoardPostPage> {
  if (state === "published")
    return loadPublishedPostFeed(
      boardId,
      offset,
      appliedSearch,
      authorId,
      options,
    );
  if (state === "archived")
    return listBoardPosts(boardId, {
      view: "archive",
      limit: options.limit,
      offset,
      sortBy: options.sortBy,
      sortOrder: options.sortOrder,
      search: normalizePublishedPostSearch(appliedSearch) || undefined,
      authorId: authorId ?? undefined,
    });
  const collection = await loadDraftCollection(
    boardId,
    appliedSearch,
    authorId,
    options,
  );
  return pageOfCollection(
    collection.items.filter((post) => postMatchesState(post, state)),
    collection.boardRevision,
    offset,
    options.limit,
  );
}

export function useServerBoardPosts(
  boardId: string,
  offset: number,
  refreshKey: number,
  appliedSearch = "",
  authorId: string | null = null,
  enabled = true,
  options: PostFeedQueryOptions = defaultPostFeedQuery,
  listState: PostListState = "published",
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
    listState,
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
    void loadPostList(
      boardId,
      listState,
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
    listState,
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
