"use client";

import type { RefObject } from "react";
import Link from "next/link";
import type { Route } from "next";
import { ArrowUpRight, MoreHorizontal, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { PersonCardPopover } from "@/components/person-card";
import { reportDone, reportError } from "@/lib/feedback";
import type { BoardEvent } from "../adapters/board-events-api";
import { HydratedBoardAttachments } from "./server-backed-board-attachments";
import { HydratedBoardRecordLinks } from "./hydrated-board-record-links";
import { CalendarSwatch, REPEAT_WORDS } from "./board-calendar-chips";
import { REMINDER_TIMINGS } from "./server-backed-board-event-editor";

/** The facts of one event, in reading order (BR20). Plain text only. */
export function BoardEventSheetBody({
  event,
  calendar,
  author,
}: {
  event: BoardEvent;
  /**
   * The event's calendar. Its name stands beside its color here, which the
   * month cells' Name Beside Color exception relies on (BR53).
   */
  calendar?: SheetCalendar;
  /** The author's person card; the sheet passes it in. */
  author?: React.ReactNode;
}) {
  const reminders = REMINDER_TIMINGS.filter((timing) =>
    event.reminders.includes(timing.value),
  ).map((timing) => timing.label);
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <dl className="divide-y text-sm">
        {calendar ? (
          <Fact label={calendar.href ? "Board" : "Calendar"}>
            <span className="flex min-w-0 flex-wrap items-center gap-x-2">
              <CalendarSwatch color={calendar.color} />
              <span className="min-w-0">{calendar.name}</span>
              {calendar.href ? (
                <Link
                  href={calendar.href as Route}
                  className="text-action-text focus-visible:outline-ring inline-flex min-h-11 items-center gap-1 rounded-sm underline underline-offset-4 focus-visible:outline-2 xl:min-h-8"
                >
                  Open board
                  <ArrowUpRight aria-hidden="true" className="size-4" />
                </Link>
              ) : null}
            </span>
          </Fact>
        ) : null}
        {event.location ? <Fact label="Location">{event.location}</Fact> : null}
        <Fact label="Reminders">
          {reminders.length ? reminders.join(", ") : "None"}
        </Fact>
        {author ? <Fact label="Added by">{author}</Fact> : null}
      </dl>
      {event.details ? (
        <p className="max-w-[65ch] text-sm leading-6 break-words whitespace-pre-wrap">
          {event.details}
        </p>
      ) : null}
      {event.links.length ? (
        <section aria-label="Event links" className="flex flex-col gap-1">
          <h3 data-slot="section-title" className="text-sm font-medium">
            Links
          </h3>
          <ul className="flex min-w-0 flex-col">
            {event.links.map((link, index) => (
              <li key={`${link.url}:${index}`}>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                  className="text-action-text focus-visible:outline-ring inline-flex min-h-11 max-w-full items-center gap-1 rounded-sm text-sm break-words underline underline-offset-4 focus-visible:outline-2 xl:min-h-8"
                >
                  {link.label}
                  <ArrowUpRight
                    aria-hidden="true"
                    className="size-4 shrink-0"
                  />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-1 py-2.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-center sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 wrap-anywhere">{children}</dd>
    </div>
  );
}

/**
 * The event's calendar in the sheet. On My calendar it is the event's board,
 * with `href` to open it there (BR53).
 */
export type SheetCalendar = { name: string; color: string; href?: string };

export type EventSheetState =
  | { status: "loading" }
  | { status: "error"; message: string; retryable: boolean }
  | { status: "ready"; event: BoardEvent; when: string };

/**
 * One event sheet for every view and for `?event=` (BR20), in the record
 * sheet grammar: the title, one meta line, a quiet Edit, More event actions,
 * and a named close. Files and Linked records show only with items.
 */
export function BoardEventSheet({
  open,
  state,
  calendar,
  canEdit,
  canArchive,
  finalFocus,
  onClose,
  onRetry,
  onEdit,
  onArchive,
}: {
  open: boolean;
  state: EventSheetState;
  calendar: SheetCalendar;
  canEdit: boolean;
  canArchive: boolean;
  finalFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
  onRetry: () => void;
  onEdit: (event: BoardEvent) => void;
  onArchive: (event: BoardEvent) => void;
}) {
  const event = state.status === "ready" ? state.event : null;
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        className="slim-ui flex w-full max-w-none flex-col gap-0 overflow-hidden p-0 sm:w-[min(92vw,40rem)]"
        finalFocus={finalFocus}
      >
        <header className="flex shrink-0 items-start gap-3 border-b p-5 pr-3">
          <div className="min-w-0 flex-1">
            <SheetTitle className="text-lg leading-tight font-semibold wrap-anywhere">
              {event?.title ??
                (state.status === "error"
                  ? "Event unavailable"
                  : "Opening event")}
            </SheetTitle>
            <SheetDescription className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
              {state.status === "ready" ? (
                <>
                  <span>{state.when}</span>
                  {state.event.recurrence !== "none" ? (
                    <span>
                      · Repeats{" "}
                      {REPEAT_WORDS[state.event.recurrence].toLowerCase()}
                    </span>
                  ) : null}
                  {state.event.archived ? (
                    <Badge variant="secondary">Archived</Badge>
                  ) : null}
                </>
              ) : state.status === "error" ? (
                state.message
              ) : (
                "Loading the event."
              )}
            </SheetDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {event && canEdit ? (
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 xl:min-h-8"
                aria-label="Edit event"
                onClick={() => onEdit(event)}
              >
                Edit
              </Button>
            ) : null}
            {event ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-11"
                      aria-label="More event actions"
                    />
                  }
                >
                  <MoreHorizontal aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="slim-ui">
                  <DropdownMenuItem
                    className="min-h-11 xl:min-h-8"
                    onClick={() => {
                      // My calendar copies the board's own address for the
                      // event, which opens it from any month.
                      void navigator.clipboard
                        .writeText(
                          calendar.href
                            ? new URL(calendar.href, window.location.href).href
                            : window.location.href,
                        )
                        .then(
                          () => reportDone("Link copied"),
                          () => reportError("Could not copy the link"),
                        );
                    }}
                  >
                    Copy link
                  </DropdownMenuItem>
                  {canArchive ? (
                    <DropdownMenuItem
                      className="min-h-11 xl:min-h-8"
                      onClick={() => onArchive(event)}
                    >
                      Archive event
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11"
              aria-label="Close event"
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5">
          {event ? (
            <div className="flex flex-col gap-6">
              <BoardEventSheetBody
                event={event}
                calendar={calendar}
                author={
                  <PersonCardPopover
                    personId={event.authorId}
                    unavailableLabel="Author unavailable"
                  />
                }
              />
              <HydratedBoardAttachments
                key={`files:${event.id}:${event.revision}`}
                access="read"
                hideWhenEmpty
                target={{
                  kind: "event",
                  boardId: event.boardId,
                  contentId: event.id,
                }}
              />
              <HydratedBoardRecordLinks
                key={`records:${event.id}:${event.revision}`}
                access="read"
                hideWhenEmpty
                target={{
                  kind: "event",
                  boardId: event.boardId,
                  contentId: event.id,
                }}
              />
            </div>
          ) : state.status === "error" && state.retryable ? (
            // A failed read can be retried; a refusal keeps its neutral line.
            <Alert
              variant="destructive"
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <span>Could not load the event.</span>
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
        </div>
      </SheetContent>
    </Sheet>
  );
}
