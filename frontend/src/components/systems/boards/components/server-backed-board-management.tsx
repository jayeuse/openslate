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
import { ApiError } from "@/lib/api";
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
  listBoardDepartments,
  type BoardDepartmentChoice,
} from "../adapters/board-departments-api";
import { getMyBoardAccess } from "../adapters/board-tools-api";
import { ConfirmAction } from "./ui";

export type BoardManagementDraft = {
  name: string;
  description: string;
  defaultSection: "overview" | "calendar" | "announcements";
  departmentId: string | null;
};

export type BoardManagementView = {
  mode: "create" | "manage";
  board: BoardManagementBoard | null;
  access: "loading" | "ready" | "denied" | "error";
  canManage: boolean;
  departmentsStatus: "loading" | "ready" | "unavailable";
  departments: BoardDepartmentChoice[];
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

const blankDraft: BoardManagementDraft = {
  name: "",
  description: "",
  defaultSection: "overview",
  departmentId: null,
};

function draftFromBoard(board: BoardManagementBoard): BoardManagementDraft {
  return {
    name: board.name,
    description: board.description ?? "",
    defaultSection: board.defaultSection,
    departmentId: board.departmentId,
  };
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
  departmentsAvailable: boolean,
): BoardCreateInput {
  return {
    name: draft.name.trim(),
    description: cleanDescription(draft.description),
    defaultSection: draft.defaultSection,
    ...(departmentsAvailable ? { departmentId: draft.departmentId } : {}),
  };
}

export function boardUpdateForDraft(
  board: BoardManagementBoard,
  draft: BoardManagementDraft,
  departmentsAvailable: boolean,
): BoardUpdateInput | null {
  const changes: BoardUpdateInput = { revision: board.revision };
  const name = draft.name.trim();
  const description = cleanDescription(draft.description);
  if (name !== board.name) changes.name = name;
  if (description !== board.description) changes.description = description;
  if (draft.defaultSection !== board.defaultSection)
    changes.defaultSection = draft.defaultSection;
  if (departmentsAvailable && draft.departmentId !== board.departmentId)
    changes.departmentId = draft.departmentId;
  return Object.keys(changes).length > 1 ? changes : null;
}

export function rebaseBoardDraft(
  original: BoardManagementBoard,
  latest: BoardManagementBoard,
  draft: BoardManagementDraft,
  departmentsAvailable: boolean,
): BoardManagementDraft {
  return {
    name: draft.name.trim() !== original.name ? draft.name : latest.name,
    description:
      cleanDescription(draft.description) !== original.description
        ? draft.description
        : (latest.description ?? ""),
    defaultSection:
      draft.defaultSection !== original.defaultSection
        ? draft.defaultSection
        : latest.defaultSection,
    departmentId:
      departmentsAvailable && draft.departmentId !== original.departmentId
        ? draft.departmentId
        : latest.departmentId,
  };
}

export type BoardManagementRevocation = {
  accessRequest: { current: number };
  departmentsRequest: { current: number };
  actionRequest: { current: number };
  departmentsAbort: { current: AbortController | null };
  setBoard: (value: null) => void;
  setDraft: (value: BoardManagementDraft) => void;
  setDraftBase: (value: null) => void;
  setDepartments: (value: BoardDepartmentChoice[]) => void;
  setDepartmentsStatus: (value: "unavailable") => void;
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
  targets.departmentsRequest.current += 1;
  targets.actionRequest.current += 1;
  targets.departmentsAbort.current?.abort();
  targets.departmentsAbort.current = null;
  targets.setAccess("denied");
  targets.setBoard(null);
  targets.setDraft(blankDraft);
  targets.setDraftBase(null);
  targets.setDepartments([]);
  targets.setDepartmentsStatus("unavailable");
  targets.setConflict(false);
  targets.setLatestReady(false);
  targets.setError(null);
  targets.setNotice(null);
  targets.setConfirmation(null);
  targets.setDiscardOpen(false);
  if (revokeBoard) targets.onAccessDenied();
}

function departmentCanBeChosen(view: BoardManagementView): boolean {
  return (
    view.departmentsStatus === "ready" &&
    (view.mode === "create" ||
      view.board?.departmentId === null ||
      view.departments.some((item) => item.id === view.board?.departmentId))
  );
}

type DisplayProps = {
  view: BoardManagementView;
  onChange?: (draft: BoardManagementDraft) => void;
  onSave?: () => void;
  onRefreshLatest?: () => void;
  onRetryWithDraft?: () => void;
  onUseLatest?: () => void;
  onConfirmLifecycle?: (action: "archive" | "restore") => void;
  onBeginPurge?: () => void;
  purgePreviewLoading?: boolean;
  purgePreview?: BoardPurgePreview | null;
  purgeConfirmationName?: string;
  purgePassword?: string;
  onChangePurgeConfirmationName?: (value: string) => void;
  onChangePurgePassword?: (value: string) => void;
  onCancelPurge?: () => void;
  onConfirmPurge?: () => void;
  onRetryAccess?: () => void;
  onRetryDepartments?: () => void;
};

export function ServerBoardManagementDisplay({
  view,
  onChange = () => undefined,
  onSave = () => undefined,
  onRefreshLatest = () => undefined,
  onRetryWithDraft = () => undefined,
  onUseLatest = () => undefined,
  onConfirmLifecycle = () => undefined,
  onBeginPurge = () => undefined,
  purgePreviewLoading = false,
  purgePreview = null,
  purgeConfirmationName = "",
  purgePassword = "",
  onChangePurgeConfirmationName = () => undefined,
  onChangePurgePassword = () => undefined,
  onCancelPurge = () => undefined,
  onConfirmPurge = () => undefined,
  onRetryAccess = () => undefined,
  onRetryDepartments = () => undefined,
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
    "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100 rounded-md border p-4 text-sm";
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
        { role: loading ? "status" : "alert", className: "text-sm" },
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
  const chooserAvailable = departmentCanBeChosen(view);
  const dirty =
    view.mode === "create"
      ? view.draft.name !== "" ||
        view.draft.description !== "" ||
        view.draft.defaultSection !== "overview" ||
        view.draft.departmentId !== null
      : board !== null && boardUpdateForDraft(board, view.draft, true) !== null;
  const savableChanges =
    view.mode === "create" ||
    (board !== null &&
      boardUpdateForDraft(board, view.draft, chooserAvailable) !== null);
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
  const departmentHint = !chooserAvailable
    ? e(
        "div",
        { className: "text-muted-foreground space-y-2 text-sm" },
        e(
          "p",
          null,
          view.departmentsStatus === "loading"
            ? "Loading department choices… "
            : "Department choices are unavailable. ",
          view.mode === "create"
            ? "No department will be assigned."
            : "Current department will stay unchanged.",
        ),
        view.departmentsStatus === "unavailable"
          ? e(
              "button",
              {
                type: "button",
                className: secondaryButton,
                onClick: onRetryDepartments,
              },
              "Retry departments",
            )
          : null,
      )
    : null;
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
        disabled: view.pending,
        className: controlClass,
        onChange: (event: ChangeEvent<HTMLInputElement>) =>
          onChange({ ...view.draft, name: event.target.value }),
      }),
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
    field(
      "Default section",
      `${id}-section`,
      e(
        "select",
        {
          id: `${id}-section`,
          className: controlClass,
          value: view.draft.defaultSection,
          disabled: view.pending,
          onChange: (event: ChangeEvent<HTMLSelectElement>) =>
            onChange({
              ...view.draft,
              defaultSection: event.target
                .value as BoardManagementDraft["defaultSection"],
            }),
        },
        e("option", { value: "overview" }, "Overview"),
        e("option", { value: "calendar" }, "Calendar"),
        e("option", { value: "announcements" }, "Announcements"),
      ),
    ),
    field(
      "Department (optional)",
      `${id}-department`,
      e(
        "select",
        {
          id: `${id}-department`,
          className: controlClass,
          value: chooserAvailable ? (view.draft.departmentId ?? "") : "",
          disabled: !chooserAvailable || view.pending,
          onChange: (event: ChangeEvent<HTMLSelectElement>) =>
            onChange({
              ...view.draft,
              departmentId: event.target.value || null,
            }),
        },
        e("option", { value: "" }, "No department"),
        ...(chooserAvailable
          ? view.departments.map((department) =>
              e(
                "option",
                { key: department.id, value: department.id },
                department.name,
              ),
            )
          : []),
      ),
      departmentHint,
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
          { role: "status", className: warningClass },
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
                    `Latest Board: ${board.name} · ${board.status} · default ${board.defaultSection}.`,
                  ),
                  e(
                    "p",
                    null,
                    `Latest description: ${board.description || "None"}.`,
                  ),
                  e(
                    "p",
                    null,
                    chooserAvailable
                      ? `Latest department: ${view.departments.find((item) => item.id === board.departmentId)?.name ?? "None"}.`
                      : "Latest department label is unavailable; the assignment will stay unchanged.",
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
            "This Board is archived. Restore it before editing its details or department.",
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
          e(
            "div",
            { className: "border-border space-y-3 border-t pt-4" },
            e("h3", { className: "text-sm font-medium" }, "Permanent deletion"),
            e(
              "p",
              { className: "text-muted-foreground text-sm" },
              "Administrators can permanently delete this archived Board after reviewing its dependencies.",
            ),
            e(
              "button",
              {
                type: "button",
                className: `${secondaryButton} border-destructive text-destructive`,
                disabled: view.pending || view.conflict || purgePreviewLoading,
                onClick: onBeginPurge,
              },
              purgePreviewLoading
                ? "Preparing review…"
                : "Permanently delete Board",
            ),
            purgePreview
              ? e(
                  "form",
                  {
                    className: "border-border space-y-4 rounded-lg border p-4",
                    onSubmit: (event: FormEvent<HTMLFormElement>) => {
                      event.preventDefault();
                      onConfirmPurge();
                    },
                  },
                  e(
                    "p",
                    { className: "text-sm", role: "status" },
                    `The review includes ${purgePreview.impact.rows.length} retained items. Type the exact Board UUID and enter your administrator password to continue.`,
                  ),
                  e(
                    "p",
                    { className: "text-sm" },
                    e("span", null, "Board UUID: "),
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
                      "Type the Board UUID",
                    ),
                    e("input", {
                      id: `${id}-purge-confirmation`,
                      value: purgeConfirmationName,
                      autoComplete: "off",
                      disabled: view.pending,
                      className: controlClass,
                      onChange: (event: ChangeEvent<HTMLInputElement>) =>
                        onChangePurgeConfirmationName(event.target.value),
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
                      onChange: (event: ChangeEvent<HTMLInputElement>) =>
                        onChangePurgePassword(event.target.value),
                    }),
                  ),
                  e(
                    "div",
                    { className: "flex flex-wrap gap-2" },
                    e(
                      "button",
                      {
                        type: "submit",
                        className: `${primaryButton} bg-destructive text-destructive-foreground`,
                        disabled:
                          view.pending ||
                          purgeConfirmationName !==
                            purgePreview.confirmation_name ||
                          purgePassword.length === 0,
                      },
                      view.pending ? "Deleting…" : "Confirm permanent deletion",
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
                )
              : null,
          ),
        )
      : form,
    view.mode === "manage" && !archived
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
  const [discardOpen, setDiscardOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<
    "archive" | "restore" | null
  >(null);
  const [purgePreview, setPurgePreview] = useState<BoardPurgePreview | null>(
    null,
  );
  const [purgePreviewLoading, setPurgePreviewLoading] = useState(false);
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
  const [departmentsStatus, setDepartmentsStatus] =
    useState<BoardManagementView["departmentsStatus"]>("loading");
  const [departments, setDepartments] = useState<BoardDepartmentChoice[]>([]);
  const [accessRetry, setAccessRetry] = useState(0);
  const [departmentsRetry, setDepartmentsRetry] = useState(0);
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [latestReady, setLatestReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const mountedRef = useRef(false);
  const deniedRef = useRef(false);
  const accessRequest = useRef(0);
  const departmentsRequest = useRef(0);
  const actionRequest = useRef(0);
  const departmentsAbort = useRef<AbortController | null>(null);
  const boardId = incomingBoard?.id ?? null;
  const onAccessDenied = props.mode === "manage" ? props.onAccessDenied : null;

  const clearPurgeReview = useCallback(() => {
    setPurgePreview(null);
    setPurgePreviewLoading(false);
    setPurgeConfirmationName("");
    setPurgePassword("");
  }, []);

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
          departmentsRequest,
          actionRequest,
          departmentsAbort,
          setBoard,
          setDraft,
          setDraftBase,
          setDepartments,
          setDepartmentsStatus,
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
      draftBase !== null &&
      boardUpdateForDraft(draftBase, draft, true) !== null;
    setBoard(incomingBoard);
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
  }, [mode, incomingBoard, board, draft, draftBase]);

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

  useEffect(() => {
    if (!open || deniedRef.current || (mode === "manage" && access !== "ready"))
      return;
    const controller = new AbortController();
    const request = ++departmentsRequest.current;
    departmentsAbort.current = controller;
    setDepartmentsStatus("loading");
    setDepartments([]);
    void listBoardDepartments(controller.signal).then(
      (choices) => {
        if (
          !controller.signal.aborted &&
          !deniedRef.current &&
          request === departmentsRequest.current
        ) {
          setDepartments(choices);
          setDepartmentsStatus("ready");
        }
      },
      () => {
        if (
          !controller.signal.aborted &&
          !deniedRef.current &&
          request === departmentsRequest.current
        )
          setDepartmentsStatus("unavailable");
      },
    );
    return () => {
      controller.abort();
      if (departmentsAbort.current === controller)
        departmentsAbort.current = null;
      departmentsRequest.current += 1;
    };
  }, [open, mode, access, departmentsRetry]);

  const view: BoardManagementView = {
    mode,
    board,
    access,
    canManage: mode === "create" || access === "ready",
    departmentsStatus,
    departments,
    draft,
    pending,
    conflict,
    latestReady,
    error,
    notice,
  };
  const chooseDepartment = departmentCanBeChosen(view);
  const dirty =
    mode === "create"
      ? draft.name !== "" ||
        draft.description !== "" ||
        draft.defaultSection !== "overview" ||
        draft.departmentId !== null
      : board !== null && boardUpdateForDraft(board, draft, true) !== null;

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
      mode === "manage" && board
        ? boardUpdateForDraft(board, draft, chooseDepartment)
        : null;
    if (mode === "manage" && !update) return;
    const request = ++actionRequest.current;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "create") {
        const created = await createBoard(
          boardCreateForDraft(draft, chooseDepartment),
        );
        if (
          !mountedRef.current ||
          deniedRef.current ||
          request !== actionRequest.current
        )
          return;
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
        handleDenied(failure)
      )
        return;
      setError(
        failure instanceof ApiError && failure.status === 403
          ? "Only an administrator can permanently delete a Board."
          : "A permanent-deletion review could not be prepared. Check the Board and try again.",
      );
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) {
        setPending(false);
        setPurgePreviewLoading(false);
      }
    }
  }

  async function confirmPurge() {
    if (
      mode !== "manage" ||
      !board ||
      board.status !== "archived" ||
      access !== "ready" ||
      !purgePreview ||
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
        handleDenied(failure)
      )
        return;
      setError(
        failure instanceof ApiError && failure.status === 403
          ? "Administrator verification failed. Confirm your password and access, then request a new review."
          : failure instanceof ApiError && failure.status === 409
            ? "The Board or its dependencies changed, or the review expired. Request a new review."
            : "The Board was not permanently deleted. Request a new review and try again.",
      );
      clearPurgeReview();
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
                {mode === "create" ? "Create a Board" : "Manage Board"}
              </SheetTitle>
              <SheetDescription>
                {mode === "create"
                  ? "Give this Board a name and choose where it opens."
                  : "Update details or archive this Board. Access is checked with the server."}
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
              setDraft(
                rebaseBoardDraft(draftBase, board, draft, chooseDepartment),
              );
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
            purgePreview={purgePreview}
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
            onRetryDepartments={() => setDepartmentsRetry((value) => value + 1)}
          />
        </SheetContent>
      </Sheet>
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
