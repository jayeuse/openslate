"use client";

import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronDown, Search, SlidersHorizontal } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { cn } from "@/lib/utils";

type AccessToolbarProps<T extends string> = {
  searchLabel: string;
  placeholder: string;
  query: string;
  onQueryChange: (query: string) => void;
  sortLabel?: string;
  searchMaxLength?: number;
  sortDisabled?: boolean;
  filtersDisabled?: boolean;
  sort: T;
  sortOptions: readonly { value: T; label: string; disabled?: boolean }[];
  onSortChange: (sort: T) => void;
  activeFilterCount: number;
  filtersClassName?: string;
  /**
   * Below the md breakpoint, show only the search and the filters button,
   * and move Sort into the filters. Off by default.
   */
  sortInFiltersBelowMd?: boolean;
  /** Quick filters beside the search (People's status). */
  quickFilters?: ReactNode;
  /** The view's own actions at the end of the row (Invite person). */
  actions?: ReactNode;
  children: ReactNode;
};

const WIDE_QUERY = "(min-width: 48rem)";

function subscribeWide(onChange: () => void) {
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** True at the md breakpoint and wider; the first render assumes wide. */
function useWideScreen(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => true,
  );
}

/**
 * The toolbar of the Access tables (People, Groups, Sessions): one flat row
 * of search, quick filters, Sort and More filters, with the view's actions
 * at the end. It keeps the names of the shared `SearchFilterToolbar`, which
 * Manage still uses through `access-search-toolbar.tsx`; each view owns its
 * filter state.
 */
export function AccessToolbar<T extends string>({
  searchLabel,
  placeholder,
  query,
  onQueryChange,
  sortLabel = "Sort",
  searchMaxLength,
  sortDisabled = false,
  filtersDisabled = false,
  sort,
  sortOptions,
  onSortChange,
  activeFilterCount,
  filtersClassName,
  sortInFiltersBelowMd = false,
  quickFilters,
  actions,
  children,
}: AccessToolbarProps<T>) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const wide = useWideScreen();
  const sortInFilters = sortInFiltersBelowMd && !wide;
  const sortSelect = (ghost: boolean) => (
    <NativeSelect
      id={`${id}-sort`}
      aria-label={sortLabel}
      // A ghost select is a quiet "Sort: Name" control; it leaves the field
      // skins (data-slot) and sizes to its longest option.
      {...(ghost ? { "data-slot": "ghost-select" } : {})}
      className={
        ghost
          ? "[&_select]:min-h-11 [&_select]:border-transparent [&_select]:bg-transparent [&_select]:pl-1.5 [&_select]:font-medium [&_select]:hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)] xl:[&_select]:min-h-8"
          : "w-full [&_select]:min-h-11"
      }
      value={sort}
      disabled={sortDisabled}
      onChange={(event) => {
        const option = sortOptions.find(
          (item) => item.value === event.target.value,
        );
        if (option) onSortChange(option.value);
      }}
    >
      {sortOptions.map((option) => (
        <NativeSelectOption
          key={option.value}
          value={option.value}
          disabled={option.disabled}
        >
          {option.label}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
  // One Sort control; a compact toolbar moves it into the filters as a
  // labelled field, never copies it.
  const sortField = sortInFilters ? (
    <Field className="w-full min-w-0 gap-1.5">
      <FieldLabel htmlFor={`${id}-sort`}>Sort</FieldLabel>
      {sortSelect(false)}
    </Field>
  ) : (
    <div className="flex shrink-0 items-center gap-0.5 md:ml-auto">
      <label
        htmlFor={`${id}-sort`}
        className="text-muted-foreground text-sm whitespace-nowrap"
      >
        Sort:
      </label>
      {sortSelect(true)}
    </div>
  );
  return (
    <section
      aria-label={`${searchLabel} controls`}
      className="flex min-w-0 shrink-0 flex-col gap-3"
    >
      {/* From 1280px one row: the search gives way to the other controls. */}
      <div className="flex min-w-0 flex-wrap items-end gap-3 xl:flex-nowrap xl:gap-2">
        <Field
          className={cn(
            "min-w-0 gap-1.5",
            sortInFiltersBelowMd
              ? "flex-1 md:w-72 md:flex-none xl:w-auto xl:max-w-72 xl:min-w-36 xl:flex-1"
              : "w-full sm:w-72 xl:w-auto xl:max-w-72 xl:min-w-36 xl:flex-1",
          )}
        >
          <FieldLabel htmlFor={`${id}-search`}>Search</FieldLabel>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            />
            <Input
              id={`${id}-search`}
              aria-label={searchLabel}
              type="search"
              maxLength={searchMaxLength}
              className="min-h-11 pl-9"
              placeholder={placeholder}
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
            />
          </div>
        </Field>
        {quickFilters ? (
          <div className="order-last w-full min-w-0 md:order-none md:w-auto xl:shrink-0">
            {quickFilters}
          </div>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          disabled={filtersDisabled}
          className="min-h-11 w-auto shrink-0 gap-2"
          aria-label="More filters"
          aria-expanded={expanded}
          aria-controls={`${id}-filters`}
          aria-describedby={`${id}-filter-count`}
          onClick={() => setExpanded((value) => !value)}
        >
          <SlidersHorizontal aria-hidden="true" /> Filters
          {activeFilterCount > 0 && (
            <Badge variant="secondary" aria-hidden="true">
              {activeFilterCount}
            </Badge>
          )}
          <ChevronDown
            aria-hidden="true"
            className={expanded ? "rotate-180" : ""}
          />
        </Button>
        {sortInFilters ? null : sortField}
        <span id={`${id}-filter-count`} className="sr-only">
          {activeFilterCount} active filters
        </span>
        {actions ? (
          <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-3 sm:ml-auto sm:w-auto sm:justify-end">
            {actions}
          </div>
        ) : null}
      </div>
      <div
        id={`${id}-filters`}
        role="region"
        aria-label={`${searchLabel} filters`}
        hidden={!expanded}
      >
        <div
          className={cn(
            "bg-card grid min-w-0 gap-3 rounded-lg border p-3 sm:grid-cols-2 xl:grid-cols-4",
            filtersClassName,
          )}
        >
          {sortInFilters ? sortField : null}
          {children}
        </div>
      </div>
    </section>
  );
}
