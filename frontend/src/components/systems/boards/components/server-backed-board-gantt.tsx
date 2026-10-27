"use client";

import { useEffect, useId, useState } from "react";
import type { Route } from "next";
import { RefreshCw } from "lucide-react";
import { useDisplayWeekStart } from "@/components/use-display-region";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import type { WorkspaceRegion } from "@/lib/date-time";
import { cn } from "@/lib/utils";
import type { KanbanCard } from "../adapters/board-kanban-schemas";
import type { WeekStart } from "../domain/calendar-dates";
import {
  MAX_STAGED,
  cardSpan,
  edgeWords,
  ganttAnnouncement,
  ganttDays,
  ganttGroups,
  ganttLines,
  ganttMonths,
  ganttTitle,
  ganttWeeks,
  ganttWindow,
  parseGanttGroup,
  parseGanttZoom,
  shiftGanttAnchor,
  todayOffset,
  unsavedWords,
  withStaged,
  type CardDates,
  type GanttGroup,
  type GanttZoom,
} from "../domain/gantt";
import { NO_FILTERS, cardName } from "../domain/kanban";
import { useCalendarPhone } from "../hooks/use-calendar-media";
import { useGanttStaging } from "../hooks/use-gantt-staging";
import { useKanbanBoardData } from "../hooks/use-kanban-board-data";
import { useKanbanCommands } from "../hooks/use-kanban-commands";
import { KanbanCardSheet } from "./board-card-sheet";
import { GANTT_KEYS_HINT, GanttChart } from "./board-gantt-chart";
import { GanttToolbar } from "./board-gantt-toolbar";
import { chartVar } from "./board-kanban-card";
import { AddStage, KanbanSetup } from "./board-kanban-stage";

/** The Gantt's URL words: zoom, group, and the open card. */
export type BoardGanttParams = Partial<
  Record<"zoom" | "group" | "card", string | null>
>;

/**
 * A board's Gantt tab (BR72–BR76): the board's cards by their dates, grouped
 * by stage, assignee or label. Writers move a bar or its end, by pointer or
 * keyboard; each change is staged until Save changes sends them in one
 * batch. It reads the Kanban's complete card list, so another viewer's
 * change refreshes it while staged changes stay (G8).
 */
export function ServerBackedBoardGantt({
  board,
  search,
  region,
  today,
  weekStart: workspaceWeekStart,
  kanbanHref,
  onParams,
  onDraftStateChange,
}: {
  board: {
    id: string;
    level: "read" | "write" | "manage";
    status: "active" | "archived";
  };
  search: string;
  region: WorkspaceRegion;
  today: string;
  weekStart: WeekStart;
  kanbanHref: Route;
  onParams: (changes: BoardGanttParams) => void;
  onDraftStateChange: (dirty: boolean, pending: boolean) => void;
}) {
  const boardId = board.id;
  const active = board.status === "active";
  const manage = active && board.level === "manage";
  const canWrite = active && board.level !== "read";
  const phone = useCalendarPhone();
  const weekStart = useDisplayWeekStart(workspaceWeekStart);
  const params = new URLSearchParams(search);
  const zoom = parseGanttZoom(params.get("zoom"), phone);
  // Phones group by stage, as the comp draws them (BR76).
  const group: GanttGroup = phone
    ? "stage"
    : parseGanttGroup(params.get("group"));
  const selectedCardId = params.get("card");
  const commands = useKanbanCommands(boardId);
  const {
    stagesRead,
    labelsRead,
    cardsRead,
    stages,
    labels,
    allCards,
    labelMap,
    people,
    hold,
  } = useKanbanBoardData({
    boardId,
    filters: NO_FILTERS,
    today,
    weekStart,
    phone,
  });
  const staging = useGanttStaging(boardId, allCards);
  const dirty = staging.staged.size > 0;
  useEffect(() => {
    onDraftStateChange(dirty, staging.saving);
  }, [dirty, staging.saving, onDraftStateChange]);
  useEffect(() => () => onDraftStateChange(false, false), [onDraftStateChange]);

  const [anchor, setAnchor] = useState<string | null>(null);
  // Today scrolls today into view again, even in the period it is in.
  const [todayTick, setTodayTick] = useState(0);
  const currentAnchor = anchor ?? today;
  const [announcement, setAnnouncement] = useState("");
  const [datesFor, setDatesFor] = useState<string | null>(null);
  const describedBy = useId();

  const shown = withStaged(allCards, staging.staged);
  const { groups, unscheduled } = ganttGroups({
    cards: shown,
    stages,
    labels,
    group,
    personName: (id) => people.get(id)?.name ?? null,
  });
  const window = currentAnchor
    ? ganttWindow(zoom, currentAnchor, weekStart)
    : null;
  // The legend lists the labels that color a bar (BR74), in board order.
  const used = new Set(
    shown.flatMap((card) => {
      if (!cardSpan(card) || card.record?.locked) return [];
      const first = labels.find((label) => card.labelIds.includes(label.id));
      return first ? [first.id] : [];
    }),
  );
  const legendLabels = labels.filter((label) => used.has(label.id));

  const stage = (card: KanbanCard, to: CardDates) => {
    const saved = allCards.find((item) => item.id === card.id) ?? card;
    const next = staging.stage(saved, to);
    if (next)
      setAnnouncement(ganttAnnouncement(cardName(card), to, next.size, region));
  };
  const undo = () => {
    const restored = staging.undo();
    if (restored.size > 0)
      setAnnouncement(`Changes restored. ${unsavedWords(restored.size)}.`);
  };
  const openCard = (card: KanbanCard) => {
    if (card.record?.locked) return;
    setDatesFor(null);
    onParams({ card: card.id });
  };
  const addDates = (card: KanbanCard) => {
    setDatesFor(card.id);
    onParams({ card: card.id });
  };

  const pending = stagesRead.isPending || cardsRead.isPending;
  const failed = stagesRead.isError || cardsRead.isError || labelsRead.isError;
  const selectedCard = selectedCardId
    ? (allCards.find((card) => card.id === selectedCardId) ?? null)
    : null;
  const count = staging.staged.size;

  return (
    <div className="slim-ui flex min-w-0 flex-col gap-2.5 xl:min-h-0 xl:flex-1">
      {window && stages.length > 0 ? (
        <GanttToolbar
          title={ganttTitle(zoom, currentAnchor, weekStart, region, phone)}
          zoom={zoom}
          group={group}
          onPrevious={() =>
            setAnchor(shiftGanttAnchor(zoom, currentAnchor, -1))
          }
          onNext={() => setAnchor(shiftGanttAnchor(zoom, currentAnchor, 1))}
          onToday={() => {
            setAnchor(today);
            setTodayTick((tick) => tick + 1);
          }}
          onZoom={(next: GanttZoom) =>
            onParams({
              zoom: next === parseGanttZoom(null, phone) ? null : next,
            })
          }
          onGroup={(next) =>
            onParams({ group: next === "stage" ? null : next })
          }
        />
      ) : null}
      <p id={describedBy} className="sr-only">
        {GANTT_KEYS_HINT}
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
                : "The Gantt could not be loaded."}
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
      <LoadingRegion
        loading={pending || !window}
        label="Loading the Gantt"
        skeleton={<GanttSkeleton />}
        className="flex min-w-0 flex-col *:flex *:min-w-0 *:flex-col xl:min-h-0 xl:flex-1 xl:*:min-h-0 xl:*:flex-1"
      >
        {stagesRead.data && cardsRead.data && window ? (
          stages.length === 0 ? (
            <section
              aria-label="Gantt"
              className="bg-card min-w-0 rounded-lg border xl:min-h-0 xl:flex-1"
            >
              <KanbanSetup
                manage={manage}
                onStart={commands.addStarterStages}
                addStage={
                  <AddStage onAdd={(name) => commands.addStage(name)} />
                }
              />
            </section>
          ) : allCards.length === 0 ? (
            <section
              aria-label="Gantt"
              className="bg-card grid min-h-60 min-w-0 place-content-center gap-1 rounded-lg border p-6 text-center xl:min-h-0 xl:flex-1"
            >
              <p data-slot="empty-title" className="font-semibold">
                No cards yet
              </p>
              <p className="text-muted-foreground text-sm">
                Cards are added on the Kanban; they show here by their dates.
              </p>
              <Button
                asChild
                variant="outline"
                className="mt-2 min-h-11 justify-self-center xl:min-h-8"
              >
                <GuardedWorkspaceLink href={kanbanHref}>
                  Open the Kanban
                </GuardedWorkspaceLink>
              </Button>
            </section>
          ) : (
            <GanttChart
              window={window}
              zoom={zoom}
              axis={{
                weeks: ganttWeeks(window, zoom, region),
                months: ganttMonths(window, region, zoom),
                days: ganttDays(window, zoom),
                lines: ganttLines(window, zoom),
                today: todayOffset(window, today),
              }}
              todayTick={todayTick}
              groups={groups}
              unscheduled={unscheduled}
              labels={labels}
              staged={staging.staged}
              region={region}
              phone={phone}
              canWrite={canWrite}
              canMove={canWrite && !phone && !staging.saving}
              describedBy={describedBy}
              facts={`${allCards.length} ${allCards.length === 1 ? "card" : "cards"} · ${unscheduled.length} unscheduled`}
              legend={
                legendLabels.length > 0 ? (
                  <ul
                    aria-label="Labels in use"
                    className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-sm md:ml-auto"
                  >
                    {legendLabels.map((label) => (
                      <li
                        key={label.id}
                        className="inline-flex items-center gap-1.5 whitespace-nowrap"
                      >
                        <span
                          aria-hidden="true"
                          className="size-2.5 rounded-full"
                          style={{ background: chartVar(label.color) }}
                        />
                        {label.name}
                      </li>
                    ))}
                  </ul>
                ) : null
              }
              onStage={stage}
              onEdge={(card, side) =>
                setAnnouncement(edgeWords(cardName(card), side, zoom))
              }
              onOpen={openCard}
              onAddDates={addDates}
              onDragging={hold}
            />
          )
        ) : null}
      </LoadingRegion>
      {/* Results sit above the save bar; after a save or a Discard, one
          muted line takes the bar's place until the next change. */}
      <div
        className={cn(
          "flex shrink-0 flex-col gap-2",
          // Empty, it holds only the live region and takes no room.
          !(
            staging.full ||
            staging.problems.length > 0 ||
            staging.failure ||
            count > 0 ||
            staging.notice
          ) && "sr-only",
        )}
      >
        {staging.full ? (
          <Alert variant="warning">
            Save these changes first: one save holds {MAX_STAGED} cards.
          </Alert>
        ) : null}
        {staging.problems.length > 0 || staging.failure ? (
          <Alert role="alert" variant="destructive">
            <ul className="flex flex-col gap-0.5">
              {staging.problems.map((problem) => (
                <li key={problem.cardId}>{problem.text}</li>
              ))}
              {staging.failure ? <li>{staging.failure}</li> : null}
            </ul>
          </Alert>
        ) : null}
        {count > 0 ? (
          <div className="bg-popover flex flex-wrap items-center gap-2.5 rounded-lg border py-2 pr-2.5 pl-3.5 shadow-[var(--shadow-lg)]">
            <span className="mr-auto flex items-center gap-2 font-semibold">
              <span
                aria-hidden="true"
                className="size-2 rounded-full bg-[var(--warn)]"
              />
              {unsavedWords(count)}
            </span>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 xl:min-h-8"
              disabled={staging.saving}
              onClick={staging.discard}
            >
              Discard
            </Button>
            <Button
              type="button"
              className="min-h-11 xl:min-h-8"
              pending={staging.saving}
              pendingLabel="Saving…"
              onClick={() => void staging.save()}
            >
              Save changes
            </Button>
          </div>
        ) : null}
        <div
          className={cn(
            "text-muted-foreground flex min-h-11 items-center gap-1.5 px-1 text-sm xl:min-h-8",
            (count > 0 || !staging.notice) && "sr-only",
          )}
        >
          <p role="status">{staging.notice}</p>
          {staging.canUndo && staging.notice ? (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                className="inline-flex min-h-11 items-center rounded-sm px-1 font-medium text-[var(--action-text)] outline-none hover:underline focus-visible:outline-2 focus-visible:outline-[var(--focus)] xl:min-h-8"
                onClick={undo}
              >
                Undo
              </button>
            </>
          ) : null}
        </div>
      </div>
      <KanbanCardSheet
        boardId={boardId}
        cardId={selectedCardId}
        listed={selectedCard}
        canWrite={canWrite}
        stages={stages}
        labels={labels}
        labelMap={labelMap}
        people={people}
        region={region}
        today={today}
        focusDates={datesFor !== null && datesFor === selectedCardId}
        onMove={(card, target) =>
          commands.move(card, target, null, { quiet: true })
        }
        onArchive={(card) => void commands.archive(card, cardName(card))}
        onClose={() => {
          setDatesFor(null);
          onParams({ card: null });
        }}
      />
    </div>
  );
}

function GanttSkeleton() {
  return (
    <div className="flex h-[38rem] flex-col gap-2 rounded-lg border p-3 xl:h-full">
      <Skeleton className="h-10" />
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <Skeleton key={index} className="h-8" />
      ))}
    </div>
  );
}
