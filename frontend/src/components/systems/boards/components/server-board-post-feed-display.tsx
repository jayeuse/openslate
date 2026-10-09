"use client";

import { createElement, useEffect, useState } from "react";
import { ArrowUpRight, History, Pin, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  type DialogContentProps,
} from "@/components/ui/dialog";
import type { BoardPostPage } from "../adapters/board-posts-api";
import type { BoardPost } from "../adapters/board-posts-api";
import { ServerBoardPostHistory } from "./server-board-post-history";
import { HydratedBoardAttachments } from "./server-backed-board-attachments";
import { HydratedBoardRecordLinks } from "./hydrated-board-record-links";
import { formatWorkspaceDateTime, type WorkspaceRegion } from "@/lib/date-time";

const SUMMARY_LIMIT = 280;
const editedLinkClass =
  "text-primary focus-visible:outline-ring -my-3 inline-flex min-h-11 items-center rounded-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2";

function publishedLabel(
  timestamp: string,
  region: WorkspaceRegion | undefined,
): string {
  if (!region) return "Date unavailable";
  return formatWorkspaceDateTime(timestamp, region, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function postSummary(body: string): string {
  const characters = Array.from(body.trim());
  if (characters.length <= SUMMARY_LIMIT) return body.trim();
  return `${characters.slice(0, SUMMARY_LIMIT).join("").trimEnd()}…`;
}

function expiryLabel(
  timestamp: string,
  region: WorkspaceRegion | undefined,
  now: number,
): string {
  const expired = Date.parse(timestamp) <= now;
  return `${expired ? "Expired" : "Expires"} on ${publishedLabel(timestamp, region)}`;
}

export function ServerBoardPostReaderContent({ post }: { post: BoardPost }) {
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
        post.body,
      ),
    ),
    post.links.length > 0
      ? createElement(
          "ul",
          {
            "aria-label": "Post links",
            className: "flex min-w-0 flex-col gap-1",
          },
          ...post.links.map((link, index) =>
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
        kind: "post",
        boardId: post.boardId,
        contentId: post.id,
        view: "published",
      },
    }),
    createElement(HydratedBoardRecordLinks, {
      target: {
        kind: "post",
        boardId: post.boardId,
        contentId: post.id,
        view: "published",
      },
      access: "read",
    }),
  );
}

export function ServerBoardPostReader({
  region,
  post,
  authorLabel,
  onHistory,
  onClose,
  loading = false,
  error = null,
  onRetry,
  finalFocus,
}: {
  post: BoardPost | null;
  region: WorkspaceRegion | undefined;
  authorLabel: string;
  onHistory: (post: BoardPost) => void;
  onClose: () => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  finalFocus?: DialogContentProps["finalFocus"];
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setNow(Date.now()), [post]);
  if (!post && !loading && !error) return null;

  const metadata = post
    ? [
        createElement("span", { key: "author" }, authorLabel),
        post.publishedAt
          ? createElement(
              "time",
              { key: "published", dateTime: post.publishedAt },
              publishedLabel(post.publishedAt, region),
            )
          : null,
        post.pinned ? createElement("span", { key: "pinned" }, "Pinned") : null,
        post.expiresAt
          ? createElement(
              "time",
              { key: "expiry", dateTime: post.expiresAt },
              expiryLabel(post.expiresAt, region, now),
            )
          : null,
        post.edited
          ? createElement(
              "button",
              {
                key: "edited",
                type: "button",
                className: editedLinkClass,
                onClick: () => onHistory(post),
              },
              "Edited",
            )
          : null,
      ].filter((item) => item !== null)
    : [];

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
      { className: "max-w-3xl p-5 sm:p-7", finalFocus },
      createElement(
        DialogHeader,
        { className: "pr-10" },
        createElement(
          DialogTitle,
          { className: "text-xl leading-snug break-words" },
          post?.title ?? (error ? "Post unavailable" : "Opening post"),
        ),
        createElement(
          DialogDescription,
          { className: "flex flex-wrap items-center gap-x-2 gap-y-1" },
          ...(post
            ? metadata.flatMap((item, index) =>
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
              )
            : [error ?? "Loading the published post."]),
        ),
      ),
      createElement(
        Button,
        {
          type: "button",
          variant: "ghost",
          size: "icon",
          "aria-label": "Close post",
          className: "absolute top-3 right-3 size-11",
          onClick: onClose,
        },
        createElement(X, { "aria-hidden": "true" }),
      ),
      post
        ? createElement(ServerBoardPostReaderContent, {
            key: `${post.id}:${post.publicationNumber}`,
            post,
          })
        : error && onRetry
          ? createElement(
              Button,
              {
                type: "button",
                variant: "outline",
                className: "mt-5 min-h-11",
                onClick: onRetry,
              },
              "Retry",
            )
          : null,
    ),
  );
}

export function ServerBoardPostFeedDisplay({
  region,
  page,
  appliedSearch = "",
  authorLabels = null,
  onReadPost,
  onHistoryAuthorChange,
}: {
  page: BoardPostPage;
  region: WorkspaceRegion | undefined;
  appliedSearch?: string;
  authorLabels?: Record<string, string> | null;
  onReadPost?: (postId: string) => void;
  onHistoryAuthorChange?: (authorId: string | null) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setNow(Date.now()), [page]);
  const [readerPostId, setReaderPostId] = useState<string | null>(null);
  const readerPost =
    page.items.find(
      (item) => item.id === readerPostId && item.publicationNumber !== null,
    ) ?? null;
  const [history, setHistory] = useState<BoardPost | null>(null);
  const openHistory = (post: BoardPost) => {
    onHistoryAuthorChange?.(post.authorId);
    setHistory(post);
  };
  const closeHistory = () => {
    setHistory(null);
    onHistoryAuthorChange?.(null);
  };
  const { offset, count, total } = page.pagination;

  useEffect(() => () => onHistoryAuthorChange?.(null), [onHistoryAuthorChange]);

  useEffect(() => {
    if (
      readerPostId !== null &&
      !page.items.some(
        (item) => item.id === readerPostId && item.publicationNumber !== null,
      )
    ) {
      setReaderPostId(null);
    }
  }, [page.items, readerPostId]);

  const emptyMessage =
    total === 0
      ? appliedSearch
        ? "No posts match this search"
        : "No published posts"
      : "No posts on this page";
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
      { "aria-label": "Published posts", className: "min-w-0" },
      createElement(
        "div",
        {
          className: "mb-4 flex flex-wrap items-baseline justify-between gap-2",
        },
        createElement(
          "h2",
          { className: "text-lg font-semibold" },
          "Published posts",
        ),
        createElement(
          "p",
          { className: "text-muted-foreground text-sm", role: "status" },
          total === 0
            ? emptyMessage
            : count === 0
              ? `No posts on this page · ${total} total`
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
                              publishedLabel(item.publishedAt, region),
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
                        item.edited
                          ? createElement(
                              "button",
                              {
                                type: "button",
                                className: `${editedLinkClass} text-sm`,
                                "aria-label": `Edit history of ${item.title}`,
                                onClick: () => openHistory(item),
                              },
                              createElement(History, {
                                "aria-hidden": "true",
                                className: "mr-1 size-4",
                              }),
                              "Edited",
                            )
                          : null,
                        item.expiresAt && Date.parse(item.expiresAt) <= now
                          ? createElement(
                              Badge,
                              { variant: "secondary" },
                              "Expired",
                            )
                          : null,
                        item.expiresAt
                          ? createElement(
                              "time",
                              {
                                dateTime: item.expiresAt,
                                className: "text-muted-foreground text-sm",
                              },
                              expiryLabel(item.expiresAt, region, now),
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
                        postSummary(item.body),
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
                          onClick: () =>
                            onReadPost
                              ? onReadPost(item.id)
                              : setReaderPostId(item.id),
                        },
                        "Open post",
                        createElement(ArrowUpRight, {
                          className: "size-4",
                          "aria-hidden": "true",
                        }),
                      ),
                    ),
                  ),
                ),
              );
            }),
          ),
    ),
    createElement(ServerBoardPostReader, {
      region,
      post: readerPost,
      authorLabel: readerPost
        ? (authorLabels?.[readerPost.authorId] ?? "Author unavailable")
        : "Author unavailable",
      onHistory: (post: BoardPost) => {
        setReaderPostId(null);
        openHistory(post);
      },
      onClose: () => setReaderPostId(null),
    }),
    history
      ? createElement(ServerBoardPostHistory, {
          region,
          boardId: history.boardId,
          postId: history.id,
          title: history.title,
          authorLabels,
          onClose: closeHistory,
        })
      : null,
  );
}
