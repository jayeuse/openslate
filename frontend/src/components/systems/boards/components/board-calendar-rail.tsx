"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  ChevronLeft,
  ChevronRight,
  ListFilter,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { formatWorkspaceDate, type WorkspaceRegion } from "@/lib/date-time";
import type { CalendarSource } from "../adapters/board-calendar-sources-api";
import {
  monthGrid,
  monthOf,
  moveDayFocus,
  shiftAnchor,
  type WeekStart,
} from "../domain/calendar-dates";
import type { CalendarReadStatus } from "../hooks/use-board-calendar-data";
import { CalendarSwatch, dayLabel } from "./board-calendar-chips";

export type CalendarListRow = {
  id: string;
  name: string;
  color: string;
  kind: "events" | "due" | "source";
  source?: CalendarSource;
  /** Where "Open records without a date" goes, when the module page can. */
  undatedHref?: string;
};

export type CalendarListActions = {
  hidden: ReadonlySet<string>;
  statuses: ReadonlyMap<string, CalendarReadStatus>;
  canManage: boolean;
  onToggle: (id: string) => void;
  onRetry: (id: string) => void;
  onAddSource: () => void;
  onRemoveSource: (source: CalendarSource) => void;
  /** A board's source copies to My calendar; My calendar's own do not. */
  onAddToMyCalendar?: (source: CalendarSource) => void;
};

/**
 * The calendar list (BR52): every calendar and record source with a
 * checkbox and its name beside its mark. A failed read shows in its row.
 */
export function CalendarList({
  rows,
  actions,
  personal = false,
}: {
  rows: readonly CalendarListRow[];
  actions: CalendarListActions;
  /**
   * My calendar's list (the comp): Board calendars with their count, My
   * cards, and the person's own record sources.
   */
  personal?: boolean;
}) {
  const own = rows.filter((row) => row.kind !== "source");
  const sources = rows.filter((row) => row.kind === "source");
  const boards = own.filter((row) => row.kind === "events");
  return (
    <div className="flex flex-col gap-3">
      {personal ? (
        <>
          <CalendarGroup
            title="Board calendars"
            count={boards.length}
            rows={boards}
            actions={actions}
          />
          <CalendarGroup
            title="My cards"
            rows={own.filter((row) => row.kind === "due")}
            actions={actions}
          />
        </>
      ) : (
        <CalendarGroup title="Calendars" rows={own} actions={actions} />
      )}
      {sources.length || actions.canManage ? (
        <CalendarGroup
          title={personal ? "My record sources" : "Record sources"}
          rows={sources}
          actions={actions}
        >
          {actions.canManage && sources.length < 5 ? (
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground min-h-11 justify-start self-start px-1.5 xl:min-h-7"
              onClick={actions.onAddSource}
            >
              <Plus data-icon="inline-start" /> Add record source
            </Button>
          ) : null}
        </CalendarGroup>
      ) : null}
    </div>
  );
}

function CalendarGroup({
  title,
  count,
  rows,
  actions,
  children,
}: {
  title: string;
  count?: number;
  rows: readonly CalendarListRow[];
  actions: CalendarListActions;
  children?: React.ReactNode;
}) {
  const headingId = useId();
  return (
    <div className="flex flex-col gap-0.5">
      <h2
        id={headingId}
        className="text-muted-foreground flex items-center justify-between px-1 pb-1 text-xs font-medium"
      >
        {title}
        {count !== undefined ? (
          <span className="tabular-nums" aria-hidden="true">
            {count}
          </span>
        ) : null}
      </h2>
      <ul aria-labelledby={headingId} className="flex flex-col">
        {rows.map((row) => (
          <CalendarListItem key={row.id} row={row} actions={actions} />
        ))}
      </ul>
      {children}
    </div>
  );
}

function CalendarListItem({
  row,
  actions,
}: {
  row: CalendarListRow;
  actions: CalendarListActions;
}) {
  const checkboxId = `board-calendar-toggle-${row.id.replace(/[^a-z0-9-]/gi, "-")}`;
  const status = actions.statuses.get(row.id);
  const failed = status === "error";
  const shown = !actions.hidden.has(row.id);
  return (
    <li className="flex min-h-11 items-center gap-2 rounded-md px-1 xl:min-h-8">
      <Checkbox
        id={checkboxId}
        checked={shown}
        onCheckedChange={() => actions.onToggle(row.id)}
      />
      <label
        htmlFor={checkboxId}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm"
        title={row.name}
      >
        <CalendarSwatch color={row.color} outlined={row.kind !== "events"} />
        <span className="truncate">{row.name}</span>
      </label>
      {failed ? (
        // A failed read is a request failure (Request feedback).
        <span
          role="alert"
          className="text-danger-text flex shrink-0 items-center gap-1 text-xs"
        >
          not loaded ·
          <Button
            type="button"
            variant="ghost"
            className="text-danger-text h-auto min-h-11 px-1 text-xs underline xl:min-h-6"
            aria-label={`Retry ${row.name}`}
            onClick={() => actions.onRetry(row.id)}
          >
            Retry
          </Button>
        </span>
      ) : status === "limited" ? (
        // A server cap, not a failure: it says so in muted words.
        <span className="text-muted-foreground shrink-0 text-xs">
          Too many events to show
        </span>
      ) : null}
      {row.source ? (
        <SourceMenu row={row} actions={actions} shown={shown} />
      ) : null}
    </li>
  );
}

function SourceMenu({
  row,
  actions,
  shown,
}: {
  row: CalendarListRow;
  actions: CalendarListActions;
  shown: boolean;
}) {
  const source = row.source!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0 xl:size-7"
            aria-label={`Record source actions, ${row.name}`}
          />
        }
      >
        <MoreHorizontal aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="slim-ui">
        <DropdownMenuItem
          className="min-h-11 xl:min-h-8"
          onClick={() => actions.onToggle(row.id)}
        >
          {shown ? "Hide" : "Show"}
        </DropdownMenuItem>
        {row.undatedHref ? (
          <DropdownMenuItem
            className="min-h-11 xl:min-h-8"
            render={<Link href={row.undatedHref as Route} />}
          >
            Open records without a date
          </DropdownMenuItem>
        ) : null}
        {actions.onAddToMyCalendar ? (
          <DropdownMenuItem
            className="min-h-11 xl:min-h-8"
            onClick={() => actions.onAddToMyCalendar?.(source)}
          >
            Add to My calendar
          </DropdownMenuItem>
        ) : null}
        {actions.canManage ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-danger-text min-h-11 xl:min-h-8"
              onClick={() => actions.onRemoveSource(source)}
            >
              Remove
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The mini month (Outlook): any day moves the calendar to it. */
export function MiniMonth({
  anchor,
  today,
  weekStart,
  highlight,
  region,
  onPick,
}: {
  anchor: string;
  today: string | null;
  weekStart: WeekStart;
  /** The week the Week view shows, tinted. */
  highlight: readonly string[];
  region: WorkspaceRegion;
  onPick: (date: string) => void;
}) {
  const [shown, setShown] = useState(anchor);
  const [followed, setFollowed] = useState(anchor);
  const [focusDay, setFocusDay] = useState<string | null>(null);
  const daysRef = useRef<HTMLDivElement>(null);
  // The mini month follows the calendar when the calendar moves.
  if (followed !== anchor) {
    setFollowed(anchor);
    setShown(anchor);
  }
  const grid = monthGrid(shown, weekStart);
  const days = grid.flat();
  // The days are one Tab stop; arrow keys move between them, and past the
  // month's edge the mini month turns its page.
  const tabDay =
    focusDay && days.includes(focusDay)
      ? focusDay
      : days.includes(anchor) && monthOf(anchor) === monthOf(shown)
        ? anchor
        : `${monthOf(shown)}-01`;
  // Focus waits for the page that holds the day.
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingFocus) return;
    const button = daysRef.current?.querySelector<HTMLButtonElement>(
      `[data-mini-day="${pendingFocus}"]`,
    );
    if (!button) return;
    button.focus();
    setPendingFocus(null);
  }, [pendingFocus, shown]);
  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    const next = moveDayFocus(date, event.key, weekStart);
    if (!next) return;
    event.preventDefault();
    setFocusDay(next);
    if (!days.includes(next)) setShown(next);
    setPendingFocus(next);
  }
  return (
    <div>
      <div className="flex items-center justify-between pb-1">
        <span className="text-sm font-semibold">
          {formatWorkspaceDate(`${monthOf(shown)}-01`, region, {
            month: "long",
            year: "numeric",
          })}
        </span>
        <span className="flex">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Previous month in the mini calendar"
            onClick={() => setShown(shiftAnchor("month", shown, -1))}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Next month in the mini calendar"
            onClick={() => setShown(shiftAnchor("month", shown, 1))}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </span>
      </div>
      <div
        ref={daysRef}
        className="grid grid-cols-7 text-center text-xs tabular-nums"
      >
        {grid[0].map((date) => (
          <span
            key={date}
            className="text-muted-foreground h-6 leading-6 font-medium"
          >
            {formatWorkspaceDate(date, region, { weekday: "narrow" })}
          </span>
        ))}
        {grid.flat().map((date) => (
          <button
            key={date}
            type="button"
            data-mini-day={date}
            tabIndex={date === tabDay ? 0 : -1}
            aria-label={`Go to ${dayLabel(date, region)}`}
            onClick={() => onPick(date)}
            onKeyDown={(event) => moveFocus(event, date)}
            onFocus={() => setFocusDay(date)}
            className={cn(
              "hover:bg-accent focus-visible:outline-ring grid h-[26px] place-items-center rounded-sm outline-none focus-visible:outline-2",
              monthOf(date) !== monthOf(shown) && "text-muted-foreground",
              highlight.includes(date) && "bg-accent rounded-none",
              date === today &&
                "bg-foreground text-background hover:bg-foreground rounded-full font-semibold",
            )}
          >
            {Number(date.slice(8))}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Below 1440px the rail folds into a Calendars popover in the toolbar. */
export function CalendarsPopover({
  rows,
  actions,
  personal = false,
}: {
  rows: readonly CalendarListRow[];
  actions: CalendarListActions;
  personal?: boolean;
}) {
  const failed = rows.filter(
    (row) => actions.statuses.get(row.id) === "error",
  ).length;
  const hidden = rows.filter((row) => actions.hidden.has(row.id)).length;
  // Hidden calendars count like active filters (the Posts Filters badge); a
  // failed read adds a danger dot. The words are the name and the tooltip,
  // so the toolbar keeps one row at 1280.
  const summary = [
    hidden ? `${hidden} hidden` : null,
    failed ? `${failed} not loaded` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const name = summary ? `Calendars, ${summary}` : "Calendars";
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className="min-h-11 max-md:min-w-11 max-md:px-2 xl:h-8 xl:min-h-8 xl:px-2.5"
            aria-label={name}
            title={name}
          />
        }
      >
        <ListFilter aria-hidden="true" />
        <span className="max-md:sr-only">Calendars</span>
        {hidden ? (
          <span
            aria-hidden="true"
            className="bg-action-tint text-action-text inline-grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-xs leading-none font-semibold tabular-nums"
          >
            {hidden}
          </span>
        ) : null}
        {failed ? (
          <span
            aria-hidden="true"
            className="bg-danger-text inline-block size-2 rounded-full"
          />
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="start" className="slim-ui w-72">
        <CalendarList rows={rows} actions={actions} personal={personal} />
      </PopoverContent>
    </Popover>
  );
}
