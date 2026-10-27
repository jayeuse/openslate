"use client";

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { Popover, PopoverContent, PopoverTitle } from "@/components/ui/popover";
import { PersonCardPopover } from "@/components/person-card";
import { formatWorkspaceDate, type WorkspaceRegion } from "@/lib/date-time";
import {
  listBoardStageNames,
  type DueCard,
} from "../adapters/board-due-cards-api";
import { dueCardTitle } from "../domain/calendar-items";

/**
 * A due card's summary until the card sheet lands (P4): its title, stage,
 * due date, and assignee. A locked record card shows no name (BR63).
 */
export function BoardCardDuePopover({
  boardId,
  card,
  anchor,
  region,
  onClose,
}: {
  boardId: string;
  card: DueCard | null;
  anchor: HTMLElement | null;
  region: WorkspaceRegion;
  onClose: () => void;
}) {
  // Focus returns to the due chip that opened the summary.
  const focusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (anchor) focusRef.current = anchor;
  }, [anchor]);
  const stages = useQuery({
    queryKey: ["boards", "calendar", "stage-names", boardId],
    queryFn: () => listBoardStageNames(boardId),
    enabled: card !== null,
  });
  const stage = card
    ? stages.data?.find((entry) => entry.id === card.stageId)?.name
    : undefined;
  return (
    <Popover
      open={card !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PopoverContent
        anchor={anchor}
        finalFocus={focusRef}
        align="start"
        className="slim-ui w-72"
      >
        {card ? (
          <>
            <PopoverTitle className="flex items-center gap-1.5 text-sm">
              {card.record?.locked ? (
                <Lock aria-hidden="true" className="size-3.5 shrink-0" />
              ) : null}
              <span className="wrap-anywhere">{dueCardTitle(card)}</span>
            </PopoverTitle>
            <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Stage</dt>
              <dd>{stage ?? (stages.isError ? "Unavailable" : "Loading…")}</dd>
              <dt className="text-muted-foreground">Due</dt>
              <dd>
                {formatWorkspaceDate(card.dueOn, region, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </dd>
              <dt className="text-muted-foreground">Assignee</dt>
              <dd className="min-w-0">
                {card.assigneeId ? (
                  <PersonCardPopover
                    personId={card.assigneeId}
                    unavailableLabel="Assignee unavailable"
                  />
                ) : (
                  "Nobody"
                )}
              </dd>
            </dl>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
