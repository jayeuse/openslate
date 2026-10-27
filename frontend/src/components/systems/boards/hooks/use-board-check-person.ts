"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import {
  getBoardAccessPreview,
  listBoardPreviewUsers,
  type BoardAccessPreview,
  type BoardPreviewUser,
} from "../adapters/board-tools-api";

const PAGE_SIZE = 25;
export const CHECK_PERSON_UNAVAILABLE = "Check a person is unavailable.";

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

/** A person's level, one read at a time: a newer pick wins, older answers drop. */
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

type Choices = {
  key: string;
  items: BoardPreviewUser[];
  nextOffset: number;
  hasMore: boolean;
};

/**
 * Check a person (BR28): one people search over the board's preview list,
 * then the picked person's level on this board. The board's managers alone
 * may read either, so a refusal turns the whole check off.
 */
export function useBoardCheckPerson(boardId: string, refreshKey: number) {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState<{ key: string; offset: number } | null>(
    null,
  );
  const [listRetry, setListRetry] = useState(0);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [selected, setSelected] = useState<{
    user: BoardPreviewUser;
    sequence: number;
  } | null>(null);
  const [preview, setPreview] = useState(emptyPreview);
  const previewSequence = useRef(0);
  const selectionSequence = useRef(0);

  const choicesKey = JSON.stringify([boardId, search.trim(), listRetry]);
  const currentOffset = offset?.key === choicesKey ? offset.offset : 0;
  const current = choices?.key === choicesKey ? choices : null;

  useEffect(() => {
    if (denied) return;
    let active = true;
    setLoading(true);
    setError(null);
    const trimmed = search.trim();
    const timer = setTimeout(
      () => {
        void listBoardPreviewUsers(boardId, {
          limit: PAGE_SIZE,
          offset: currentOffset,
          sortBy: "username",
          sortOrder: "asc",
          ...(trimmed ? { search: trimmed } : {}),
        })
          .then((page) => {
            if (!active) return;
            setChoices((previous) => ({
              key: choicesKey,
              items:
                currentOffset > 0 && previous?.key === choicesKey
                  ? [
                      ...new Map(
                        [...previous.items, ...page.items].map((user) => [
                          user.id,
                          user,
                        ]),
                      ).values(),
                    ]
                  : page.items,
              nextOffset: page.pagination.offset + page.pagination.count,
              hasMore: page.pagination.hasMore,
            }));
            setLoading(false);
          })
          .catch((failure: unknown) => {
            if (!active) return;
            setLoading(false);
            if (isAccessDenied(failure)) {
              setDenied(true);
              setChoices(null);
              setSelected(null);
              setPreview(emptyPreview);
              return;
            }
            setError("People could not be loaded.");
          });
      },
      trimmed ? 200 : 0,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [boardId, choicesKey, currentOffset, denied, refreshKey, search]);

  const previewKey = selected
    ? JSON.stringify([boardId, selected.user.id, selected.sequence, refreshKey])
    : null;
  useEffect(() => {
    if (!selected || !previewKey || denied) return;
    let active = true;
    const sequence = ++previewSequence.current;
    setPreview((state) =>
      transitionAccessPreview(state, {
        type: "begin",
        key: previewKey,
        sequence,
      }),
    );
    void getBoardAccessPreview(boardId, selected.user.id)
      .then((data) => {
        if (!active) return;
        setPreview((state) =>
          transitionAccessPreview(state, {
            type: "resolve",
            key: previewKey,
            sequence,
            data,
          }),
        );
      })
      .catch((failure: unknown) => {
        if (!active) return;
        const refused = isAccessDenied(failure);
        if (refused) setDenied(true);
        setPreview((state) =>
          transitionAccessPreview(state, {
            type: "reject",
            key: previewKey,
            sequence,
            error: refused
              ? CHECK_PERSON_UNAVAILABLE
              : "This person's access could not be checked.",
          }),
        );
      });
    return () => {
      active = false;
    };
  }, [boardId, denied, previewKey, previewRetry, selected]);

  return {
    denied,
    search,
    setSearch: (value: string) => setSearch(value.slice(0, 100)),
    options: current?.items ?? [],
    loading: loading && currentOffset === 0,
    loadingMore: loading && currentOffset > 0,
    error,
    hasMore: current?.hasMore ?? false,
    loadMore: () => {
      if (current?.hasMore && !loading)
        setOffset({ key: choicesKey, offset: current.nextOffset });
    },
    retryList: () => setListRetry((value) => value + 1),
    selected: selected?.user ?? null,
    choose: (userId: string) => {
      const user =
        current?.items.find((item) => item.id === userId) ??
        (selected?.user.id === userId ? selected.user : null);
      setPreview(emptyPreview);
      setSelected(
        user ? { user, sequence: ++selectionSequence.current } : null,
      );
    },
    preview: preview.key === previewKey ? preview : emptyPreview,
    retryPreview: () => setPreviewRetry((value) => value + 1),
  };
}
