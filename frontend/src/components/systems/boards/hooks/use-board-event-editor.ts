"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";
import { reportDone } from "@/lib/feedback";
import {
  createBoardEvent,
  readBoardEvent,
  updateBoardEvent,
  type BoardEvent,
  type BoardEventOccurrencePage,
} from "../adapters/board-events-api";
import type { BoardAttachmentVersions } from "../adapters/board-files-api";
import { readBoard } from "../adapters/board-management-api";
import {
  BoardEventDraftError,
  boardEventDraftFromEvent,
  boardEventInputFromDraft,
  newBoardEventDraft,
  prepareBoardEventConflictRetry,
  type BoardEventDraft,
  type BoardEventLatestVersion,
} from "../components/server-backed-board-event-editor";
import type { CalendarState } from "./use-server-board-events";

export type BoardEventConflict = {
  eventId: string | null;
  status: "needs-check" | "checking" | "ready";
  latest: BoardEventLatestVersion | null;
};

function sameEventContent(left: BoardEvent, right: BoardEvent): boolean {
  return (
    left.id === right.id &&
    left.boardId === right.boardId &&
    left.authorId === right.authorId &&
    left.title === right.title &&
    left.details === right.details &&
    left.location === right.location &&
    JSON.stringify(left.links) === JSON.stringify(right.links) &&
    left.allDay === right.allDay &&
    left.startDate === right.startDate &&
    left.endDate === right.endDate &&
    left.startAt === right.startAt &&
    left.endAt === right.endAt &&
    left.timezoneName === right.timezoneName &&
    left.recurrence === right.recurrence &&
    left.repeatUntil === right.repeatUntil &&
    JSON.stringify(left.reminders) === JSON.stringify(right.reminders) &&
    left.archived === right.archived
  );
}

/** A draft without its revisions, to tell an edit from a refreshed base. */
function draftContent(draft: BoardEventDraft | null): string {
  return JSON.stringify(
    draft ? { ...draft, boardRevision: 0, eventRevision: 0 } : null,
  );
}

/**
 * The board calendar's event draft (BR21): its one owner. It holds the
 * draft, its base and starting form, the save and file/link pending guards,
 * the editor's error, and a revision conflict; it rechecks an open draft
 * when the board's events change, saves, and resolves conflicts. The
 * calendar passes in the events read and is told after a save or a denial.
 */
export function useBoardEventEditor({
  boardId,
  viewerId,
  boardActive,
  liveKey,
  canEdit,
  calendarPage,
  eventsState,
  retry,
  invalidate,
  onSaved,
  onAccessDenied,
}: {
  boardId: string;
  viewerId: string;
  boardActive: boolean;
  liveKey: number;
  /** The viewer may edit events on this board now. */
  canEdit: boolean;
  calendarPage: BoardEventOccurrencePage | null;
  eventsState: Pick<CalendarState, "status" | "error">;
  retry: () => void;
  invalidate: () => void;
  /** After Create or Save: the event sheet opens on the saved event. */
  onSaved: (eventId: string) => void;
  /**
   * A save or a file/link check was refused: the board's access changed.
   * `recheck` asks the calendar to read the viewer's access again.
   */
  onAccessDenied: (recheck: boolean) => void;
}) {
  const [draft, setDraft] = useState<BoardEventDraft | null>(null);
  const [draftBase, setDraftBase] = useState<BoardEvent | null>(null);
  // A new event's starting draft, to tell an edit from an untouched form.
  const [draftOrigin, setDraftOrigin] = useState<BoardEventDraft | null>(null);
  const liveDraft = useRef<{
    draft: BoardEventDraft | null;
    base: BoardEvent | null;
  }>({ draft: null, base: null });
  const consumedLiveKey = useRef<string | null>(null);
  const liveDraftRequest = useRef(0);
  const [pending, setPending] = useState(false);
  const [attachmentPending, setAttachmentPending] = useState(false);
  const attachmentPendingRef = useRef(false);
  const [recordLinkPending, setRecordLinkPending] = useState(false);
  const recordLinkPendingRef = useRef(false);
  const pendingRef = useRef(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<BoardEventConflict | null>(null);
  const invalidateRef = useRef(invalidate);
  const activeDraft = canEdit && draft?.boardId === boardId ? draft : null;

  useEffect(() => {
    liveDraft.current = { draft, base: draftBase };
  }, [draft, draftBase]);

  useEffect(() => {
    if (pending || attachmentPending || recordLinkPending) return;
    const signal = `${viewerId}:${boardId}:${liveKey}`;
    if (consumedLiveKey.current === signal) return;
    consumedLiveKey.current = signal;
    const selected = liveDraft.current.draft;
    if (
      !viewerId ||
      !boardActive ||
      !selected?.eventId ||
      selected.boardId !== boardId
    )
      return;
    const request = ++liveDraftRequest.current;
    void Promise.all([
      readBoardEvent(boardId, selected.eventId),
      readBoard(boardId),
    ])
      .then(([event, board]) => {
        const current = liveDraft.current;
        if (
          request !== liveDraftRequest.current ||
          !current.draft ||
          current.draft.eventId !== selected.eventId ||
          current.draft.eventRevision !== selected.eventRevision
        )
          return;
        if (
          event.id !== selected.eventId ||
          event.boardId !== boardId ||
          board.id !== boardId ||
          event.boardRevision !== board.revision
        ) {
          setEditorError(
            "Could not verify the latest event. Your draft is retained; try again.",
          );
          return;
        }
        if (event.revision < (current.draft.eventRevision ?? 0)) return;
        if (event.revision === current.draft.eventRevision) {
          setDraft((value) =>
            value?.eventId === event.id
              ? { ...value, boardRevision: board.revision }
              : value,
          );
          return;
        }
        const original = current.base && boardEventDraftFromEvent(current.base);
        const dirty =
          original === null ||
          JSON.stringify({
            ...current.draft,
            boardRevision: 0,
            eventRevision: 0,
          }) !==
            JSON.stringify({ ...original, boardRevision: 0, eventRevision: 0 });
        if (dirty || event.archived || board.status !== "active") {
          setConflict({
            eventId: event.id,
            status: "ready",
            latest: {
              boardId: board.id,
              boardRevision: board.revision,
              boardActive: board.status === "active",
              event,
            },
          });
        } else {
          setDraft(boardEventDraftFromEvent(event));
          setDraftBase(event);
          setConflict(null);
        }
      })
      .catch((failure: unknown) => {
        const current = liveDraft.current.draft;
        if (
          request !== liveDraftRequest.current ||
          current?.eventId !== selected.eventId ||
          current.eventRevision !== selected.eventRevision
        )
          return;
        if (
          failure instanceof ApiError &&
          [401, 403, 404].includes(failure.status)
        ) {
          setDraft(null);
          setDraftBase(null);
          setConflict(null);
          invalidateRef.current();
          setEditorError(
            "This event or Board is no longer available. The editor was closed.",
          );
        } else {
          setConflict({
            eventId: selected.eventId,
            status: "needs-check",
            latest: null,
          });
          setEditorError(
            "Could not check the latest version. Your draft is retained; try again.",
          );
        }
      });
    return () => {
      liveDraftRequest.current += 1;
    };
  }, [
    liveKey,
    boardId,
    viewerId,
    boardActive,
    pending,
    attachmentPending,
    recordLinkPending,
  ]);

  useEffect(() => {
    invalidateRef.current = invalidate;
  }, [invalidate]);

  useEffect(() => {
    // My calendar moves a new draft to the board chosen in its Board field,
    // and the board an edit opens on: a draft that already belongs to the
    // new board stays. A board's own calendar is keyed by its board.
    if (liveDraft.current.draft?.boardId === boardId) return;
    setDraft(null);
    setDraftBase(null);
    attachmentPendingRef.current = false;
    recordLinkPendingRef.current = false;
    setAttachmentPending(false);
    setRecordLinkPending(false);
    setEditorError(null);
    setConflict(null);
  }, [boardId]);

  useEffect(() => {
    if (!boardActive) {
      setDraft(null);
      setEditorError(null);
      setConflict(null);
    }
  }, [boardActive]);

  useEffect(() => {
    if (
      eventsState.status === "error" &&
      eventsState.error?.startsWith("Calendar unavailable.")
    ) {
      setDraft(null);
      setEditorError(null);
      setConflict(null);
    }
  }, [eventsState.error, eventsState.status]);

  async function saveEvent(draftToSave: BoardEventDraft | null = activeDraft) {
    if (
      !draftToSave ||
      pendingRef.current ||
      attachmentPendingRef.current ||
      recordLinkPendingRef.current ||
      draftToSave.boardId !== boardId
    )
      return;
    pendingRef.current = true;
    setPending(true);
    setEditorError(null);
    try {
      const input = boardEventInputFromDraft(draftToSave);
      let savedId: string;
      if (draftToSave.eventId !== null && "eventRevision" in input)
        savedId = (await updateBoardEvent(boardId, draftToSave.eventId, input))
          .id;
      else if (draftToSave.eventId === null && !("eventRevision" in input))
        savedId = (await createBoardEvent(boardId, input)).id;
      else throw new Error("Event editor state is invalid.");
      setDraft(null);
      setConflict(null);
      reportDone(draftToSave.eventId ? "Event saved." : "Event created.");
      retry();
      onSaved(savedId);
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        setDraft(null);
        setConflict(null);
        setEditorError("Your access changed. The event editor was closed.");
        onAccessDenied(true);
        invalidate();
      } else {
        if (error instanceof ApiError && error.status === 409)
          setConflict({
            eventId: draftToSave.eventId,
            status: "needs-check",
            latest: null,
          });
        setEditorError(
          error instanceof ApiError && error.status === 409
            ? `${apiErrorMessage(error, "Could not save the event.")} Your draft is retained. Check the latest version before choosing how to continue.`
            : error instanceof ApiError && error.status === 422
              ? `${apiErrorMessage(error, "Could not save the event.")} Your draft is retained; check the fields and try again.`
              : error instanceof BoardEventDraftError
                ? error.message
                : "Could not save the event. Your draft is still here; try again.",
        );
      }
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function refreshAttachmentVersions(): Promise<BoardAttachmentVersions> {
    const selected = activeDraft;
    if (!selected?.eventId)
      throw new ApiError(409, "Save the event before attaching files.");
    try {
      const [latestEvent, latestBoard] = await Promise.all([
        readBoardEvent(boardId, selected.eventId),
        readBoard(boardId),
      ]);
      const baseline =
        calendarPage?.items.find((item) => item.event.id === selected.eventId)
          ?.event ?? null;
      const latest: BoardEventLatestVersion = {
        boardId: latestBoard.id,
        boardRevision: latestBoard.revision,
        boardActive: latestBoard.status === "active",
        event: latestEvent,
      };
      if (
        latestBoard.id !== boardId ||
        latestEvent.id !== selected.eventId ||
        latestEvent.boardId !== boardId ||
        latestEvent.boardRevision !== latestBoard.revision ||
        !baseline ||
        !sameEventContent(baseline, latestEvent)
      ) {
        setConflict({
          eventId: selected.eventId,
          status: "ready",
          latest,
        });
        setEditorError(
          "The saved event changed while you were editing. Your draft is retained; review the latest version before continuing.",
        );
        throw new ApiError(
          409,
          "Event content changed; review the latest version.",
        );
      }
      const versions = {
        boardRevision: latestBoard.revision,
        contentRevision: latestEvent.revision,
      };
      setDraft((current) =>
        current?.eventId === selected.eventId
          ? {
              ...current,
              boardRevision: versions.boardRevision,
              eventRevision: versions.contentRevision,
            }
          : current,
      );
      retry();
      return versions;
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        setDraft(null);
        setConflict(null);
        setEditorError("Your access changed. The event editor was closed.");
        onAccessDenied(false);
        invalidate();
      }
      throw error;
    }
  }

  function changeAttachmentPending(value: boolean) {
    attachmentPendingRef.current = value;
    setAttachmentPending(value);
  }

  function changeRecordLinkPending(value: boolean) {
    recordLinkPendingRef.current = value;
    setRecordLinkPending(value);
  }

  async function checkLatestVersion() {
    if (
      !activeDraft ||
      !conflict ||
      pendingRef.current ||
      conflict.eventId !== activeDraft.eventId
    )
      return;
    pendingRef.current = true;
    setPending(true);
    setEditorError(null);
    setConflict({ ...conflict, status: "checking", latest: null });
    try {
      const latestEvent = activeDraft.eventId
        ? await readBoardEvent(boardId, activeDraft.eventId)
        : null;
      const latestBoard = await readBoard(boardId);
      const latest: BoardEventLatestVersion = {
        boardId: latestBoard.id,
        boardRevision: latestBoard.revision,
        boardActive: latestBoard.status === "active",
        event: latestEvent,
      };
      setConflict({ eventId: activeDraft.eventId, status: "ready", latest });
      setEditorError(
        !latest.boardActive
          ? "This Board is archived. Keep a copy of your draft and ask a Board manager to restore it."
          : latest.event?.archived
            ? "This event is archived. Keep a copy of your draft and ask a Board manager to restore it."
            : null,
      );
      retry();
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        setDraft(null);
        setConflict(null);
        setEditorError(
          "This event or Board is no longer available. The editor was closed.",
        );
        invalidate();
      } else {
        setConflict({
          eventId: activeDraft.eventId,
          status: "needs-check",
          latest: null,
        });
        setEditorError(
          "Could not check the latest version. Your draft is retained; try again.",
        );
      }
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  function loadLatestEvent() {
    if (!activeDraft || !conflict?.latest?.event || pendingRef.current) return;
    const latest = conflict.latest;
    const event = latest.event;
    if (!event) return;
    if (
      event.id !== activeDraft.eventId ||
      !latest.boardActive ||
      event.archived
    )
      return;
    setDraft({
      ...boardEventDraftFromEvent(event),
      boardRevision: latest.boardRevision,
    });
    setDraftBase(event);
    setConflict(null);
    setEditorError(null);
  }

  function retryWithLatestVersion() {
    if (!activeDraft || !conflict?.latest || pendingRef.current) return;
    try {
      const updated = prepareBoardEventConflictRetry(
        activeDraft,
        conflict.latest,
      );
      setDraft(updated);
      setConflict(null);
      setEditorError(null);
      void saveEvent(updated);
    } catch (error) {
      setEditorError(
        error instanceof BoardEventDraftError
          ? error.message
          : "The latest event cannot be used. Your draft is retained.",
      );
    }
  }

  /** Opens the editor on an event the viewer may edit. */
  function editEvent(event: BoardEvent) {
    setEditorError(null);
    setConflict(null);
    setDraft(boardEventDraftFromEvent(event));
    setDraftBase(event);
  }

  /** Opens the editor on a new event for the given day. */
  function newEvent(boardRevision: number, date: string) {
    setEditorError(null);
    setConflict(null);
    const next = newBoardEventDraft(boardId, boardRevision, date);
    setDraftOrigin(next);
    setDraftBase(null);
    setDraft(next);
  }

  /** Drops the draft without a word: the access or the board changed. */
  function dropDraft() {
    setDraft(null);
    setConflict(null);
  }

  const draftDirty =
    activeDraft !== null &&
    draftContent(activeDraft) !==
      draftContent(
        draftBase && activeDraft.eventId === draftBase.id
          ? boardEventDraftFromEvent(draftBase)
          : draftOrigin,
      );

  return {
    /** The draft the viewer may still edit; null when none or no longer. */
    activeDraft,
    /** Any draft, editable or not, for the board's unsaved-changes guard. */
    hasDraft: draft !== null,
    draftDirty,
    pending,
    attachmentPending,
    recordLinkPending,
    editorError,
    setEditorError,
    conflict: activeDraft ? conflict : null,
    saveEvent,
    refreshAttachmentVersions,
    changeAttachmentPending,
    changeRecordLinkPending,
    checkLatestVersion,
    loadLatestEvent,
    retryWithLatestVersion,
    editEvent,
    newEvent,
    dropDraft,
    change: (patch: Partial<BoardEventDraft>) =>
      setDraft((current) => (current ? { ...current, ...patch } : null)),
    close: () => {
      setDraft(null);
      setEditorError(null);
      setConflict(null);
    },
  };
}
