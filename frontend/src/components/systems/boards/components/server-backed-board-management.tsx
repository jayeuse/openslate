"use client";

import {
  createElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { lifecycleErrorMessage } from "@/lib/lifecycle";
import type { WorkspaceRegion } from "@/lib/date-time";
import { cn } from "@/lib/utils";
import { reportDone } from "@/lib/feedback";
import { LifecyclePurgeReview } from "@/components/systems/shared/lifecycle-purge-review";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  archiveBoard,
  createBoard,
  readBoard,
  restoreBoard,
  previewBoardPurge,
  purgeBoard,
  updateBoard,
  type BoardPurgePreview,
  type BoardCreateInput,
  type BoardManagementBoard,
  type BoardUpdateInput,
} from "../adapters/board-management-api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
import { ServerBackedBoardGroups } from "./server-backed-board-groups";
import { ConfirmAction } from "./ui";

export type BoardManagementDraft = {
  name: string;
  description: string;
};

export type BoardManagementView = {
  mode: "create" | "manage";
  board: BoardManagementBoard | null;
  access: "loading" | "ready" | "denied" | "error";
  canManage: boolean;
  draft: BoardManagementDraft;
  pending: boolean;
  conflict: boolean;
  latestReady?: boolean;
  error: string | null;
  notice: string | null;
};

type Props = {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Only an administrator changes the groups of a project Board. */
  isAdmin?: boolean;
} & (
  | { mode: "create"; onCreated: (board: BoardManagementBoard) => void }
  | {
      mode: "manage";
      board: BoardManagementBoard;
      onUpdated: (board: BoardManagementBoard) => void;
      onAccessDenied: (boardId: string) => void;
      onPurged: (boardId: string) => void;
    }
);

const blankDraft: BoardManagementDraft = { name: "", description: "" };

function draftFromBoard(board: BoardManagementBoard): BoardManagementDraft {
  return { name: board.name, description: board.description ?? "" };
}

function cleanDescription(value: string): string | null {
  return value.trim() || null;
}

function validDraft(draft: BoardManagementDraft): boolean {
  return (
    draft.name.trim().length > 0 &&
    draft.name.trim().length <= 200 &&
    draft.description.trim().length <= 240
  );
}

export function boardCreateForDraft(
  draft: BoardManagementDraft,
): BoardCreateInput {
  return {
    name: draft.name.trim(),
    description: cleanDescription(draft.description),
  };
}

/** A department Board takes its name from the department, so only its description changes. */
export function boardUpdateForDraft(
  board: BoardManagementBoard,
  draft: BoardManagementDraft,
): BoardUpdateInput | null {
  const changes: BoardUpdateInput = { revision: board.revision };
  const name = draft.name.trim();
  const description = cleanDescription(draft.description);
  if (board.scope !== "department" && name !== board.name) changes.name = name;
  if (description !== board.description) changes.description = description;
  return Object.keys(changes).length > 1 ? changes : null;
}

export function boardPurgeFailureMessage(
  error: unknown,
  stage: "preview" | "execute",
): string {
  if (
    error instanceof ApiError &&
    (error.code === "purge_disabled" ||
      error.code === "confirmation_name_mismatch")
  )
    return error.message;
  if (stage === "preview")
    return lifecycleErrorMessage(
      error,
      error instanceof ApiError && error.status === 403
        ? "Only an administrator can permanently delete a Board."
        : "A permanent-deletion review could not be prepared. Check the Board and try again.",
    );
  if (error instanceof ApiError && error.status === 403)
    return lifecycleErrorMessage(
      error,
      "Administrator verification failed. Confirm your password and access, then request a new review.",
    );
  if (error instanceof ApiError && error.status === 409)
    return lifecycleErrorMessage(
      error,
      "The Board or its dependencies changed, or the review expired. Request a new review.",
    );
  return lifecycleErrorMessage(
    error,
    "The Board was not permanently deleted. Request a new review and try again.",
  );
}

export function rebaseBoardDraft(
  original: BoardManagementBoard,
  latest: BoardManagementBoard,
  draft: BoardManagementDraft,
): BoardManagementDraft {
  return {
    name: draft.name.trim() !== original.name ? draft.name : latest.name,
    description:
      cleanDescription(draft.description) !== original.description
        ? draft.description
        : (latest.description ?? ""),
  };
}

export type BoardManagementRevocation = {
  accessRequest: { current: number };
  actionRequest: { current: number };
  setBoard: (value: null) => void;
  setDraft: (value: BoardManagementDraft) => void;
  setDraftBase: (value: null) => void;
  setAccess: (value: "denied") => void;
  setConflict: (value: false) => void;
  setLatestReady: (value: false) => void;
  setError: (value: null) => void;
  setNotice: (value: null) => void;
  setConfirmation: (value: null) => void;
  setDiscardOpen: (value: false) => void;
  onAccessDenied: () => void;
};

export function revokeBoardManagementState(
  targets: BoardManagementRevocation,
  revokeBoard = true,
): void {
  targets.accessRequest.current += 1;
  targets.actionRequest.current += 1;
  targets.setAccess("denied");
  targets.setBoard(null);
  targets.setDraft(blankDraft);
  targets.setDraftBase(null);
  targets.setConflict(false);
  targets.setLatestReady(false);
  targets.setError(null);
  targets.setNotice(null);
  targets.setConfirmation(null);
  targets.setDiscardOpen(false);
  if (revokeBoard) targets.onAccessDenied();
}

type DisplayProps = {
  view: BoardManagementView;
  isAdmin?: boolean;
  purgeEnabled?: boolean;
  onChange?: (draft: BoardManagementDraft) => void;
  onSave?: () => void;
  onRefreshLatest?: () => void;
  onRetryWithDraft?: () => void;
  onUseLatest?: () => void;
  onConfirmLifecycle?: (action: "archive" | "restore") => void;
  onBeginPurge?: () => void;
  purgePreviewLoading?: boolean;
  purgeReviewAgain?: boolean;
  purgePreview?: BoardPurgePreview | null;
  region?: WorkspaceRegion;
  purgeConfirmationName?: string;
  purgePassword?: string;
  onChangePurgeConfirmationName?: (value: string) => void;
  onChangePurgePassword?: (value: string) => void;
  onCancelPurge?: () => void;
  onConfirmPurge?: () => void;
  onRetryAccess?: () => void;
  /** The group editor of a project Board, shown between details and archive. */
  groups?: ReactNode;
};

export function ServerBoardManagementDisplay({
  view,
  isAdmin = false,
  purgeEnabled = false,
  onChange = () => undefined,
  onSave = () => undefined,
  onRefreshLatest = () => undefined,
  onRetryWithDraft = () => undefined,
  onUseLatest = () => undefined,
  onConfirmLifecycle = () => undefined,
  onBeginPurge = () => undefined,
  purgePreviewLoading = false,
  purgeReviewAgain = false,
  purgePreview = null,
  region,
  purgeConfirmationName = "",
  purgePassword = "",
  onChangePurgeConfirmationName = () => undefined,
  onChangePurgePassword = () => undefined,
  onCancelPurge = () => undefined,
  onConfirmPurge = () => undefined,
  onRetryAccess = () => undefined,
  groups = null,
}: DisplayProps) {
  const e = createElement;
  const id = useId();
  const board = view.board;
  const secondaryButton =
    "border-border bg-card text-foreground focus-visible:outline-ring min-h-11 rounded-md border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";
  const primaryButton =
    "bg-primary text-primary-foreground focus-visible:outline-ring min-h-11 rounded-md px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";
  const controlClass =
    "border-input bg-card text-foreground focus-visible:outline-ring min-h-11 w-full rounded-md border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";
  const warningClass =
    "border-warn-rule bg-warn-tint text-foreground rounded-md border p-4 text-sm";
  if (view.mode === "create" && view.access === "denied")
    return e(
      "div",
      { role: "status", className: warningClass },
      "You cannot create a Board with your current access.",
    );
  if (view.mode === "manage" && (view.access !== "ready" || !view.canManage)) {
    const loading = view.access === "loading";
    const failed = view.access === "error";
    return e(
      "section",
      { "aria-label": "Board management", className: "space-y-3" },
      e(
        "p",
        {
          role: loading ? "status" : "alert",
          className: loading
            ? "text-sm"
            : "border-danger-rule bg-danger-tint rounded-md border p-4 text-sm",
        },
        loading
          ? "Checking Board management access…"
          : failed
            ? "Board management could not be loaded. Try again."
            : "You do not have Board manage access.",
      ),
      failed
        ? e(
            "button",
            {
              type: "button",
              className: secondaryButton,
              onClick: onRetryAccess,
            },
            "Retry access check",
          )
        : null,
    );
  }

  const archived = view.mode === "manage" && board?.status === "archived";
  const project = view.mode === "create" || board?.scope === "project";
  const nameFixed = view.mode === "manage" && board?.scope === "department";
  const dirty =
    view.mode === "create"
      ? view.draft.name !== "" || view.draft.description !== ""
      : board !== null && boardUpdateForDraft(board, view.draft) !== null;
  const savableChanges = view.mode === "create" || dirty;
  const canSave =
    !archived &&
    !view.pending &&
    !view.conflict &&
    validDraft(view.draft) &&
    savableChanges;
  const field = (
    label: string,
    fieldId: string,
    control: ReactNode,
    hint?: ReactNode,
  ) =>
    e(
      "div",
      { className: "space-y-2" },
      e("label", { htmlFor: fieldId, className: "text-sm font-medium" }, label),
      control,
      hint ?? null,
    );
  const form = e(
    "form",
    {
      className: "space-y-5",
      onSubmit: (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        onSave();
      },
    },
    field(
      "Board name",
      `${id}-name`,
      e("input", {
        id: `${id}-name`,
        value: view.draft.name,
        maxLength: 200,
        required: true,
        readOnly: nameFixed,
        disabled: view.pending,
        "aria-describedby": nameFixed ? `${id}-name-hint` : undefined,
        className: controlClass,
        onChange: (event: ChangeEvent<HTMLInputElement>) =>
          onChange({ ...view.draft, name: event.target.value }),
      }),
      nameFixed
        ? e(
            "p",
            {
              id: `${id}-name-hint`,
              className: "text-muted-foreground text-sm",
            },
            "A department Board always has its department's name.",
          )
        : null,
    ),
    field(
      "Description (optional)",
      `${id}-description`,
      e("textarea", {
        id: `${id}-description`,
        value: view.draft.description,
        maxLength: 240,
        disabled: view.pending,
        className: `${controlClass} min-h-24 py-2`,
        onChange: (event: ChangeEvent<HTMLTextAreaElement>) =>
          onChange({ ...view.draft, description: event.target.value }),
      }),
    ),
    e(
      "div",
      { className: "flex flex-wrap gap-2" },
      e(
        "button",
        { type: "submit", className: primaryButton, disabled: !canSave },
        view.pending
          ? "Saving…"
          : view.mode === "create"
            ? "Create Board"
            : "Save changes",
      ),
      view.mode === "manage" && dirty && !view.conflict
        ? e(
            "button",
            {
              type: "button",
              className: secondaryButton,
              disabled: view.pending,
              onClick: onUseLatest,
            },
            "Discard changes",
          )
        : null,
    ),
  );

  return e(
    "section",
    { "aria-label": "Board management", className: "min-w-0 space-y-5" },
    view.error
      ? e(
          "div",
          {
            role: "alert",
            className:
              "border-destructive text-destructive rounded-md border p-4 text-sm",
          },
          view.error,
        )
      : null,
    view.notice
      ? e(
          "div",
          {
            role: "status",
            className: "border-border bg-card rounded-md border p-4 text-sm",
          },
          view.notice,
        )
      : null,
    view.conflict
      ? e(
          "div",
          {
            role: "alert",
            className:
              "border-danger-rule bg-danger-tint rounded-md border p-4 text-sm",
          },
          e(
            "div",
            { className: "space-y-3" },
            e(
              "p",
              null,
              "Board changed elsewhere. Your draft is kept, but saving is paused until you review the latest Board.",
            ),
            view.latestReady && board
              ? e(
                  "div",
                  { className: "space-y-1" },
                  e(
                    "p",
                    null,
                    `Latest Board: ${board.name} · ${board.status}.`,
                  ),
                  e(
                    "p",
                    null,
                    `Latest description: ${board.description || "None"}.`,
                  ),
                )
              : null,
            e(
              "div",
              { className: "flex flex-wrap gap-2" },
              e(
                "button",
                {
                  type: "button",
                  className: secondaryButton,
                  disabled: view.pending,
                  onClick: onRefreshLatest,
                },
                "Refresh latest Board",
              ),
              view.latestReady
                ? e(
                    "button",
                    {
                      type: "button",
                      className: secondaryButton,
                      disabled: view.pending,
                      onClick: onUseLatest,
                    },
                    "Use latest values",
                  )
                : null,
              view.latestReady && board?.status === "active"
                ? e(
                    "button",
                    {
                      type: "button",
                      className: secondaryButton,
                      disabled: view.pending,
                      onClick: onRetryWithDraft,
                    },
                    "Retry with my draft",
                  )
                : null,
            ),
          ),
        )
      : null,
    archived
      ? e(
          "div",
          { className: "space-y-3" },
          e(
            "p",
            { className: "text-muted-foreground text-sm" },
            "This Board is archived. Restore it before you change its details.",
          ),
          e(
            "button",
            {
              type: "button",
              className: secondaryButton,
              disabled: view.pending || view.conflict,
              onClick: () => onConfirmLifecycle("restore"),
            },
            "Restore Board",
          ),
          isAdmin && purgeEnabled
            ? e(
                "div",
                { className: "border-border space-y-3 border-t pt-4" },
                e(
                  "h3",
                  { className: "text-sm font-medium" },
                  "Permanent deletion",
                ),
                e(
                  "p",
                  { className: "text-muted-foreground text-sm" },
                  "Administrators can permanently delete this archived Board after reviewing its dependencies.",
                ),
                e(
                  "button",
                  {
                    type: "button",
                    className: cn(
                      secondaryButton,
                      "border-destructive text-destructive",
                    ),
                    disabled:
                      view.pending || view.conflict || purgePreviewLoading,
                    onClick: onBeginPurge,
                  },
                  purgePreviewLoading
                    ? "Preparing review…"
                    : purgeReviewAgain
                      ? "Review again"
                      : "Permanently delete Board",
                ),
                purgePreview
                  ? e(
                      "div",
                      {
                        className:
                          "border-border space-y-4 rounded-lg border p-4",
                      },
                      e(LifecyclePurgeReview, {
                        preview: purgePreview,
                        region,
                      }),
                      purgePreview.impact.blockers.length > 0
                        ? null
                        : e(
                            "form",
                            {
                              className: "space-y-4",
                              onSubmit: (event: FormEvent<HTMLFormElement>) => {
                                event.preventDefault();
                                onConfirmPurge();
                              },
                            },
                            e(
                              "p",
                              { className: "text-sm", role: "status" },
                              "Type the exact Board name and enter your administrator password to continue.",
                            ),
                            e(
                              "p",
                              { className: "text-sm" },
                              e("span", null, "Board name: "),
                              e(
                                "code",
                                { className: "break-all" },
                                purgePreview.confirmation_name,
                              ),
                            ),
                            e(
                              "div",
                              { className: "space-y-2" },
                              e(
                                "label",
                                {
                                  htmlFor: `${id}-purge-confirmation`,
                                  className: "text-sm font-medium",
                                },
                                "Type the Board name",
                              ),
                              e("input", {
                                id: `${id}-purge-confirmation`,
                                value: purgeConfirmationName,
                                autoComplete: "off",
                                disabled: view.pending,
                                className: controlClass,
                                onChange: (
                                  event: ChangeEvent<HTMLInputElement>,
                                ) =>
                                  onChangePurgeConfirmationName(
                                    event.target.value,
                                  ),
                              }),
                            ),
                            e(
                              "div",
                              { className: "space-y-2" },
                              e(
                                "label",
                                {
                                  htmlFor: `${id}-purge-password`,
                                  className: "text-sm font-medium",
                                },
                                "Administrator password",
                              ),
                              e("input", {
                                id: `${id}-purge-password`,
                                type: "password",
                                value: purgePassword,
                                autoComplete: "current-password",
                                disabled: view.pending,
                                className: controlClass,
                                onChange: (
                                  event: ChangeEvent<HTMLInputElement>,
                                ) => onChangePurgePassword(event.target.value),
                              }),
                            ),
                            e(
                              "div",
                              { className: "flex flex-wrap gap-2" },
                              e(
                                "button",
                                {
                                  type: "submit",
                                  className: cn(
                                    primaryButton,
                                    "bg-destructive text-destructive-foreground",
                                  ),
                                  disabled:
                                    view.pending ||
                                    purgeConfirmationName !==
                                      purgePreview.confirmation_name ||
                                    purgePassword.length === 0,
                                },
                                view.pending
                                  ? "Deleting…"
                                  : "Confirm permanent deletion",
                              ),
                              e(
                                "button",
                                {
                                  type: "button",
                                  className: secondaryButton,
                                  disabled: view.pending,
                                  onClick: onCancelPurge,
                                },
                                "Cancel",
                              ),
                            ),
                          ),
                    )
                  : null,
              )
            : null,
        )
      : form,
    view.mode === "manage" && board && !archived && !project
      ? e(
          "p",
          {
            className:
              "text-muted-foreground border-border border-t pt-5 text-sm",
          },
          board.scope === "company"
            ? "The company Board is always open."
            : "A department Board is archived when its department closes, and restored when it reopens.",
        )
      : null,
    view.mode === "manage" && board && project && view.canManage
      ? groups
      : null,
    view.mode === "manage" && !archived && project
      ? e(
          "div",
          { className: "border-border border-t pt-5" },
          e("h3", { className: "text-sm font-medium" }, "Archive Board"),
          e(
            "p",
            { className: "text-muted-foreground mt-1 text-sm" },
            "Archiving makes this Board read-only until it is restored.",
          ),
          e(
            "button",
            {
              type: "button",
              className: `${secondaryButton} mt-3`,
              disabled: view.pending || view.conflict || dirty,
              onClick: () => onConfirmLifecycle("archive"),
            },
            "Archive Board",
          ),
          dirty
            ? e(
                "p",
                { className: "text-muted-foreground mt-2 text-sm" },
                "Save or discard changes before archiving.",
              )
            : null,
        )
      : null,
  );
}

function ManagementInstance(props: Props) {
  const mode = props.mode;
  const incomingBoard = mode === "manage" ? props.board : null;
  const [internalOpen, setInternalOpen] = useState(false);
  const open = props.open ?? internalOpen;
  const setOpen = props.onOpenChange ?? setInternalOpen;
  const client = useQueryClient();
  const readPurgeSetting = open && mode === "manage" && props.isAdmin === true;
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
  const [confirmation, setConfirmation] = useState<
    "archive" | "restore" | null
  >(null);
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
    incomingBoard ? draftFromBoard(incomingBoard) : blankDraft,
  );
  const [access, setAccess] = useState<BoardManagementView["access"]>(
    mode === "create" ? "ready" : "loading",
  );
  const [accessRetry, setAccessRetry] = useState(0);
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [latestReady, setLatestReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const mountedRef = useRef(false);
  const deniedRef = useRef(false);
  const accessRequest = useRef(0);
  const actionRequest = useRef(0);
  const boardId = incomingBoard?.id ?? null;
  const onAccessDenied = props.mode === "manage" ? props.onAccessDenied : null;

  const clearPurgeReview = useCallback(() => {
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
      if (mode === "create") {
        setAccess("denied");
        setError("You cannot create a Board with your current access.");
        return true;
      }
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
          setError,
          setNotice,
          setConfirmation,
          setDiscardOpen,
          onAccessDenied: () => {
            if (boardId !== null) onAccessDenied?.(boardId);
          },
        },
        revokeBoard,
      );
      return true;
    },
    [mode, boardId, onAccessDenied, clearPurgeReview],
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
      mode !== "manage" ||
      !incomingBoard ||
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
  }, [mode, incomingBoard, board, draft, draftBase, clearPurgeReview]);

  useEffect(() => {
    if (!open || mode !== "manage" || !incomingBoard || deniedRef.current)
      return;
    let current = true;
    const request = ++accessRequest.current;
    setAccess("loading");
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
      },
      (failure: unknown) => {
        if (!current || request !== accessRequest.current || deniedRef.current)
          return;
        if (!handleDenied(failure)) setAccess("error");
      },
    );
    return () => {
      current = false;
      accessRequest.current += 1;
    };
  }, [open, mode, incomingBoard, accessRetry, handleDenied]);

  const view: BoardManagementView = {
    mode,
    board,
    access,
    canManage: mode === "create" || access === "ready",
    draft,
    pending,
    conflict,
    latestReady,
    error,
    notice,
  };
  const dirty =
    mode === "create"
      ? draft.name !== "" || draft.description !== ""
      : board !== null && boardUpdateForDraft(board, draft) !== null;

  const filesEnabled =
    open &&
    mode === "manage" &&
    props.isAdmin === true &&
    board?.status === "active" &&
    access === "ready";
  const filesKey = `${board?.id}:${fileStatus}:${fileOffset}:${fileRefresh}`;
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
        setFileError("Unattached Board files could not be loaded. Try again.");
      })
      .finally(() => {
        if (current) setFileLoading(false);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [filesEnabled, board?.id, fileStatus, fileOffset, filesKey, handleDenied]);

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
      if (
        !mountedRef.current ||
        deniedRef.current ||
        request !== actionRequest.current
      )
        return;
      setNotice("File archived.");
      setFileRefresh((value) => value + 1);
    } catch (failure) {
      if (
        mountedRef.current &&
        !deniedRef.current &&
        request === actionRequest.current &&
        !handleDenied(failure)
      )
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
      if (
        !mountedRef.current ||
        deniedRef.current ||
        request !== actionRequest.current
      )
        return;
      setPurgePreview(preview);
    } catch (failure) {
      if (
        !mountedRef.current ||
        deniedRef.current ||
        request !== actionRequest.current
      )
        return;
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
      if (
        !mountedRef.current ||
        deniedRef.current ||
        request !== actionRequest.current
      )
        return;
      clearPurgeReview();
      setFileRefresh((value) => value + 1);
      setNotice("File permanently deleted.");
      reportDone("File permanently deleted.");
    } catch (failure) {
      if (
        !mountedRef.current ||
        deniedRef.current ||
        request !== actionRequest.current
      )
        return;
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
          "The file was not permanently deleted. Request a new review.",
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
      setOpen(false);
    }
  }

  async function save() {
    if (
      pendingRef.current ||
      deniedRef.current ||
      (mode === "create" && access === "denied") ||
      conflict ||
      !validDraft(draft)
    )
      return;
    if (
      mode === "manage" &&
      (access !== "ready" || !board || board.status !== "active")
    )
      return;
    const update =
      mode === "manage" && board ? boardUpdateForDraft(board, draft) : null;
    if (mode === "manage" && !update) return;
    const request = ++actionRequest.current;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "create") {
        const created = await createBoard(boardCreateForDraft(draft));
        if (
          !mountedRef.current ||
          deniedRef.current ||
          request !== actionRequest.current
        )
          return;
        reportDone("Board created.");
        props.onCreated(created);
        setDraft(blankDraft);
        setOpen(false);
      } else if (board && update) {
        const saved = await updateBoard(board.id, update);
        if (
          !mountedRef.current ||
          deniedRef.current ||
          request !== actionRequest.current
        )
          return;
        setBoard(saved);
        setDraftBase(saved);
        setDraft(draftFromBoard(saved));
        setNotice("Board details saved.");
        props.onUpdated(saved);
      }
    } catch (failure) {
      if (
        !mountedRef.current ||
        deniedRef.current ||
        request !== actionRequest.current
      )
        return;
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
    if (mode !== "manage" || !board || pendingRef.current || deniedRef.current)
      return;
    const request = ++actionRequest.current;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const latest = await readBoard(board.id);
      if (
        !mountedRef.current ||
        deniedRef.current ||
        request !== actionRequest.current
      )
        return;
      setBoard(latest);
      setLatestReady(true);
      props.onUpdated(latest);
    } catch (failure) {
      if (
        !mountedRef.current ||
        deniedRef.current ||
        request !== actionRequest.current
      )
        return;
      if (!handleDenied(failure))
        setError("Latest Board details could not be loaded. Try again.");
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setPending(false);
    }
  }

  /** Saving groups moves the Board revision on; keep the draft if it has changes. */
  async function reloadAfterGroups() {
    if (mode !== "manage" || !board || deniedRef.current) return;
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
      mode !== "manage" ||
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
    try {
      const changed =
        action === "archive"
          ? await archiveBoard(board.id, board.revision)
          : await restoreBoard(board.id, board.revision);
      if (
        !mountedRef.current ||
        deniedRef.current ||
        request !== actionRequest.current
      )
        return;
      setBoard(changed);
      setDraftBase(changed);
      setDraft(draftFromBoard(changed));
      setConfirmation(null);
      clearPurgeReview();
      setNotice(action === "archive" ? "Board archived." : "Board restored.");
      props.onUpdated(changed);
    } catch (failure) {
      if (
        !mountedRef.current ||
        deniedRef.current ||
        request !== actionRequest.current
      )
        return;
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
        setError(
          `Board could not be ${action === "archive" ? "archived" : "restored"}. Try again.`,
        );
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setPending(false);
    }
  }

  async function beginPurgeReview() {
    if (
      mode !== "manage" ||
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
    try {
      const preview = await previewBoardPurge(board.id);
      if (
        !mountedRef.current ||
        deniedRef.current ||
        request !== actionRequest.current
      )
        return;
      setPurgePreview(preview);
      setPurgeReviewAgain(preview.impact.blockers.length > 0);
    } catch (failure) {
      if (
        !mountedRef.current ||
        deniedRef.current ||
        request !== actionRequest.current
      )
        return;
      if (
        failure instanceof ApiError &&
        [401, 404].includes(failure.status) &&
        failure.code !== "challenge_not_found" &&
        handleDenied(failure)
      )
        return;
      setError(boardPurgeFailureMessage(failure, "preview"));
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
      mode !== "manage" ||
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
    const boardId = board.id;
    const request = ++actionRequest.current;
    const password = purgePassword;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await purgeBoard(boardId, {
        token: purgePreview.token,
        confirmationName: purgePreview.confirmation_name,
        password,
      });
      if (
        !mountedRef.current ||
        deniedRef.current ||
        request !== actionRequest.current
      )
        return;
      clearPurgeReview();
      setOpen(false);
      reportDone("Board permanently deleted.");
      if (props.mode === "manage") props.onPurged(boardId);
    } catch (failure) {
      if (
        !mountedRef.current ||
        deniedRef.current ||
        request !== actionRequest.current
      )
        return;
      if (
        failure instanceof ApiError &&
        [401, 404].includes(failure.status) &&
        failure.code !== "challenge_not_found" &&
        handleDenied(failure)
      )
        return;
      setError(boardPurgeFailureMessage(failure, "execute"));
      clearPurgeReview();
      setPurgeReviewAgain(true);
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setPending(false);
      setPurgePassword("");
    }
  }

  return (
    <>
      {props.open === undefined && (
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={() => setOpen(true)}
        >
          {mode === "create" ? "New Board" : "Manage Board"}
        </Button>
      )}
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <SheetContent className="w-full gap-6 overflow-y-auto sm:w-[min(92vw,36rem)]">
          <div className="flex items-start justify-between gap-3">
            <SheetHeader>
              <SheetTitle>
                {mode === "create" ? "New project Board" : "Manage Board"}
              </SheetTitle>
              <SheetDescription>
                {mode === "create"
                  ? "A project Board starts with no groups. Add groups after you create it."
                  : "Change the details of this Board. Access is checked with the server."}
              </SheetDescription>
            </SheetHeader>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 shrink-0"
              onClick={close}
            >
              Close
            </Button>
          </div>
          <ServerBoardManagementDisplay
            view={view}
            isAdmin={props.isAdmin ?? false}
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
            onConfirmLifecycle={(action) => {
              if (!deniedRef.current) setConfirmation(action);
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
            }}
            onConfirmPurge={() => {
              void confirmPurge();
            }}
            onRetryAccess={() => setAccessRetry((value) => value + 1)}
            groups={
              board?.scope === "project" ? (
                <ServerBackedBoardGroups
                  key={`groups:${board.id}`}
                  boardId={board.id}
                  boardActive={board.status === "active"}
                  isAdmin={props.isAdmin ?? false}
                  onChanged={() => {
                    void reloadAfterGroups();
                  }}
                />
              ) : null
            }
          />
          {open &&
            mode === "manage" &&
            props.isAdmin &&
            access === "ready" &&
            board && (
              <section
                aria-label="Unattached Board files"
                className="border-border space-y-4 border-t pt-4"
              >
                <h3 className="text-sm font-medium">Unattached Board files</h3>
                {board.status === "archived" ? (
                  <p className="text-muted-foreground text-sm">
                    Restore this Board to manage its unattached files.
                  </p>
                ) : (
                  <>
                    <p className="text-muted-foreground text-sm">
                      Archive and permanently delete unattached files before
                      archiving this Board. Linked and published files must be
                      handled in their original content.
                    </p>
                    <label className="flex flex-wrap items-center gap-2 text-sm">
                      File status
                      <select
                        className="border-input bg-card min-h-11 rounded-md border px-3"
                        value={fileStatus}
                        disabled={pending}
                        onChange={(event) => {
                          setFileStatus(
                            event.target.value as "exclude" | "only",
                          );
                          setFileOffset(0);
                          clearPurgeReview();
                        }}
                      >
                        <option value="exclude">Active</option>
                        <option value="only">Archived</option>
                      </select>
                    </label>
                    {fileLoading && (
                      <p role="status" className="text-sm">
                        Loading unattached files…
                      </p>
                    )}
                    {fileError && (
                      <div
                        role="alert"
                        className="text-destructive space-y-2 text-sm"
                      >
                        <p>{fileError}</p>
                        <Button
                          variant="outline"
                          onClick={() => setFileRefresh((value) => value + 1)}
                        >
                          Retry file list
                        </Button>
                      </div>
                    )}
                    {filePage && (
                      <>
                        <p
                          className="text-muted-foreground text-sm"
                          role="status"
                        >
                          {filePage.page.pagination.total} files · Showing{" "}
                          {filePage.page.items.length
                            ? filePage.page.pagination.offset + 1
                            : 0}
                          –
                          {filePage.page.pagination.offset +
                            filePage.page.items.length}
                        </p>
                        {filePage.page.items.length === 0 ? (
                          <p className="text-muted-foreground text-sm">
                            No unattached files on this page.
                          </p>
                        ) : (
                          <ul className="space-y-2">
                            {filePage.page.items.map((file) => (
                              <li
                                key={file.id}
                                className="border-border flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                              >
                                <span className="min-w-0 text-sm break-words">
                                  {file.filename}
                                </span>
                                {file.state === "purged" ? (
                                  <span className="text-muted-foreground text-sm">
                                    Permanently deleted
                                  </span>
                                ) : file.state === "deleting" ||
                                  file.state === "uploading" ? (
                                  <span className="text-muted-foreground text-sm">
                                    File operation requires reconciliation.
                                  </span>
                                ) : !file.isDeleted ? (
                                  <Button
                                    variant="outline"
                                    className="min-h-11"
                                    aria-label={`Archive ${file.filename}`}
                                    disabled={
                                      pending ||
                                      dirty ||
                                      conflict ||
                                      fileLoading ||
                                      filePage.key !== filesKey
                                    }
                                    onClick={() => void archiveFile(file)}
                                  >
                                    Archive file
                                  </Button>
                                ) : purgeEnabled ? (
                                  <Button
                                    variant="destructive"
                                    className="min-h-11"
                                    aria-label={`Permanently delete ${file.filename}`}
                                    disabled={
                                      pending ||
                                      dirty ||
                                      conflict ||
                                      fileLoading ||
                                      filePage.key !== filesKey
                                    }
                                    onClick={() => void beginFilePurge(file)}
                                  >
                                    Permanently delete
                                  </Button>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        )}
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            className="min-h-11"
                            disabled={
                              pending || fileLoading || fileOffset === 0
                            }
                            onClick={() =>
                              setFileOffset((value) => Math.max(0, value - 25))
                            }
                          >
                            Previous files
                          </Button>
                          <Button
                            variant="outline"
                            className="min-h-11"
                            disabled={
                              pending ||
                              fileLoading ||
                              filePage.key !== filesKey ||
                              !filePage.page.pagination.hasMore
                            }
                            onClick={() => setFileOffset((value) => value + 25)}
                          >
                            Next files
                          </Button>
                        </div>
                      </>
                    )}
                  </>
                )}
              </section>
            )}
        </SheetContent>
      </Sheet>
      <Dialog
        open={
          purgeFile !== null &&
          purgeTarget?.kind === "file" &&
          purgeTarget.boardId === board?.id &&
          purgeTarget.revision === board.revision &&
          purgeTarget.fileId === purgeFile.id
        }
        dismissible={!pending}
        onOpenChange={(next) => {
          if (!next && !pendingRef.current) {
            clearPurgeReview();
            setError(null);
          }
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Permanently delete file?</DialogTitle>
            <DialogDescription>
              This permanently removes the archived file. Review its impact
              before confirming.
            </DialogDescription>
          </DialogHeader>
          {purgePreviewLoading && <p role="status">Preparing review…</p>}
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          {purgePreview ? (
            <>
              <LifecyclePurgeReview
                preview={purgePreview}
                region={region.data}
              />
              {purgePreview.impact.blockers.length === 0 && (
                <form
                  className="space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void confirmFilePurge();
                  }}
                >
                  <p className="text-sm break-words">
                    File name: <code>{purgePreview.confirmation_name}</code>
                  </p>
                  <label className="block space-y-2 text-sm">
                    Type the file name
                    <Input
                      autoComplete="off"
                      value={purgeConfirmationName}
                      disabled={pending}
                      onChange={(event) =>
                        setPurgeConfirmationName(event.target.value)
                      }
                    />
                  </label>
                  <label className="block space-y-2 text-sm">
                    Administrator password
                    <Input
                      type="password"
                      autoComplete="current-password"
                      value={purgePassword}
                      disabled={pending}
                      onChange={(event) => setPurgePassword(event.target.value)}
                    />
                  </label>
                  <Button
                    variant="destructive"
                    className="min-h-11"
                    type="submit"
                    disabled={
                      pending ||
                      purgeConfirmationName !==
                        purgePreview.confirmation_name ||
                      !purgePassword ||
                      !purgeEnabled
                    }
                  >
                    Confirm permanent deletion
                  </Button>
                </form>
              )}
            </>
          ) : (
            purgeFile &&
            !purgePreviewLoading && (
              <Button
                variant="outline"
                className="min-h-11"
                disabled={pending || !purgeEnabled}
                onClick={() => void beginFilePurge(purgeFile)}
              >
                Review again
              </Button>
            )
          )}
          <Button
            variant="outline"
            className="min-h-11"
            disabled={pending}
            onClick={() => {
              clearPurgeReview();
              setError(null);
            }}
          >
            Cancel
          </Button>
        </DialogContent>
      </Dialog>
      <ConfirmAction
        open={discardOpen}
        title="Discard Board changes?"
        description="Your unsaved Board details will be lost."
        action="Discard changes"
        onConfirm={() => {
          if (deniedRef.current) {
            setDiscardOpen(false);
            setOpen(false);
            return;
          }
          setDraft(board ? draftFromBoard(board) : blankDraft);
          setDraftBase(board);
          setConflict(false);
          setLatestReady(false);
          clearPurgeReview();
          setDiscardOpen(false);
          setOpen(false);
        }}
        onCancel={() => setDiscardOpen(false)}
      />
      <ConfirmAction
        key={board?.id ?? "board-access-denied"}
        open={confirmation !== null}
        title={confirmation === "archive" ? "Archive Board?" : "Restore Board?"}
        description={
          confirmation === "archive"
            ? "The Board will become read-only until restored."
            : "The Board will become editable again for people with access."
        }
        action={confirmation === "archive" ? "Archive Board" : "Restore Board"}
        phrase={confirmation === "archive" ? board?.name : undefined}
        disabled={pending}
        onConfirm={() => {
          if (confirmation) void changeLifecycle(confirmation);
        }}
        onCancel={() => setConfirmation(null)}
      />
    </>
  );
}

export function ServerBackedBoardManagement(props: Props) {
  return (
    <ManagementInstance
      key={props.mode === "manage" ? props.board.id : "create"}
      {...props}
    />
  );
}
