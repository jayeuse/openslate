"use client";

import { useEffect, useRef, useState } from "react";
import { ApiContractError, ApiError } from "@/lib/api";
import type { WorkspaceRegion } from "@/lib/date-time";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";
import {
  createBoardPost,
  listBoardPosts,
  publishBoardPost,
  readBoardPost,
  scheduleBoardPost,
  updateBoardPost,
  type BoardPost,
} from "../adapters/board-posts-api";
import type { BoardAttachmentVersions } from "../adapters/board-files-api";
import { getMyBoardAccess } from "../adapters/board-tools-api";
import type { PostEditorView } from "../components/server-backed-board-post-editor";
import {
  postCancellationPatch,
  postExpiryTimeToUtc,
  postLocalScheduleValue,
  postPatchForForm,
  postScheduleTimeToUtc,
  dirty,
  editorFailure,
  editorStateForKey,
  emptyState,
  formFor,
  isDenial,
  resolveEditorRefresh,
  samePostContent,
  scheduleTimeError,
  valid,
} from "./post-editor-state";
import type { PostEditorForm, PostEditorState } from "./post-editor-state";

export {
  postCancellationPatch,
  postLocalScheduleValue,
  postPatchForForm,
  postScheduleTimeToUtc,
  editorFailure,
  editorStateForKey,
  resolveEditorRefresh,
  validPostLinks,
} from "./post-editor-state";
export type {
  PostEditorForm,
  PostEditorState,
  PostScheduleTimeResult,
} from "./post-editor-state";

export function useServerBoardPostEditor({
  boardId,
  boardRevision,
  boardStatus,
  refreshKey,
  region,
  onPublished,
}: {
  boardId: string;
  boardRevision: number;
  boardStatus: "active" | "archived";
  refreshKey: number;
  /** Times are typed and shown in this zone; editing waits for it. */
  region: WorkspaceRegion | undefined;
  onPublished?: (boardId: string) => void;
}) {
  const actorId = useVerifiedWorkspaceUserId();
  const key = `${boardId}:${actorId}:${boardStatus}`;
  const [state, setState] = useState<PostEditorState>(() =>
    emptyState(key, boardRevision),
  );
  const [retryKey, setRetryKey] = useState(0);
  const zone = region?.timezone ?? null;
  // Until the region is read, nothing is open to edit, so no time was read
  // in another zone; the fallback only satisfies the types.
  const timezone = zone ?? "UTC";
  const timezoneRef = useRef(timezone);
  const loadSequence = useRef(0);
  const mutationSequence = useRef(0);
  const operationPendingRef = useRef(false);
  const deferredReload = useRef(false);
  const attachmentPendingRef = useRef(false);
  const recordLinkPendingRef = useRef(false);
  const mountedRef = useRef(false);
  const selectedRef = useRef<BoardPost | null>(null);
  const activeKeyRef = useRef(key);
  const publishKeyRef = useRef<{
    id: string;
    revision: number;
    key: string;
  } | null>(null);
  const current = editorStateForKey(state, key, boardRevision);

  useEffect(() => {
    timezoneRef.current = timezone;
  }, [timezone]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      mutationSequence.current += 1;
    };
  }, []);

  function flushDeferredReload() {
    if (
      deferredReload.current &&
      mountedRef.current &&
      activeKeyRef.current === key &&
      !operationPendingRef.current &&
      !attachmentPendingRef.current &&
      !recordLinkPendingRef.current
    ) {
      deferredReload.current = false;
      setRetryKey((value) => value + 1);
    }
  }

  useEffect(() => {
    const switched = activeKeyRef.current !== key;
    if (
      !switched &&
      (operationPendingRef.current ||
        attachmentPendingRef.current ||
        recordLinkPendingRef.current)
    ) {
      deferredReload.current = true;
      return;
    }
    deferredReload.current = false;
    const request = ++loadSequence.current;
    activeKeyRef.current = key;
    if (switched) {
      selectedRef.current = null;
      publishKeyRef.current = null;
      mutationSequence.current += 1;
      operationPendingRef.current = false;
      attachmentPendingRef.current = false;
      recordLinkPendingRef.current = false;
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
        // One row is enough: the read carries the board's current revision.
        const page = await listBoardPosts(boardId, {
          view: "editable",
          limit: 1,
          offset: 0,
          sortBy: "updated_at",
          sortOrder: "desc",
        });
        const selected = selectedRef.current;
        const verified = selected
          ? await readBoardPost(boardId, selected.id, "editable")
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
            timezoneRef.current,
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
  }, [actorId, boardId, boardRevision, boardStatus, key, refreshKey, retryKey]);

  const access = current.access;
  // A background re-check keeps this Board's last confirmed access, so open menus
  // and editors stay mounted; a denial or failure clears it.
  const canEdit =
    boardStatus === "active" &&
    (current.status === "ready" || current.status === "loading") &&
    access?.edit === true &&
    zone !== null;
  const canManage = access?.manage === true;
  const scheduleDirty =
    current.scheduleLocal !==
    postLocalScheduleValue(current.selected, timezone);
  const view: PostEditorView = {
    // Editing waits for the workspace zone, so the editor reads as opening.
    status:
      zone === null && current.status === "ready" ? "loading" : current.status,
    active: boardStatus === "active",
    canEdit,
    canManage,
    selected: canEdit ? current.selected : null,
    form: canEdit ? current.form : null,
    dirty: dirty(current.form, current.selected, timezone),
    scheduleDirty,
    scheduleLocal: canEdit ? current.scheduleLocal : "",
    region: region ?? null,
    scheduleError: canEdit ? current.scheduleError : null,
    expiryError: canEdit ? current.expiryError : null,
    pending:
      current.pending || current.attachmentPending || current.recordLinkPending,
    conflict: current.conflict,
    error: current.error,
    notice: canEdit ? current.notice : null,
  };

  function newDraft() {
    if (
      !canEdit ||
      current.pending ||
      attachmentPendingRef.current ||
      recordLinkPendingRef.current ||
      dirty(current.form, current.selected, timezone) ||
      scheduleDirty
    )
      return;
    selectedRef.current = null;
    publishKeyRef.current = null;
    setState((previous) => ({
      ...previous,
      selected: null,
      form: { title: "", body: "", links: [], pinned: false, expiresLocal: "" },
      scheduleLocal: "",
      scheduleError: null,
      expiryError: null,
      conflict: false,
      error: null,
      notice: null,
    }));
  }

  function changeForm(form: PostEditorForm) {
    if (
      !canEdit ||
      current.pending ||
      attachmentPendingRef.current ||
      recordLinkPendingRef.current ||
      current.form === null
    )
      return;
    setState((previous) =>
      previous.key === key
        ? {
            ...previous,
            form: {
              ...form,
              pinned: canManage
                ? form.pinned
                : (previous.form?.pinned ?? false),
            },
            expiryError: null,
            error: null,
          }
        : previous,
    );
  }

  const busy = () =>
    !canEdit ||
    current.pending ||
    attachmentPendingRef.current ||
    recordLinkPendingRef.current ||
    current.conflict ||
    operationPendingRef.current;

  /** Marks an invalid local expiry; true when the form cannot be saved. */
  function rejectExpiry(form: PostEditorForm): boolean {
    try {
      postExpiryTimeToUtc(form.expiresLocal, timezone);
      return false;
    } catch {
      setState((previous) =>
        previous.key === key
          ? {
              ...previous,
              expiryError:
                "Choose a valid local expiry time. Clock changes can make some local times unavailable.",
            }
          : previous,
      );
      return true;
    }
  }

  /** Creates or updates the draft, then reads it back as the server keeps it. */
  async function persist(
    form: PostEditorForm,
    selected: BoardPost | null,
    revision: number,
  ): Promise<{ saved: BoardPost; boardRevision: number }> {
    const result = selected
      ? await updateBoardPost(
          boardId,
          selected.id,
          postPatchForForm(selected, form, revision, timezone, canManage),
        )
      : await createBoardPost(boardId, {
          boardRevision: revision,
          title: form.title,
          body: form.body,
          links: form.links,
          expiresAt: postExpiryTimeToUtc(form.expiresLocal, timezone),
          ...(canManage ? { pinned: form.pinned } : {}),
        });
    const saved = await readBoardPost(boardId, result.id, "draft");
    return { saved, boardRevision: result.boardRevision };
  }

  /** The editor now holds the saved draft; `pending` stays for a next step. */
  function adopt(
    saved: BoardPost,
    revision: number,
    pending: boolean,
    notice: string | null,
  ) {
    selectedRef.current = saved;
    publishKeyRef.current = null;
    setState((previous) =>
      previous.key === key
        ? {
            ...previous,
            selected: saved,
            form: formFor(saved, timezone),
            expiryError: null,
            scheduleLocal: pending
              ? previous.scheduleLocal
              : postLocalScheduleValue(saved, timezone),
            scheduleError: null,
            boardRevision: revision,
            pending,
            conflict: false,
            error: null,
            notice,
          }
        : previous,
    );
  }

  function failed(operation: number, error: unknown) {
    if (operation !== mutationSequence.current) return;
    if (isDenial(error)) selectedRef.current = null;
    setState((previous) =>
      previous.key === key ? editorFailure(previous, error) : previous,
    );
  }

  function settle(operation: number) {
    if (operation === mutationSequence.current) {
      operationPendingRef.current = false;
      flushDeferredReload();
    }
  }

  function begin(): number {
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
    return operation;
  }

  function owns(selected: BoardPost | null): boolean {
    return !selected || selected.authorId === actorId || canManage;
  }

  async function save() {
    const form = current.form;
    const selected = current.selected;
    if (busy() || !valid(form) || !owns(selected)) return;
    // A published post saves as a draft even unchanged, so its files and
    // record links can be edited before it is published again.
    if (
      selected &&
      !dirty(form, selected, timezone) &&
      selected.status !== "published"
    )
      return;
    if (rejectExpiry(form)) return;
    const operation = begin();
    try {
      const { saved, boardRevision: revision } = await persist(
        form,
        selected,
        current.boardRevision,
      );
      if (operation !== mutationSequence.current) return;
      adopt(saved, revision, false, null);
      if (mountedRef.current && activeKeyRef.current === key)
        onPublished?.(boardId);
      setRetryKey((value) => value + 1);
    } catch (error) {
      failed(operation, error);
    } finally {
      settle(operation);
    }
  }

  /**
   * Schedules the post for the chosen local time. Unsaved text is saved as
   * the draft first, in the same step. Resolves true once it is scheduled.
   */
  async function schedule(): Promise<boolean> {
    const form = current.form;
    const selected = current.selected;
    if (busy() || !valid(form) || !owns(selected)) return false;
    if (rejectExpiry(form)) return false;
    const converted = postScheduleTimeToUtc(
      current.scheduleLocal,
      timezone,
      Date.now(),
      postExpiryTimeToUtc(form.expiresLocal, timezone),
    );
    if (!converted.ok) {
      setState((previous) =>
        previous.key === key
          ? { ...previous, scheduleError: scheduleTimeError(converted.reason) }
          : previous,
      );
      return false;
    }
    if (
      selected?.status === "scheduled" &&
      !dirty(form, selected, timezone) &&
      converted.publishAt === selected.publishAt
    )
      return false;
    const operation = begin();
    try {
      let target = selected;
      let revision = current.boardRevision;
      if (!target || dirty(form, target, timezone)) {
        const result = await persist(form, target, revision);
        if (operation !== mutationSequence.current) return false;
        adopt(result.saved, result.boardRevision, true, null);
        target = result.saved;
        revision = result.boardRevision;
      }
      if (target.postRevision === null) throw new ApiContractError();
      const result = await scheduleBoardPost(boardId, target.id, {
        boardRevision: revision,
        postRevision: target.postRevision,
        publishAt: converted.publishAt,
      });
      const saved = await readBoardPost(boardId, result.id, "draft");
      if (
        saved.status !== "scheduled" ||
        saved.publishAt === null ||
        Date.parse(saved.publishAt) !== Date.parse(converted.publishAt)
      )
        throw new ApiContractError();
      if (operation !== mutationSequence.current) return false;
      adopt(saved, result.boardRevision, false, null);
      if (mountedRef.current && activeKeyRef.current === key)
        onPublished?.(boardId);
      setRetryKey((value) => value + 1);
      return true;
    } catch (error) {
      if (operation !== mutationSequence.current) return false;
      if (isDenial(error)) selectedRef.current = null;
      setState((previous) => {
        if (previous.key !== key) return previous;
        const failure = editorFailure(previous, error);
        return {
          ...failure,
          scheduleError:
            error instanceof ApiError &&
            error.status === 422 &&
            error.code === "post_schedule_invalid"
              ? error.message
              : previous.scheduleError,
        };
      });
      return false;
    } finally {
      settle(operation);
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
      selected.postRevision === null ||
      !form ||
      dirty(form, selected, timezone) ||
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
      const result = await updateBoardPost(
        boardId,
        selected.id,
        postCancellationPatch(selected, current.boardRevision),
      );
      const saved = await readBoardPost(boardId, result.id, "draft");
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
              form: formFor(saved, timezone),
              expiryError: null,
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
      if (operation === mutationSequence.current) {
        operationPendingRef.current = false;
        flushDeferredReload();
      }
    }
  }

  /**
   * Publishes the post now. Unsaved text is saved as the draft first, in the
   * same step; when publishing then fails, the saved draft stays open with the
   * error. Resolves with the post's id once it is published.
   */
  async function publish(): Promise<string | null> {
    const form = current.form;
    const selected = current.selected;
    if (busy() || !valid(form) || !owns(selected)) return null;
    if (rejectExpiry(form)) return null;
    const operation = begin();
    try {
      let target = selected;
      let revision = current.boardRevision;
      if (!target || dirty(form, target, timezone)) {
        const result = await persist(form, target, revision);
        if (operation !== mutationSequence.current) return null;
        adopt(result.saved, result.boardRevision, true, null);
        target = result.saved;
        revision = result.boardRevision;
      }
      if (target.postRevision === null) throw new ApiContractError();
      const sameKey = publishKeyRef.current;
      const publicationKey =
        sameKey?.id === target.id && sameKey.revision === target.postRevision
          ? sameKey.key
          : crypto.randomUUID();
      publishKeyRef.current = {
        id: target.id,
        revision: target.postRevision,
        key: publicationKey,
      };
      await publishBoardPost(boardId, target.id, {
        boardRevision: revision,
        postRevision: target.postRevision,
        publicationKey,
      });
      if (operation !== mutationSequence.current) return null;
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
              pending: false,
              conflict: false,
              error: null,
              notice: null,
            }
          : previous,
      );
      if (mountedRef.current && activeKeyRef.current === key)
        onPublished?.(boardId);
      setRetryKey((value) => value + 1);
      return target.id;
    } catch (error) {
      failed(operation, error);
      return null;
    } finally {
      settle(operation);
    }
  }

  /** Opens a post the viewer may change, read as its editable version. */
  async function edit(postId: string): Promise<boolean> {
    if (
      !canEdit ||
      current.pending ||
      attachmentPendingRef.current ||
      recordLinkPendingRef.current ||
      dirty(current.form, current.selected, timezone) ||
      scheduleDirty
    )
      return false;
    const operation = ++mutationSequence.current;
    try {
      const item = await readBoardPost(boardId, postId, "editable");
      if (
        operation !== mutationSequence.current ||
        activeKeyRef.current !== key
      )
        return false;
      if (item.authorId !== actorId && !canManage) return false;
      selectedRef.current = item;
      publishKeyRef.current = null;
      setState((previous) =>
        previous.key === key
          ? {
              ...previous,
              selected: item,
              form: formFor(item, timezone),
              expiryError: null,
              scheduleLocal: postLocalScheduleValue(item, timezone),
              scheduleError: null,
              conflict: false,
              error: null,
              notice: null,
            }
          : previous,
      );
      return true;
    } catch (error) {
      failed(operation, error);
      return false;
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
    if (!pending) flushDeferredReload();
    setState((previous) =>
      previous.key === key
        ? { ...previous, attachmentPending: pending }
        : previous,
    );
  }

  function setRecordLinkPending(pending: boolean) {
    recordLinkPendingRef.current = pending;
    if (!pending) flushDeferredReload();
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
      selected.postRevision === null ||
      selected.boardId !== boardId
    )
      throw new ApiContractError();
    try {
      const latest = await readBoardPost(boardId, selected.id, "editable");
      if (latest.postRevision === null || !samePostContent(selected, latest)) {
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
          "Post content changed; review the latest version.",
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
        contentRevision: latest.postRevision,
      };
    } catch (error) {
      if (isDenial(error)) {
        selectedRef.current = null;
        setState((previous) =>
          previous.key === key
            ? {
                ...emptyState(key, previous.boardRevision),
                status: "denied",
                error: "You cannot post on this board.",
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
    edit,
    changeForm,
    changeScheduleTime: (scheduleLocal: string) => {
      if (!canEdit || current.pending || current.conflict || !current.form)
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
  };
}
