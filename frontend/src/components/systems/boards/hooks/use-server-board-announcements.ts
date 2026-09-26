"use client";

import { useEffect, useRef, useState } from "react";
import { ApiContractError, ApiError } from "@/lib/api";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";
import { listBoardAnnouncements } from "../adapters/board-announcements-api";
import type {
  BoardAnnouncementListOptions,
  BoardAnnouncementPage,
} from "../adapters/board-announcements-api";
import {
  listBoardAnnouncementPersonal,
  putBoardAnnouncementBookmark,
  putBoardAnnouncementRead,
  type BoardAnnouncementPersonalState,
} from "../adapters/board-announcement-personal-api";
import {
  listBoardAnnouncementAuthors,
  type BoardAnnouncementAuthorChoice,
} from "../adapters/board-announcement-author-api";

export type AnnouncementAuthorsState = {
  key: string | null;
  sequence: number;
  data: BoardAnnouncementAuthorChoice[] | null;
  status: "idle" | "loading" | "ready" | "error" | "denied";
  error: string | null;
};

export type AnnouncementAuthorsEvent =
  | { type: "begin"; key: string; sequence: number }
  | {
      type: "resolve";
      key: string;
      sequence: number;
      data: BoardAnnouncementAuthorChoice[];
    }
  | {
      type: "reject";
      key: string;
      sequence: number;
      error: string;
      retain: boolean;
      denied: boolean;
    };

export const initialAnnouncementAuthorsState: AnnouncementAuthorsState = {
  key: null,
  sequence: 0,
  data: null,
  status: "idle",
  error: null,
};

export function transitionAnnouncementAuthors(
  state: AnnouncementAuthorsState,
  event: AnnouncementAuthorsEvent,
): AnnouncementAuthorsState {
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

export function visibleAnnouncementAuthorId(
  selectedId: string | null,
  choices: readonly BoardAnnouncementAuthorChoice[] | null,
): string | null {
  return selectedId && choices?.some((choice) => choice.id === selectedId)
    ? selectedId
    : null;
}

export function announcementAuthorChoiceFailure(error: unknown): {
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

export function useServerBoardAnnouncementAuthors(
  boardId: string,
  refreshKey: number,
) {
  const actorId = useVerifiedWorkspaceUserId();
  const [state, setState] = useState<AnnouncementAuthorsState>(
    initialAnnouncementAuthorsState,
  );
  const [retryKey, setRetryKey] = useState(0);
  const sequence = useRef(0);
  const key = JSON.stringify([boardId, actorId]);

  useEffect(() => {
    const request = ++sequence.current;
    setState((current) =>
      transitionAnnouncementAuthors(current, {
        type: "begin",
        key,
        sequence: request,
      }),
    );
    void listBoardAnnouncementAuthors(boardId)
      .then((data) => {
        if (request !== sequence.current) return;
        setState((current) =>
          transitionAnnouncementAuthors(current, {
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
          transitionAnnouncementAuthors(current, {
            type: "reject",
            key,
            sequence: request,
            ...announcementAuthorChoiceFailure(error),
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
            ...initialAnnouncementAuthorsState,
            key,
            status: "loading" as const,
          },
    retry: () => setRetryKey((value) => value + 1),
  };
}

export type AnnouncementPersonalById = Record<
  string,
  BoardAnnouncementPersonalState
>;

export type PublishedAnnouncementSort = "newest" | "oldest" | "title";
export type AnnouncementFeedQueryOptions = {
  limit: number;
  sortBy: NonNullable<BoardAnnouncementListOptions["sortBy"]>;
  sortOrder: NonNullable<BoardAnnouncementListOptions["sortOrder"]>;
};

export const defaultAnnouncementFeedQuery: AnnouncementFeedQueryOptions = {
  limit: 25,
  sortBy: "updated_at",
  sortOrder: "desc",
};

export function announcementFeedQueryForSort(
  sort: PublishedAnnouncementSort,
): Pick<AnnouncementFeedQueryOptions, "sortBy" | "sortOrder"> {
  switch (sort) {
    case "newest":
      return { sortBy: "updated_at", sortOrder: "desc" };
    case "oldest":
      return { sortBy: "updated_at", sortOrder: "asc" };
    case "title":
      return { sortBy: "title", sortOrder: "asc" };
  }
}

export type AnnouncementFeedState = {
  key: string | null;
  sequence: number;
  data: BoardAnnouncementPage | null;
  personal: AnnouncementPersonalById | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  pendingId: string | null;
  actionError: string | null;
};

export type AnnouncementFeedEvent =
  | { type: "begin"; key: string; sequence: number }
  | {
      type: "resolve";
      key: string;
      sequence: number;
      data: BoardAnnouncementPage;
      personal?: AnnouncementPersonalById;
    }
  | {
      type: "reject";
      key: string;
      sequence: number;
      error: string;
      retain: boolean;
    }
  | { type: "action-begin"; key: string; sequence: number; id: string }
  | {
      type: "action-resolve";
      key: string;
      sequence: number;
      state: BoardAnnouncementPersonalState;
    }
  | {
      type: "action-reject";
      key: string;
      sequence: number;
      error: string;
      clear: boolean;
    };

export function announcementFeedFailure(error: unknown): {
  error: string;
  retain: boolean;
} {
  const transient =
    error instanceof TypeError ||
    (error instanceof ApiError &&
      (error.status >= 500 || error.status === 408 || error.status === 429));
  return transient
    ? { error: "Could not refresh announcements. Try again.", retain: true }
    : {
        error: "Announcements unavailable. Check your access or try again.",
        retain: false,
      };
}

export function transitionAnnouncementFeed(
  state: AnnouncementFeedState,
  event: AnnouncementFeedEvent,
): AnnouncementFeedState {
  if (event.type === "begin")
    return {
      key: event.key,
      sequence: event.sequence,
      data: state.key === event.key ? state.data : null,
      personal: state.key === event.key ? state.personal : null,
      status: "loading",
      error: null,
      pendingId: null,
      actionError: state.key === event.key ? state.actionError : null,
    };
  if (state.key !== event.key || state.sequence !== event.sequence)
    return state;
  if (event.type === "resolve")
    return {
      ...state,
      data: event.data,
      personal: event.personal ?? null,
      status: "ready",
      error: null,
    };
  if (event.type === "action-begin")
    return { ...state, pendingId: event.id, actionError: null };
  if (event.type === "action-resolve") {
    const item = state.data?.items.find(
      (item) => item.id === event.state.announcementId,
    );
    if (!item || item.publicationNumber !== event.state.publicationNumber)
      return {
        ...state,
        pendingId: null,
        actionError: "Announcement changed. Refresh before saving.",
      };
    return {
      ...state,
      pendingId: null,
      actionError: null,
      personal: {
        ...state.personal,
        [event.state.announcementId]: event.state,
      },
    };
  }
  if (event.type === "action-reject")
    return {
      ...state,
      pendingId: null,
      actionError: event.error,
      data: event.clear ? null : state.data,
      personal: event.clear ? null : state.personal,
      status: event.clear ? "error" : state.status,
    };
  const data = event.retain ? state.data : null;
  return {
    ...state,
    data,
    personal: event.retain ? state.personal : null,
    status: data ? "ready" : "error",
    error: event.error,
    pendingId: null,
  };
}

const initialState: AnnouncementFeedState = {
  key: null,
  sequence: 0,
  data: null,
  personal: null,
  status: "idle",
  error: null,
  pendingId: null,
  actionError: null,
};

export function announcementFeedKey(
  boardId: string,
  offset: number,
  actorId: string,
  appliedSearch = "",
  authorId: string | null = null,
  options: AnnouncementFeedQueryOptions = defaultAnnouncementFeedQuery,
): string {
  return JSON.stringify([
    boardId,
    actorId,
    offset,
    normalizePublishedAnnouncementSearch(appliedSearch),
    authorId,
    options.limit,
    options.sortBy,
    options.sortOrder,
  ]);
}

export function normalizePublishedAnnouncementSearch(draft: string): string {
  return draft.slice(0, 100).trim();
}

export async function loadPublishedAnnouncementFeed(
  boardId: string,
  offset: number,
  onHidden: () => void = () => {},
  appliedSearch = "",
  authorId: string | null = null,
  options: AnnouncementFeedQueryOptions = defaultAnnouncementFeedQuery,
): Promise<{
  page: BoardAnnouncementPage;
  personal: AnnouncementPersonalById;
}> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const page = await listBoardAnnouncements(boardId, {
      view: "published",
      limit: options.limit,
      offset,
      sortBy: options.sortBy,
      sortOrder: options.sortOrder,
      search: normalizePublishedAnnouncementSearch(appliedSearch) || undefined,
      authorId: authorId ?? undefined,
    });
    const ids = page.items.map((item) => item.id);
    if (ids.length === 0) return { page, personal: {} };
    try {
      const states = await listBoardAnnouncementPersonal(boardId, ids);
      if (
        states.some(
          (state, index) =>
            state.publicationNumber !== page.items[index].publicationNumber,
        )
      )
        throw new ApiContractError();
      return {
        page,
        personal: Object.fromEntries(
          states.map((state) => [state.announcementId, state]),
        ),
      };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404 && attempt === 0) {
        onHidden();
        continue;
      }
      throw error;
    }
  }
  throw new ApiContractError();
}

export function useServerBoardAnnouncements(
  boardId: string,
  offset: number,
  refreshKey: number,
  appliedSearch = "",
  authorId: string | null = null,
  enabled = true,
  options: AnnouncementFeedQueryOptions = defaultAnnouncementFeedQuery,
) {
  const actorId = useVerifiedWorkspaceUserId();
  const [state, setState] = useState<AnnouncementFeedState>(initialState);
  const [retryKey, setRetryKey] = useState(0);
  const sequence = useRef(0);
  const pending = useRef(false);
  const normalizedSearch = normalizePublishedAnnouncementSearch(appliedSearch);
  const key = announcementFeedKey(
    boardId,
    offset,
    actorId,
    normalizedSearch,
    authorId,
    options,
  );

  useEffect(() => {
    if (!enabled) {
      pending.current = false;
      sequence.current += 1;
      setState(initialState);
      return;
    }
    pending.current = false;
    const request = ++sequence.current;
    setState((current) =>
      transitionAnnouncementFeed(current, {
        type: "begin",
        key,
        sequence: request,
      }),
    );
    void loadPublishedAnnouncementFeed(
      boardId,
      offset,
      () => {
        if (request !== sequence.current) return;
        setState((current) =>
          transitionAnnouncementFeed(current, {
            type: "reject",
            key,
            sequence: request,
            retain: false,
            error: "An announcement changed. Refreshing the current page…",
          }),
        );
      },
      normalizedSearch,
      authorId,
      options,
    )
      .then(({ page, personal }) => {
        if (request !== sequence.current) return;
        setState((current) =>
          transitionAnnouncementFeed(current, {
            type: "resolve",
            key,
            sequence: request,
            data: page,
            personal,
          }),
        );
      })
      .catch((error: unknown) => {
        if (request !== sequence.current) return;
        setState((current) =>
          transitionAnnouncementFeed(current, {
            type: "reject",
            key,
            sequence: request,
            ...announcementFeedFailure(error),
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

  async function toggle(
    id: string,
    publicationNumber: number,
    flag: "read" | "bookmark",
    value: boolean,
  ): Promise<void> {
    const item = state.data?.items.find((entry) => entry.id === id);
    if (
      pending.current ||
      !enabled ||
      state.key !== key ||
      state.status !== "ready" ||
      !item ||
      item.publicationNumber !== publicationNumber ||
      state.personal?.[id]?.publicationNumber !== publicationNumber
    )
      return;
    pending.current = true;
    const request = sequence.current;
    setState((current) =>
      transitionAnnouncementFeed(current, {
        type: "action-begin",
        key,
        sequence: request,
        id,
      }),
    );
    try {
      const result =
        flag === "read"
          ? await putBoardAnnouncementRead(
              boardId,
              id,
              publicationNumber,
              value,
            )
          : await putBoardAnnouncementBookmark(
              boardId,
              id,
              publicationNumber,
              value,
            );
      if (request !== sequence.current) return;
      setState((current) =>
        transitionAnnouncementFeed(current, {
          type: "action-resolve",
          key,
          sequence: request,
          state: result,
        }),
      );
    } catch (error: unknown) {
      if (request !== sequence.current) return;
      const denied =
        error instanceof ApiError && [401, 403, 404].includes(error.status);
      const conflict = error instanceof ApiError && error.status === 409;
      setState((current) =>
        transitionAnnouncementFeed(current, {
          type: "action-reject",
          key,
          sequence: request,
          clear: denied || conflict,
          error: conflict
            ? "Published announcement changed. Review its current state before trying again."
            : denied
              ? "Announcement unavailable. Refreshing may update your access."
              : "Could not update announcement state. Try again.",
        }),
      );
      if (conflict || (error instanceof ApiError && error.status === 404))
        setRetryKey((current) => current + 1);
    } finally {
      if (request === sequence.current) pending.current = false;
    }
  }

  return {
    state: !enabled
      ? initialState
      : state.key === key
        ? state
        : { ...initialState, key, status: "loading" as const },
    retry: () => setRetryKey((value) => value + 1),
    toggleRead: (id: string, publicationNumber: number, read: boolean) =>
      void toggle(id, publicationNumber, "read", read),
    toggleBookmark: (
      id: string,
      publicationNumber: number,
      bookmarked: boolean,
    ) => void toggle(id, publicationNumber, "bookmark", bookmarked),
  };
}
