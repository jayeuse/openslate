"use client";

import { createElement, useEffect, useState } from "react";
import {
  ArrowUpRight,
  Bookmark,
  BookmarkCheck,
  Check,
  Pin,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { BoardAnnouncementPage } from "../adapters/board-announcements-api";
import type { BoardAnnouncement } from "../adapters/board-announcements-api";
import type { BoardAnnouncementPersonalState } from "../adapters/board-announcement-personal-api";
import { HydratedBoardAttachments } from "./server-backed-board-attachments";
import { HydratedBoardRecordLinks } from "./hydrated-board-record-links";

const SUMMARY_LIMIT = 280;

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

function announcementSummary(body: string): string {
  const characters = Array.from(body.trim());
  if (characters.length <= SUMMARY_LIMIT) return body.trim();
  return `${characters.slice(0, SUMMARY_LIMIT).join("").trimEnd()}…`;
}

export function ServerBoardAnnouncementReaderContent({
  announcement,
}: {
  announcement: BoardAnnouncement;
}) {
  return createElement(
    "div",
    { className: "space-y-6" },
    createElement(
      "div",
      { className: "max-w-prose" },
      createElement(
        "p",
        {
          className: "leading-7 break-words whitespace-pre-wrap",
        },
        announcement.body,
      ),
    ),
    announcement.links.length > 0
      ? createElement(
          "ul",
          {
            "aria-label": "Announcement links",
            className: "flex min-w-0 flex-col gap-1",
          },
          ...announcement.links.map((link, index) =>
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
                    "text-primary focus-visible:outline-ring inline-flex min-h-11 max-w-full items-center gap-1 rounded-sm py-2.5 text-sm break-words underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2",
                },
                link.label,
                createElement(ArrowUpRight, {
                  "aria-hidden": "true",
                  className: "size-4 shrink-0",
                }),
                createElement(
                  "span",
                  { className: "sr-only" },
                  "(opens in a new tab)",
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
        boardId: announcement.boardId,
        contentId: announcement.id,
        view: "published",
      },
    }),
    createElement(HydratedBoardRecordLinks, {
      target: {
        kind: "announcement",
        boardId: announcement.boardId,
        contentId: announcement.id,
        view: "published",
      },
      access: "read",
    }),
  );
}

function ServerBoardAnnouncementReader({
  announcement,
  authorLabel,
  personalState,
  onClose,
}: {
  announcement: BoardAnnouncement | null;
  authorLabel: string;
  personalState?: BoardAnnouncementPersonalState | null;
  onClose: () => void;
}) {
  if (!announcement) return null;

  const metadata = [
    createElement("span", { key: "author" }, authorLabel),
    announcement.publishedAt
      ? createElement(
          "time",
          { key: "published", dateTime: announcement.publishedAt },
          publishedLabel(announcement.publishedAt),
        )
      : null,
    announcement.pinned
      ? createElement("span", { key: "pinned" }, "Pinned")
      : null,
    personalState?.publicationNumber === announcement.publicationNumber
      ? createElement(
          "span",
          { key: "read-state" },
          personalState.read ? "Read" : "Unread",
        )
      : null,
  ].filter((item) => item !== null);

  return createElement(
    Dialog,
    {
      open: true,
      onOpenChange: (open: boolean) => {
        if (!open) onClose();
      },
    },
    createElement(
      DialogContent,
      { className: "max-w-3xl p-5 sm:p-7" },
      createElement(
        DialogHeader,
        { className: "pr-10" },
        createElement(
          DialogTitle,
          { className: "text-xl leading-snug break-words" },
          announcement.title,
        ),
        createElement(
          DialogDescription,
          { className: "flex flex-wrap items-center gap-x-2 gap-y-1" },
          ...metadata.flatMap((item, index) =>
            index === 0
              ? [item]
              : [
                  createElement(
                    "span",
                    { key: `separator-${index}`, "aria-hidden": "true" },
                    "·",
                  ),
                  item,
                ],
          ),
        ),
      ),
      createElement(
        Button,
        {
          type: "button",
          variant: "ghost",
          size: "icon",
          "aria-label": "Close announcement",
          className: "absolute top-3 right-3 size-11",
          onClick: onClose,
        },
        createElement(X, { "aria-hidden": "true" }),
      ),
      createElement(ServerBoardAnnouncementReaderContent, {
        key: `${announcement.id}:${announcement.publicationNumber}`,
        announcement,
      }),
    ),
  );
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
  const [readerAnnouncementId, setReaderAnnouncementId] = useState<
    string | null
  >(null);
  const readerAnnouncement =
    page.items.find(
      (item) =>
        item.id === readerAnnouncementId && item.publicationNumber !== null,
    ) ?? null;
  const readerState = readerAnnouncement
    ? (personal?.[readerAnnouncement.id] ?? null)
    : null;
  const readerPersonal =
    readerState?.publicationNumber === readerAnnouncement?.publicationNumber
      ? readerState
      : null;
  const { offset, count, total } = page.pagination;

  useEffect(() => {
    if (
      readerAnnouncementId !== null &&
      !page.items.some(
        (item) =>
          item.id === readerAnnouncementId && item.publicationNumber !== null,
      )
    ) {
      setReaderAnnouncementId(null);
    }
  }, [page.items, readerAnnouncementId]);

  const emptyMessage =
    total === 0
      ? appliedSearch
        ? "No announcements match this search"
        : "No published announcements"
      : "No announcements on this page";
  const emptyDescription =
    total === 0
      ? appliedSearch
        ? "Try another phrase or clear the search."
        : "Published updates from this Board will appear here."
      : "The list changed. Go to an earlier page or refresh.";

  return createElement(
    "div",
    { className: "w-full min-w-0" },
    createElement(
      "section",
      { "aria-label": "Published announcements", className: "min-w-0" },
      createElement(
        "div",
        {
          className: "mb-4 flex flex-wrap items-baseline justify-between gap-2",
        },
        createElement(
          "h2",
          { className: "text-lg font-semibold" },
          "Published announcements",
        ),
        createElement(
          "p",
          { className: "text-muted-foreground text-sm", role: "status" },
          total === 0
            ? emptyMessage
            : count === 0
              ? `No announcements on this page · ${total} total`
              : `Showing ${offset + 1}–${offset + count} of ${total}`,
        ),
      ),
      count === 0
        ? createElement(
            "div",
            {
              className: "border-border rounded-xl border border-dashed p-6",
            },
            createElement("h3", { className: "font-medium" }, emptyMessage),
            createElement(
              "p",
              { className: "text-muted-foreground mt-2 text-sm" },
              emptyDescription,
            ),
          )
        : createElement(
            "ol",
            { className: "flex min-w-0 flex-col gap-3" },
            ...page.items.map((item) => {
              const personalState = personal?.[item.id] ?? null;
              const currentPersonal =
                item.publicationNumber !== null &&
                personalState?.publicationNumber === item.publicationNumber
                  ? personalState
                  : null;
              const authorLabel =
                authorLabels?.[item.authorId] ?? "Author unavailable";

              return createElement(
                "li",
                { key: item.id, className: "min-w-0" },
                createElement(
                  "article",
                  {
                    className:
                      "border-border bg-card text-card-foreground min-w-0 rounded-xl border p-4 sm:p-5",
                  },
                  createElement(
                    "div",
                    {
                      className:
                        "grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center",
                    },
                    createElement(
                      "div",
                      { className: "min-w-0" },
                      createElement(
                        "div",
                        {
                          className:
                            "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1",
                        },
                        createElement(
                          "span",
                          { className: "text-sm font-medium" },
                          authorLabel,
                        ),
                        item.publishedAt
                          ? createElement(
                              "time",
                              {
                                dateTime: item.publishedAt,
                                className: "text-muted-foreground text-sm",
                              },
                              publishedLabel(item.publishedAt),
                            )
                          : null,
                        item.pinned
                          ? createElement(
                              Badge,
                              { variant: "secondary" },
                              createElement(Pin, {
                                "aria-hidden": "true",
                              }),
                              " Pinned",
                            )
                          : null,
                        currentPersonal && !currentPersonal.read
                          ? createElement(
                              Badge,
                              { variant: "secondary" },
                              "Unread",
                            )
                          : null,
                      ),
                      createElement(
                        "h3",
                        {
                          className:
                            "mt-2 min-w-0 text-base font-semibold break-words",
                        },
                        item.title,
                      ),
                      createElement(
                        "p",
                        {
                          className:
                            "text-muted-foreground mt-1 line-clamp-3 text-sm leading-6 break-words whitespace-pre-line",
                        },
                        announcementSummary(item.body),
                      ),
                    ),
                    createElement(
                      "div",
                      {
                        className:
                          "flex flex-wrap items-center gap-2 md:justify-end",
                      },
                      createElement(
                        Button,
                        {
                          type: "button",
                          variant: "ghost",
                          className: "min-h-11",
                          onClick: () => setReaderAnnouncementId(item.id),
                        },
                        "Open announcement",
                        createElement(ArrowUpRight, {
                          className: "size-4",
                          "aria-hidden": "true",
                        }),
                      ),
                      currentPersonal
                        ? createElement(
                            "div",
                            { className: "flex flex-wrap items-center gap-2" },
                            createElement(
                              Button,
                              {
                                type: "button",
                                variant: "outline",
                                className: "min-h-11",
                                "aria-pressed": currentPersonal.read,
                                disabled:
                                  actionsDisabled ||
                                  pendingId !== null ||
                                  !onToggleRead,
                                onClick: () =>
                                  onToggleRead?.(
                                    item.id,
                                    currentPersonal.publicationNumber,
                                    !currentPersonal.read,
                                  ),
                              },
                              currentPersonal.read
                                ? createElement(
                                    "span",
                                    {
                                      className:
                                        "inline-flex items-center gap-2",
                                    },
                                    createElement(Check, {
                                      className: "size-4",
                                      "aria-hidden": "true",
                                    }),
                                    " Read",
                                  )
                                : "Mark as read",
                            ),
                            createElement(
                              Button,
                              {
                                type: "button",
                                variant: "outline",
                                className: "min-h-11",
                                "aria-pressed": currentPersonal.bookmarked,
                                disabled:
                                  actionsDisabled ||
                                  pendingId !== null ||
                                  !onToggleBookmark,
                                onClick: () =>
                                  onToggleBookmark?.(
                                    item.id,
                                    currentPersonal.publicationNumber,
                                    !currentPersonal.bookmarked,
                                  ),
                              },
                              currentPersonal.bookmarked
                                ? createElement(
                                    "span",
                                    {
                                      className:
                                        "inline-flex items-center gap-2",
                                    },
                                    createElement(BookmarkCheck, {
                                      className: "size-4",
                                      "aria-hidden": "true",
                                    }),
                                    " Bookmarked",
                                  )
                                : createElement(
                                    "span",
                                    {
                                      className:
                                        "inline-flex items-center gap-2",
                                    },
                                    createElement(Bookmark, {
                                      className: "size-4",
                                      "aria-hidden": "true",
                                    }),
                                    " Bookmark",
                                  ),
                            ),
                          )
                        : null,
                    ),
                  ),
                ),
              );
            }),
          ),
    ),
    createElement(ServerBoardAnnouncementReader, {
      announcement: readerAnnouncement,
      authorLabel: readerAnnouncement
        ? (authorLabels?.[readerAnnouncement.authorId] ?? "Author unavailable")
        : "Author unavailable",
      personalState: readerPersonal,
      onClose: () => setReaderAnnouncementId(null),
    }),
  );
}
