"use client";

import { createElement } from "react";
import type { BoardAnnouncementPage } from "../adapters/board-announcements-api";
import type { BoardAnnouncementPersonalState } from "../adapters/board-announcement-personal-api";
import { HydratedBoardAttachments } from "./server-backed-board-attachments";
import { HydratedBoardRecordLinks } from "./hydrated-board-record-links";

function publishedLabel(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(timestamp));
}

export function ServerBoardAnnouncementFeedDisplay({
  page,
  personal,
  pendingId = null,
  actionsDisabled = false,
  appliedSearch = "",
  authorLabels = null,
  onToggleRead,
  onToggleBookmark,
}: {
  page: BoardAnnouncementPage;
  personal?: Record<string, BoardAnnouncementPersonalState> | null;
  pendingId?: string | null;
  actionsDisabled?: boolean;
  appliedSearch?: string;
  authorLabels?: Record<string, string> | null;
  onToggleRead?: (
    announcementId: string,
    publicationNumber: number,
    read: boolean,
  ) => void;
  onToggleBookmark?: (
    announcementId: string,
    publicationNumber: number,
    bookmarked: boolean,
  ) => void;
}) {
  const { offset, count, total } = page.pagination;
  return createElement(
    "section",
    { "aria-label": "Published announcements", className: "min-w-0" },
    createElement(
      "div",
      { className: "mb-4 flex flex-wrap items-baseline justify-between gap-2" },
      createElement(
        "h2",
        { className: "text-lg font-semibold" },
        "Published announcements",
      ),
      createElement(
        "p",
        { className: "text-muted-foreground text-sm", role: "status" },
        total === 0
          ? appliedSearch
            ? "No announcements match this search"
            : "No published announcements"
          : count === 0
            ? `No announcements on this page · ${total} total`
            : `Showing ${offset + 1}–${offset + count} of ${total}`,
      ),
    ),
    count === 0
      ? createElement(
          "div",
          { className: "border-border rounded-xl border border-dashed p-6" },
          createElement(
            "h3",
            { className: "font-medium" },
            total === 0
              ? appliedSearch
                ? "No announcements match this search"
                : "No published announcements"
              : "No announcements on this page",
          ),
          createElement(
            "p",
            { className: "text-muted-foreground mt-2 text-sm" },
            total === 0
              ? appliedSearch
                ? "Try another phrase or clear the search."
                : "Published updates from this Board will appear here."
              : "The list changed. Go to an earlier page or refresh.",
          ),
        )
      : createElement(
          "ol",
          { className: "flex min-w-0 flex-col gap-3" },
          ...page.items.map((item) =>
            createElement(
              "li",
              {
                key: item.id,
                className:
                  "border-border bg-card text-card-foreground min-w-0 rounded-xl border p-5",
              },
              createElement(
                "div",
                {
                  className:
                    "flex min-w-0 flex-wrap items-start justify-between gap-2",
                },
                createElement(
                  "h3",
                  { className: "min-w-0 text-base font-semibold break-words" },
                  item.title,
                ),
                item.pinned
                  ? createElement(
                      "span",
                      {
                        className:
                          "bg-secondary text-secondary-foreground rounded-md px-2 py-0.5 text-xs font-medium",
                      },
                      "Pinned",
                    )
                  : null,
                personal?.[item.id]?.publicationNumber ===
                  item.publicationNumber && !personal[item.id].read
                  ? createElement(
                      "span",
                      {
                        className:
                          "bg-secondary text-secondary-foreground rounded-md px-2 py-0.5 text-xs font-medium",
                      },
                      "Unread",
                    )
                  : null,
              ),
              createElement(
                "p",
                { className: "mt-3 whitespace-pre-wrap break-words" },
                item.body,
              ),
              createElement(
                "p",
                { className: "text-muted-foreground mt-2 text-sm" },
                authorLabels?.[item.authorId] ?? "Author unavailable",
              ),
              item.links.length > 0
                ? createElement(
                    "ul",
                    {
                      "aria-label": "Announcement links",
                      className: "mt-2 flex min-w-0 flex-col gap-1",
                    },
                    ...item.links.map((link, index) =>
                      createElement(
                        "li",
                        { key: `${link.url}:${link.label}:${index}` },
                        createElement(
                          "a",
                          {
                            href: link.url,
                            target: "_blank",
                            rel: "noopener noreferrer",
                            referrerPolicy: "no-referrer",
                            className:
                              "text-primary focus-visible:outline-ring inline-block min-h-11 max-w-full rounded-sm py-2.5 text-sm break-words underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2",
                          },
                          link.label,
                          createElement(
                            "span",
                            { className: "sr-only" },
                            " (opens in a new tab)",
                          ),
                        ),
                      ),
                    ),
                  )
                : null,
              createElement(HydratedBoardAttachments, {
                access: "read",
                target: {
                  kind: "announcement",
                  boardId: item.boardId,
                  contentId: item.id,
                  view: "published",
                },
              }),
              createElement(HydratedBoardRecordLinks, {
                access: "read",
                target: {
                  kind: "announcement",
                  boardId: item.boardId,
                  contentId: item.id,
                  view: "published",
                },
              }),
              item.publishedAt
                ? createElement(
                    "p",
                    { className: "text-muted-foreground mt-3 text-sm" },
                    "Published ",
                    createElement(
                      "time",
                      { dateTime: item.publishedAt },
                      publishedLabel(item.publishedAt),
                    ),
                  )
                : null,
              personal?.[item.id]?.publicationNumber ===
                item.publicationNumber && item.publicationNumber !== null
                ? createElement(
                    "div",
                    {
                      className:
                        "border-border mt-4 flex flex-wrap gap-2 border-t pt-4",
                    },
                    createElement(
                      "button",
                      {
                        type: "button",
                        className:
                          "border-border bg-card text-foreground hover:bg-muted focus-visible:outline-ring inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50",
                        "aria-pressed": personal[item.id].read,
                        disabled:
                          actionsDisabled ||
                          pendingId !== null ||
                          !onToggleRead,
                        onClick: () => {
                          const number = item.publicationNumber;
                          if (number !== null)
                            onToggleRead?.(
                              item.id,
                              number,
                              !personal[item.id].read,
                            );
                        },
                      },
                      personal[item.id].read ? "Read" : "Mark as read",
                    ),
                    createElement(
                      "button",
                      {
                        type: "button",
                        className:
                          "border-border bg-card text-foreground hover:bg-muted focus-visible:outline-ring inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50",
                        "aria-pressed": personal[item.id].bookmarked,
                        disabled:
                          actionsDisabled ||
                          pendingId !== null ||
                          !onToggleBookmark,
                        onClick: () => {
                          const number = item.publicationNumber;
                          if (number !== null)
                            onToggleBookmark?.(
                              item.id,
                              number,
                              !personal[item.id].bookmarked,
                            );
                        },
                      },
                      personal[item.id].bookmarked ? "Bookmarked" : "Bookmark",
                    ),
                  )
                : null,
            ),
          ),
        ),
  );
}
