"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { RefreshCw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import type { WorkspaceRegion } from "@/lib/date-time";
import type { WeekStart } from "../domain/calendar-dates";
import type { KanbanCard, KanbanStage } from "../adapters/board-kanban-schemas";
import {
  cardName,
  dropPosition,
  hasCardFilters,
  kanbanFilterParams,
  parseKanbanFilters,
  stageCount,
  type KanbanFilters,
} from "../domain/kanban";
import {
  IDLE_MOVE,
  keyboardStep,
  type KeyboardAction,
  type KeyboardLayout,
  type KeyboardMove,
} from "../domain/kanban-keyboard";
import { useCalendarPhone } from "../hooks/use-calendar-media";
import { useKanbanCommands } from "../hooks/use-kanban-commands";
import { useAssigneeChoices } from "../hooks/use-card-sheet";
import {
  kanbanCellKey,
  useKanbanBoardData,
} from "../hooks/use-kanban-board-data";
import {
  KanbanBoard,
  UNGROUPED,
  type KanbanTarget,
} from "./board-kanban-board";
import { KanbanCardSheet } from "./board-card-sheet";
import { KanbanComposer } from "./board-kanban-composer";
import {
  AddStage,
  ArchiveStageDialog,
  KanbanSetup,
} from "./board-kanban-stage";
import {
  KanbanLabelsDialog,
  KanbanToolbar,
  StageSwitcher,
} from "./board-kanban-toolbar";

/** The Kanban's URL words (BR68, preserved behavior `card=<id>`). */
export type BoardKanbanParams = Partial<
  Record<"search" | "assignee" | "due" | "group" | "card", string | null>
> & { label?: string[] };

const KEYS: Record<string, KeyboardAction["type"]> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Escape: "cancel",
};

/**
 * A board's Kanban tab (BR60–BR71): stages that managers own, cards that
 * writers add and move, read-only for readers. A move saves at once with
 * Undo; another viewer's change refreshes the board through the shared
 * stream (P0 handoffs).
 */
export function ServerBackedBoardKanban({
  board,
  search,
  region,
  today,
  weekStart,
  onParams,
}: {
  board: {
    id: string;
    level: "read" | "write" | "manage";
    status: "active" | "archived";
  };
  /** The page's query string: the filters and `card=` live there. */
  search: string;
  region: WorkspaceRegion;
  today: string;
  weekStart: WeekStart;
  onParams: (changes: BoardKanbanParams) => void;
}) {
  const boardId = board.id;
  const active = board.status === "active";
  const manage = active && board.level === "manage";
  const canWrite = active && board.level !== "read";
  const phone = useCalendarPhone();
  const commands = useKanbanCommands(boardId);
  const filters = parseKanbanFilters(search);
  const selectedCardId = new URLSearchParams(search).get("card");
  const {
    stagesRead,
    labelsRead,
    cardsRead,
    stages,
    labels,
    allCards,
    labelMap,
    byStage,
    counts,
    people,
    peopleList,
    lanes,
    laneOf,
    cells,
    hold,
    holdRef,
  } = useKanbanBoardData({ boardId, filters, today, weekStart, phone });

  // ---- Phones: one stage at a time ----
  const [phoneStage, setPhoneStage] = useState<string | null>(null);
  const currentStage =
    stages.find((stage) => stage.id === phoneStage)?.id ??
    stages[0]?.id ??
    null;
  const shownStages = phone
    ? stages.filter((stage) => stage.id === currentStage)
    : stages;
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onSwipeStart = (event: PointerEvent<HTMLDivElement>) => {
    swipe.current =
      event.pointerType === "touch"
        ? { x: event.clientX, y: event.clientY }
        : null;
  };
  const onSwipeEnd = (event: PointerEvent<HTMLDivElement>) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start || !phone) return;
    const dx = event.clientX - start.x;
    if (Math.abs(dx) < 60 || Math.abs(event.clientY - start.y) > 40) return;
    const index = stages.findIndex((stage) => stage.id === currentStage);
    const next = stages[index + (dx < 0 ? 1 : -1)];
    if (next) setPhoneStage(next.id);
  };

  // ---- Moves ----
  const [keyboard, setKeyboardState] = useState<KeyboardMove>(IDLE_MOVE);
  // The move as the last key left it, for a blur that comes before the
  // next render (a drop moves focus).
  const keyboardNow = useRef<KeyboardMove>(IDLE_MOVE);
  const setKeyboard = (state: KeyboardMove) => {
    keyboardNow.current = state;
    setKeyboardState(state);
  };
  const [liftLane, setLiftLane] = useState(UNGROUPED);
  const [announcement, setAnnouncement] = useState("");
  const [focusCard, setFocusCard] = useState<string | null>(null);
  useEffect(() => {
    if (!focusCard) return;
    const node = document.querySelector<HTMLElement>(
      `[data-kanban-focus="${CSS.escape(focusCard)}"]`,
    );
    if (node) {
      node.focus();
      setFocusCard(null);
    }
  });

  function layoutFor(laneId: string): KeyboardLayout {
    return shownStages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      cards: (cells.get(kanbanCellKey(stage.id, laneId))?.cards ?? []).map(
        (card) => ({
          id: card.id,
          name: cardName(card),
        }),
      ),
    }));
  }

  function dropCard(card: KanbanCard, target: KanbanTarget) {
    const stage = stages.find((item) => item.id === target.stageId);
    if (!stage) return;
    const full = (byStage.get(stage.id) ?? []).map((item) => item.id);
    const visible = (
      cells.get(kanbanCellKey(target.stageId, target.laneId))?.cards ?? []
    ).map((item) => item.id);
    const manual = stage.cardSort === "manual";
    const position = dropPosition({
      full,
      visible,
      movingId: card.id,
      slot: target.slot,
      manual,
    });
    if (stage.id === card.stageId) {
      const others = full.filter((id) => id !== card.id);
      const now = full.indexOf(card.id);
      if (!manual || (position ?? others.length) === now) return;
    }
    setFocusCard(card.id);
    void commands.move(card, stage, position);
  }

  function onKey(card: KanbanCard, event: KeyboardEvent<HTMLElement>) {
    const lifted = keyboard.kind === "lifted" && keyboard.cardId === card.id;
    let action: KeyboardAction | null = null;
    if (event.key === " ")
      action = lifted ? { type: "drop" } : { type: "lift", cardId: card.id };
    else if (lifted && KEYS[event.key])
      action = { type: KEYS[event.key] } as KeyboardAction;
    if (!action || (keyboard.kind === "lifted" && !lifted)) return;
    if (commands.pending.has(card.id)) return;
    event.preventDefault();
    event.stopPropagation();
    const lane =
      action.type === "lift" ? (laneOf.get(card.id) ?? UNGROUPED) : liftLane;
    const step = keyboardStep(keyboard, action, layoutFor(lane));
    if (action.type === "lift") setLiftLane(lane);
    setKeyboard(step.state);
    hold(step.state.kind === "lifted");
    if (step.announcement) setAnnouncement(step.announcement);
    if (step.drop)
      dropCard(card, {
        stageId: step.drop.stageId,
        laneId: lane,
        slot: step.drop.slot,
      });
  }
  /** Focus left the lifted card: put it back, as Escape does (WCAG 2.1.1). */
  function onLiftLost(card: KanbanCard) {
    const now = keyboardNow.current;
    if (now.kind !== "lifted" || now.cardId !== card.id) return;
    const step = keyboardStep(now, { type: "cancel" }, layoutFor(liftLane));
    setKeyboard(step.state);
    hold(false);
    if (step.announcement) setAnnouncement(step.announcement);
  }
  // A lifted card that leaves the board (a live refresh) is put back.
  const liftedCard =
    keyboard.kind === "lifted"
      ? allCards.find((card) => card.id === keyboard.cardId)
      : null;
  const liftLost = keyboard.kind === "lifted" && !liftedCard;
  useEffect(() => {
    if (!liftLost) return;
    keyboardNow.current = IDLE_MOVE;
    setKeyboardState(IDLE_MOVE);
    holdRef.current = false;
  }, [liftLost]);
  const lifted =
    keyboard.kind === "lifted" && shownStages[keyboard.at.stage]
      ? {
          cardId: keyboard.cardId,
          target: {
            stageId: shownStages[keyboard.at.stage].id,
            laneId: liftLane,
            slot: keyboard.at.slot,
          },
        }
      : null;

  // ---- Stages, composer, labels, card summary ----
  const [composing, setComposing] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<KanbanStage | null>(null);
  const [editingLabels, setEditingLabels] = useState(false);
  const describedBy = useId();
  const setFilters = (changes: Partial<KanbanFilters>) => {
    const next = kanbanFilterParams({ ...filters, ...changes });
    onParams({ ...next, label: next.label });
  };
  // A locked card never opens (BR63); any other opens its sheet (BR64).
  const openCard = (card: KanbanCard) => {
    if (!card.record?.locked) onParams({ card: card.id });
  };
  const choices = useAssigneeChoices({
    boardId,
    enabled: canWrite,
    assigned: peopleList,
  });
  const moveStage = (stage: KanbanStage, offset: -1 | 1) => {
    const ids = stages.map((item) => item.id);
    const from = ids.indexOf(stage.id);
    const to = from + offset;
    if (to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    void commands.orderStages(ids);
  };
  const addStage = (
    <AddStage className="w-full" onAdd={(name) => commands.addStage(name)} />
  );

  const pending = stagesRead.isPending || cardsRead.isPending;
  const failed = stagesRead.isError || cardsRead.isError || labelsRead.isError;
  const selectedCard = selectedCardId
    ? (allCards.find((card) => card.id === selectedCardId) ?? null)
    : null;
  const switcher = stages.map((stage) => {
    const count = stageCount(counts.get(stage.id) ?? 0, stage.wipLimit);
    return {
      id: stage.id,
      name: stage.name,
      color: stage.color,
      count: count.text,
      over: count.over,
      label: count.label,
    };
  });

  return (
    <div className="slim-ui flex min-w-0 flex-col gap-2.5 xl:min-h-0 xl:flex-1">
      {/* Filters need stages to filter; the setup state stands alone. */}
      {stages.length > 0 ? (
        <KanbanToolbar
          filters={filters}
          onFilters={setFilters}
          people={peopleList}
          labels={labels}
          manage={manage}
          phone={phone}
          onEditLabels={() => setEditingLabels(true)}
        />
      ) : null}
      <p id={describedBy} className="sr-only">
        Press Space to lift the card, then the arrow keys to move it.
      </p>
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {failed && !pending ? (
        <Alert variant="destructive">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {stagesRead.data && cardsRead.data
                ? "The board could not be refreshed. It shows the last loaded cards."
                : "The Kanban could not be loaded."}
            </span>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 xl:min-h-8"
              onClick={() => void commands.refresh()}
            >
              <RefreshCw data-icon="inline-start" /> Retry
            </Button>
          </div>
        </Alert>
      ) : null}
      {phone && stages.length > 0 ? (
        <StageSwitcher
          stages={switcher}
          current={currentStage}
          onSelect={setPhoneStage}
          addStage={
            manage ? (
              <AddStage
                className="flex-none"
                onAdd={(name) => commands.addStage(name)}
              />
            ) : null
          }
        />
      ) : null}
      <LoadingRegion
        loading={pending}
        label="Loading the Kanban"
        skeleton={<KanbanSkeleton />}
        // The region wraps its content in one element: it fills the height too.
        className="flex min-w-0 flex-col *:flex *:min-w-0 *:flex-col xl:min-h-0 xl:flex-1 xl:*:min-h-0 xl:*:flex-1"
      >
        {stagesRead.data && cardsRead.data ? (
          <div
            // Vertical scroll stays native; a sideways swipe changes the stage.
            className="flex min-w-0 touch-pan-y flex-col xl:min-h-0 xl:flex-1"
            onPointerDown={onSwipeStart}
            onPointerUp={onSwipeEnd}
          >
            {stages.length === 0 ? (
              <div
                data-skin="board-surface"
                className="relative min-w-0 overflow-hidden rounded-lg border xl:min-h-0 xl:flex-1"
              >
                <section aria-label="Kanban board" className="relative h-full">
                  <KanbanSetup
                    manage={manage}
                    onStart={commands.addStarterStages}
                    addStage={
                      <AddStage onAdd={(name) => commands.addStage(name)} />
                    }
                  />
                </section>
              </div>
            ) : (
              <KanbanBoard
                stages={shownStages}
                allStages={stages}
                counts={counts}
                lanes={lanes}
                cells={cells}
                labels={labels}
                labelMap={labelMap}
                people={people}
                region={region}
                today={today}
                manage={manage}
                canWrite={canWrite}
                phone={phone}
                filtered={hasCardFilters(filters)}
                pending={commands.pending}
                lifted={lifted}
                describedBy={describedBy}
                composing={composing}
                composer={(stage) => (
                  <KanbanComposer
                    stageName={stage.name}
                    region={region}
                    onClose={() => setComposing(null)}
                    onAddObjective={async (title) => {
                      await commands.addObjective(stage.id, title);
                    }}
                    onAddRecord={async (input) => {
                      await commands.addRecordCard({
                        stageId: stage.id,
                        ...input,
                      });
                    }}
                  />
                )}
                addStage={addStage}
                onCompose={setComposing}
                onOpen={openCard}
                onKey={onKey}
                onLiftLost={onLiftLost}
                onMoveTo={(card, stageId) => {
                  const stage = stages.find((item) => item.id === stageId);
                  if (stage) void commands.move(card, stage, null);
                }}
                onToggleLabel={(card, labelId) =>
                  void commands.setLabels(
                    card,
                    card.labelIds.includes(labelId)
                      ? card.labelIds.filter((id) => id !== labelId)
                      : [...card.labelIds, labelId],
                  )
                }
                onArchive={(card) =>
                  void commands.archive(card, cardName(card))
                }
                onDrop={dropCard}
                onDragging={hold}
                onStageChange={commands.changeStage}
                onStageMove={moveStage}
                onStageOrder={(ids) => void commands.orderStages(ids)}
                onStageArchive={setArchiving}
              />
            )}
          </div>
        ) : null}
      </LoadingRegion>
      <ArchiveStageDialog
        key={archiving?.id ?? "none"}
        stage={archiving}
        count={archiving ? (counts.get(archiving.id) ?? 0) : 0}
        others={stages.filter((stage) => stage.id !== archiving?.id)}
        onCancel={() => setArchiving(null)}
        onConfirm={async (cards, target) => {
          if (!archiving) return;
          await commands.archiveStage(archiving, cards, target);
          setArchiving(null);
        }}
      />
      <KanbanLabelsDialog
        open={editingLabels}
        labels={labels}
        onClose={() => setEditingLabels(false)}
        onAdd={commands.addLabel}
        onChange={commands.changeLabel}
        onRemove={commands.removeLabel}
      />
      <KanbanCardSheet
        boardId={boardId}
        cardId={selectedCardId}
        listed={selectedCard}
        canWrite={canWrite}
        stages={stages}
        labels={labels}
        labelMap={labelMap}
        people={people}
        choices={choices}
        region={region}
        today={today}
        onMove={(card, stage) =>
          commands.move(card, stage, null, { quiet: true })
        }
        onArchive={(card) => void commands.archive(card, cardName(card))}
        onClose={() => onParams({ card: null })}
      />
    </div>
  );
}

function KanbanSkeleton() {
  return (
    <div className="grid h-[40rem] grid-cols-1 gap-2.5 rounded-lg border p-3 md:grid-cols-3 xl:h-full xl:grid-cols-4">
      {[0, 1, 2, 3].map((index) => (
        <div
          key={index}
          className="flex flex-col gap-2 max-md:[&:not(:first-child)]:hidden"
        >
          <Skeleton className="h-8" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ))}
    </div>
  );
}
