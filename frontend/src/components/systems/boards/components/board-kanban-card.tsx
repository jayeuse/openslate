"use client";

import type {
  CSSProperties,
  FocusEvent,
  KeyboardEvent,
  ReactNode,
} from "react";
import { useDraggable } from "@dnd-kit/core";
import { Check, FileText, Lock, MoreHorizontal } from "lucide-react";
import { PersonAvatar } from "@/components/person-avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { WorkspaceRegion } from "@/lib/date-time";
import { cn } from "@/lib/utils";
import type { KanbanCard, KanbanLabel } from "../adapters/board-kanban-schemas";
import { cardLabel, cardName, dueWords } from "../domain/kanban";

/** A person on a card: their name and avatar, when their card was read. */
export type KanbanPerson = { name: string; avatarUrl: string | null };

/** A chart series color as a CSS value (BR69). */
export const chartVar = (color: string | null) =>
  color ? `var(--${color})` : "var(--ink-muted)";

export function LabelChip({ label }: { label: KanbanLabel }) {
  return (
    <span
      className="text-foreground inline-flex h-5 items-center gap-1.5 rounded-full pr-2 pl-1.5 text-xs font-medium whitespace-nowrap"
      style={{
        background: `color-mix(in oklab, ${chartVar(label.color)} 22%, var(--card))`,
      }}
    >
      <span
        aria-hidden="true"
        className="size-[7px] rounded-full"
        style={{ background: chartVar(label.color) }}
      />
      {label.name}
    </span>
  );
}

/** What a card shows (BR63, BR67): no field-name labels, one fact line. */
function CardFace({
  card,
  labels,
  person,
  region,
  today,
}: {
  card: KanbanCard;
  labels: ReadonlyMap<string, KanbanLabel>;
  person: KanbanPerson | null;
  region: WorkspaceRegion;
  today: string;
}) {
  const due = dueWords(card, region, today);
  const record = card.record && !card.record.locked ? card.record : null;
  const chips = card.labelIds.flatMap((id) => {
    const label = labels.get(id);
    return label ? [label] : [];
  });
  // The fact line shows only with something to say (BR67).
  const hasFacts = Boolean(
    record?.status || due || card.checklist.total > 0 || person,
  );
  return (
    <>
      {record ? (
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <FileText aria-hidden="true" className="size-3.5" />
          {record.moduleName}
        </span>
      ) : null}
      {chips.length > 0 ? (
        <span className="flex flex-wrap gap-1">
          {chips.map((label) => (
            <LabelChip key={label.id} label={label} />
          ))}
        </span>
      ) : null}
      <span className="line-clamp-2 font-medium">{cardName(card)}</span>
      {record && record.fields.length > 0 ? (
        <span className="text-muted-foreground truncate text-xs tabular-nums">
          {record.fields
            .slice(0, 2)
            .map((field) => field.value)
            .join(" · ")}
        </span>
      ) : null}
      {hasFacts ? (
        <span className="text-muted-foreground flex min-h-[22px] items-center gap-2 text-xs tabular-nums">
          {record?.status ? (
            <span className="bg-muted text-foreground inline-flex h-5 items-center rounded-sm px-1.5 font-medium">
              {record.status.value}
            </span>
          ) : null}
          {due ? (
            <span className={cn(due.late && "text-warn-text font-medium")}>
              {due.text}
            </span>
          ) : null}
          {card.checklist.total > 0 ? (
            <span className="inline-flex items-center gap-1">
              <Check aria-hidden="true" className="size-3.5" />
              {card.checklist.done}/{card.checklist.total}
            </span>
          ) : null}
          {person ? (
            <span className="ml-auto" title={person.name}>
              <PersonAvatar
                name={person.name}
                avatarUrl={person.avatarUrl}
                className="size-[22px] text-[9px]"
              />
            </span>
          ) : null}
        </span>
      ) : null}
    </>
  );
}

/** The note body, shared by the board and the lifted copy under the pointer. */
export const noteClass =
  "bg-card text-foreground border-[var(--card-edge,var(--border))] flex min-w-0 flex-col gap-1.5 rounded-md border px-2.5 py-2 text-left text-sm shadow-[var(--card-lift,none)]";

export type CardDragState = "idle" | "lifted" | "source";

/** The lifted card under the pointer (BR67): raised lift, focus-color edge. */
export function KanbanCardOverlay(props: {
  card: KanbanCard;
  labels: ReadonlyMap<string, KanbanLabel>;
  person: KanbanPerson | null;
  region: WorkspaceRegion;
  today: string;
}) {
  return props.card.record?.locked ? (
    <div
      className={cn(
        noteClass,
        "w-full -rotate-[1.5deg] border-[var(--focus)] shadow-[var(--lift-raised)]",
      )}
    >
      <LockedFace />
    </div>
  ) : (
    <div
      className={cn(
        noteClass,
        "w-full -rotate-[1.5deg] cursor-grabbing border-[var(--focus)] shadow-[var(--lift-raised)]",
      )}
    >
      <CardFace {...props} />
    </div>
  );
}

function LockedFace() {
  return (
    <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
      <Lock aria-hidden="true" className="size-3.5" />
      No access to this record
    </span>
  );
}

export type KanbanCardProps = {
  card: KanbanCard;
  labels: readonly KanbanLabel[];
  labelMap: ReadonlyMap<string, KanbanLabel>;
  person: KanbanPerson | null;
  region: WorkspaceRegion;
  today: string;
  stages: readonly { id: string; name: string }[];
  canWrite: boolean;
  canDrag: boolean;
  pending: boolean;
  /** "lifted" by the keyboard; "source" while the pointer drags it. */
  drag: CardDragState;
  describedBy: string;
  onOpen: (card: KanbanCard) => void;
  onKey: (card: KanbanCard, event: KeyboardEvent<HTMLElement>) => void;
  /** Focus left a lifted card: the move is cancelled. */
  onLiftLost: (card: KanbanCard) => void;
  onMoveTo: (card: KanbanCard, stageId: string) => void;
  onToggleLabel: (card: KanbanCard, labelId: string) => void;
  onArchive: (card: KanbanCard) => void;
};

/**
 * One card on the board, as a note (BR66, BR67). The whole note opens the
 * card; writers drag it, lift it with Space, or move it from its menu
 * (WCAG 2.5.7). A locked record card shows no name and never opens.
 */
export function KanbanCardNote(props: KanbanCardProps) {
  const { card, canWrite, canDrag, pending, drag } = props;
  const { setNodeRef, listeners } = useDraggable({
    id: `card:${card.id}`,
    data: { type: "card", cardId: card.id },
    disabled: !canDrag || pending,
  });
  const locked = card.record?.locked === true;
  const name = cardName(card);
  const lifted = drag === "lifted";
  const frame = cn(
    noteClass,
    "hover:border-[var(--rule-strong)]",
    lifted &&
      "border-[var(--focus)] shadow-[var(--lift-raised)] ring-2 ring-[var(--focus)]",
    drag === "source" && "border-dashed opacity-30",
    pending && "opacity-70",
  );
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (canWrite) props.onKey(card, event);
  };
  // A lift ends when focus leaves the card, except into its own menu.
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (!lifted) return;
    const next = event.relatedTarget;
    if (
      next instanceof Element &&
      (event.currentTarget.contains(next) ||
        next.closest(`[data-card-menu="${CSS.escape(card.id)}"]`))
    )
      return;
    props.onLiftLost(card);
  };
  // Space lifts instead of opening: a button would also click on key up.
  const onKeyUp = (event: KeyboardEvent<HTMLElement>) => {
    if (canWrite && event.key === " ") event.preventDefault();
  };
  const menu = canWrite ? <CardMenu {...props} name={name} /> : null;
  return (
    <div
      ref={setNodeRef}
      data-kanban-card={card.id}
      data-card-note=""
      className="group/card relative min-w-0"
      // Focus leaving the card and its menu ends a keyboard lift.
      onBlur={onBlur}
      {...(locked ? {} : listeners)}
    >
      {locked ? (
        <div
          role="group"
          aria-label="No access to this record"
          data-kanban-focus={card.id}
          tabIndex={canWrite ? 0 : undefined}
          aria-describedby={canWrite ? props.describedBy : undefined}
          className={cn(
            frame,
            "cursor-default border-dashed bg-[color-mix(in_oklab,var(--surface-sunken)_60%,var(--card))] pr-9 outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus)]",
            canDrag && "cursor-grab",
          )}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          {...listeners}
        >
          <LockedFace />
          {menu}
        </div>
      ) : (
        <>
          <button
            type="button"
            data-kanban-focus={card.id}
            aria-label={cardLabel(card, {
              region: props.region,
              today: props.today,
              labelNames: card.labelIds.flatMap((id) => {
                const label = props.labelMap.get(id);
                return label ? [label.name] : [];
              }),
              assignee: props.person?.name ?? null,
            })}
            aria-describedby={canWrite ? props.describedBy : undefined}
            className={cn(
              frame,
              "w-full outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus)]",
              canWrite && "pr-9",
              canDrag ? "cursor-grab" : "cursor-pointer",
            )}
            onClick={() => props.onOpen(card)}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
          >
            <CardFace
              card={card}
              labels={props.labelMap}
              person={props.person}
              region={props.region}
              today={props.today}
            />
          </button>
          {menu}
        </>
      )}
    </div>
  );
}

/** Move to stage, labels, and Archive card (writers). */
function CardMenu({
  card,
  name,
  labels,
  stages,
  pending,
  onMoveTo,
  onToggleLabel,
  onArchive,
}: KanbanCardProps & { name: string }) {
  const locked = card.record?.locked === true;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Card actions for ${name}`}
            disabled={pending}
            // Hidden at rest only where a pointer can hover (wide screens);
            // tablets and phones always show it at 44px.
            className="absolute top-1 right-1 size-11 xl:size-8 xl:[@media(hover:hover)]:[[data-card-note]:not(:hover)_&:not(:focus-visible):not([data-popup-open])]:opacity-0"
            onPointerDown={(event) => event.stopPropagation()}
          />
        }
      >
        <MoreHorizontal aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="slim-ui min-w-48"
        data-card-menu={card.id}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-muted-foreground px-2 py-1.5 text-xs font-medium">
            Move to stage
          </DropdownMenuLabel>
          {stages.map((stage) => (
            <DropdownMenuItem
              key={stage.id}
              role="menuitemradio"
              aria-checked={stage.id === card.stageId}
              className="min-h-11 xl:min-h-8"
              onClick={() => {
                if (stage.id !== card.stageId) onMoveTo(card, stage.id);
              }}
            >
              <Check
                aria-hidden="true"
                className={cn(stage.id !== card.stageId && "invisible")}
              />
              {stage.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {!locked && labels.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-muted-foreground px-2 py-1.5 text-xs font-medium">
                Labels
              </DropdownMenuLabel>
              {labels.map((label) => (
                <DropdownMenuItem
                  key={label.id}
                  role="menuitemcheckbox"
                  aria-checked={card.labelIds.includes(label.id)}
                  closeOnClick={false}
                  className="min-h-11 xl:min-h-8"
                  onClick={() => onToggleLabel(card, label.id)}
                >
                  <Check
                    aria-hidden="true"
                    className={cn(
                      !card.labelIds.includes(label.id) && "invisible",
                    )}
                  />
                  <LabelChip label={label} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="min-h-11 xl:min-h-8"
          onClick={() => onArchive(card)}
        >
          Archive card
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The dashed place where a lifted card lands (BR67). */
export function DropSlot({ stageName }: { stageName: string }): ReactNode {
  return (
    <div
      aria-hidden="true"
      className="text-action-text grid min-h-16 place-content-center rounded-md border-[1.5px] border-dashed border-[var(--action)] text-xs font-medium"
    >
      Drops here · {stageName}
    </div>
  );
}

export const stageColorStyle = (color: string | null): CSSProperties =>
  ({ "--stage-color": chartVar(color) }) as CSSProperties;
