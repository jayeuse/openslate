"use client";

import { createElement, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SearchSelect } from "@/components/ui/search-select";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";
import type { BoardAnnouncementPage } from "../adapters/board-announcements-api";
import type { BoardAnnouncementPersonalState } from "../adapters/board-announcement-personal-api";
import {
  normalizePublishedAnnouncementSearch,
  useServerBoardAnnouncementAuthors,
  useServerBoardAnnouncements,
  visibleAnnouncementAuthorId,
} from "../hooks/use-server-board-announcements";
import { BoardEmpty } from "./ui";
import { HydratedBoardAttachments } from "./server-backed-board-attachments";
import { HydratedBoardRecordLinks } from "./hydrated-board-record-links";

const PAGE_SIZE = 25;

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

export function ServerBackedBoardAnnouncements({
  boardId,
  refreshKey,
}: {
  boardId: string;
  refreshKey: number;
}) {
  const actorId = useVerifiedWorkspaceUserId();
  return (
    <ScopedServerBackedBoardAnnouncements
      key={`${actorId}:${boardId}`}
      boardId={boardId}
      refreshKey={refreshKey}
    />
  );
}

function ScopedServerBackedBoardAnnouncements({
  boardId,
  refreshKey,
}: {
  boardId: string;
  refreshKey: number;
}) {
  const [offset, setOffset] = useState(0);
  const [searchDraft, setSearchDraft] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [selectedAuthorId, setSelectedAuthorId] = useState<string | null>(null);
  const authors = useServerBoardAnnouncementAuthors(boardId, refreshKey);
  const choices = authors.state.data;
  const visibleAuthorId = visibleAnnouncementAuthorId(
    selectedAuthorId,
    choices,
  );
  const authorSelectionGone =
    selectedAuthorId !== null && visibleAuthorId === null;
  const effectiveOffset = authorSelectionGone ? 0 : offset;
  const { state, retry, toggleRead, toggleBookmark } =
    useServerBoardAnnouncements(
      boardId,
      effectiveOffset,
      refreshKey,
      appliedSearch,
      visibleAuthorId,
      choices !== null && authors.state.status !== "denied",
    );
  const page = state.data;
  const authorLabels = Object.fromEntries(
    (choices ?? []).map((choice) => [choice.id, choice.label]),
  );

  useEffect(() => {
    if (!authorSelectionGone) return;
    setSelectedAuthorId(null);
    setOffset(0);
  }, [authorSelectionGone]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          Only announcements published for your access are shown.
        </p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={state.status === "loading"}
          onClick={retry}
        >
          <RefreshCw data-icon="inline-start" /> Refresh announcements
        </Button>
      </div>
      <div className="max-w-sm">
        <SearchSelect
          label="Announcement author"
          value={visibleAuthorId ?? ""}
          options={[
            { value: "", label: "All authors" },
            ...(choices ?? []).map((choice) => ({
              value: choice.id,
              label: choice.label,
            })),
          ]}
          disabled={choices === null || authors.state.status === "loading"}
          onValueChange={(value) => {
            if (value !== "" && !choices?.some((choice) => choice.id === value))
              return;
            setSelectedAuthorId(value || null);
            setOffset(0);
          }}
        />
      </div>
      {authors.state.error && (
        <Alert variant={choices ? "warning" : "destructive"}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{authors.state.error}</span>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={authors.retry}
            >
              Retry authors
            </Button>
          </div>
        </Alert>
      )}
      <form
        role="search"
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setAppliedSearch(normalizePublishedAnnouncementSearch(searchDraft));
          setOffset(0);
        }}
      >
        <label
          htmlFor="board-announcement-search"
          className="flex min-w-48 flex-1 flex-col gap-1 text-sm font-medium"
        >
          Search published announcements
          <input
            id="board-announcement-search"
            type="search"
            maxLength={100}
            value={searchDraft}
            onChange={(event) =>
              setSearchDraft(event.currentTarget.value.slice(0, 100))
            }
            className="border-input bg-background text-foreground focus-visible:outline-ring min-h-11 w-full rounded-md border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
          />
        </label>
        <Button type="submit" variant="outline" className="min-h-11">
          Search
        </Button>
        {(appliedSearch || searchDraft) && (
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            onClick={() => {
              setSearchDraft("");
              setAppliedSearch("");
              setOffset(0);
            }}
          >
            Clear search
          </Button>
        )}
      </form>
      {state.error && (
        <Alert variant={page ? "warning" : "destructive"}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {page ? "Showing the last loaded announcements. " : ""}
              {state.error}
            </span>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={retry}
            >
              Retry
            </Button>
          </div>
        </Alert>
      )}
      {state.actionError && (
        <Alert variant="warning">{state.actionError}</Alert>
      )}
      {page && (
        <ServerBoardAnnouncementFeedDisplay
          page={page}
          appliedSearch={appliedSearch}
          authorLabels={authorLabels}
          personal={state.personal}
          pendingId={state.pendingId}
          actionsDisabled={state.status !== "ready"}
          onToggleRead={toggleRead}
          onToggleBookmark={toggleBookmark}
        />
      )}
      {!page && state.status === "loading" && (
        <p role="status" className="text-muted-foreground py-8 text-sm">
          Loading published announcements…
        </p>
      )}
      {!page && state.status === "error" && (
        <BoardEmpty
          title="Announcements unavailable"
          description="No announcement content is shown. Retry or ask a Board manager to check your access."
        />
      )}
      {page && (page.pagination.total > PAGE_SIZE || offset > 0) && (
        <nav
          aria-label="Announcement pages"
          className="flex items-center gap-2"
        >
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={offset === 0 || state.status === "loading"}
            onClick={() =>
              setOffset((current) => Math.max(0, current - PAGE_SIZE))
            }
          >
            Previous
          </Button>
          <span className="text-muted-foreground text-sm">
            Page {Math.floor(offset / PAGE_SIZE) + 1}
          </span>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={!page.pagination.hasMore || state.status === "loading"}
            onClick={() => setOffset((current) => current + PAGE_SIZE)}
          >
            Next
          </Button>
        </nav>
      )}
    </div>
  );
}
