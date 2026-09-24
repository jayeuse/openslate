"use client";

import { createElement, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  BoardManagementBoard,
  BoardTemplate,
} from "../adapters/board-management-api";
import {
  useServerBoardTemplates,
  type BoardTemplatesState,
} from "../hooks/use-server-board-templates";

export function ServerBoardTemplatesDisplay({
  state,
  board,
  name = "",
  pending = false,
  notice = null,
  onNameChange,
  onSave,
  onInstantiate,
  onRetry,
}: {
  state: BoardTemplatesState;
  board: BoardManagementBoard | null;
  name?: string;
  pending?: boolean;
  notice?: string | null;
  onNameChange?: (name: string) => void;
  onSave?: () => void;
  onInstantiate?: (template: BoardTemplate) => void;
  onRetry?: () => void;
}) {
  const currentBoard =
    board !== null &&
    state.source?.id === board.id &&
    state.source.revision === board.revision;
  const canSave =
    state.status === "ready" &&
    currentBoard &&
    state.canManage &&
    state.source?.status === "active" &&
    board?.status === "active";
  const canInstantiate = state.status === "ready" && !pending;
  return createElement(
    "section",
    { "aria-label": "Board templates", className: "min-w-0 space-y-5" },
    createElement(
      "div",
      null,
      createElement(
        "h2",
        { className: "text-lg font-semibold" },
        "Board templates",
      ),
      createElement(
        "p",
        { className: "text-muted-foreground mt-1 text-sm" },
        "Templates copy Board structure only. They do not include record data, linked records, events, announcements, files, audiences or access grants.",
      ),
    ),
    notice
      ? createElement("p", { role: "status", className: "text-sm" }, notice)
      : null,
    state.error
      ? createElement(
          Alert,
          { variant: state.templates ? "warning" : "destructive" },
          createElement("p", null, state.error),
          onRetry
            ? createElement(
                Button,
                {
                  type: "button",
                  variant: "outline",
                  className: "mt-3 min-h-11",
                  onClick: onRetry,
                },
                "Retry templates",
              )
            : null,
        )
      : null,
    state.status === "loading"
      ? createElement(
          "p",
          { role: "status", className: "text-muted-foreground text-sm" },
          "Checking template access…",
        )
      : null,
    state.templates === null
      ? null
      : state.templates.length === 0
        ? createElement(
            "p",
            {
              className:
                "border-border text-muted-foreground rounded-xl border border-dashed p-6 text-sm",
            },
            "No Board templates yet.",
          )
        : createElement(
            "ul",
            { className: "space-y-3" },
            ...state.templates.map((template) =>
              createElement(
                "li",
                {
                  key: template.id,
                  className:
                    "border-border bg-card flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border p-4",
                },
                createElement(
                  "div",
                  { className: "min-w-0" },
                  createElement(
                    "p",
                    { className: "font-medium break-words" },
                    template.name,
                  ),
                  createElement(
                    "p",
                    { className: "text-muted-foreground text-sm" },
                    `${template.widgetCount} ${template.widgetCount === 1 ? "widget" : "widgets"}`,
                  ),
                ),
                onInstantiate
                  ? createElement(
                      Button,
                      {
                        type: "button",
                        variant: "outline",
                        className: "min-h-11",
                        disabled: !canInstantiate,
                        onClick: () => onInstantiate(template),
                        "aria-label": `Create private Board from ${template.name}`,
                      },
                      "Create private Board",
                    )
                  : null,
              ),
            ),
          ),
    board && state.status === "ready" && !currentBoard
      ? createElement(
          Alert,
          { variant: "warning" },
          "This Board changed. Refresh the Board before saving a template.",
        )
      : null,
    canSave
      ? createElement(
          "form",
          {
            className: "border-border space-y-3 border-t pt-5",
            onSubmit: (event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              onSave?.();
            },
          },
          createElement(
            "div",
            null,
            createElement(
              "label",
              {
                htmlFor: "board-template-name",
                className: "mb-1 block text-sm font-medium",
              },
              "Template name",
            ),
            createElement(Input, {
              id: "board-template-name",
              value: name,
              maxLength: 80,
              required: true,
              className: "min-h-11",
              onChange: (event) => onNameChange?.(event.target.value),
            }),
          ),
          createElement(
            Button,
            {
              type: "submit",
              className: "min-h-11",
              disabled: pending || !name.trim() || !onSave,
            },
            "Save current Board as template",
          ),
        )
      : null,
  );
}

export function ServerBackedBoardTemplates({
  board,
  refreshKey,
  onBoardCreated,
}: {
  board: BoardManagementBoard | null;
  refreshKey: number;
  onBoardCreated: (board: BoardManagementBoard) => void;
}) {
  const model = useServerBoardTemplates(board, refreshKey, onBoardCreated);
  return createElement(ServerBoardTemplatesDisplay, {
    state: model.state,
    board,
    name: model.name,
    pending: model.pending,
    notice: model.notice,
    onNameChange: model.setName,
    onSave: model.save,
    onInstantiate: model.instantiate,
    onRetry: model.retry,
  });
}
