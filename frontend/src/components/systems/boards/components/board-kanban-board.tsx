"use client";

import { Fragment, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Plus } from "lucide-react";
import type { WorkspaceRegion } from "@/lib/date-time";
import { cn } from "@/lib/utils";
import type {
  KanbanCard,
  KanbanLabel,
  KanbanStage,
} from "../adapters/board-kanban-schemas";
import { KANBAN_PAGE, cardName, stagePage } from "../domain/kanban";
import {
  DropSlot,
  KanbanCardNote,
  KanbanCardOverlay,
  stageColorStyle,
  type KanbanPerson,
} from "./board-kanban-card";
import { StageHeader } from "./board-kanban-stage";
import type { StageChanges } from "../adapters/board-kanban-api";

/** One stage's cards in one lane (the whole stage when not grouped). */
export type KanbanCell = {
  stageId: string;
  laneId: string;
  cards: KanbanCard[];
};
export type KanbanLane = { id: string; name: string };
/** Where a lifted card would land: a cell and a place among its other cards. */
export type KanbanTarget = { stageId: string; laneId: string; slot: number };

export const UNGROUPED = "all";
/** Drag is off on phones and for readers (BR71). */
const NO_SENSORS: ReturnType<typeof useSensors> = [];
const cellKey = (stageId: string, laneId: string) => `${stageId}:${laneId}`;

const pickCollision: CollisionDetection = (args) => {
  const type = args.active.data.current?.type === "stage" ? "column" : "cell";
  const droppableContainers = args.droppableContainers.filter(
    (container) => container.data.current?.type === type,
  );
  const within = pointerWithin({ ...args, droppableContainers });
  return within.length > 0
    ? within
    : rectIntersection({ ...args, droppableContainers });
};

export type KanbanBoardProps = {
  /** The stages drawn: all of them, or the one a phone shows. */
  stages: readonly KanbanStage[];
  /** Every stage, for a card's Move to stage. */
  allStages: readonly KanbanStage[];
  /** Every active card per stage, unfiltered (the counts). */
  counts: ReadonlyMap<string, number>;
  lanes: readonly KanbanLane[] | null;
  cells: ReadonlyMap<string, KanbanCell>;
  labels: readonly KanbanLabel[];
  labelMap: ReadonlyMap<string, KanbanLabel>;
  people: ReadonlyMap<string, KanbanPerson>;
  region: WorkspaceRegion;
  today: string;
  manage: boolean;
  canWrite: boolean;
  phone: boolean;
  filtered: boolean;
  pending: ReadonlySet<string>;
  /** The keyboard-lifted card and where it would land. */
  lifted: { cardId: string; target: KanbanTarget } | null;
  describedBy: string;
  composing: string | null;
  composer: (stage: KanbanStage) => ReactNode;
  addStage: ReactNode;
  onCompose: (stageId: string | null) => void;
  onOpen: (card: KanbanCard) => void;
  onKey: (card: KanbanCard, event: KeyboardEvent<HTMLElement>) => void;
  onLiftLost: (card: KanbanCard) => void;
  onMoveTo: (card: KanbanCard, stageId: string) => void;
  onToggleLabel: (card: KanbanCard, labelId: string) => void;
  onArchive: (card: KanbanCard) => void;
  onDrop: (card: KanbanCard, target: KanbanTarget) => void;
  onDragging: (dragging: boolean) => void;
  onStageChange: (stage: KanbanStage, changes: StageChanges) => Promise<void>;
  onStageMove: (stage: KanbanStage, offset: -1 | 1) => void;
  onStageOrder: (stageIds: string[]) => void;
  onStageArchive: (stage: KanbanStage) => void;
};

/**
 * The board surface (BR66, BR67): stages drawn on the canvas skin, side by
 * side; each stage scrolls on its own, and the board scrolls sideways only
 * when the stages do not fit. Grouped, each lane is a row with a sticky
 * name across the stages. Writers drag cards; managers drag stages.
 */
export function KanbanBoard(props: KanbanBoardProps) {
  const { stages, lanes, phone } = props;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  const [active, setActive] = useState<
    | { type: "card"; card: KanbanCard }
    | { type: "stage"; stageId: string }
    | null
  >(null);
  const [over, setOver] = useState<KanbanTarget | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<string, number>>({});

  const cardOf = (cardId: string) => {
    for (const cell of props.cells.values()) {
      const found = cell.cards.find((card) => card.id === cardId);
      if (found) return found;
    }
    return null;
  };

  function slotAt(dropId: string, movingId: string, pointerY: number): number {
    const nodes = document.querySelectorAll<HTMLElement>(
      `[data-kanban-drop="${CSS.escape(dropId)}"] [data-kanban-card]`,
    );
    let slot = 0;
    for (const node of nodes) {
      if (node.dataset.kanbanCard === movingId) continue;
      const box = node.getBoundingClientRect();
      if (box.top + box.height / 2 < pointerY) slot += 1;
    }
    return slot;
  }

  function onDragStart(event: DragStartEvent) {
    const data = event.active.data.current;
    if (data?.type === "card") {
      const card = cardOf(String(data.cardId));
      if (card) setActive({ type: "card", card });
    } else if (data?.type === "stage")
      setActive({ type: "stage", stageId: String(data.stageId) });
    props.onDragging(true);
  }

  function onDragMove(event: DragMoveEvent) {
    const data = event.over?.data.current;
    if (!active || !data) {
      setOver(null);
      setOverColumn(null);
      return;
    }
    if (active.type === "stage") {
      setOverColumn(String(data.stageId));
      return;
    }
    const start = event.activatorEvent as PointerEvent;
    const pointerY = start.clientY + event.delta.y;
    const next: KanbanTarget = {
      stageId: String(data.stageId),
      laneId: String(data.laneId),
      slot: slotAt(String(event.over?.id), active.card.id, pointerY),
    };
    setOver((current) =>
      current &&
      current.stageId === next.stageId &&
      current.laneId === next.laneId &&
      current.slot === next.slot
        ? current
        : next,
    );
  }

  function finish() {
    setActive(null);
    setOver(null);
    setOverColumn(null);
    props.onDragging(false);
  }

  function onDragEnd(event: DragEndEvent) {
    if (active?.type === "card" && over && event.over)
      props.onDrop(active.card, over);
    if (
      active?.type === "stage" &&
      overColumn &&
      overColumn !== active.stageId
    ) {
      const ids = stages.map((stage) => stage.id);
      const from = ids.indexOf(active.stageId);
      const to = ids.indexOf(overColumn);
      ids.splice(from, 1);
      ids.splice(to, 0, active.stageId);
      props.onStageOrder(ids);
    }
    finish();
  }

  // What a screen reader hears during a pointer drag: names, never ids.
  const nameOf = (data: Record<string, unknown> | undefined) => {
    if (typeof data?.cardId === "string") {
      const card = cardOf(data.cardId);
      return card ? cardName(card) : "the card";
    }
    if (typeof data?.stageId === "string")
      return (
        props.allStages.find((stage) => stage.id === data.stageId)?.name ??
        "the stage"
      );
    return "the item";
  };
  const stageOf = (data: Record<string, unknown> | undefined) =>
    typeof data?.stageId === "string"
      ? (props.allStages.find((stage) => stage.id === data.stageId)?.name ??
        null)
      : null;
  const announcements: Announcements = {
    onDragStart: ({ active: item }) =>
      `Picked up ${nameOf(item.data.current)}.`,
    onDragOver: ({ active: item, over: place }) => {
      const stage = stageOf(place?.data.current);
      return stage
        ? `${nameOf(item.data.current)} is over ${stage}.`
        : `${nameOf(item.data.current)} is not over a stage.`;
    },
    onDragEnd: ({ active: item, over: place }) => {
      const stage = stageOf(place?.data.current);
      return stage
        ? `${nameOf(item.data.current)} was dropped in ${stage}.`
        : `${nameOf(item.data.current)} was put back.`;
    },
    onDragCancel: ({ active: item }) =>
      `Moving ${nameOf(item.data.current)} was cancelled.`,
  };

  const target =
    active?.type === "card" ? over : (props.lifted?.target ?? null);
  // A card drops only in its own lane: its lane is its assignee or label,
  // which a move never changes.
  let activeLane: string | null = null;
  if (active?.type === "card")
    for (const cell of props.cells.values())
      if (cell.cards.some((card) => card.id === active.card.id))
        activeLane = cell.laneId;
  const movingId =
    active?.type === "card" ? active.card.id : (props.lifted?.cardId ?? null);

  /**
   * One stage's cards in one lane. `tail` (the page line and Add a card)
   * follows the last card; in a scrolling stage it sticks to the foot.
   */
  function renderCell(
    stage: KanbanStage,
    laneId: string,
    scroll: boolean,
    tail?: (more: ReactNode) => ReactNode,
  ) {
    const cell = props.cells.get(cellKey(stage.id, laneId));
    const cards = cell?.cards ?? [];
    const key = cellKey(stage.id, laneId);
    const page = stagePage(cards.length, shown[key] ?? KANBAN_PAGE);
    const visible = cards.slice(0, page.shown);
    const here =
      target && target.stageId === stage.id && target.laneId === laneId;
    const items: ReactNode[] = [];
    let place = 0;
    let slotted = false;
    for (const card of visible) {
      const moving = card.id === movingId;
      if (here && !slotted && !moving && place === target.slot) {
        items.push(<DropSlot key="slot" stageName={stage.name} />);
        slotted = true;
      }
      items.push(
        <KanbanCardNote
          key={card.id}
          card={card}
          labels={props.labels}
          labelMap={props.labelMap}
          person={
            card.assigneeId ? (props.people.get(card.assigneeId) ?? null) : null
          }
          region={props.region}
          today={props.today}
          stages={props.allStages}
          canWrite={props.canWrite}
          canDrag={props.canWrite && !phone}
          pending={props.pending.has(card.id)}
          drag={
            card.id === props.lifted?.cardId
              ? "lifted"
              : active?.type === "card" && active.card.id === card.id
                ? "source"
                : "idle"
          }
          describedBy={props.describedBy}
          onOpen={props.onOpen}
          onKey={props.onKey}
          onLiftLost={props.onLiftLost}
          onMoveTo={props.onMoveTo}
          onToggleLabel={props.onToggleLabel}
          onArchive={props.onArchive}
        />,
      );
      if (!moving) place += 1;
    }
    if (here && !slotted)
      items.push(<DropSlot key="slot" stageName={stage.name} />);
    // The page line sits with Add a card, after the last card (BR67).
    const more = page.line ? (
      <div className="text-muted-foreground flex shrink-0 items-center justify-between px-1.5 text-xs tabular-nums">
        <span>{page.line}</span>
        <button
          type="button"
          className="text-action-text min-h-11 font-medium xl:min-h-6"
          onClick={() =>
            setShown((current) => ({ ...current, [key]: page.next }))
          }
        >
          {page.more}
        </button>
      </div>
    ) : null;
    const end = tail ? tail(more) : null;
    return (
      <Fragment key={key}>
        <DropCell
          id={`drop:${key}`}
          stageId={stage.id}
          laneId={laneId}
          scroll={scroll}
          targeted={Boolean(here)}
          disabled={
            !props.canWrite || (activeLane !== null && activeLane !== laneId)
          }
        >
          {items.length > 0 ? (
            items
          ) : (
            <div className="text-muted-foreground grid min-h-16 place-content-center rounded-md border-[1.5px] border-dashed border-[var(--rule-strong)] p-2 text-center text-xs">
              {props.filtered ? "No matching cards" : "No cards"}
            </div>
          )}
          {end ? (
            <div
              className={cn(
                "flex min-w-0 shrink-0 flex-col gap-1",
                scroll &&
                  "sticky bottom-0 z-[1] -mx-1 -mb-1 bg-[var(--canvas-background)] px-1 pb-1.5",
              )}
            >
              {end}
            </div>
          ) : null}
        </DropCell>
        {tail ? null : more}
      </Fragment>
    );
  }

  function header(stage: KanbanStage, index: number) {
    return (
      <StageHeader
        stage={stage}
        count={props.counts.get(stage.id) ?? 0}
        manage={props.manage}
        canDrag={!phone}
        index={index}
        total={stages.length}
        onChange={(changes) => props.onStageChange(stage, changes)}
        onMove={(offset) => props.onStageMove(stage, offset)}
        onArchive={() => props.onStageArchive(stage)}
      />
    );
  }

  function footer(stage: KanbanStage) {
    if (!props.canWrite) return null;
    return props.composing === stage.id ? (
      props.composer(stage)
    ) : (
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground flex h-11 w-full items-center gap-1.5 rounded-md px-2 text-sm hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)] focus-visible:outline-2 focus-visible:outline-[var(--focus)] xl:h-8"
        onClick={() => props.onCompose(stage.id)}
      >
        <Plus aria-hidden="true" className="size-4" />
        Add a card
      </button>
    );
  }

  // Stages stop at 17rem, so a few stages stay readable notes, not wide bands.
  const columns = `repeat(${stages.length}, minmax(12rem, 17rem))${props.manage && !phone ? " 8rem" : ""}`;
  const grouped = lanes !== null && !phone;
  const body = grouped ? (
    <div
      className="grid min-w-min gap-x-2.5 px-3 pb-3"
      style={{ gridTemplateColumns: columns }}
    >
      {stages.map((stage, index) => (
        <Column
          key={stage.id}
          stage={stage}
          sticky
          highlighted={overColumn === stage.id}
        >
          {header(stage, index)}
        </Column>
      ))}
      {props.manage ? (
        <div className="sticky top-0 z-10 bg-[var(--canvas-background)] pt-3">
          {props.addStage}
        </div>
      ) : null}
      {lanes.map((lane) => (
        <Fragment key={lane.id}>
          <div className="col-span-full pt-3 pb-1.5">
            <span className="text-foreground sticky left-3 text-sm font-semibold">
              {lane.name}
            </span>
          </div>
          {stages.map((stage) => (
            <div key={stage.id} style={stageColorStyle(stage.color)}>
              {renderCell(stage, lane.id, false)}
            </div>
          ))}
          {props.manage ? <div /> : null}
        </Fragment>
      ))}
      {stages.map((stage) => (
        <div key={stage.id} className="pt-2">
          {footer(stage)}
        </div>
      ))}
    </div>
  ) : (
    <div
      className={cn(
        "grid gap-2.5 p-3",
        phone ? "grid-cols-1" : "h-full min-w-min grid-rows-[minmax(0,1fr)]",
      )}
      style={phone ? undefined : { gridTemplateColumns: columns }}
    >
      {stages.map((stage, index) => (
        <Column
          key={stage.id}
          stage={stage}
          highlighted={overColumn === stage.id}
        >
          {header(stage, index)}
          {renderCell(stage, UNGROUPED, !phone, (more) =>
            more || props.canWrite ? (
              <>
                {more}
                {footer(stage)}
              </>
            ) : null,
          )}
        </Column>
      ))}
      {props.manage && !phone ? props.addStage : null}
    </div>
  );

  return (
    <DndContext
      sensors={
        phone || (!props.canWrite && !props.manage) ? NO_SENSORS : sensors
      }
      collisionDetection={pickCollision}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={finish}
      accessibility={{ restoreFocus: false, announcements }}
    >
      <div
        data-skin="board-surface"
        className={cn(
          "relative min-w-0 overflow-hidden rounded-lg border",
          phone ? "" : "h-[40rem] xl:h-auto xl:min-h-0 xl:flex-1",
        )}
      >
        <section
          aria-label="Kanban board"
          className={cn(
            "relative h-full",
            !phone && "overflow-auto overscroll-contain",
          )}
        >
          {body}
        </section>
      </div>
      <DragOverlay dropAnimation={null}>
        {active?.type === "card" ? (
          <KanbanCardOverlay
            card={active.card}
            labels={props.labelMap}
            person={
              active.card.assigneeId
                ? (props.people.get(active.card.assigneeId) ?? null)
                : null
            }
            region={props.region}
            today={props.today}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function Column({
  stage,
  sticky = false,
  highlighted,
  children,
}: {
  stage: KanbanStage;
  sticky?: boolean;
  highlighted: boolean;
  children: ReactNode;
}) {
  const { setNodeRef } = useDroppable({
    id: `column:${stage.id}`,
    data: { type: "column", stageId: stage.id },
  });
  return (
    <section
      ref={setNodeRef}
      aria-label={sticky ? undefined : stage.name}
      style={stageColorStyle(stage.color)}
      className={cn(
        "flex min-h-0 min-w-0 flex-col rounded-md",
        sticky && "sticky top-0 z-10 bg-[var(--canvas-background)] pt-3",
        highlighted && "ring-2 ring-[var(--action)]",
      )}
    >
      {children}
    </section>
  );
}

function DropCell({
  id,
  stageId,
  laneId,
  scroll,
  targeted,
  disabled,
  children,
}: {
  id: string;
  stageId: string;
  laneId: string;
  scroll: boolean;
  targeted: boolean;
  disabled: boolean;
  children: ReactNode;
}) {
  const { setNodeRef } = useDroppable({
    id,
    data: { type: "cell", stageId, laneId },
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      data-kanban-drop={id}
      className={cn(
        "relative flex min-w-0 flex-col gap-2 rounded-md px-1 pt-2 pb-1",
        scroll && "min-h-0 flex-1 overflow-y-auto overscroll-contain",
        targeted &&
          "bg-[color-mix(in_oklab,var(--action-tint)_65%,transparent)] shadow-[inset_0_0_0_2px_var(--action)]",
      )}
    >
      {children}
    </div>
  );
}
