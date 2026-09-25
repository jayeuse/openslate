"use client";

import { Fragment, createElement } from "react";
import {
  type BoardAnnouncement,
  type BoardAnnouncementPage,
  type BoardAnnouncementView,
} from "../adapters/board-announcements-api";
import { useServerBoardAnnouncementLifecycle } from "../hooks/use-server-board-announcement-lifecycle";
import { ConfirmAction } from "./ui";

export { prepareBoardAnnouncementLifecycleAction } from "../hooks/use-server-board-announcement-lifecycle";

export type AnnouncementLifecycleAction = {
  kind: "archive" | "restore" | "delete";
  boardId: string;
  announcementId: string;
  title: string;
  boardRevision: number;
  announcementRevision: number;
};

export type AnnouncementLifecycleView = {
  status: "loading" | "ready" | "error" | "denied";
  active: boolean;
  canManage: boolean;
  view: BoardAnnouncementView;
  page: BoardAnnouncementPage | null;
  pending: boolean;
  conflict: boolean;
  error: string | null;
  notice: string | null;
  confirmation: AnnouncementLifecycleAction | null;
};

export function ServerBoardAnnouncementLifecycleDisplay({
  view,
  onSelectView,
  onRetry,
  onPage,
  onBeginAction,
}: {
  view: AnnouncementLifecycleView;
  onSelectView: (view: BoardAnnouncementView) => void;
  onRetry: () => void;
  onPage: (offset: number) => void;
  onBeginAction: (
    item: BoardAnnouncement,
    kind: AnnouncementLifecycleAction["kind"],
  ) => void;
}) {
  const e = createElement;
  const primaryClass =
    "bg-primary text-primary-foreground focus-visible:outline-ring min-h-11 rounded-md px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";
  const secondaryClass =
    "border-border bg-card text-foreground hover:bg-muted focus-visible:outline-ring min-h-11 rounded-md border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";
  const destructiveClass =
    "bg-destructive text-destructive-foreground focus-visible:outline-ring min-h-11 rounded-md px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";
  const heading = e(
    "h2",
    { className: "text-lg font-semibold" },
    "Announcement lifecycle",
  );
  if (!view.active || view.status === "denied") {
    return e(
      "section",
      { "aria-label": "Announcement lifecycle", className: "min-w-0" },
      heading,
      e(
        "p",
        { className: "text-muted-foreground mt-2 text-sm" },
        !view.active
          ? "This Board is archived and read-only."
          : "Announcement management is unavailable for your current access.",
      ),
    );
  }
  if (view.status === "loading" || view.status === "error") {
    return e(
      "section",
      { "aria-label": "Announcement lifecycle", className: "min-w-0" },
      heading,
      e(
        "p",
        {
          role: view.status === "error" ? "alert" : "status",
          className: "mt-2 text-sm",
        },
        view.status === "loading"
          ? "Loading announcements…"
          : (view.error ?? "Announcements are unavailable."),
      ),
      view.status === "error"
        ? e(
            "button",
            {
              type: "button",
              className: `${secondaryClass} mt-3`,
              onClick: onRetry,
            },
            "Retry",
          )
        : null,
    );
  }
  if (!view.canManage) {
    return e(
      "section",
      { "aria-label": "Announcement lifecycle", className: "min-w-0" },
      heading,
      e(
        "p",
        { className: "text-muted-foreground mt-2 text-sm" },
        "Announcement management is unavailable for your current access.",
      ),
    );
  }
  const page = view.page;
  if (page === null) return null;
  const { offset, count, total, hasMore } = page.pagination;
  const options: { value: BoardAnnouncementView; label: string }[] = [
    { value: "published", label: "Published" },
    { value: "draft", label: "Drafts & scheduled" },
    { value: "archive", label: "Archived" },
  ];
  return e(
    "section",
    {
      "aria-label": "Announcement lifecycle",
      className: "flex min-w-0 flex-col gap-4",
    },
    e(
      "div",
      { className: "flex flex-wrap items-start justify-between gap-3" },
      e(
        "div",
        null,
        heading,
        e(
          "p",
          { className: "text-muted-foreground mt-1 text-sm" },
          "Only announcements allowed by your content audience are shown. Management is checked again before each change.",
        ),
      ),
      e(
        "button",
        {
          type: "button",
          className: secondaryClass,
          disabled: view.pending,
          onClick: onRetry,
        },
        "Refresh announcements",
      ),
    ),
    view.error
      ? e(
          "p",
          { role: "alert", className: "text-destructive text-sm" },
          view.error,
        )
      : null,
    view.conflict
      ? e(
          "p",
          { role: "alert", className: "text-muted-foreground text-sm" },
          "This announcement changed elsewhere. Refresh the list before trying again.",
        )
      : null,
    view.notice
      ? e(
          "p",
          { role: "status", className: "text-muted-foreground text-sm" },
          view.notice,
        )
      : null,
    e(
      "div",
      {
        role: "group",
        "aria-label": "Announcement views",
        className: "flex flex-wrap gap-2",
      },
      ...options.map(({ value, label }) =>
        e(
          "button",
          {
            key: value,
            type: "button",
            className: view.view === value ? primaryClass : secondaryClass,
            disabled: view.pending,
            "aria-pressed": view.view === value,
            onClick: () => onSelectView(value),
          },
          label,
        ),
      ),
    ),
    e(
      "p",
      { role: "status", className: "text-muted-foreground text-sm" },
      total === 0
        ? "No announcements in this view."
        : count === 0
          ? `No announcements on this page · ${total} total`
          : `Showing ${offset + 1}–${offset + count} of ${total}`,
    ),
    count === 0
      ? e(
          "p",
          {
            className:
              "border-border rounded-xl border border-dashed p-6 text-sm",
          },
          "There are no announcements on this page.",
        )
      : e(
          "ul",
          { className: "flex min-w-0 flex-col gap-2" },
          ...page.items.map((item) =>
            e(
              "li",
              {
                key: item.id,
                className:
                  "border-border bg-card flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border p-4",
              },
              e(
                "div",
                { className: "min-w-0" },
                e("h3", { className: "font-medium break-words" }, item.title),
                e(
                  "p",
                  { className: "text-muted-foreground text-sm capitalize" },
                  item.status,
                ),
              ),
              !view.conflict
                ? e(
                    "div",
                    { className: "flex flex-wrap gap-2" },
                    item.status !== "archived"
                      ? e(
                          "button",
                          {
                            type: "button",
                            className: secondaryClass,
                            disabled: view.pending,
                            onClick: () => onBeginAction(item, "archive"),
                            "aria-label": `Archive announcement ${item.title}`,
                          },
                          "Archive announcement",
                        )
                      : e(
                          "button",
                          {
                            type: "button",
                            className: secondaryClass,
                            disabled: view.pending,
                            onClick: () => onBeginAction(item, "restore"),
                            "aria-label": `Restore announcement ${item.title}`,
                          },
                          "Restore announcement",
                        ),
                    item.status === "archived"
                      ? e(
                          "button",
                          {
                            type: "button",
                            className: destructiveClass,
                            disabled: view.pending,
                            onClick: () => onBeginAction(item, "delete"),
                            "aria-label": `Delete permanently ${item.title}`,
                          },
                          "Delete permanently",
                        )
                      : null,
                  )
                : null,
            ),
          ),
        ),
    e(
      "div",
      { className: "flex flex-wrap gap-2" },
      e(
        "button",
        {
          type: "button",
          className: secondaryClass,
          disabled: view.pending || offset === 0,
          onClick: () => onPage(Math.max(0, offset - 25)),
        },
        "Previous page",
      ),
      e(
        "button",
        {
          type: "button",
          className: secondaryClass,
          disabled: view.pending || !hasMore,
          onClick: () => onPage(offset + 25),
        },
        "Next page",
      ),
    ),
  );
}

export function ServerBackedBoardAnnouncementLifecycle({
  boardId,
  boardStatus,
  refreshKey,
  onChanged,
  onAccessDenied,
}: {
  boardId: string;
  boardStatus: "active" | "archived";
  refreshKey: number;
  onChanged?: (boardId: string) => void;
  onAccessDenied?: (boardId: string) => void;
}) {
  const panel = useServerBoardAnnouncementLifecycle({
    boardId,
    boardStatus,
    refreshKey,
    onChanged,
    onAccessDenied,
  });
  const confirmation = panel.view.confirmation;
  return createElement(
    Fragment,
    null,
    createElement(ServerBoardAnnouncementLifecycleDisplay, {
      view: panel.view,
      onSelectView: panel.selectView,
      onRetry: panel.retry,
      onPage: panel.selectPage,
      onBeginAction: panel.beginAction,
    }),
    createElement(ConfirmAction, {
      open:
        panel.view.status === "ready" &&
        panel.view.canManage &&
        !panel.view.conflict &&
        confirmation !== null,
      title:
        confirmation?.kind === "delete"
          ? "Permanently delete announcement?"
          : "Archive announcement?",
      description:
        confirmation?.kind === "delete"
          ? `Delete “${confirmation.title}” and all its published revisions? This cannot be undone.`
          : `Archive “${confirmation?.title ?? "this announcement"}”? It will no longer appear in published or draft lists.`,
      action:
        confirmation?.kind === "delete"
          ? "Delete permanently"
          : "Archive announcement",
      phrase: confirmation?.kind === "delete" ? confirmation.title : undefined,
      disabled: panel.view.pending,
      onConfirm: panel.confirm,
      onCancel: panel.cancelConfirmation,
    }),
  );
}
