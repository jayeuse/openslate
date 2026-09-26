"use client";

import { useId, useState, type ReactNode } from "react";
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

type SearchFilterToolbarProps<T extends string> = {
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
  children: ReactNode;
};

/** Shared layout; each view retains ownership of its filter state. */
export function SearchFilterToolbar<T extends string>({
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
  children,
}: SearchFilterToolbarProps<T>) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  return (
    <section
      aria-label={`${searchLabel} controls`}
      className="bg-card min-w-0 overflow-hidden rounded-lg border"
    >
      <div className="grid min-w-0 gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,14rem)_auto] sm:items-end">
        <Field className="min-w-0">
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
        <Field className="min-w-0">
          <FieldLabel htmlFor={`${id}-sort`}>Sort</FieldLabel>
          <NativeSelect
            id={`${id}-sort`}
            aria-label={sortLabel}
            className="w-full [&_select]:min-h-11"
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
        </Field>
        <Button
          type="button"
          variant="outline"
          disabled={filtersDisabled}
          className="min-h-11 w-full gap-2 sm:w-auto"
          aria-label="More filters"
          aria-expanded={expanded}
          aria-controls={`${id}-filters`}
          aria-describedby={`${id}-filter-count`}
          onClick={() => setExpanded((value) => !value)}
        >
          <SlidersHorizontal aria-hidden="true" /> More filters
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
        <span id={`${id}-filter-count`} className="sr-only">
          {activeFilterCount} active filters
        </span>
      </div>
      <div
        id={`${id}-filters`}
        role="region"
        aria-label={`${searchLabel} filters`}
        hidden={!expanded}
      >
        <div
          className={cn(
            "grid min-w-0 gap-3 border-t p-3 sm:grid-cols-2 xl:grid-cols-4",
            filtersClassName,
          )}
        >
          {children}
        </div>
      </div>
    </section>
  );
}
