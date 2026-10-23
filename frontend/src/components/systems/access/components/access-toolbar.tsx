"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogCloseButton,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** One active filter, shown as a removable chip above the table. */
export type FilterChip = {
  key: string;
  label: string;
  value: string;
  onRemove: () => void;
};

type AccessToolbarProps<T extends string> = {
  searchLabel: string;
  /** The search box's id, so a view can return focus to it. */
  searchId?: string;
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
  /** The active filters; the Filters button counts them. */
  chips: readonly FilterChip[];
  /** Clears every chip's filter; the search, status and sort stay. */
  onClearFilters: () => void;
  /**
   * Below the md breakpoint, show only the search and the Filters button,
   * and move Sort into the filters. Off by default.
   */
  sortInFiltersBelowMd?: boolean;
  /** Quick filters beside the search (People's status). */
  quickFilters?: ReactNode;
  /** The view's own actions at the end of the row. */
  actions?: ReactNode;
  /** The Filters rows (`FilterRow`, `FilterSelect`). */
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
 * A label-left Filters row: from 768px a 96px muted label column and the
 * field on the right; the bottom sheet on a phone stacks the label above.
 */
export const filterRowClassName =
  "flex min-w-0 flex-col gap-1.5 md:grid md:grid-cols-[6rem_minmax(0,1fr)] md:items-center md:gap-x-3 md:gap-y-1";
const filterLabelClassName = "md:text-muted-foreground";

/**
 * A row around a field that renders its own label (SearchSelect): from
 * 768px its field root becomes part of the row's grid.
 */
export function FilterRow({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        filterRowClassName,
        "md:[&_[data-slot=field-label]]:text-muted-foreground md:[&>*]:contents",
      )}
    >
      {children}
    </div>
  );
}

/** A native select as a Filters row; a choice applies at once. */
export function FilterSelect<V extends string>({
  id,
  label,
  ariaLabel,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  /** A fuller name than the visible label, when the label is short. */
  ariaLabel?: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (value: V) => void;
}) {
  return (
    <Field className={filterRowClassName}>
      <FieldLabel htmlFor={id} className={filterLabelClassName}>
        {label}
      </FieldLabel>
      <NativeSelect
        id={id}
        aria-label={ariaLabel}
        className="w-full [&_select]:min-h-11"
        value={value}
        onChange={(event) => {
          const option = options.find(
            (item) => item.value === event.target.value,
          );
          if (option) onChange(option.value);
        }}
      >
        {options.map((option) => (
          <NativeSelectOption key={option.value} value={option.value}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  );
}

/**
 * Active filters above the table: "Showing", one removable chip per filter,
 * and Clear all. Absent when nothing is active, so it takes no space.
 */
function FilterChips({
  chips,
  onClearFilters,
  triggerRef,
}: {
  chips: readonly FilterChip[];
  onClearFilters: () => void;
  /** The Filters button, which takes focus when the last chip goes. */
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const removers = useRef(new Map<string, HTMLButtonElement>());
  // A removed chip's focus goes to its neighbour's ✕, or to the Filters
  // button when no chip is left; set by the click, applied after render.
  const focusAfter = useRef<string | null>(null);
  useEffect(() => {
    const target = focusAfter.current;
    if (target === null) return;
    focusAfter.current = null;
    const next = removers.current.get(target);
    if (next) next.focus();
    else triggerRef.current?.focus();
  });
  if (!chips.length) return null;
  return (
    <div
      role="group"
      aria-label="Active filters"
      className="flex min-w-0 shrink-0 flex-wrap items-center gap-1.5"
    >
      <span className="text-muted-foreground mr-1 text-xs">Showing</span>
      {chips.map((chip, index) => (
        <Badge
          key={chip.key}
          variant="secondary"
          className="min-h-11 gap-1 rounded-full py-0 pr-0 pl-2.5 text-xs font-normal xl:h-[26px] xl:min-h-0 xl:pr-1"
        >
          <span>
            {chip.label}: <b className="font-semibold">{chip.value}</b>
          </span>
          <button
            ref={(node) => {
              if (node) removers.current.set(chip.key, node);
              else removers.current.delete(chip.key);
            }}
            type="button"
            aria-label={`Remove ${chip.label} filter`}
            className="text-muted-foreground hover:text-foreground focus-visible:outline-ring inline-grid size-11 shrink-0 place-items-center rounded-full outline-none hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)] focus-visible:outline-2 xl:size-5"
            onClick={() => {
              focusAfter.current =
                (chips[index + 1] ?? chips[index - 1])?.key ?? "";
              chip.onRemove();
            }}
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </Badge>
      ))}
      <Button
        type="button"
        variant="ghost"
        className="min-h-11 px-2 xl:min-h-7"
        onClick={() => {
          focusAfter.current = "";
          onClearFilters();
        }}
      >
        Clear all
      </Button>
    </div>
  );
}

/**
 * The toolbar of the Access tables (People, Groups, Sessions): one flat row
 * of search, quick filters, a quiet Filters button and Sort, with the view's
 * actions at the end, then the active filters as chips. Filters opens a
 * popover anchored to its button (a bottom sheet on a phone) whose rows
 * apply as they are chosen; each view owns its filter state.
 */
export function AccessToolbar<T extends string>({
  searchLabel,
  searchId,
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
  chips,
  onClearFilters,
  sortInFiltersBelowMd = false,
  quickFilters,
  actions,
  children,
}: AccessToolbarProps<T>) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const wide = useWideScreen();
  const sortInFilters = sortInFiltersBelowMd && !wide;
  const count = chips.length;
  const sortSelect = (inToolbar: boolean) => (
    <NativeSelect
      id={`${id}-sort`}
      aria-label={sortLabel}
      // The toolbar's "Sort: Name" control keeps the field edge of every
      // other select and sizes to the chosen option where the browser
      // supports field-sizing (to its longest option elsewhere).
      className={
        inToolbar
          ? "[&_select]:field-sizing-content [&_select]:min-h-11 [&_select]:font-medium xl:[&_select]:min-h-8"
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
  // row, never copies it.
  const sortField = sortInFilters ? (
    <Field className={filterRowClassName}>
      <FieldLabel htmlFor={`${id}-sort`} className={filterLabelClassName}>
        Sort
      </FieldLabel>
      {sortSelect(false)}
    </Field>
  ) : (
    <div className="flex shrink-0 items-center gap-2 md:ml-auto">
      <label
        htmlFor={`${id}-sort`}
        className="text-muted-foreground text-sm whitespace-nowrap"
      >
        Sort:
      </label>
      {sortSelect(true)}
    </div>
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const trigger: ReactElement = (
    <Button
      ref={triggerRef}
      type="button"
      variant="ghost"
      disabled={filtersDisabled}
      // The popover trigger replaces the Button's data-slot, so the slim
      // size from 1280px is set here.
      className="min-h-11 w-auto shrink-0 gap-1.5 px-3 xl:h-8 xl:min-h-8 xl:px-2.5"
      aria-describedby={`${id}-filter-count`}
    />
  );
  const triggerContent = (
    <>
      <SlidersHorizontal aria-hidden="true" />
      Filters
      {count > 0 ? (
        <span
          aria-hidden="true"
          className="bg-action-tint text-action-text inline-grid h-[18px] min-w-[18px] place-items-center rounded-full px-[5px] text-xs font-semibold tabular-nums"
        >
          {count}
        </span>
      ) : null}
    </>
  );
  const body = (
    <>
      <div className="grid gap-2 px-3.5 py-3">
        {sortInFilters ? sortField : null}
        {children}
      </div>
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
    </>
  );
  return (
    <section
      aria-label={`${searchLabel} controls`}
      className="flex min-w-0 shrink-0 flex-col gap-2"
    >
      {/* From 1280px one row: the search gives way to the other controls. */}
      <div className="flex min-w-0 flex-wrap items-end gap-3 xl:flex-nowrap xl:gap-2">
        <Field
          className={cn(
            "min-w-0 gap-1.5",
            sortInFiltersBelowMd
              ? "flex-1 md:w-72 md:flex-none xl:w-auto xl:max-w-72 xl:min-w-28 xl:flex-1"
              : "w-full sm:w-72 xl:w-auto xl:max-w-72 xl:min-w-28 xl:flex-1",
          )}
        >
          <FieldLabel htmlFor={searchId ?? `${id}-search`}>Search</FieldLabel>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            />
            <Input
              id={searchId ?? `${id}-search`}
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
        {wide ? (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger render={trigger}>{triggerContent}</PopoverTrigger>
            <PopoverContent
              aria-label="Filters"
              // A pointer open leaves focus on the button (Tab enters the
              // rows); a keyboard open moves it to the first row.
              initialFocus={(type) => type === "keyboard"}
              align="end"
              collisionPadding={16}
              className="access-ui w-[380px] max-w-[calc(100vw-2rem)] gap-0 p-0"
            >
              {body}
            </PopoverContent>
          </Popover>
        ) : (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger render={trigger}>{triggerContent}</DialogTrigger>
            <DialogContent
              aria-label="Filters"
              className="access-ui -mx-4 -mb-4 w-[calc(100%+2rem)] max-w-none self-end rounded-b-none p-0"
            >
              <DialogTitle className="px-3.5 pt-4 pb-1 text-base">
                Filters
              </DialogTitle>
              <DialogCloseButton />
              {body}
            </DialogContent>
          </Dialog>
        )}
        {sortInFilters ? null : sortField}
        <span id={`${id}-filter-count`} className="sr-only">
          {count} active {count === 1 ? "filter" : "filters"}
        </span>
        {actions ? (
          <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-3 sm:ml-auto sm:w-auto sm:justify-end">
            {actions}
          </div>
        ) : null}
      </div>
      <FilterChips
        chips={chips}
        onClearFilters={onClearFilters}
        triggerRef={triggerRef}
      />
    </section>
  );
}
