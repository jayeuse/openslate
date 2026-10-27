"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { lifecycleErrorMessage } from "@/lib/lifecycle";
import type { WorkspaceRegion } from "@/lib/date-time";
import { reportDone } from "@/lib/feedback";
import type { WorkspaceInvalidation } from "../../shared/adapters/invalidation-events";
import { useInvalidationRefresh } from "../../shared/adapters/use-invalidation-refresh";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  archiveBoard,
  readBoard,
  restoreBoard,
  previewBoardPurge,
  purgeBoard,
  updateBoard,
  type BoardPurgePreview,
  type BoardManagementBoard,
} from "../adapters/board-management-api";
import {
  listUnlinkedBoardFiles,
  archiveUnlinkedBoardFile,
  previewBoardFilePurge,
  purgeBoardFile,
  type BoardUnlinkedFile,
  type BoardUnlinkedFilePage,
} from "../adapters/board-files-api";
import { getMyBoardAccess } from "../adapters/board-tools-api";
import {
  subscribeWorkspaceLifecycleSettings,
  workspaceLifecycleQueryOptions,
  workspaceCalendarQueryOptions,
} from "../../manage/adapters/workspace-api";
import {
  blankDraft,
  boardPurgeFailureMessage,
  boardUpdateForDraft,
  draftFromBoard,
  rebaseBoardDraft,
  revokeBoardManagementState,
  validDraft,
  type BoardManagementDraft,
  type BoardManagementView,
} from "../domain/board-details";
import {
  BOARD_SETTINGS_TABS,
  boardLifecycleConfirmation,
  boardSettingsMeta,
  type BoardSettingsTab,
} from "../domain/board-settings";
import { ServerBoardManagementDisplay } from "./board-settings-details";
import {
  BoardFilePurgeDialog,
  BoardUnattachedFiles,
} from "./board-settings-files";
import { BoardSettingsAccess } from "./board-settings-access";
import { ServerBackedBoardActivity } from "./server-backed-board-activity";
import { ConfirmAction } from "./ui";

type Props = {
  board: BoardManagementBoard;
  /** Only an administrator changes groups, files, and deletes forever. */
  isAdmin: boolean;
  /** The open tab, from the address; null while the sheet is closed. */
  tab: BoardSettingsTab | null;
  onTabChange: (tab: BoardSettingsTab) => void;
  onClose: () => void;
  /** The board's detail read; a new read refreshes Access and Activity. */
  refreshKey: number;
  region: WorkspaceRegion | undefined;
  onUpdated: (board: BoardManagementBoard) => void;
  onAccessDenied: (boardId: string) => void;
  onPurged: (boardId: string) => void;
};

const TAB_LABEL: Record<BoardSettingsTab, string> = {
  details: "Details",
  access: "Access",
  activity: "Activity",
};

const tabPanelClass =
  "relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-5";

function SettingsInstance(props: Props) {
  const open = props.tab !== null;
  const incomingBoard = props.board;
  const client = useQueryClient();
  const readPurgeSetting = open && props.isAdmin;
  const workspace = useQuery({
    ...workspaceLifecycleQueryOptions(),
    enabled: readPurgeSetting,
  });
  const region = useQuery({
    ...workspaceCalendarQueryOptions(),
    enabled: readPurgeSetting,
  });
  const purgeEnabled = workspace.isSuccess && workspace.data.purge_enabled;
  useEffect(() => {
    if (readPurgeSetting) return subscribeWorkspaceLifecycleSettings(client);
  }, [client, readPurgeSetting]);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<"archive" | null>(null);
  const [purgePreview, setPurgePreview] = useState<BoardPurgePreview | null>(
    null,
  );
  const [purgeFile, setPurgeFile] = useState<BoardUnlinkedFile | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<
    | ({ boardId: string; revision: number } & (
        { kind: "board" } | { kind: "file"; fileId: string }
      ))
    | null
  >(null);
  const previewRequest = useRef<number | null>(null);
  const [fileStatus, setFileStatus] = useState<"exclude" | "only">("exclude");
  const [fileOffset, setFileOffset] = useState(0);
  const [fileRefresh, setFileRefresh] = useState(0);
  const [filePage, setFilePage] = useState<{
    key: string;
    page: BoardUnlinkedFilePage;
  } | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [purgePreviewLoading, setPurgePreviewLoading] = useState(false);
  const [purgeReviewAgain, setPurgeReviewAgain] = useState(false);
  const [purgeConfirmationName, setPurgeConfirmationName] = useState("");
  const [purgePassword, setPurgePassword] = useState("");
  const [board, setBoard] = useState<BoardManagementBoard | null>(
    incomingBoard,
  );
  const [draftBase, setDraftBase] = useState<BoardManagementBoard | null>(
    incomingBoard,
  );
  const [draft, setDraft] = useState<BoardManagementDraft>(() =>
    draftFromBoard(incomingBoard),
  );
  const [access, setAccess] =
    useState<BoardManagementView["access"]>("loading");
  const [accessRetry, setAccessRetry] = useState(0);
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [latestReady, setLatestReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Lifecycle and purge results show beside their action in Advanced (R2).
  const [lifecycleError, setLifecycleError] =
    useState<BoardManagementView["lifecycleError"]>(null);
  const [lifecycleNotice, setLifecycleNotice] = useState<string | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  // Archive and Restore swap one button for the other, and the access check
  // that follows a board change redraws Details: focus waits for the new
  // button and goes to it (R5).
  // After the action, focus waits for an access check that completes after
  // the board change (a count, so a check that loads and settles between two
  // renders still counts), then moves.
  const [accessChecks, setAccessChecks] = useState(0);
  const accessChecksRef = useRef(0);
  /** The board whose management access is known; a re-check keeps it. */
  const accessFor = useRef<string | null>(null);
  const [focusLifecycle, setFocusLifecycle] = useState<number | null>(null);
  const lifecycleAction = useCallback(
    () =>
      tabsRef.current
        ?.closest('[data-slot="sheet-content"]')
        ?.querySelector<HTMLElement>("[data-lifecycle-action]") ?? null,
    [],
  );

  const pendingRef = useRef(false);
  const mountedRef = useRef(false);
  const deniedRef = useRef(false);
  const accessRequest = useRef(0);
  const actionRequest = useRef(0);
  const boardId = incomingBoard.id;
  const onAccessDenied = props.onAccessDenied;

  const clearPurgeReview = useCallback(() => {
    if (previewRequest.current !== null) {
      actionRequest.current += 1;
      previewRequest.current = null;
      pendingRef.current = false;
      setPending(false);
    }
    setPurgePreview(null);
    setPurgeFile(null);
    setPurgeTarget(null);
    setPurgePreviewLoading(false);
    setPurgeReviewAgain(false);
    setPurgeConfirmationName("");
    setPurgePassword("");
  }, []);
  useEffect(() => {
    if (!purgeEnabled) clearPurgeReview();
  }, [purgeEnabled, clearPurgeReview]);

  const handleDenied = useCallback(
    (failure: unknown, revokeBoard = true): boolean => {
      if (
        !(failure instanceof ApiError) ||
        ![401, 403, 404].includes(failure.status)
      )
        return false;
      if (deniedRef.current) return true;
      deniedRef.current = true;
      clearPurgeReview();
      revokeBoardManagementState(
        {
          accessRequest,
          actionRequest,
          setBoard,
          setDraft,
          setDraftBase,
          setAccess,
          setConflict,
          setLatestReady,
          setError: (value) => {
            setError(value);
            setLifecycleError(null);
          },
          setNotice: (value) => {
            setNotice(value);
            setLifecycleNotice(null);
          },
          setConfirmation,
          setDiscardOpen,
          onAccessDenied: () => onAccessDenied(boardId),
        },
        revokeBoard,
      );
      return true;
    },
    [boardId, onAccessDenied, clearPurgeReview],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (
      deniedRef.current ||
      (board !== null && incomingBoard.revision <= board.revision)
    )
      return;
    const changed =
      draftBase !== null && boardUpdateForDraft(draftBase, draft) !== null;
    if (previewRequest.current !== null) {
      actionRequest.current += 1;
      previewRequest.current = null;
      pendingRef.current = false;
      setPending(false);
    }
    clearPurgeReview();
    setBoard(incomingBoard);
    setPurgeFile(null);
    setPurgePreview(null);
    setPurgeConfirmationName("");
    setPurgePassword("");
    if (changed) {
      setConflict(true);
      setLatestReady(true);
    } else {
      setDraft(draftFromBoard(incomingBoard));
      setDraftBase(incomingBoard);
      setConflict(false);
      setLatestReady(false);
    }
  }, [incomingBoard, board, draft, draftBase, clearPurgeReview]);

  useEffect(() => {
    if (!open || deniedRef.current) return;
    let current = true;
    const request = ++accessRequest.current;
    // A re-check of the same board keeps Details drawn (last good), so the
    // button that holds focus is not swapped for the loading frame.
    if (accessFor.current !== incomingBoard.id) setAccess("loading");
    void getMyBoardAccess(incomingBoard.id).then(
      (permissions) => {
        if (!current || request !== accessRequest.current || deniedRef.current)
          return;
        if (!permissions.manage) {
          handleDenied(
            new ApiError(403, "Board management unavailable"),
            !permissions.view,
          );
          return;
        }
        setAccess("ready");
        accessFor.current = incomingBoard.id;
        accessChecksRef.current += 1;
        setAccessChecks(accessChecksRef.current);
      },
      (failure: unknown) => {
        if (!current || request !== accessRequest.current || deniedRef.current)
          return;
        accessFor.current = null;
        if (!handleDenied(failure)) setAccess("error");
      },
    );
    return () => {
      current = false;
      accessRequest.current += 1;
    };
  }, [open, incomingBoard, accessRetry, handleDenied]);

  useEffect(() => {
    if (
      focusLifecycle === null ||
      access !== "ready" ||
      accessChecks <= focusLifecycle
    )
      return;
    const target = lifecycleAction();
    if (!target) return;
    target.focus();
    // A button that a draft re-sync disables for a render cannot take focus
    // yet; the next render tries again.
    if (document.activeElement === target) setFocusLifecycle(null);
  }, [
    focusLifecycle,
    access,
    accessChecks,
    board,
    draft,
    conflict,
    lifecycleAction,
  ]);

  const view: BoardManagementView = {
    board,
    access,
    canManage: access === "ready",
    draft,
    pending,
    conflict,
    latestReady,
    error,
    notice,
    lifecycleError,
    lifecycleNotice,
  };
  const dirty = board !== null && boardUpdateForDraft(board, draft) !== null;

  const filesEnabled =
    open && props.isAdmin && board?.status === "active" && access === "ready";
  const acceptsFileInvalidation = useCallback(
    (event: WorkspaceInvalidation) =>
      event.type === "invalidate" &&
      (event.entity === "files" ||
        (event.entity === "boards" && event.boardId === board?.id)),
    [board?.id],
  );
  const fileLiveKey = useInvalidationRefresh(
    filesEnabled ? (board?.id ?? null) : null,
    acceptsFileInvalidation,
  );
  const filesKey = `${board?.id}:${fileStatus}:${fileOffset}:${fileRefresh}:${fileLiveKey}`;
  useEffect(() => {
    if (!purgeFile || filePage?.key !== filesKey) return;
    const current = filePage.page.items.find(
      (file) => file.id === purgeFile.id,
    );
    if (!current || JSON.stringify(current) !== JSON.stringify(purgeFile))
      clearPurgeReview();
  }, [filePage, filesKey, purgeFile, clearPurgeReview]);
  useEffect(() => {
    if (!filesEnabled || !board || deniedRef.current) {
      setFilePage(null);
      setFileLoading(false);
      setFileError(null);
      return;
    }
    const controller = new AbortController();
    let current = true;
    setFileLoading(true);
    setFileError(null);
    void listUnlinkedBoardFiles(
      board.id,
      { deleted: fileStatus, offset: fileOffset },
      controller.signal,
    )
      .then((page) => {
        if (current && !deniedRef.current) setFilePage({ key: filesKey, page });
      })
      .catch((failure: unknown) => {
        if (!current || controller.signal.aborted) return;
        if (handleDenied(failure)) {
          setFilePage(null);
          return;
        }
        setFileError("Unattached files could not be loaded.");
      })
      .finally(() => {
        if (current) setFileLoading(false);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [filesEnabled, board?.id, fileStatus, fileOffset, filesKey, handleDenied]);

  /** True when the request is still the newest and the board is still ours. */
  function stillCurrent(request: number): boolean {
    return (
      mountedRef.current &&
      !deniedRef.current &&
      request === actionRequest.current
    );
  }

  async function archiveFile(file: BoardUnlinkedFile) {
    if (
      !filesEnabled ||
      deniedRef.current ||
      !board ||
      pendingRef.current ||
      dirty ||
      conflict ||
      file.isDeleted ||
      file.boardId !== board.id
    )
      return;
    const request = ++actionRequest.current;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    clearPurgeReview();
    try {
      await archiveUnlinkedBoardFile(board.id, file.id);
      if (!stillCurrent(request)) return;
      setNotice("File archived.");
      setFileRefresh((value) => value + 1);
    } catch (failure) {
      if (stillCurrent(request) && !handleDenied(failure))
        setError(
          lifecycleErrorMessage(
            failure,
            "The file could not be archived. Refresh and try again.",
          ),
        );
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setPending(false);
    }
  }

  async function beginFilePurge(file: BoardUnlinkedFile) {
    if (
      !filesEnabled ||
      deniedRef.current ||
      !board ||
      !purgeEnabled ||
      pendingRef.current ||
      dirty ||
      conflict ||
      !file.isDeleted ||
      file.boardId !== board.id ||
      ["deleting", "purged", "uploading"].includes(file.state)
    )
      return;
    const request = ++actionRequest.current;
    pendingRef.current = true;
    setPending(true);
    clearPurgeReview();
    setError(null);
    previewRequest.current = request;
    setPurgeTarget({
      kind: "file",
      boardId: board.id,
      revision: board.revision,
      fileId: file.id,
    });
    setPurgeFile(file);
    setPurgePreviewLoading(true);
    try {
      const preview = await previewBoardFilePurge(board.id, file.id);
      if (!stillCurrent(request)) return;
      setPurgePreview(preview);
    } catch (failure) {
      if (!stillCurrent(request)) return;
      if (
        failure instanceof ApiError &&
        [401, 404].includes(failure.status) &&
        failure.code !== "challenge_not_found" &&
        handleDenied(failure)
      )
        return;
      setError(
        lifecycleErrorMessage(
          failure,
          "The file review could not be prepared. Refresh and review again.",
        ),
      );
    } finally {
      if (request === actionRequest.current) {
        previewRequest.current = null;
        pendingRef.current = false;
        if (mountedRef.current) {
          setPending(false);
          setPurgePreviewLoading(false);
        }
      }
    }
  }

  async function confirmFilePurge() {
    if (
      fileLoading ||
      fileError !== null ||
      filePage?.key !== filesKey ||
      !filesEnabled ||
      deniedRef.current ||
      !board ||
      !purgeFile ||
      !purgePreview ||
      purgeTarget?.kind !== "file" ||
      purgeTarget.boardId !== board.id ||
      purgeTarget.revision !== board.revision ||
      purgeTarget.fileId !== purgeFile.id ||
      purgePreview.impact.target_type !== "file" ||
      purgePreview.impact.target_id !== purgeFile.id ||
      !purgeEnabled ||
      pendingRef.current ||
      dirty ||
      conflict ||
      purgeFile.boardId !== board.id ||
      !purgeFile.isDeleted ||
      purgePreview.impact.blockers.length > 0 ||
      purgeConfirmationName !== purgePreview.confirmation_name ||
      !purgePassword
    )
      return;
    const request = ++actionRequest.current;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await purgeBoardFile(board.id, purgeFile.id, {
        token: purgePreview.token,
        confirmationName: purgeConfirmationName,
        password: purgePassword,
      });
      if (!stillCurrent(request)) return;
      clearPurgeReview();
      setFileRefresh((value) => value + 1);
      // The sheet stays open, so the result shows in it, not in a toast.
      setNotice("File deleted forever.");
    } catch (failure) {
      if (!stillCurrent(request)) return;
      if (
        failure instanceof ApiError &&
        [401, 404].includes(failure.status) &&
        failure.code !== "challenge_not_found" &&
        handleDenied(failure)
      )
        return;
      setError(
        lifecycleErrorMessage(
          failure,
          "The file was not deleted. Request a new review.",
        ),
      );
      setPurgePreview(null);
      setPurgeConfirmationName("");
    } finally {
      pendingRef.current = false;
      setPurgePassword("");
      if (mountedRef.current) setPending(false);
    }
  }

  function close() {
    if (pendingRef.current) return;
    if (dirty) setDiscardOpen(true);
    else {
      clearPurgeReview();
      props.onClose();
    }
  }

  async function save() {
    if (
      pendingRef.current ||
      deniedRef.current ||
      conflict ||
      !validDraft(draft) ||
      access !== "ready" ||
      !board ||
      board.status !== "active"
    )
      return;
    const update = boardUpdateForDraft(board, draft);
    if (!update) return;
    const request = ++actionRequest.current;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    setLifecycleNotice(null);
    try {
      const saved = await updateBoard(board.id, update);
      if (!stillCurrent(request)) return;
      setBoard(saved);
      setDraftBase(saved);
      setDraft(draftFromBoard(saved));
      setNotice("Board details saved.");
      props.onUpdated(saved);
    } catch (failure) {
      if (!stillCurrent(request)) return;
      if (handleDenied(failure)) return;
      if (
        failure instanceof ApiError &&
        failure.status === 409 &&
        failure.code === "stale_revision"
      ) {
        setConflict(true);
        setLatestReady(false);
        setError(null);
      } else
        setError(
          "Board could not be saved. Review your details and try again.",
        );
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setPending(false);
    }
  }

  async function refreshLatest() {
    if (!board || pendingRef.current || deniedRef.current) return;
    const request = ++actionRequest.current;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const latest = await readBoard(board.id);
      if (!stillCurrent(request)) return;
      setBoard(latest);
      setLatestReady(true);
      props.onUpdated(latest);
    } catch (failure) {
      if (!stillCurrent(request)) return;
      if (!handleDenied(failure))
        setError("The latest board details could not be loaded. Try again.");
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setPending(false);
    }
  }

  /** Saving groups moves the Board revision on; keep the draft if it has changes. */
  async function reloadAfterGroups() {
    if (!board || deniedRef.current) return;
    try {
      const latest = await readBoard(board.id);
      if (!mountedRef.current || deniedRef.current) return;
      setBoard(latest);
      if (!dirty) {
        setDraftBase(latest);
        setDraft(draftFromBoard(latest));
      }
      props.onUpdated(latest);
    } catch (failure) {
      if (!mountedRef.current || deniedRef.current) return;
      handleDenied(failure);
    }
  }

  function useLatest() {
    if (!board || deniedRef.current) return;
    setDraft(draftFromBoard(board));
    setDraftBase(board);
    setConflict(false);
    setLatestReady(false);
    setError(null);
  }

  async function changeLifecycle(action: "archive" | "restore") {
    if (
      !board ||
      access !== "ready" ||
      pendingRef.current ||
      deniedRef.current ||
      conflict ||
      dirty
    )
      return;
    const request = ++actionRequest.current;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    setLifecycleError(null);
    setLifecycleNotice(null);
    try {
      const changed =
        action === "archive"
          ? await archiveBoard(board.id, board.revision)
          : await restoreBoard(board.id, board.revision);
      if (!stillCurrent(request)) return;
      setBoard(changed);
      setDraftBase(changed);
      setDraft(draftFromBoard(changed));
      setConfirmation(null);
      clearPurgeReview();
      // Inside the open sheet the result is inline (Request feedback).
      setLifecycleNotice(
        action === "archive" ? "Board archived." : "Board restored.",
      );
      setFocusLifecycle(accessChecksRef.current);

      props.onUpdated(changed);
    } catch (failure) {
      if (!stillCurrent(request)) return;
      setConfirmation(null);
      if (handleDenied(failure)) return;
      if (
        failure instanceof ApiError &&
        failure.status === 409 &&
        failure.code === "stale_revision"
      ) {
        setConflict(true);
        setLatestReady(false);
      } else
        setLifecycleError({
          action: "lifecycle",
          message: `Board could not be ${action === "archive" ? "archived" : "restored"}. Try again.`,
        });
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setPending(false);
    }
  }

  async function beginPurgeReview() {
    if (
      !board ||
      !props.isAdmin ||
      !purgeEnabled ||
      board.status !== "archived" ||
      access !== "ready" ||
      pendingRef.current ||
      deniedRef.current ||
      conflict ||
      dirty
    )
      return;
    const request = ++actionRequest.current;
    pendingRef.current = true;
    setPending(true);
    clearPurgeReview();
    previewRequest.current = request;
    setPurgeTarget({
      kind: "board",
      boardId: board.id,
      revision: board.revision,
    });
    setPurgePreviewLoading(true);
    setError(null);
    setNotice(null);
    setLifecycleError(null);
    setLifecycleNotice(null);
    try {
      const preview = await previewBoardPurge(board.id);
      if (!stillCurrent(request)) return;
      setPurgePreview(preview);
      setPurgeReviewAgain(preview.impact.blockers.length > 0);
    } catch (failure) {
      if (!stillCurrent(request)) return;
      if (
        failure instanceof ApiError &&
        [401, 404].includes(failure.status) &&
        failure.code !== "challenge_not_found" &&
        handleDenied(failure)
      )
        return;
      setLifecycleError({
        action: "purge",
        message: boardPurgeFailureMessage(failure, "preview"),
      });
      setPurgeReviewAgain(true);
    } finally {
      if (request === actionRequest.current) {
        previewRequest.current = null;
        pendingRef.current = false;
        if (mountedRef.current) {
          setPending(false);
          setPurgePreviewLoading(false);
        }
      }
    }
  }

  async function confirmPurge() {
    if (
      !board ||
      !props.isAdmin ||
      !purgeEnabled ||
      board.status !== "archived" ||
      access !== "ready" ||
      !purgePreview ||
      purgeTarget?.kind !== "board" ||
      purgeTarget.boardId !== board.id ||
      purgeTarget.revision !== board.revision ||
      purgePreview.impact.target_type !== "board" ||
      purgePreview.impact.target_id !== board.id ||
      purgePreview.impact.blockers.length > 0 ||
      purgeConfirmationName !== purgePreview.confirmation_name ||
      purgePassword.length === 0 ||
      pendingRef.current ||
      deniedRef.current ||
      conflict ||
      dirty
    )
      return;
    const purgedId = board.id;
    const request = ++actionRequest.current;
    const password = purgePassword;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    setLifecycleError(null);
    try {
      await purgeBoard(purgedId, {
        token: purgePreview.token,
        confirmationName: purgePreview.confirmation_name,
        password,
      });
      if (!stillCurrent(request)) return;
      clearPurgeReview();
      reportDone("Board deleted forever.");
      props.onPurged(purgedId);
    } catch (failure) {
      if (!stillCurrent(request)) return;
      if (
        failure instanceof ApiError &&
        [401, 404].includes(failure.status) &&
        failure.code !== "challenge_not_found" &&
        handleDenied(failure)
      )
        return;
      setLifecycleError({
        action: "purge",
        message: boardPurgeFailureMessage(failure, "execute"),
      });
      clearPurgeReview();
      setPurgeReviewAgain(true);
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setPending(false);
      setPurgePassword("");
    }
  }

  const archiveStep = boardLifecycleConfirmation("archive");
  const shownBoard = board ?? incomingBoard;
  const filesShown =
    open && props.isAdmin && access === "ready" && board !== null;

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <SheetContent
          // One sheet width across Boards: the record sheet's (C7).
          className="slim-ui flex w-full max-w-none flex-col gap-0 overflow-hidden p-0 sm:w-[min(92vw,40rem)]"
          // Focus starts on the open tab, not on Close (C13).
          initialFocus={() =>
            tabsRef.current?.querySelector<HTMLElement>(
              '[role="tab"][aria-selected="true"]',
            ) ?? true
          }
        >
          <header className="flex shrink-0 items-start gap-3 border-b p-5 pr-3">
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-lg leading-tight font-semibold wrap-anywhere">
                {shownBoard.name}
              </SheetTitle>
              <SheetDescription className="text-muted-foreground mt-1 text-sm">
                {boardSettingsMeta(shownBoard)}
              </SheetDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 shrink-0"
              aria-label="Close board settings"
              disabled={pending}
              onClick={close}
            >
              <X aria-hidden="true" />
            </Button>
          </header>
          <Tabs
            value={props.tab ?? "details"}
            onValueChange={(value) => {
              const next = BOARD_SETTINGS_TABS.find((tab) => tab === value);
              if (next) props.onTabChange(next);
            }}
            className="min-h-0 flex-1 gap-0"
          >
            <div ref={tabsRef} className="shrink-0 border-b px-5 py-3">
              <TabsList
                aria-label="Board settings"
                className="grid w-full grid-cols-3 sm:w-fit"
              >
                {BOARD_SETTINGS_TABS.map((tab) => (
                  <TabsTrigger
                    key={tab}
                    value={tab}
                    className="min-h-11 xl:min-h-8"
                  >
                    {TAB_LABEL[tab]}
                    {tab === "details" && dirty ? (
                      <>
                        <span
                          aria-hidden="true"
                          className="bg-warn ml-1 size-1.5 shrink-0 rounded-full"
                        />
                        <span className="sr-only">, unsaved changes</span>
                      </>
                    ) : null}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            {/* Details stays mounted while Access or Activity shows, so its
                draft survives a look at them. */}
            <TabsContent value="details" keepMounted className={tabPanelClass}>
              <ServerBoardManagementDisplay
                view={view}
                isAdmin={props.isAdmin}
                purgeEnabled={purgeEnabled}
                onChange={(next) => {
                  if (!deniedRef.current) setDraft(next);
                }}
                onSave={() => {
                  void save();
                }}
                onRefreshLatest={() => {
                  void refreshLatest();
                }}
                onRetryWithDraft={() => {
                  if (!board || !draftBase || deniedRef.current) return;
                  setDraft(rebaseBoardDraft(draftBase, board, draft));
                  setDraftBase(board);
                  setConflict(false);
                  setLatestReady(false);
                }}
                onUseLatest={useLatest}
                onArchive={() => {
                  if (!deniedRef.current) setConfirmation("archive");
                }}
                onRestore={() => {
                  void changeLifecycle("restore");
                }}
                onBeginPurge={() => {
                  void beginPurgeReview();
                }}
                purgePreviewLoading={purgePreviewLoading}
                purgeReviewAgain={purgeReviewAgain}
                purgePreview={
                  purgeTarget?.kind === "board" &&
                  purgeTarget.boardId === board?.id &&
                  purgeTarget.revision === board.revision &&
                  purgePreview?.impact.target_type === "board" &&
                  purgePreview.impact.target_id === board.id
                    ? purgePreview
                    : null
                }
                region={region.data}
                purgeConfirmationName={purgeConfirmationName}
                purgePassword={purgePassword}
                onChangePurgeConfirmationName={setPurgeConfirmationName}
                onChangePurgePassword={setPurgePassword}
                onCancelPurge={() => {
                  clearPurgeReview();
                  setError(null);
                  setLifecycleError(null);
                }}
                onConfirmPurge={() => {
                  void confirmPurge();
                }}
                onRetryAccess={() => setAccessRetry((value) => value + 1)}
                files={
                  filesShown ? (
                    <BoardUnattachedFiles
                      archived={board.status === "archived"}
                      status={fileStatus}
                      onStatusChange={(next) => {
                        setFileStatus(next);
                        setFileOffset(0);
                        clearPurgeReview();
                      }}
                      loading={fileLoading}
                      error={fileError}
                      onRetry={() => setFileRefresh((value) => value + 1)}
                      page={filePage?.page ?? null}
                      stale={filePage?.key !== filesKey}
                      pending={pending}
                      locked={pending || dirty || conflict}
                      purgeEnabled={purgeEnabled}
                      offset={fileOffset}
                      onArchive={(file) => void archiveFile(file)}
                      onPurge={(file) => void beginFilePurge(file)}
                      onPrevious={() =>
                        setFileOffset((value) => Math.max(0, value - 25))
                      }
                      onNext={() => setFileOffset((value) => value + 25)}
                    />
                  ) : null
                }
              />
            </TabsContent>
            <TabsContent value="access" className={tabPanelClass}>
              {board ? (
                <BoardSettingsAccess
                  board={board}
                  isAdmin={props.isAdmin}
                  refreshKey={props.refreshKey}
                  onGroupsChanged={() => {
                    void reloadAfterGroups();
                  }}
                />
              ) : null}
            </TabsContent>
            <TabsContent value="activity" className={tabPanelClass}>
              {board ? (
                <ServerBackedBoardActivity
                  key={board.id}
                  region={props.region}
                  boardId={board.id}
                  refreshKey={props.refreshKey}
                  onAccessDenied={() =>
                    handleDenied(new ApiError(403, "Activity unavailable"))
                  }
                />
              ) : null}
            </TabsContent>
          </Tabs>
          {/* Inside the sheet, so the sheet knows this dialog is its own
              and never hides it when its modal scope is set again. */}
          {archiveStep ? (
            <ConfirmAction
              key={board?.id ?? "board-access-denied"}
              open={confirmation === "archive"}
              title={archiveStep.title}
              description={archiveStep.description}
              action={archiveStep.action}
              tone="neutral"
              disabled={pending}
              pending={pending}
              pendingLabel="Archiving…"
              finalFocus={lifecycleAction}
              onConfirm={() => {
                void changeLifecycle("archive");
              }}
              onCancel={() => setConfirmation(null)}
            />
          ) : null}
        </SheetContent>
      </Sheet>
      <BoardFilePurgeDialog
        open={
          purgeFile !== null &&
          purgeTarget?.kind === "file" &&
          purgeTarget.boardId === board?.id &&
          purgeTarget.revision === board.revision &&
          purgeTarget.fileId === purgeFile.id
        }
        pending={pending}
        loading={purgePreviewLoading}
        error={error}
        preview={purgePreview}
        region={region.data}
        confirmationName={purgeConfirmationName}
        password={purgePassword}
        confirmDisabled={
          pending ||
          fileLoading ||
          fileError !== null ||
          filePage?.key !== filesKey ||
          !purgePreview ||
          purgeConfirmationName !== purgePreview.confirmation_name ||
          !purgePassword ||
          !purgeEnabled
        }
        canReviewAgain={purgeFile !== null && !purgePreviewLoading}
        onConfirmationName={setPurgeConfirmationName}
        onPassword={setPurgePassword}
        onConfirm={() => void confirmFilePurge()}
        onReviewAgain={() => {
          if (purgeFile) void beginFilePurge(purgeFile);
        }}
        onCancel={() => {
          if (pendingRef.current) return;
          clearPurgeReview();
          setError(null);
        }}
      />
      <ConfirmAction
        open={discardOpen}
        title="Discard board changes?"
        description="Your unsaved board details will be lost."
        action="Discard changes"
        onConfirm={() => {
          setDiscardOpen(false);
          if (!deniedRef.current) {
            setDraft(board ? draftFromBoard(board) : blankDraft);
            setDraftBase(board);
            setConflict(false);
            setLatestReady(false);
            clearPurgeReview();
          }
          props.onClose();
        }}
        onCancel={() => setDiscardOpen(false)}
      />
    </>
  );
}

/** Board settings (BR26): one sheet, Details · Access · Activity. */
export function ServerBackedBoardSettings(props: Props) {
  return <SettingsInstance key={props.board.id} {...props} />;
}
