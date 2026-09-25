"use client";

import { useEffect, useRef, useState } from "react";
import { ApiContractError, ApiError } from "@/lib/api";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";
import {
  createBoardAnnouncement,
  listBoardAnnouncements,
  publishBoardAnnouncement,
  readBoardAnnouncement,
  scheduleBoardAnnouncement,
  updateBoardAnnouncement,
  type BoardAnnouncement,
} from "../adapters/board-announcements-api";
import type { BoardAttachmentVersions } from "../adapters/board-files-api";
import { getMyBoardAccess } from "../adapters/board-tools-api";
import type { AnnouncementEditorView } from "../components/server-backed-board-announcement-editor";
import {
  audienceInput,
  announcementCancellationPatch,
  announcementLocalScheduleValue,
  announcementPatchForForm,
  announcementScheduleTimeToUtc,
  dirty,
  editorFailure,
  editorStateForKey,
  emptyState,
  formFor,
  isDenial,
  resolveEditorRefresh,
  sameAnnouncementContent,
  scheduleTimeError,
  valid,
} from "./announcement-editor-state";
import type {
  AnnouncementEditorForm,
  AnnouncementEditorState,
} from "./announcement-editor-state";

export {
  announcementCancellationPatch,
  announcementLocalScheduleValue,
  announcementPatchForForm,
  announcementScheduleTimeToUtc,
  editorFailure,
  editorStateForKey,
  resolveEditorRefresh,
  validAnnouncementLinks,
} from "./announcement-editor-state";
export type {
  AnnouncementEditorForm,
  AnnouncementEditorState,
  AnnouncementScheduleTimeResult,
} from "./announcement-editor-state";

export function useServerBoardAnnouncementEditor({
  boardId,
  boardRevision,
  boardStatus,
  refreshKey,
  onPublished,
}: {
  boardId: string;
  boardRevision: number;
  boardStatus: "active" | "archived";
  refreshKey: number;
  onPublished?: (boardId: string) => void;
}) {
  const actorId = useVerifiedWorkspaceUserId();
  const key = `${boardId}:${actorId}:${boardStatus}`;
  const [state, setState] = useState<AnnouncementEditorState>(() =>
    emptyState(key, boardRevision),
  );
  const [offset, setOffset] = useState(0);
  const [retryKey, setRetryKey] = useState(0);
  const [deviceTimeZone, setDeviceTimeZone] = useState(
    "your device's local time zone",
  );
  const loadSequence = useRef(0);
  const mutationSequence = useRef(0);
  const operationPendingRef = useRef(false);
  const attachmentPendingRef = useRef(false);
  const recordLinkPendingRef = useRef(false);
  const mountedRef = useRef(false);
  const selectedRef = useRef<BoardAnnouncement | null>(null);
  const activeKeyRef = useRef(key);
  const publishKeyRef = useRef<{
    id: string;
    revision: number;
    key: string;
  } | null>(null);
  const current = editorStateForKey(state, key, boardRevision);

  useEffect(() => {
    try {
      const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (resolved) setDeviceTimeZone(resolved);
    } catch {
      setDeviceTimeZone("your device's local time zone");
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      mutationSequence.current += 1;
    };
  }, []);

  useEffect(() => {
    const request = ++loadSequence.current;
    const switched = activeKeyRef.current !== key;
    activeKeyRef.current = key;
    if (switched) {
      selectedRef.current = null;
      publishKeyRef.current = null;
      mutationSequence.current += 1;
      operationPendingRef.current = false;
      attachmentPendingRef.current = false;
      recordLinkPendingRef.current = false;
      setOffset(0);
    }
    if (boardStatus !== "active") {
      setState({ ...emptyState(key, boardRevision), status: "ready" });
      return;
    }
    setState((previous) => ({
      ...editorStateForKey(previous, key, boardRevision),
      status: "loading",
      error: null,
    }));
    void (async () => {
      try {
        const access = await getMyBoardAccess(boardId);
        if (!access.edit) {
          if (request !== loadSequence.current) return;
          selectedRef.current = null;
          setState({
            ...emptyState(key, boardRevision),
            status: "ready",
            access,
          });
          return;
        }
        const page = await listBoardAnnouncements(boardId, {
          view: "editable",
          limit: 25,
          offset,
          sortBy: "updated_at",
          sortOrder: "desc",
        });
        const selected = selectedRef.current;
        const verified = selected
          ? await readBoardAnnouncement(boardId, selected.id, "editable")
          : null;
        if (request !== loadSequence.current) return;
        if (verified && verified.authorId !== actorId && !access.manage) {
          selectedRef.current = null;
          setState({
            ...emptyState(key, page.boardRevision),
            status: "denied",
          });
          return;
        }
        selectedRef.current = verified;
        setState((previous) => {
          const scoped = editorStateForKey(previous, key, boardRevision);
          return resolveEditorRefresh(
            scoped,
            access,
            page,
            verified,
            selected !== null,
          );
        });
      } catch (error) {
        if (request !== loadSequence.current) return;
        if (isDenial(error)) selectedRef.current = null;
        setState((previous) => {
          const scoped = editorStateForKey(previous, key, boardRevision);
          const failed = editorFailure(scoped, error);
          return {
            ...failed,
            status: isDenial(error) ? "denied" : "error",
            access: null,
            page: null,
          };
        });
      }
    })();
    return () => {
      loadSequence.current += 1;
    };
  }, [
    actorId,
    boardId,
    boardRevision,
    boardStatus,
    key,
    offset,
    refreshKey,
    retryKey,
  ]);

  const access = current.access;
  const canEdit =
    boardStatus === "active" &&
    current.status === "ready" &&
    access?.edit === true;
  const canManage = access?.manage === true;
  const scheduleDirty =
    current.scheduleLocal !== announcementLocalScheduleValue(current.selected);
  const drafts = canEdit
    ? (current.page?.items.filter(
        (item) => canManage || item.authorId === actorId,
      ) ?? [])
    : [];
  const view: AnnouncementEditorView = {
    status: current.status,
    active: boardStatus === "active",
    canEdit,
    canManage,
    drafts,
    offset,
    total: canEdit ? (current.page?.pagination.total ?? 0) : 0,
    hasMore: canEdit ? (current.page?.pagination.hasMore ?? false) : false,
    selected: canEdit ? current.selected : null,
    form: canEdit ? current.form : null,
    dirty: dirty(current.form, current.selected),
    scheduleDirty,
    scheduleLocal: canEdit ? current.scheduleLocal : "",
    deviceTimeZone,
    scheduleError: canEdit ? current.scheduleError : null,
    pending:
      current.pending || current.attachmentPending || current.recordLinkPending,
    conflict: current.conflict,
    error: current.error,
    notice: canEdit ? current.notice : null,
    displayed: canEdit ? current.displayed : null,
  };

  function newDraft() {
    if (
      !canEdit ||
      current.pending ||
      attachmentPendingRef.current ||
      recordLinkPendingRef.current ||
      dirty(current.form, current.selected) ||
      scheduleDirty
    )
      return;
    selectedRef.current = null;
    publishKeyRef.current = null;
    setState((previous) => ({
      ...previous,
      selected: null,
      form: { title: "", body: "", links: [], audience: { kind: "author" } },
      scheduleLocal: "",
      scheduleError: null,
      displayed: null,
      conflict: false,
      error: null,
      notice: null,
    }));
  }

  function selectDraft(item: BoardAnnouncement) {
    if (
      !canEdit ||
      current.pending ||
      attachmentPendingRef.current ||
      recordLinkPendingRef.current ||
      dirty(current.form, current.selected) ||
      scheduleDirty ||
      item.boardId !== boardId
    )
      return;
    if (item.authorId !== actorId && !canManage) return;
    selectedRef.current = item;
    publishKeyRef.current = null;
    setState((previous) => ({
      ...previous,
      selected: item,
      form: formFor(item),
      scheduleLocal: announcementLocalScheduleValue(item),
      scheduleError: null,
      displayed: null,
      conflict: false,
      error: null,
      notice: null,
    }));
  }

  function changeForm(form: AnnouncementEditorForm) {
    if (
      !canEdit ||
      current.pending ||
      attachmentPendingRef.current ||
      recordLinkPendingRef.current ||
      current.form === null
    )
      return;
    setState((previous) =>
      previous.key === key ? { ...previous, form, error: null } : previous,
    );
  }

  async function save() {
    if (
      !canEdit ||
      current.pending ||
      attachmentPendingRef.current ||
      recordLinkPendingRef.current ||
      current.conflict ||
      operationPendingRef.current ||
      !valid(current.form)
    )
      return;
    const form = current.form;
    const selected = current.selected;
    if (selected && !dirty(form, selected)) return;
    if (selected && selected.authorId !== actorId && !canManage) return;
    const operation = ++mutationSequence.current;
    operationPendingRef.current = true;
    setState((previous) =>
      previous.key === key
        ? { ...previous, pending: true, error: null, notice: null }
        : previous,
    );
    try {
      const result = selected
        ? await updateBoardAnnouncement(
            boardId,
            selected.id,
            announcementPatchForForm(selected, form, current.boardRevision),
          )
        : await createBoardAnnouncement(boardId, {
            boardRevision: current.boardRevision,
            title: form.title,
            body: form.body,
            links: form.links,
            audience: audienceInput(form.audience),
          });
      const saved = await readBoardAnnouncement(boardId, result.id, "draft");
      if (operation !== mutationSequence.current) return;
      selectedRef.current = saved;
      publishKeyRef.current = null;
      setState((previous) =>
        previous.key === key
          ? {
              ...previous,
              selected: saved,
              form: formFor(saved),
              scheduleLocal: announcementLocalScheduleValue(saved),
              scheduleError: null,
              boardRevision: result.boardRevision,
              pending: false,
              conflict: false,
              error: null,
              notice: "Draft saved.",
            }
          : previous,
      );
      if (mountedRef.current && activeKeyRef.current === key)
        onPublished?.(boardId);
      setRetryKey((value) => value + 1);
    } catch (error) {
      if (operation !== mutationSequence.current) return;
      if (isDenial(error)) selectedRef.current = null;
      setState((previous) =>
        previous.key === key ? editorFailure(previous, error) : previous,
      );
    } finally {
      if (operation === mutationSequence.current)
        operationPendingRef.current = false;
    }
  }

  async function schedule() {
    const selected = current.selected;
    const form = current.form;
    if (
      !canEdit ||
      current.pending ||
      attachmentPendingRef.current ||
      recordLinkPendingRef.current ||
      current.conflict ||
      operationPendingRef.current ||
      !selected ||
      selected.announcementRevision === null ||
      !form ||
      dirty(form, selected) ||
      (selected.authorId !== actorId && !canManage)
    )
      return;
    const converted = announcementScheduleTimeToUtc(
      current.scheduleLocal,
      Date.now(),
      selected.expiresAt,
    );
    if (!converted.ok) {
      setState((previous) =>
        previous.key === key
          ? { ...previous, scheduleError: scheduleTimeError(converted.reason) }
          : previous,
      );
      return;
    }
    if (
      selected.status === "scheduled" &&
      converted.publishAt === selected.publishAt
    )
      return;
    const operation = ++mutationSequence.current;
    operationPendingRef.current = true;
    setState((previous) =>
      previous.key === key
        ? {
            ...previous,
            pending: true,
            error: null,
            notice: null,
            scheduleError: null,
          }
        : previous,
    );
    try {
      const result = await scheduleBoardAnnouncement(boardId, selected.id, {
        boardRevision: current.boardRevision,
        announcementRevision: selected.announcementRevision,
        publishAt: converted.publishAt,
      });
      const saved = await readBoardAnnouncement(boardId, result.id, "draft");
      if (
        saved.status !== "scheduled" ||
        saved.publishAt === null ||
        Date.parse(saved.publishAt) !== Date.parse(converted.publishAt)
      )
        throw new ApiContractError();
      if (operation !== mutationSequence.current) return;
      selectedRef.current = saved;
      publishKeyRef.current = null;
      setState((previous) =>
        previous.key === key
          ? {
              ...previous,
              selected: saved,
              form: formFor(saved),
              scheduleLocal: announcementLocalScheduleValue(saved),
              scheduleError: null,
              boardRevision: result.boardRevision,
              pending: false,
              conflict: false,
              error: null,
              notice: "Publication scheduled.",
            }
          : previous,
      );
      if (mountedRef.current && activeKeyRef.current === key)
        onPublished?.(boardId);
      setRetryKey((value) => value + 1);
    } catch (error) {
      if (operation !== mutationSequence.current) return;
      if (isDenial(error)) selectedRef.current = null;
      setState((previous) => {
        if (previous.key !== key) return previous;
        const failed = editorFailure(previous, error);
        return {
          ...failed,
          scheduleError:
            error instanceof ApiError &&
            error.status === 422 &&
            error.code === "announcement_schedule_invalid"
              ? error.message
              : previous.scheduleError,
        };
      });
    } finally {
      if (operation === mutationSequence.current)
        operationPendingRef.current = false;
    }
  }

  async function cancelSchedule() {
    const selected = current.selected;
    const form = current.form;
    if (
      !canEdit ||
      current.pending ||
      attachmentPendingRef.current ||
      recordLinkPendingRef.current ||
      current.conflict ||
      operationPendingRef.current ||
      !selected ||
      selected.status !== "scheduled" ||
      selected.announcementRevision === null ||
      !form ||
      dirty(form, selected) ||
      scheduleDirty ||
      (selected.authorId !== actorId && !canManage)
    )
      return;
    const operation = ++mutationSequence.current;
    operationPendingRef.current = true;
    setState((previous) =>
      previous.key === key
        ? { ...previous, pending: true, error: null, notice: null }
        : previous,
    );
    try {
      const result = await updateBoardAnnouncement(
        boardId,
        selected.id,
        announcementCancellationPatch(selected, current.boardRevision),
      );
      const saved = await readBoardAnnouncement(boardId, result.id, "draft");
      if (saved.status !== "draft" || saved.publishAt !== null)
        throw new ApiContractError();
      if (operation !== mutationSequence.current) return;
      selectedRef.current = saved;
      publishKeyRef.current = null;
      setState((previous) =>
        previous.key === key
          ? {
              ...previous,
              selected: saved,
              form: formFor(saved),
              scheduleLocal: "",
              scheduleError: null,
              boardRevision: result.boardRevision,
              pending: false,
              conflict: false,
              error: null,
              notice:
                "Scheduled publication canceled. The draft is still available.",
            }
          : previous,
      );
      if (mountedRef.current && activeKeyRef.current === key)
        onPublished?.(boardId);
      setRetryKey((value) => value + 1);
    } catch (error) {
      if (operation !== mutationSequence.current) return;
      if (isDenial(error)) selectedRef.current = null;
      setState((previous) =>
        previous.key === key ? editorFailure(previous, error) : previous,
      );
    } finally {
      if (operation === mutationSequence.current)
        operationPendingRef.current = false;
    }
  }

  async function publish() {
    const selected = current.selected;
    if (
      !canEdit ||
      current.pending ||
      attachmentPendingRef.current ||
      recordLinkPendingRef.current ||
      current.conflict ||
      operationPendingRef.current ||
      scheduleDirty ||
      !selected ||
      selected.announcementRevision === null ||
      dirty(current.form, selected) ||
      (selected.authorId !== actorId && !canManage)
    )
      return;
    const operation = ++mutationSequence.current;
    operationPendingRef.current = true;
    const sameKey = publishKeyRef.current;
    const publicationKey =
      sameKey?.id === selected.id &&
      sameKey.revision === selected.announcementRevision
        ? sameKey.key
        : crypto.randomUUID();
    publishKeyRef.current = {
      id: selected.id,
      revision: selected.announcementRevision,
      key: publicationKey,
    };
    setState((previous) =>
      previous.key === key
        ? { ...previous, pending: true, error: null, notice: null }
        : previous,
    );
    try {
      const publication = await publishBoardAnnouncement(boardId, selected.id, {
        boardRevision: current.boardRevision,
        announcementRevision: selected.announcementRevision,
        publicationKey,
      });
      if (operation !== mutationSequence.current) return;
      selectedRef.current = null;
      publishKeyRef.current = null;
      let displayed: BoardAnnouncement | null = null;
      let notice = "Published successfully.";
      try {
        const currentDisplay = await readBoardAnnouncement(
          boardId,
          selected.id,
          "published",
        );
        if (currentDisplay.publicationNumber === publication.publicationNumber)
          displayed = currentDisplay;
        else
          notice =
            "Published, but a newer displayed revision is available. Refresh the feed.";
      } catch (error) {
        notice = isDenial(error)
          ? "Published, but the displayed revision is unavailable to your account."
          : "Published. The displayed revision could not be loaded; refresh the feed.";
      }
      if (operation !== mutationSequence.current) return;
      setState((previous) =>
        previous.key === key
          ? {
              ...previous,
              selected: null,
              form: null,
              scheduleLocal: "",
              scheduleError: null,
              displayed,
              pending: false,
              conflict: false,
              error: null,
              notice,
            }
          : previous,
      );
      if (mountedRef.current && activeKeyRef.current === key)
        onPublished?.(boardId);
      setRetryKey((value) => value + 1);
    } catch (error) {
      if (operation !== mutationSequence.current) return;
      if (isDenial(error)) selectedRef.current = null;
      setState((previous) =>
        previous.key === key ? editorFailure(previous, error) : previous,
      );
    } finally {
      if (operation === mutationSequence.current)
        operationPendingRef.current = false;
    }
  }

  function close() {
    if (
      !canEdit ||
      current.pending ||
      attachmentPendingRef.current ||
      recordLinkPendingRef.current
    )
      return;
    selectedRef.current = null;
    publishKeyRef.current = null;
    setState((previous) =>
      previous.key === key
        ? {
            ...previous,
            selected: null,
            form: null,
            scheduleLocal: "",
            scheduleError: null,
            boardRevision:
              previous.page?.boardRevision ?? previous.boardRevision,
            error: null,
            conflict: false,
          }
        : previous,
    );
  }

  function setAttachmentPending(pending: boolean) {
    attachmentPendingRef.current = pending;
    setState((previous) =>
      previous.key === key
        ? { ...previous, attachmentPending: pending }
        : previous,
    );
  }

  function setRecordLinkPending(pending: boolean) {
    recordLinkPendingRef.current = pending;
    setState((previous) =>
      previous.key === key
        ? { ...previous, recordLinkPending: pending }
        : previous,
    );
  }

  async function refreshAttachmentVersions(): Promise<BoardAttachmentVersions> {
    const selected = current.selected;
    if (
      !canEdit ||
      !selected ||
      selected.announcementRevision === null ||
      selected.boardId !== boardId
    )
      throw new ApiContractError();
    try {
      const latest = await readBoardAnnouncement(
        boardId,
        selected.id,
        "editable",
      );
      if (
        latest.announcementRevision === null ||
        !sameAnnouncementContent(selected, latest)
      ) {
        setState((previous) =>
          previous.key === key
            ? {
                ...previous,
                conflict: true,
                error:
                  "This draft changed while you were editing. Your text is retained; refresh drafts to review the latest version.",
              }
            : previous,
        );
        throw new ApiError(
          409,
          "Announcement content changed; review the latest version.",
        );
      }
      selectedRef.current = latest;
      setState((previous) =>
        previous.key === key && previous.selected?.id === selected.id
          ? {
              ...previous,
              selected: latest,
              boardRevision: latest.boardRevision,
              conflict: false,
              error: null,
            }
          : previous,
      );
      return {
        boardRevision: latest.boardRevision,
        contentRevision: latest.announcementRevision,
      };
    } catch (error) {
      if (isDenial(error)) {
        selectedRef.current = null;
        setState((previous) =>
          previous.key === key
            ? {
                ...emptyState(key, previous.boardRevision),
                status: "denied",
                error:
                  "Announcement editing is unavailable. Check your Board access.",
              }
            : previous,
        );
      } else if (!(error instanceof ApiError && error.status === 409)) {
        setState((previous) =>
          previous.key === key
            ? {
                ...previous,
                conflict: true,
                error:
                  "Could not check the latest draft version. Your text is retained; refresh drafts before continuing.",
              }
            : previous,
        );
      }
      throw error;
    }
  }

  return {
    view,
    newDraft,
    selectDraft,
    changeForm,
    changeScheduleTime: (scheduleLocal: string) => {
      if (!canEdit || current.pending || current.conflict || !current.selected)
        return;
      setState((previous) =>
        previous.key === key
          ? { ...previous, scheduleLocal, scheduleError: null }
          : previous,
      );
    },
    save,
    schedule,
    cancelSchedule,
    publish,
    setAttachmentPending,
    setRecordLinkPending,
    refreshAttachmentVersions,
    retry: () => setRetryKey((value) => value + 1),
    close,
    page: (nextOffset: number) => setOffset(Math.max(0, nextOffset)),
  };
}
