"use client";

import { useRef, useState, type ReactNode } from "react";
import {
  ArrowUpDown,
  Check,
  ChevronLeft,
  ChevronRight,
  ListFilter,
  Pin,
  Search,
} from "lucide-react";
import {
  FilterChips,
  type FilterChip,
} from "@/components/systems/access/components/access-toolbar";
import {
  RowOpenButton,
  openRowClassName,
  tintRowClassName,
} from "@/components/systems/access/components/row-open-button";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type { BoardPostPage } from "../adapters/board-posts-api";
import { POST_STATE_LABELS, type PostListState } from "../domain/post-list";
import type { PublishedPostSort } from "../hooks/use-server-board-posts";

export const POST_SORT_OPTIONS: readonly {
  value: PublishedPostSort;
  label: string;
}[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "title", label: "Title A–Z" },
];

export type PostListRow = {
  id: string;
  title: string;
  pinned: boolean;
  /** The second line's words after Pinned: author, date, state words. */
  meta: string[];
};

const iconButton = "size-11 shrink-0 xl:size-8 [&_svg]:size-4";

/**
 * The Posts list panel (BR10, BR11): a slim toolbar (search, Filters with
 * Author, Sort), the state filter for writers and managers, two-line rows
 * where the whole row opens the post, and a compact pager at the foot.
 */
export function BoardPostList({
  states,
  state,
  onStateChange,
  query,
  onQueryChange,
  sort,
  onSortChange,
  chips,
  onClearFilters,
  filters,
  page,
  rows,
  loading,
  error,
  onRetry,
  selectedId,
  onOpen,
  onPage,
  empty,
}: {
  states: readonly PostListState[];
  state: PostListState;
  onStateChange: (state: PostListState) => void;
  query: string;
  onQueryChange: (query: string) => void;
  sort: PublishedPostSort;
  onSortChange: (sort: PublishedPostSort) => void;
  chips: readonly FilterChip[];
  onClearFilters: () => void;
  /** The Filters rows (Author). */
  filters: ReactNode;
  page: BoardPostPage | null;
  rows: readonly PostListRow[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  selectedId: string | null;
  onOpen: (postId: string) => void;
  onPage: (offset: number) => void;
  /** The empty list's teaching state, in the list's own frame. */
  empty: ReactNode;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersButton = useRef<HTMLButtonElement>(null);
  const sortLabel =
    POST_SORT_OPTIONS.find((option) => option.value === sort)?.label ?? "";
  const pagination = page?.pagination ?? null;
  return (
    <section
      aria-label="Posts"
      className="bg-card flex min-w-0 flex-col overflow-hidden rounded-lg border lg:min-h-0 xl:flex-1"
    >
      <div className="flex shrink-0 flex-col gap-2 border-b p-3">
        <div className="flex min-w-0 items-center gap-1">
          <InputGroup className="min-h-11 min-w-0 flex-1 xl:min-h-8">
            <InputGroupAddon aria-hidden="true">
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              aria-label="Search posts"
              placeholder="Search posts"
              maxLength={100}
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
            />
          </InputGroup>
          <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
            <PopoverTrigger
              render={
                <Button
                  ref={filtersButton}
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn(iconButton, "relative")}
                  aria-label={
                    chips.length ? `Filters, ${chips.length} active` : "Filters"
                  }
                />
              }
            >
              <ListFilter aria-hidden="true" />
              {chips.length ? (
                <span
                  aria-hidden="true"
                  className="bg-action-tint text-action-text absolute top-0.5 right-0.5 inline-grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold tabular-nums xl:-top-1 xl:-right-1"
                >
                  {chips.length}
                </span>
              ) : null}
            </PopoverTrigger>
            <PopoverContent
              aria-label="Filters"
              initialFocus={(type) => type === "keyboard"}
              align="end"
              collisionPadding={16}
              className="slim-ui w-[340px] max-w-[calc(100vw-2rem)] gap-0 p-0"
            >
              <div className="grid gap-2 px-3.5 py-3">{filters}</div>
              <div className="flex items-center justify-between gap-3 border-t px-2.5 py-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11 px-2 xl:min-h-8"
                  onClick={onClearFilters}
                >
                  Clear all
                </Button>
                <span className="text-muted-foreground text-xs">
                  Filters apply as you choose
                </span>
              </div>
            </PopoverContent>
          </Popover>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={iconButton}
                  aria-label={`Sort: ${sortLabel}`}
                />
              }
            >
              <ArrowUpDown aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="slim-ui min-w-44">
              {POST_SORT_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option.value}
                  role="menuitemradio"
                  aria-checked={option.value === sort}
                  className="min-h-11 xl:min-h-8"
                  onClick={() => onSortChange(option.value)}
                >
                  <Check
                    aria-hidden="true"
                    className={option.value === sort ? undefined : "invisible"}
                  />
                  {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <FilterChips
          chips={chips}
          onClearFilters={onClearFilters}
          triggerRef={filtersButton}
          disabled={false}
        />
        {states.length > 1 ? (
          <ToggleGroup
            aria-label="Post state"
            variant="segmented"
            multiple={false}
            value={[state]}
            className="w-full overflow-x-auto"
            onValueChange={(selection) => {
              const next = states.find((item) => item === selection[0]);
              if (next) onStateChange(next);
            }}
          >
            {states.map((item) => (
              <ToggleGroupItem
                key={item}
                value={item}
                className="flex-1 px-2 text-sm"
              >
                {POST_STATE_LABELS[item]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}
      </div>
      <div
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
        aria-busy={loading}
      >
        {error ? (
          <Alert
            variant="destructive"
            className="m-3 flex flex-wrap items-center justify-between gap-2"
          >
            <span>{error}</span>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 xl:min-h-8"
              onClick={onRetry}
            >
              Retry
            </Button>
          </Alert>
        ) : null}
        {!page && loading ? (
          <div aria-hidden="true" className="flex flex-col">
            {[0, 1, 2, 3, 4].map((row) => (
              <div
                key={row}
                className="flex flex-col gap-1.5 border-b px-4 py-3"
              >
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
            <span role="status" className="sr-only">
              Loading posts
            </span>
          </div>
        ) : null}
        {page && rows.length === 0 ? empty : null}
        {rows.length > 0 ? (
          <ul aria-label={`${POST_STATE_LABELS[state]} posts`}>
            {rows.map((row) => {
              const selected = row.id === selectedId;
              return (
                <li
                  key={row.id}
                  aria-current={selected ? "true" : undefined}
                  data-state={selected ? "selected" : undefined}
                  className={cn(
                    openRowClassName,
                    tintRowClassName,
                    "flex min-h-14 items-center border-b px-4 py-1.5 xl:min-h-[3.25rem]",
                  )}
                >
                  <RowOpenButton
                    title={row.title}
                    className="w-full max-w-none"
                    subtitle={
                      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
                        {row.pinned ? (
                          <span className="text-foreground inline-flex items-center gap-1 font-medium">
                            <Pin aria-hidden="true" className="size-3" />
                            Pinned
                          </span>
                        ) : null}
                        {row.meta.map((part, index) => (
                          <span key={`${index}:${part}`} className="contents">
                            {row.pinned || index > 0 ? (
                              <span aria-hidden="true">·</span>
                            ) : null}
                            <span>{part}</span>
                          </span>
                        ))}
                      </span>
                    }
                    onOpen={() => onOpen(row.id)}
                  />
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
      {pagination && pagination.total > 0 ? (
        <nav
          aria-label="Post pages"
          className="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-1.5"
        >
          <span
            role="status"
            className="text-muted-foreground text-xs tabular-nums"
          >
            {pagination.count > 0
              ? `${pagination.offset + 1}–${pagination.offset + pagination.count} of ${pagination.total}`
              : `0 of ${pagination.total}`}
          </span>
          <span className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={iconButton}
              aria-label="Previous page"
              disabled={loading || pagination.offset === 0}
              onClick={() =>
                onPage(Math.max(0, pagination.offset - pagination.limit))
              }
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={iconButton}
              aria-label="Next page"
              disabled={loading || !pagination.hasMore}
              onClick={() => onPage(pagination.offset + pagination.limit)}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </span>
        </nav>
      ) : null}
    </section>
  );
}
