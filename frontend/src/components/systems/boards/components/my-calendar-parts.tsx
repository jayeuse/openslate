"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import type { CalendarSource } from "../adapters/board-calendar-sources-api";
import type { BoardManagementBoard } from "../adapters/board-management-api";
import type { CalendarShow } from "../domain/calendar-dates";
import {
  filterCalendarItems,
  upcomingGroups,
  type CalendarItem,
} from "../domain/calendar-items";
import { boardConsequence, type MyCalendarBoard } from "../domain/my-calendar";
import { useMyCalendarWindow } from "../hooks/use-my-calendar-data";
import type { CalendarInfo, OpenCalendarItem } from "./board-calendar-chips";
import { UpcomingGroupList } from "./board-calendar-upcoming";
import type { WorkspaceRegion } from "@/lib/date-time";

export const BOARD_FIELD_ID = "my-calendar-event-board";

/**
 * The calendar's items after hidden calendars and Created by me; the server
 * searches event titles, so the search applies here to records and cards.
 */
export function shownItems(
  items: readonly CalendarItem[],
  options: {
    hidden: ReadonlySet<string>;
    show: CalendarShow;
    viewerId: string | null;
    search: string;
  },
): CalendarItem[] {
  const query = options.search.trim().toLocaleLowerCase();
  return filterCalendarItems(items, { ...options, search: "" }).filter(
    (item) =>
      item.kind === "event" ||
      !query ||
      item.title.toLocaleLowerCase().includes(query),
  );
}

/** The editor's first field on My calendar (BR35): where the event goes. */
export function MyCalendarBoardField({
  boards,
  value,
  disabled,
  onChange,
}: {
  boards: readonly MyCalendarBoard[];
  value: MyCalendarBoard;
  disabled: boolean;
  onChange: (board: MyCalendarBoard) => void;
}) {
  const hintId = useId();
  return (
    <Field className="gap-1.5">
      <FieldLabel htmlFor={BOARD_FIELD_ID}>Board</FieldLabel>
      <NativeSelect
        id={BOARD_FIELD_ID}
        className="w-full"
        value={value.id}
        disabled={disabled}
        aria-describedby={hintId}
        onChange={(event) => {
          const next = boards.find((board) => board.id === event.target.value);
          if (next) onChange(next);
        }}
      >
        {boards.map((board) => (
          <option key={board.id} value={board.id}>
            {board.name}
          </option>
        ))}
      </NativeSelect>
      <FieldDescription id={hintId}>{boardConsequence(value)}</FieldDescription>
    </Field>
  );
}

/** A later Upcoming window on My calendar: its own reads, filtered alike. */
export function MyLaterWindow({
  window,
  search,
  sources,
  hidden,
  show,
  viewerId,
  listed,
  departmentOrder,
  today,
  calendars,
  region,
  onOpen,
}: {
  window: { start: string; end: string };
  search: string;
  sources: readonly CalendarSource[];
  hidden: ReadonlySet<string>;
  show: CalendarShow;
  viewerId: string | null;
  listed: readonly BoardManagementBoard[];
  departmentOrder: (departmentId: string) => number | null;
  today: string;
  calendars: ReadonlyMap<string, CalendarInfo>;
  region: WorkspaceRegion;
  onOpen: OpenCalendarItem;
}) {
  const data = useMyCalendarWindow({
    window,
    search,
    sources,
    hidden,
    listed,
    departmentOrder,
  });
  const items = shownItems(data.items, { hidden, show, viewerId, search });
  if (data.eventsError)
    return (
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
        <span role="alert" className="text-danger-text">
          Later events could not be loaded.
        </span>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 xl:min-h-8"
          onClick={() => data.retry("events")}
        >
          Retry later events
        </Button>
      </div>
    );
  if (!data.eventsReady)
    return (
      <p role="status" className="text-muted-foreground px-4 py-3 text-sm">
        Loading later events…
      </p>
    );
  return (
    <UpcomingGroupList
      groups={upcomingGroups(items, window.start)}
      today={today}
      calendars={calendars}
      region={region}
      onOpen={onOpen}
    />
  );
}
