"use client";

import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import type { WorkspaceRegion } from "@/lib/date-time";
import { readBoardEvent, type BoardEvent } from "../adapters/board-events-api";
import type { CrossBoardOccurrence } from "../adapters/board-my-calendar-api";
import type { MyCalendarBoard } from "../domain/my-calendar";
import type { EventSheetState } from "../components/board-event-sheet";
import {
  boardEventTimeLabel,
  boardOccurrenceTimeLabel,
} from "../components/server-board-calendar-display";

const UNAVAILABLE = "This event is unavailable or you no longer have access.";

/**
 * My calendar's event sheet (`?event=`): which board the event belongs to,
 * and the event's own read on that board. There is no board-less event
 * read, so the board comes from the chip that opened it, a save, or the
 * window read; an event none of them holds reads as unavailable.
 */
export function useMyCalendarSheet({
  viewerId,
  selectedEventId,
  occurrences,
  eventsReady,
  boardById,
  region,
}: {
  viewerId: string | null;
  selectedEventId: string | null;
  occurrences: readonly CrossBoardOccurrence[];
  eventsReady: boolean;
  boardById: ReadonlyMap<string, MyCalendarBoard>;
  region: WorkspaceRegion | undefined;
}) {
  const [eventBoards, setEventBoards] = useState<Record<string, string>>({});
  const [selectedOccurrence, setSelectedOccurrence] = useState<string | null>(
    null,
  );
  const [retryCount, setRetryCount] = useState(0);
  const listed = selectedEventId
    ? occurrences.find((item) => item.eventId === selectedEventId)
    : undefined;
  const boardId = selectedEventId
    ? (eventBoards[selectedEventId] ?? listed?.board.id ?? null)
    : null;
  const board = boardId ? (boardById.get(boardId) ?? null) : null;
  const key = `${viewerId}:${boardId}:${selectedEventId}:${retryCount}`;
  const [detail, setDetail] = useState<{
    key: string;
    event: BoardEvent | null;
    error: string | null;
    refused: boolean;
  } | null>(null);

  useEffect(() => {
    if (!viewerId || !selectedEventId || !boardId) {
      setDetail(null);
      return;
    }
    let active = true;
    void readBoardEvent(boardId, selectedEventId)
      .then((event) => {
        if (active) setDetail({ key, event, error: null, refused: false });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const refused =
          error instanceof ApiError && [401, 403, 404].includes(error.status);
        setDetail({
          key,
          event: null,
          error: refused ? UNAVAILABLE : "Could not load the event. Try again.",
          refused,
        });
      });
    return () => {
      active = false;
    };
  }, [boardId, key, selectedEventId, viewerId]);

  const current = detail?.key === key ? detail : null;
  const occurrence =
    occurrences.find(
      (item) =>
        item.id === selectedOccurrence && item.eventId === selectedEventId,
    ) ?? null;
  const event = current?.event ?? (current ? null : (listed?.event ?? null));
  const unresolved =
    selectedEventId !== null && boardId === null && eventsReady;
  const state: EventSheetState = unresolved
    ? { status: "error", message: UNAVAILABLE, retryable: false }
    : current?.error
      ? { status: "error", message: current.error, retryable: !current.refused }
      : event
        ? {
            status: "ready",
            event,
            when: occurrence
              ? boardOccurrenceTimeLabel({ ...occurrence, event }, region)
              : boardEventTimeLabel(event, region),
          }
        : { status: "loading" };

  return {
    board,
    event,
    state,
    /** An opened or saved event's board, so its sheet reads it there. */
    remember(eventId: string, eventBoardId: string, occurrenceKey?: string) {
      setEventBoards((value) => ({ ...value, [eventId]: eventBoardId }));
      setSelectedOccurrence(occurrenceKey ?? null);
    },
    retry: () => setRetryCount((value) => value + 1),
  };
}
