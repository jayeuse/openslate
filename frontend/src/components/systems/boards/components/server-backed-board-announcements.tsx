"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SearchSelect } from "@/components/ui/search-select";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";
import {
  normalizePublishedAnnouncementSearch,
  useServerBoardAnnouncementAuthors,
  useServerBoardAnnouncements,
  visibleAnnouncementAuthorId,
} from "../hooks/use-server-board-announcements";
import { BoardEmpty } from "./ui";
import { ServerBoardAnnouncementFeedDisplay } from "./server-board-announcement-feed-display";
export { ServerBoardAnnouncementFeedDisplay } from "./server-board-announcement-feed-display";

const PAGE_SIZE = 25;

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
