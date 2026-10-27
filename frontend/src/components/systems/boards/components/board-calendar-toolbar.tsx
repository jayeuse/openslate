"use client";

import type { ReactNode, RefObject } from "react";
import {
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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

/**
 * One toolbar row (BR16, BR51): the Calendars popover below 1440px,
 * previous, next, the period, Today, then search, the view switch, and
 * Show. An empty month says so on its own grid (BR43), so the row never
 * wraps. Phones wrap it into short rows (BR59).
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
  titleRef,
  onPrevious,
  onNext,
  onToday,
  onView,
  onShow,
  onSearch,
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
  /** The period title, which takes focus after a jump to another period. */
  titleRef: RefObject<HTMLHeadingElement | null>;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  onView: (view: CalendarView) => void;
  onShow: (show: CalendarShow) => void;
  onSearch: (value: string) => void;
}) {
  return (
    <div
      role="group"
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
        ref={titleRef}
        tabIndex={-1}
        data-slot="section-title"
        aria-live="polite"
        className="min-w-0 rounded-sm text-lg font-semibold whitespace-nowrap tabular-nums outline-none focus-visible:outline-2 focus-visible:outline-[var(--focus)]"
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
      <span className="hidden flex-1 md:block" />
      <label className="relative block min-w-0 max-md:order-95 max-md:flex-1 md:w-32 min-[90rem]:w-40">
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
      <ToggleGroup
        aria-label="Calendar view"
        variant="segmented"
        multiple={false}
        value={[view]}
        className="gap-0.5 p-0.5 max-md:order-90 max-md:w-full md:w-auto"
        onValueChange={(selection) => {
          const next = VIEWS.find((option) => option.value === selection[0]);
          if (next) onView(next.value);
        }}
      >
        {VIEWS.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            className="px-3 text-sm xl:px-2"
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
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
