"use client";

import type { ReactNode, RefObject } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { CalendarShow, CalendarView } from "../domain/calendar-dates";

const VIEWS: { value: CalendarView; label: string }[] = [
  { value: "month", label: "Month" },
  { value: "week", label: "Week" },
  { value: "upcoming", label: "Upcoming" },
];

export const SHOW_LABELS: Record<CalendarShow, string> = {
  all: "All",
  mine: "Created by me",
  archived: "Archived",
};

export type CalendarStatus = {
  message: string;
  next: { text: string; name: string } | null;
};

/**
 * One toolbar row (BR16, BR51): the Calendars popover below 1440px,
 * previous, next, the period, Today, the empty-month status, then search,
 * the view switch, and Show. Phones wrap it into short rows (BR59).
 */
export function BoardCalendarToolbar({
  calendars,
  title,
  view,
  show,
  showOptions,
  search,
  navigation,
  todayRef,
  status,
  onPrevious,
  onNext,
  onToday,
  onView,
  onShow,
  onSearch,
  onGoToNext,
}: {
  calendars: ReactNode;
  title: string;
  view: CalendarView;
  show: CalendarShow;
  showOptions: CalendarShow[];
  search: string;
  /** Previous and next move the period; Upcoming has none. */
  navigation: { previous: string; next: string } | null;
  todayRef: RefObject<HTMLButtonElement | null>;
  status: CalendarStatus | null;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  onView: (view: CalendarView) => void;
  onShow: (show: CalendarShow) => void;
  onSearch: (value: string) => void;
  onGoToNext: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Calendar"
      className="flex min-w-0 shrink-0 flex-wrap items-center gap-2"
    >
      {calendars}
      {navigation ? (
        <span className="flex items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 xl:size-8"
            aria-label={navigation.previous}
            onClick={onPrevious}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 xl:size-8"
            aria-label={navigation.next}
            onClick={onNext}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </span>
      ) : null}
      <h2
        data-slot="section-title"
        aria-live="polite"
        className="min-w-0 text-lg font-semibold whitespace-nowrap tabular-nums"
      >
        {title}
      </h2>
      <Button
        ref={todayRef}
        type="button"
        variant="outline"
        className="min-h-11 max-md:ml-auto xl:min-h-8"
        onClick={onToday}
      >
        Today
      </Button>
      {status ? (
        <span
          role="status"
          className="text-muted-foreground flex items-center gap-1.5 text-sm whitespace-nowrap"
        >
          <span>{status.message}</span>
          {status.next ? (
            <>
              <span aria-hidden="true">·</span>
              <Button
                type="button"
                variant="ghost"
                className="text-action-text min-h-11 px-1.5 xl:min-h-7"
                aria-label={status.next.name}
                onClick={onGoToNext}
              >
                {status.next.text}
                <ArrowRight aria-hidden="true" data-icon="inline-end" />
              </Button>
            </>
          ) : null}
        </span>
      ) : null}
      <span className="hidden flex-1 md:block" />
      <div
        role="group"
        aria-label="Calendar view"
        className="bg-muted grid grid-cols-3 rounded-md p-0.5 max-md:order-90 max-md:w-full md:inline-flex"
      >
        {VIEWS.map((option) => (
          <Button
            key={option.value}
            type="button"
            variant="ghost"
            aria-pressed={view === option.value}
            className={cn(
              "min-h-11 px-3 xl:min-h-7 xl:px-2.5",
              view === option.value && "bg-card shadow-xs",
            )}
            onClick={() => onView(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>
      <label className="relative block min-w-0 max-md:order-95 max-md:flex-1 md:w-40">
        <span className="sr-only">Search events</span>
        <Search
          aria-hidden="true"
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
        />
        <Input
          type="search"
          maxLength={100}
          placeholder="Search"
          className="min-h-11 pl-8 xl:min-h-8"
          value={search}
          onChange={(event) => onSearch(event.currentTarget.value)}
        />
      </label>
      {showOptions.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="outline"
                className="min-h-11 max-md:order-96 xl:min-h-8"
                aria-label={`Show: ${SHOW_LABELS[show]}`}
              />
            }
          >
            <span className="text-muted-foreground">Show:</span>
            {SHOW_LABELS[show]}
            <ChevronDown aria-hidden="true" data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="slim-ui">
            {showOptions.map((option) => (
              <DropdownMenuItem
                key={option}
                role="menuitemradio"
                aria-checked={option === show}
                className="min-h-11 xl:min-h-8"
                onClick={() => onShow(option)}
              >
                {SHOW_LABELS[option]}
                {option === show ? (
                  <Check aria-hidden="true" className="ml-auto" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
