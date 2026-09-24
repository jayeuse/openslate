"use client";

import { createElement } from "react";
import type { BoardEvent, BoardEventPage } from "../adapters/board-events-api";
import type { BoardMyAccess } from "../adapters/board-tools-api";

export type BoardEventLifecycleAction = {
  kind: "archive" | "restore";
  boardId: string;
  eventId: string;
  boardRevision: number;
  eventRevision: number;
  title: string;
};

export function prepareBoardEventLifecycleAction(
  event: BoardEvent,
  boardId: string,
  boardRevision: number,
  access: BoardMyAccess | null,
  boardActive: boolean,
  kind: "archive" | "restore",
): BoardEventLifecycleAction | null {
  if (
    !boardActive ||
    access?.manage !== true ||
    event.boardId !== boardId ||
    event.archived !== (kind === "restore") ||
    event.boardRevision !== boardRevision
  )
    return null;
  return {
    kind,
    boardId,
    eventId: event.id,
    boardRevision,
    eventRevision: event.revision,
    title: event.title,
  };
}

export function ServerArchivedBoardEventsDisplay({
  page,
  canRestoreEvent,
  onRestoreEvent,
}: {
  page: BoardEventPage;
  canRestoreEvent: (event: BoardEvent) => boolean;
  onRestoreEvent: (event: BoardEvent) => void;
}) {
  return createElement(
    "section",
    { "aria-label": "Archived Board events" },
    createElement(
      "h3",
      { className: "text-base font-semibold" },
      "Archived events",
    ),
    page.items.length === 0
      ? createElement(
          "p",
          { className: "text-muted-foreground mt-2 text-sm" },
          "No archived events on this page.",
        )
      : createElement(
          "ul",
          { className: "mt-3 flex flex-col gap-2" },
          ...page.items.map((event) =>
            createElement(
              "li",
              {
                key: event.id,
                className:
                  "border-border flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3",
              },
              createElement(
                "span",
                { className: "min-w-0 font-medium break-words" },
                event.title,
              ),
              canRestoreEvent(event)
                ? createElement(
                    "button",
                    {
                      type: "button",
                      className:
                        "border-border bg-card text-foreground hover:bg-muted focus-visible:outline-ring inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2",
                      onClick: () => onRestoreEvent(event),
                      "aria-label": `Restore ${event.title}`,
                    },
                    "Restore event",
                  )
                : null,
            ),
          ),
        ),
  );
}
