"use client";

import { Fragment, createElement, useId, type ChangeEvent } from "react";
import type { BoardManagementBoard } from "../adapters/board-management-api";
import {
  useServerBoardPortability,
  type PortabilityAction,
  type PortabilityConfirmation,
  type PortabilitySourceStatus,
} from "../hooks/use-server-board-portability";
import { ConfirmAction } from "./ui";

export function ServerBoardPortabilityDisplay({
  board,
  source = null,
  sourceStatus = "idle",
  canDuplicate = false,
  pending = null,
  selectedFileName = null,
  preparedFilename = null,
  preparedUrl = null,
  error = null,
  notice = null,
  onSelectFile,
  onExport,
  onConfirmChoice,
  onRetry,
}: {
  board: BoardManagementBoard | null;
  source?: BoardManagementBoard | null;
  sourceStatus?: PortabilitySourceStatus;
  canDuplicate?: boolean;
  pending?: PortabilityAction | null;
  selectedFileName?: string | null;
  preparedFilename?: string | null;
  preparedUrl?: string | null;
  error?: string | null;
  notice?: string | null;
  onSelectFile?: (file: File | null) => void;
  onExport?: () => void;
  onConfirmChoice?: (kind: PortabilityConfirmation) => void;
  onRetry?: () => void;
}) {
  const e = createElement;
  const fileId = useId();
  const current =
    board !== null &&
    sourceStatus === "ready" &&
    source?.id === board.id &&
    source.revision === board.revision;
  const stale = board !== null && sourceStatus === "ready" && !current;
  return e(
    "section",
    { "aria-label": "Board portability", className: "min-w-0 space-y-5" },
    e(
      "div",
      null,
      e("h2", { className: "text-lg font-semibold" }, "Board portability"),
      e(
        "p",
        { className: "text-muted-foreground mt-1 text-sm" },
        "A configuration holds the Board name, description and widgets. It does not include posts, events, files, record links or groups.",
      ),
    ),
    error
      ? e(
          "p",
          {
            role: "alert",
            className:
              "border-destructive text-destructive rounded-md border p-3 text-sm",
          },
          error,
        )
      : null,
    notice ? e("p", { role: "status", className: "text-sm" }, notice) : null,
    e(
      "div",
      { className: "border-border space-y-3 rounded-xl border p-4" },
      e("h3", { className: "font-medium" }, "Import a configuration"),
      e(
        "p",
        { className: "text-muted-foreground text-sm" },
        "Choose a Board configuration JSON file, up to 1 MiB. Import creates a new project Board with no groups; it never writes into the selected Board.",
      ),
      e(
        "label",
        { htmlFor: fileId, className: "block text-sm font-medium" },
        "Board configuration file",
      ),
      e("input", {
        id: fileId,
        type: "file",
        accept: ".json,application/json",
        disabled: pending !== null,
        className:
          "border-input bg-card text-foreground focus-visible:outline-ring min-h-11 w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2",
        onChange: (event: ChangeEvent<HTMLInputElement>) => {
          onSelectFile?.(event.target.files?.[0] ?? null);
          event.target.value = "";
        },
      }),
      selectedFileName
        ? e(
            "p",
            { className: "text-muted-foreground text-sm break-all" },
            `Selected: ${selectedFileName}`,
          )
        : null,
      e(
        "button",
        {
          type: "button",
          className:
            "bg-primary text-primary-foreground focus-visible:outline-ring min-h-11 rounded-md px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50",
          disabled: pending !== null || !selectedFileName,
          onClick: () => onConfirmChoice?.("import"),
        },
        "Import configuration",
      ),
    ),
    board
      ? e(
          "div",
          { className: "border-border space-y-3 rounded-xl border p-4" },
          e("h3", { className: "font-medium" }, "Current Board structure"),
          sourceStatus === "loading"
            ? e(
                "p",
                { role: "status", className: "text-muted-foreground text-sm" },
                "Checking current Board access…",
              )
            : null,
          sourceStatus === "unavailable"
            ? e(
                "div",
                {
                  role: "status",
                  className: "border-border rounded-md border p-3 text-sm",
                },
                "Current Board access is unavailable. Import remains available if your workspace permissions allow it.",
                e(
                  "button",
                  {
                    type: "button",
                    className:
                      "border-border bg-card text-foreground focus-visible:outline-ring mt-3 min-h-11 rounded-md border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2",
                    disabled: pending !== null,
                    onClick: onRetry,
                  },
                  "Retry Board access",
                ),
              )
            : null,
          stale
            ? e(
                "p",
                {
                  role: "status",
                  className: "border-border rounded-md border p-3 text-sm",
                },
                "This Board changed. Refresh the Board before exporting or duplicating its structure.",
              )
            : null,
          current
            ? e(
                "div",
                { className: "flex flex-wrap gap-3" },
                e(
                  "button",
                  {
                    type: "button",
                    className:
                      "border-border bg-card text-foreground focus-visible:outline-ring min-h-11 rounded-md border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50",
                    disabled: pending !== null,
                    onClick: onExport,
                  },
                  pending === "export"
                    ? "Preparing configuration…"
                    : "Export configuration",
                ),
                canDuplicate
                  ? e(
                      "button",
                      {
                        type: "button",
                        className:
                          "border-border bg-card text-foreground focus-visible:outline-ring min-h-11 rounded-md border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50",
                        disabled: pending !== null,
                        onClick: () => onConfirmChoice?.("duplicate"),
                      },
                      "Duplicate Board",
                    )
                  : null,
              )
            : null,
          current && preparedUrl && preparedFilename
            ? e(
                "a",
                {
                  href: preparedUrl,
                  download: preparedFilename,
                  className:
                    "text-primary focus-visible:outline-ring inline-flex min-h-11 items-center rounded-md text-sm font-medium underline focus-visible:outline-2 focus-visible:outline-offset-2",
                },
                "Download configuration",
              )
            : null,
        )
      : null,
  );
}

export function ServerBackedBoardPortability({
  board,
  refreshKey,
  onBoardCreated,
  onAccessDenied,
}: {
  board: BoardManagementBoard | null;
  refreshKey: number;
  onBoardCreated: (board: BoardManagementBoard) => void;
  onAccessDenied: (boardId: string) => void;
}) {
  const model = useServerBoardPortability({
    board,
    refreshKey,
    onBoardCreated,
    onAccessDenied,
  });
  return createElement(
    Fragment,
    null,
    createElement(ServerBoardPortabilityDisplay, {
      board,
      source: model.source,
      sourceStatus: model.sourceStatus,
      canDuplicate: model.canDuplicate,
      pending: model.pending,
      selectedFileName: model.selectedFileName,
      preparedFilename: model.preparedFilename,
      preparedUrl: model.preparedUrl,
      error: model.error,
      notice: model.notice,
      onSelectFile: model.selectFile,
      onExport: model.runExport,
      onConfirmChoice: model.setConfirmation,
      onRetry: model.retry,
    }),
    createElement(ConfirmAction, {
      open: model.confirmation === "import" && !!model.selectedFileName,
      title: "Import Board configuration?",
      description:
        "This creates a new project Board with no groups from the configuration. Posts, events, files and record links are not copied.",
      action: "Create project Board",
      onConfirm: model.confirmAction,
      onCancel: () => model.setConfirmation(null),
      disabled: model.pending !== null,
    }),
    createElement(ConfirmAction, {
      open:
        model.confirmation === "duplicate" &&
        board !== null &&
        model.sourceStatus === "ready" &&
        model.source?.id === board.id &&
        model.source.revision === board.revision &&
        model.canDuplicate,
      title: "Duplicate Board structure?",
      description:
        "This creates a new project Board with no groups and the widgets of the current Board. Posts, events, files and record links are not copied.",
      action: "Duplicate structure",
      onConfirm: model.confirmAction,
      onCancel: () => model.setConfirmation(null),
      disabled: model.pending !== null,
    }),
  );
}
