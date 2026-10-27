"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { Popover, PopoverContent, PopoverTitle } from "@/components/ui/popover";
import { toast } from "@/components/ui/toast";
import type { WorkspaceRegion } from "@/lib/date-time";
import { readKanbanCard } from "../adapters/board-kanban-api";
import type {
  KanbanCard,
  KanbanLabel,
  KanbanStage,
} from "../adapters/board-kanban-schemas";
import { cardName } from "../domain/kanban";
import {
  LabelChip,
  chartVar,
  dueWords,
  shortDate,
  type KanbanPerson,
} from "./board-kanban-card";

/**
 * A card's read-only summary (P4a), until the card sheets land (P4b, BR64):
 * the name, the stage, the dates, the labels, the checklist and the
 * assignee. A card the board has not drawn is read once by its link; a
 * card the viewer cannot open gets the one unavailable answer.
 */
export function KanbanCardSummary({
  boardId,
  cardId,
  card,
  stages,
  labelMap,
  people,
  region,
  today,
  fallbackAnchor,
  onClose,
}: {
  boardId: string;
  cardId: string | null;
  card: KanbanCard | null;
  stages: readonly KanbanStage[];
  labelMap: ReadonlyMap<string, KanbanLabel>;
  people: ReadonlyMap<string, KanbanPerson>;
  region: WorkspaceRegion;
  today: string;
  fallbackAnchor: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const linked = useQuery({
    queryKey: ["boards", "kanban", boardId, "card", cardId],
    queryFn: () => readKanbanCard(boardId, cardId ?? ""),
    enabled: cardId !== null && card === null,
    staleTime: 0,
  });
  const shown = card ?? (linked.data?.id === cardId ? linked.data : null);
  const unavailable =
    cardId !== null &&
    ((shown?.record?.locked ?? false) || (card === null && linked.isError));
  // Said once per link, though the parent's close handler is new each render.
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (!unavailable || reported.current === cardId) return;
    reported.current = cardId;
    toast.add({ title: "This card is not available.", type: "error" });
    onClose();
  }, [unavailable, cardId, onClose]);

  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!shown) return setAnchor(null);
    const node =
      document.querySelector<HTMLElement>(
        `[data-kanban-card="${CSS.escape(shown.id)}"]`,
      ) ?? fallbackAnchor.current;
    returnFocus.current =
      node?.querySelector<HTMLElement>("[data-kanban-focus]") ?? null;
    setAnchor(node);
  }, [shown, fallbackAnchor]);

  const open = shown !== null && !unavailable && anchor !== null;
  const stage = shown ? stages.find((item) => item.id === shown.stageId) : null;
  const due = shown ? dueWords(shown, region, today) : null;
  const person = shown?.assigneeId ? people.get(shown.assigneeId) : undefined;
  const record = shown?.record && !shown.record.locked ? shown.record : null;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <PopoverContent
        anchor={anchor}
        finalFocus={returnFocus}
        align="start"
        className="slim-ui w-72"
      >
        {shown ? (
          <>
            {record ? (
              <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <FileText aria-hidden="true" className="size-3.5" />
                {record.moduleName}
              </p>
            ) : null}
            <PopoverTitle className="text-base font-semibold">
              {cardName(shown)}
            </PopoverTitle>
            <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
              {stage ? (
                <>
                  <dt className="text-muted-foreground">Stage</dt>
                  <dd className="flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="size-2 rounded-full"
                      style={{ background: chartVar(stage.color) }}
                    />
                    {stage.name}
                  </dd>
                </>
              ) : null}
              {shown.startOn ? (
                <>
                  <dt className="text-muted-foreground">Start</dt>
                  <dd className="tabular-nums">
                    {shortDate(shown.startOn, region)}
                  </dd>
                </>
              ) : null}
              {due ? (
                <>
                  <dt className="text-muted-foreground">Due</dt>
                  <dd
                    className={
                      due.late ? "text-warn-text tabular-nums" : "tabular-nums"
                    }
                  >
                    {due.text}
                  </dd>
                </>
              ) : null}
              {person ? (
                <>
                  <dt className="text-muted-foreground">Assignee</dt>
                  <dd>{person.name}</dd>
                </>
              ) : null}
              {shown.checklist.total > 0 ? (
                <>
                  <dt className="text-muted-foreground">Checklist</dt>
                  <dd className="tabular-nums">
                    {shown.checklist.done} of {shown.checklist.total}
                  </dd>
                </>
              ) : null}
              {record?.status ? (
                <>
                  <dt className="text-muted-foreground">
                    {record.status.name}
                  </dt>
                  <dd>{record.status.value}</dd>
                </>
              ) : null}
              {record?.fields.map((field) => (
                <FieldRow
                  key={field.fieldId}
                  name={field.name}
                  value={field.value}
                />
              ))}
            </dl>
            {shown.labelIds.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {shown.labelIds.flatMap((id) => {
                  const label = labelMap.get(id);
                  return label ? [<LabelChip key={id} label={label} />] : [];
                })}
              </div>
            ) : null}
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function FieldRow({ name, value }: { name: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground truncate">{name}</dt>
      <dd className="min-w-0 truncate">{value}</dd>
    </>
  );
}
