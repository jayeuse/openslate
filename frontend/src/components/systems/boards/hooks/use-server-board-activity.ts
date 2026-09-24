"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { listBoardActivity } from "../adapters/board-tools-api";
import type {
  BoardActivity,
  BoardToolsPage,
} from "../adapters/board-tools-api";

export type BoardActivityState = {
  key: string | null;
  sequence: number;
  data: BoardToolsPage<BoardActivity> | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
};

export type BoardActivityEvent =
  | { type: "begin"; key: string; sequence: number }
  | {
      type: "resolve";
      key: string;
      sequence: number;
      data: BoardToolsPage<BoardActivity>;
    }
  | {
      type: "reject";
      key: string;
      sequence: number;
      error: string;
      retain: boolean;
    };

export function boardActivityFailure(error: unknown): {
  error: string;
  retain: boolean;
  denied: boolean;
} {
  const denied =
    error instanceof ApiError &&
    (error.status === 401 || error.status === 403 || error.status === 404);
  const transient =
    error instanceof TypeError ||
    (error instanceof ApiError &&
      (error.status >= 500 || error.status === 408 || error.status === 429));
  return transient
    ? {
        error: "Could not refresh activity. Try again.",
        retain: true,
        denied: false,
      }
    : {
        error: "Board activity is unavailable. Check your access or try again.",
        retain: false,
        denied,
      };
}

export function transitionBoardActivity(
  state: BoardActivityState,
  event: BoardActivityEvent,
): BoardActivityState {
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

const initialState: BoardActivityState = {
  key: null,
  sequence: 0,
  data: null,
  status: "idle",
  error: null,
};

export function useServerBoardActivity(
  boardId: string,
  offset: number,
  refreshKey: number,
  onAccessDenied: () => void,
) {
  const [state, setState] = useState<BoardActivityState>(initialState);
  const [retryKey, setRetryKey] = useState(0);
  const sequence = useRef(0);
  const key = `${boardId}:${offset}`;

  useEffect(() => {
    const request = ++sequence.current;
    setState((current) =>
      transitionBoardActivity(current, {
        type: "begin",
        key,
        sequence: request,
      }),
    );
    void listBoardActivity(boardId, {
      limit: 25,
      offset,
      sortBy: "created_at",
      sortOrder: "desc",
    })
      .then((data) => {
        if (request !== sequence.current) return;
        setState((current) =>
          transitionBoardActivity(current, {
            type: "resolve",
            key,
            sequence: request,
            data,
          }),
        );
      })
      .catch((error: unknown) => {
        if (request !== sequence.current) return;
        const failure = boardActivityFailure(error);
        setState((current) =>
          transitionBoardActivity(current, {
            type: "reject",
            key,
            sequence: request,
            error: failure.error,
            retain: failure.retain,
          }),
        );
        if (failure.denied) onAccessDenied();
      });
    return () => {
      sequence.current += 1;
    };
  }, [boardId, key, offset, refreshKey, retryKey, onAccessDenied]);

  return {
    state:
      state.key === key
        ? state
        : { ...initialState, key, status: "loading" as const },
    retry: () => setRetryKey((value) => value + 1),
  };
}
