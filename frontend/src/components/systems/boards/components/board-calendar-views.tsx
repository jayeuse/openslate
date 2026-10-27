"use client";

import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { monthGrid, type CalendarShow } from "../domain/calendar-dates";
import {
  calendarEmptyStatus,
  calendarFilterEmpty,
  type CalendarItem,
} from "../domain/calendar-items";
import { minuteNow } from "../hooks/use-calendar-media";
import type { CalendarPeriod } from "../hooks/use-calendar-period";
import {
  dayLabel,
  type CalendarInfo,
  type OpenCalendarItem,
} from "./board-calendar-chips";
import {
  BoardCalendarMonth,
  BoardCalendarPhoneMonth,
} from "./board-calendar-month";
import {
  BoardCalendarPhoneWeek,
  BoardCalendarWeek,
} from "./board-calendar-week";
import { BoardCalendarUpcoming } from "./board-calendar-upcoming";

export type CalendarEmpty = {
  filterEmpty: ReturnType<typeof calendarFilterEmpty>;
  /** The words for the one live region that announces an empty view. */
  message: string;
  /** The words and their one step, drawn on the grid. */
  notice: ReactNode;
  undo: () => void;
};

/**
 * What an empty view says (BR43, C12): a search or hidden calendar that
 * emptied it, with the step that undoes it, else the empty month's pointer
 * to the next event.
 */
export function useCalendarEmpty({
  period,
  items,
  ready,
  search,
  hiddenCount,
  show,
  nextOccurrence,
  onClearSearch,
  onShowAll,
}: {
  period: CalendarPeriod;
  items: readonly CalendarItem[];
  ready: boolean;
  search: string;
  hiddenCount: number;
  show: CalendarShow;
  nextOccurrence: { date: string } | null;
  onClearSearch: () => void;
  onShowAll: () => void;
}): CalendarEmpty {
  const { region, view } = period;
  const emptyView = ready && items.length === 0 && region;
  const filterEmpty = emptyView
    ? calendarFilterEmpty(search, hiddenCount)
    : null;
  const monthEmpty =
    view === "month" && show === "all" && emptyView && !filterEmpty
      ? calendarEmptyStatus(
          period.monthName,
          nextOccurrence && region
            ? dayLabel(nextOccurrence.date, region)
            : null,
        )
      : null;
  const undo = () => {
    if (filterEmpty?.kind === "search") onClearSearch();
    else onShowAll();
  };
  const message =
    show === "archived" || view === "upcoming"
      ? ""
      : view === "week" && !filterEmpty
        ? ""
        : (filterEmpty?.message ?? monthEmpty?.message ?? "");
  const notice =
    filterEmpty || monthEmpty ? (
      <>
        <span aria-hidden="true">
          {filterEmpty?.message ?? monthEmpty?.message}
        </span>
        {filterEmpty ? (
          <>
            <span aria-hidden="true">·</span>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 px-1.5 xl:min-h-7"
              onClick={undo}
            >
              {filterEmpty.action}
            </Button>
          </>
        ) : monthEmpty?.next ? (
          <>
            <span aria-hidden="true">·</span>
            <Button
              type="button"
              variant="ghost"
              className="text-action-text min-h-11 px-1.5 xl:min-h-7"
              aria-label={monthEmpty.next.name}
              onClick={() => {
                if (nextOccurrence) period.jump(nextOccurrence.date);
              }}
            >
              {monthEmpty.next.text}
              <ArrowRight aria-hidden="true" data-icon="inline-end" />
            </Button>
          </>
        ) : null}
      </>
    ) : null;
  return { filterEmpty, message, notice, undo };
}

/**
 * Month, Week, or Upcoming for the period (BR51–BR56, BR59), with the phone
 * month and day list. The caller handles the Workspace date's own states.
 */
export function CalendarViews({
  period,
  items,
  calendars,
  ready,
  nextOccurrence,
  empty,
  onOpen,
  onShowDay,
  renderLater,
}: {
  period: CalendarPeriod & {
    region: NonNullable<CalendarPeriod["region"]>;
    today: string;
  };
  items: CalendarItem[];
  calendars: ReadonlyMap<string, CalendarInfo>;
  ready: boolean;
  nextOccurrence: { date: string } | null;
  empty: CalendarEmpty;
  onOpen: OpenCalendarItem;
  /** A month's day number opens that day's week. */
  onShowDay: (date: string) => void;
  renderLater: (window: { start: string; end: string }) => ReactNode;
}) {
  const { region, today, view, phone } = period;
  if (view === "month") {
    const grid = monthGrid(period.anchorDate, period.weekStart);
    return phone ? (
      <BoardCalendarPhoneMonth
        grid={grid}
        anchor={period.anchorDate}
        today={today}
        label={period.title}
        items={items}
        calendars={calendars}
        region={region}
        selected={period.daySelected}
        onSelect={period.setSelectedDay}
        onOpen={onOpen}
      />
    ) : (
      <BoardCalendarMonth
        grid={grid}
        anchor={period.anchorDate}
        today={today}
        weekStart={period.weekStart}
        label={period.title}
        items={items}
        calendars={calendars}
        region={region}
        onOpen={onOpen}
        empty={empty.notice}
        onShowDay={onShowDay}
      />
    );
  }
  if (view === "week")
    return phone ? (
      <BoardCalendarPhoneWeek
        days={period.days}
        today={today}
        items={items}
        calendars={calendars}
        region={region}
        selected={period.daySelected}
        onSelect={period.setSelectedDay}
        onOpen={onOpen}
      />
    ) : (
      <BoardCalendarWeek
        days={period.days}
        label={period.title}
        today={today}
        nowMinute={minuteNow(region.timezone)}
        items={items}
        calendars={calendars}
        region={region}
        onOpen={onOpen}
        empty={empty.filterEmpty ? empty.notice : null}
      />
    );
  return (
    <BoardCalendarUpcoming
      today={today}
      items={items}
      ready={ready}
      nextOccurrence={nextOccurrence}
      calendars={calendars}
      region={region}
      onOpen={onOpen}
      filterEmpty={
        empty.filterEmpty
          ? { ...empty.filterEmpty, onAction: empty.undo }
          : null
      }
      renderLater={renderLater}
    />
  );
}
