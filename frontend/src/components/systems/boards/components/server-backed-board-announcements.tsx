"use client";

import { useEffect, useId, useState } from "react";
import { ChevronDown, Search, SlidersHorizontal } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { SearchSelect } from "@/components/ui/search-select";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";
import {
  announcementFeedQueryForSort,
  normalizePublishedAnnouncementSearch,
  useServerBoardAnnouncementAuthors,
  useServerBoardAnnouncements,
  visibleAnnouncementAuthorId,
  type PublishedAnnouncementSort,
} from "../hooks/use-server-board-announcements";
import { BoardEmpty } from "./ui";
import { ServerBoardAnnouncementFeedDisplay } from "./server-board-announcement-feed-display";
export { ServerBoardAnnouncementFeedDisplay } from "./server-board-announcement-feed-display";

const PAGE_SIZE_OPTIONS = [5, 10, 25] as const;
const SORT_OPTIONS: readonly {
  value: PublishedAnnouncementSort;
  label: string;
}[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "title", label: "Title A–Z" },
];

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
  const id = useId();
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState<number>(25);
  const [sort, setSort] = useState<PublishedAnnouncementSort>("newest");
  const [searchDraft, setSearchDraft] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [selectedAuthorId, setSelectedAuthorId] = useState<string | null>(null);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const authors = useServerBoardAnnouncementAuthors(boardId, refreshKey);
  const choices = authors.state.data;
  const visibleAuthorId = visibleAnnouncementAuthorId(
    selectedAuthorId,
    choices,
  );
  const authorSelectionGone =
    selectedAuthorId !== null && visibleAuthorId === null;
  const effectiveOffset = authorSelectionGone ? 0 : offset;
  const queryOptions = {
    limit: pageSize,
    ...announcementFeedQueryForSort(sort),
  };
  const { state, retry, toggleRead, toggleBookmark } =
    useServerBoardAnnouncements(
      boardId,
      effectiveOffset,
      refreshKey,
      appliedSearch,
      visibleAuthorId,
      choices !== null && authors.state.status !== "denied",
      queryOptions,
    );
  const page = state.data;
  const authorLabels = Object.fromEntries(
    (choices ?? []).map((choice) => [choice.id, choice.label]),
  );
  const activeFilterCount = visibleAuthorId === null ? 0 : 1;
  const filtersId = `${id}-filters`;
  const filterCountId = `${id}-filter-count`;

  useEffect(() => {
    if (!authorSelectionGone) return;
    setSelectedAuthorId(null);
    setOffset(0);
  }, [authorSelectionGone]);

  useEffect(() => {
    if (authorSelectionGone || state.status !== "ready" || !page) return;
    const { offset: loadedOffset, total } = page.pagination;
    if (loadedOffset === 0 || loadedOffset < total) return;
    const lastValidOffset =
      total === 0 ? 0 : Math.floor((total - 1) / pageSize) * pageSize;
    if (loadedOffset !== lastValidOffset) setOffset(lastValidOffset);
  }, [authorSelectionGone, page, pageSize, state.status]);

  return (
    <div
      className="flex w-full min-w-0 flex-col gap-4"
      aria-busy={state.status === "loading"}
    >
      <Card
        aria-label="Announcement search and filters"
        className="min-w-0 self-auto overflow-hidden rounded-lg"
      >
        <form
          role="search"
          className="grid min-w-0 gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,14rem)_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            setAppliedSearch(normalizePublishedAnnouncementSearch(searchDraft));
            setOffset(0);
          }}
        >
          <Field className="min-w-0">
            <FieldLabel htmlFor={`${id}-search`}>Search</FieldLabel>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
              />
              <Input
                id={`${id}-search`}
                aria-label="Search announcements"
                type="search"
                maxLength={100}
                placeholder="Search announcements"
                className="min-h-11 pl-9"
                value={searchDraft}
                onChange={(event) =>
                  setSearchDraft(event.currentTarget.value.slice(0, 100))
                }
              />
            </div>
          </Field>
          <Field className="min-w-0">
            <FieldLabel htmlFor={`${id}-sort`}>Sort</FieldLabel>
            <NativeSelect
              id={`${id}-sort`}
              aria-label="Sort announcements"
              className="w-full [&_select]:min-h-11"
              value={sort}
              onChange={(event) => {
                const nextSort = SORT_OPTIONS.find(
                  (option) => option.value === event.currentTarget.value,
                );
                if (!nextSort) return;
                setSort(nextSort.value);
                setOffset(0);
              }}
            >
              {SORT_OPTIONS.map((option) => (
                <NativeSelectOption key={option.value} value={option.value}>
                  {option.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
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
            <Button
              type="button"
              variant="outline"
              className="min-h-11 gap-2"
              aria-label="More filters"
              aria-expanded={filtersExpanded}
              aria-controls={filtersId}
              aria-describedby={filterCountId}
              onClick={() => setFiltersExpanded((current) => !current)}
            >
              <SlidersHorizontal aria-hidden="true" /> More filters
              {activeFilterCount > 0 && (
                <Badge variant="secondary" aria-hidden="true">
                  {activeFilterCount}
                </Badge>
              )}
              <ChevronDown
                aria-hidden="true"
                className={filtersExpanded ? "rotate-180" : undefined}
              />
            </Button>
            <span id={filterCountId} className="sr-only">
              {activeFilterCount} active filters
            </span>
          </div>
        </form>
        <div
          id={filtersId}
          role="region"
          aria-label="Announcement filters"
          hidden={!filtersExpanded}
          className="border-t p-3"
        >
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
                if (
                  value !== "" &&
                  !choices?.some((choice) => choice.id === value)
                )
                  return;
                setSelectedAuthorId(value || null);
                setOffset(0);
              }}
            />
          </div>
        </div>
      </Card>
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
      {page && page.pagination.total > 0 && (
        <div
          data-slot="card"
          className="border-card-edge bg-card shadow-card flex min-w-0 flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-muted-foreground text-sm" role="status">
            {page.pagination.count > 0
              ? `Showing ${page.pagination.offset + 1}–${page.pagination.offset + page.pagination.count} of ${page.pagination.total}`
              : `No announcements on this page · ${page.pagination.total} total`}
          </p>
          <div className="flex flex-wrap items-center gap-3 sm:justify-end">
            <div className="flex items-center gap-2">
              <label
                htmlFor={`${id}-page-size`}
                className="text-muted-foreground text-sm"
              >
                Rows per page
              </label>
              <NativeSelect
                id={`${id}-page-size`}
                aria-label="Rows per page"
                className="w-20 [&_select]:min-h-11"
                value={String(pageSize)}
                disabled={state.status === "loading"}
                onChange={(event) => {
                  const nextPageSize = PAGE_SIZE_OPTIONS.find(
                    (option) => String(option) === event.currentTarget.value,
                  );
                  if (nextPageSize === undefined) return;
                  setPageSize(nextPageSize);
                  setOffset(0);
                }}
              >
                {PAGE_SIZE_OPTIONS.map((option) => (
                  <NativeSelectOption key={option} value={String(option)}>
                    {option}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <PaginationControls
              ariaLabel="Announcement pages"
              className="w-auto"
              pageCount={Math.max(
                1,
                Math.ceil(page.pagination.total / pageSize),
              )}
              pageIndex={Math.floor(page.pagination.offset / pageSize)}
              onPageIndexChange={(nextPageIndex) =>
                setOffset(nextPageIndex * pageSize)
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}
