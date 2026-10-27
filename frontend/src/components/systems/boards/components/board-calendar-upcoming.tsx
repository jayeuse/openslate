"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { WorkspaceRegion } from "@/lib/date-time";
import {
  UPCOMING_WINDOW_DAYS,
  daysBetween,
  upcomingWindow,
} from "../domain/calendar-dates";
import { upcomingGroups, type CalendarItem } from "../domain/calendar-items";
import {
  CalendarRow,
  dayLabel,
  type CalendarInfo,
  type OpenCalendarItem,
} from "./board-calendar-chips";

type UpcomingProps = {
  today: string;
  /** The first 42 days, read by the calendar itself. */
  items: readonly CalendarItem[];
  ready: boolean;
  nextOccurrence: { date: string } | null;
  calendars: ReadonlyMap<string, CalendarInfo>;
  region: WorkspaceRegion;
  onOpen: OpenCalendarItem;
  /** Reads and filters a later window; it renders its own groups. */
  renderLater: (window: { start: string; end: string }) => React.ReactNode;
};

/**
 * Upcoming (BR19): from today forward, grouped by day, 42 days at a time;
 * Show later adds the next 42 days. A series shows its repeat in each row.
 */
export function BoardCalendarUpcoming({
  today,
  items,
  ready,
  nextOccurrence,
  calendars,
  region,
  onOpen,
  renderLater,
}: UpcomingProps) {
  const [windows, setWindows] = useState(1);
  const groups = upcomingGroups(items, today);
  const empty = ready && groups.length === 0 && windows === 1;
  return (
    <section
      aria-labelledby="board-calendar-upcoming"
      className="bg-card flex min-w-0 flex-col overflow-hidden rounded-lg border xl:min-h-0 xl:flex-1"
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-4">
        <h3
          id="board-calendar-upcoming"
          data-slot="section-title"
          className="text-sm font-semibold"
        >
          Upcoming
        </h3>
        <span className="text-muted-foreground text-[13px]">From today</span>
      </div>
      <div className="min-h-0 overflow-y-auto overscroll-contain xl:flex-1">
        <UpcomingGroupList
          groups={groups}
          today={today}
          calendars={calendars}
          region={region}
          onOpen={onOpen}
        />
        {Array.from({ length: windows - 1 }, (_, index) => (
          <div key={index + 1}>
            {renderLater(upcomingWindow(today, index + 1))}
          </div>
        ))}
        {empty ? (
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 px-4 py-6 text-sm">
            {nextOccurrence ? (
              <>
                <span>Nothing in the next 6 weeks</span>
                <span aria-hidden="true">·</span>
                <Button
                  variant="ghost"
                  className="text-action-text min-h-11 px-1.5 xl:min-h-7"
                  aria-label={`Go to the next event, ${dayLabel(nextOccurrence.date, region)}`}
                  onClick={() =>
                    setWindows(
                      Math.floor(
                        daysBetween(today, nextOccurrence.date) /
                          UPCOMING_WINDOW_DAYS,
                      ) + 1,
                    )
                  }
                >
                  Next: {dayLabel(nextOccurrence.date, region)}
                </Button>
              </>
            ) : (
              <span>No upcoming events</span>
            )}
          </div>
        ) : null}
        {ready && (!empty || nextOccurrence) ? (
          <div className="flex justify-center border-t p-3">
            <Button
              variant="ghost"
              className="min-h-11 xl:min-h-8"
              onClick={() => setWindows((value) => value + 1)}
            >
              Show later
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function UpcomingGroupList({
  groups,
  today,
  calendars,
  region,
  onOpen,
}: {
  groups: { date: string; items: CalendarItem[] }[];
  today: string | null;
  calendars: ReadonlyMap<string, CalendarInfo>;
  region: WorkspaceRegion;
  onOpen: OpenCalendarItem;
}) {
  return groups.map((group) => (
    <section key={group.date} aria-label={dayLabel(group.date, region)}>
      <h4 className="text-muted-foreground bg-muted/40 border-b px-4 py-2 text-xs font-medium">
        {dayLabel(group.date, region)}
        {group.date === today ? " · Today" : ""}
      </h4>
      <ul>
        {group.items.map((item) => (
          <CalendarRow
            key={item.key}
            item={item}
            calendar={calendars.get(item.calendarId)}
            region={region}
            date={group.date}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </section>
  ));
}
