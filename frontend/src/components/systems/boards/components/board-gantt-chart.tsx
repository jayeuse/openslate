"use client";

import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { FileText } from "lucide-react";
import type { WorkspaceRegion } from "@/lib/date-time";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  ChartColor,
  KanbanCard,
  KanbanLabel,
} from "../adapters/board-kanban-schemas";
import {
  barColor,
  barLabel,
  barPlacement,
  cardProgress,
  cardSpan,
  clampShift,
  datesWords,
  dayWidth,
  moveDates,
  outOfView,
  resizeDue,
  type CardDates,
  type GanttGroupRows,
  type GanttWindow,
  type GanttZoom,
  type StagedDates,
} from "../domain/gantt";
import { cardName } from "../domain/kanban";
import { chartVar } from "./board-kanban-card";

/** The axis: a month row over a week row, and a day row at Week zoom. */
const AXIS = 52;
const MONTH_ROW = 28;
const DAY_ROW = 20;
/** A month's name needs this much room, or it keeps only its line. */
const MONTH_NAME_MIN = 36;

export type GanttAxis = {
  weeks: { offset: number; label: string }[];
  months: { offset: number; label: string | null }[];
  days: { offset: number; label: string }[];
  lines: { offset: number; kind: "day" | "week" | "month" }[];
  today: number | null;
};

/**
 * A bar's 1px edge carries its 3:1 against the card (WCAG 1.4.11; BR74).
 * `--chart-2` is under 3:1 on light cards, so only its edge takes some ink.
 */
const barEdge = (color: ChartColor | null) =>
  color === null
    ? "var(--ink-muted)"
    : color === "chart-2"
      ? "color-mix(in oklab, var(--chart-2) 80%, var(--ink))"
      : `var(--${color})`;

/** The edge, the staged warn ring and the drag lift share one shadow. */
const barShadow = (edge: string, staged: boolean, lifted: boolean) =>
  [
    `inset 0 0 0 1px ${edge}`,
    staged ? "0 0 0 2px var(--warn)" : null,
    lifted ? "var(--shadow-lg)" : null,
  ]
    .filter(Boolean)
    .join(", ");

type Drag = {
  cardId: string;
  mode: "move" | "resize";
  x: number;
  days: number;
  moved: boolean;
};

/**
 * The Gantt panel (BR72–BR76): a sticky date axis over sticky names and
 * bars. Each row has one control: on desktop the bar (writers drag it, or
 * its end, and move it by keyboard; everyone opens the card with it), or
 * the name when the bar is out of view; on phones the 44px row. A locked
 * card has none (BR63).
 */
/** How a writer moves a focused bar: its description and tooltip (C9). */
export const GANTT_KEYS_HINT =
  "Arrow keys move the bar a day. Shift with an arrow key changes the due date.";

export function GanttChart({
  window,
  zoom,
  axis,
  todayTick,
  groups,
  unscheduled,
  labels,
  staged,
  region,
  phone,
  canWrite,
  canMove,
  describedBy,
  facts,
  legend,
  onStage,
  onEdge,
  onOpen,
  onAddDates,
  onDragging,
}: {
  window: GanttWindow;
  zoom: GanttZoom;
  axis: GanttAxis;
  /** Counts presses of Today, which scrolls today into view again. */
  todayTick: number;
  groups: GanttGroupRows[];
  unscheduled: KanbanCard[];
  labels: readonly KanbanLabel[];
  staged: StagedDates;
  region: WorkspaceRegion;
  phone: boolean;
  canWrite: boolean;
  /** Drag and keys are on: a writer on a tablet or desktop, not mid-save. */
  canMove: boolean;
  describedBy: string;
  facts: string;
  legend: ReactNode;
  onStage: (card: KanbanCard, to: CardDates) => void;
  /** An arrow key met the window's edge; the bar stays (BR75). */
  onEdge: (card: KanbanCard, side: "start" | "end") => void;
  onOpen: (card: KanbanCard) => void;
  onAddDates: (card: KanbanCard) => void;
  onDragging: (held: boolean) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    setWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);
  const names = phone ? 120 : 248;
  const firstDatable = canWrite
    ? (unscheduled.find((card) => card.record?.locked !== true) ?? null)
    : null;
  const day = dayWidth(zoom, Math.max(0, width - names), window.days);
  const track = Math.round(day * window.days);
  const x = (offset: number) => offset * day;
  const axisHeight = axis.days.length > 0 ? AXIS + DAY_ROW : AXIS;

  // Today in view on the first paint of a period and on each Today (BR76:
  // phones scroll); a drag or a live refresh never moves the view. The view
  // starts at a week line, so the first week's label is whole, unless that
  // would leave today out (a phone at Week zoom); then at a day line.
  const today = axis.today;
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    const node = scroller.current;
    const key = `${zoom}:${window.start}:${todayTick}`;
    if (!node || width === 0 || scrolledFor.current === key) return;
    scrolledFor.current = key;
    if (today === null) return;
    const view = node.clientWidth - names;
    const at = today * day;
    if (at >= node.scrollLeft && at <= node.scrollLeft + view - day) return;
    const target = Math.max(0, at - view / 3);
    const week = Math.floor(target / (7 * day)) * 7 * day;
    node.scrollLeft =
      at + day <= week + view ? week : Math.floor(target / day) * day;
  });

  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const clickAfterDrag = useRef(false);
  const setDragState = (next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  };
  const preview = (card: KanbanCard): CardDates => {
    if (!drag || drag.cardId !== card.id || drag.days === 0) return card;
    return drag.mode === "move"
      ? moveDates(card, drag.days)
      : resizeDue(card, drag.days);
  };

  function barEvents(card: KanbanCard) {
    return {
      onPointerDown(event: PointerEvent<HTMLButtonElement>) {
        if (!canMove || event.button !== 0) return;
        const mode = (event.target as HTMLElement).closest(
          "[data-gantt-resize]",
        )
          ? "resize"
          : "move";
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragState({
          cardId: card.id,
          mode,
          x: event.clientX,
          days: 0,
          moved: false,
        });
        onDragging(true);
      },
      onPointerMove(event: PointerEvent<HTMLButtonElement>) {
        const now = dragRef.current;
        if (!now || now.cardId !== card.id) return;
        const dx = event.clientX - now.x;
        const moved = now.moved || Math.abs(dx) > 4;
        // Past the window's edge the bar would unmount mid-drag.
        const days = moved
          ? clampShift(card, now.mode, Math.round(dx / day), window)
          : 0;
        if (days !== now.days || moved !== now.moved)
          setDragState({ ...now, days, moved });
      },
      onPointerUp() {
        const now = dragRef.current;
        if (!now || now.cardId !== card.id) return;
        setDragState(null);
        onDragging(false);
        if (!now.moved) return;
        clickAfterDrag.current = true;
        if (now.days !== 0)
          onStage(
            card,
            now.mode === "move"
              ? moveDates(card, now.days)
              : resizeDue(card, now.days),
          );
      },
      onPointerCancel() {
        if (!dragRef.current) return;
        setDragState(null);
        onDragging(false);
      },
      // Fires after pointerup too, which has already ended the drag.
      onLostPointerCapture() {
        if (!dragRef.current) return;
        setDragState(null);
        onDragging(false);
      },
      onClick() {
        // A drag ends in a click; only a click without one opens the card.
        if (clickAfterDrag.current) {
          clickAfterDrag.current = false;
          return;
        }
        onOpen(card);
      },
      onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
        if (!canMove) return;
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const step = event.key === "ArrowRight" ? 1 : -1;
        const mode = event.shiftKey ? "resize" : "move";
        const days = clampShift(card, mode, step, window);
        // At the edge the bar and its focus stay; the live region says why.
        if (days === 0) {
          onEdge(card, step > 0 ? "end" : "start");
          return;
        }
        onStage(
          card,
          mode === "resize" ? resizeDue(card, days) : moveDates(card, days),
        );
      },
    };
  }

  const rowHeight = phone ? "h-11" : "h-11 xl:h-10";
  const nameCell =
    "sticky left-0 z-[3] flex min-w-0 items-center gap-1.5 border-b border-dotted bg-card pr-3 pl-3 text-sm text-muted-foreground focus-within:z-[4] md:pl-5";

  function cardRow(card: KanbanCard) {
    const locked = card.record?.locked === true;
    const dates = preview(card);
    const span = cardSpan(dates);
    const place = span ? barPlacement(span, window) : null;
    const change = staged.get(card.id);
    const color = barColor(card, labels);
    const progress = cardProgress(card);
    const name = cardName(card);
    // The row's one control (see the component's note).
    const barIsControl = !phone && !locked && place !== null;
    const nameIsControl = !locked && (phone || place === null);
    const was =
      change || (drag?.cardId === card.id && drag.days !== 0)
        ? cardSpan(change ? change.from : card)
        : null;
    const wasPlace = was ? barPlacement(was, window) : null;
    const away = span && !place ? outOfView(span, window, region) : null;
    const label = barLabel(
      { ...card, ...dates },
      labels,
      region,
      change ? change.from : null,
    );
    // Less ink reads lighter in every look (BR74): a label bar is its
    // series at 52%, a bar with no label ink-muted at 14%.
    const fill: CSSProperties = {
      background: color
        ? `color-mix(in oklab, ${chartVar(color)} 52%, var(--card))`
        : "color-mix(in oklab, var(--ink-muted) 14%, var(--card))",
      boxShadow: barShadow(
        barEdge(color),
        change !== undefined,
        drag?.cardId === card.id,
      ),
    };
    const barStyle: CSSProperties = place
      ? {
          ...fill,
          left: x(place.from),
          width: Math.max(4, x(place.length)),
        }
      : fill;
    const inner = (
      <>
        {progress ? (
          // Inside the 1px edge, so the edge stays whole.
          <span
            aria-hidden="true"
            className="absolute inset-y-px left-px"
            style={{
              width: `calc(${Math.round(progress * 100)}% - 1px)`,
              background: chartVar(color),
            }}
          />
        ) : null}
        {canMove && place && x(place.length) >= 16 ? (
          <span
            aria-hidden="true"
            data-gantt-resize=""
            className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r-[3px] bg-[color-mix(in_oklab,var(--ink)_70%,transparent)] opacity-0 group-hover/bar:opacity-100 group-focus-visible/bar:opacity-100 data-[staged]:opacity-100"
            data-staged={change ? "" : undefined}
          />
        ) : null}
      </>
    );
    const barClass = cn(
      "group/bar absolute top-1/2 z-[1] h-6 -translate-y-1/2 overflow-hidden rounded-[4px]",
      place?.clippedStart && "rounded-l-none",
      place?.clippedEnd && "rounded-r-none",
    );
    return (
      <Fragment key={card.id}>
        <div className={cn(nameCell, rowHeight)} title={name}>
          {nameIsControl ? (
            <button
              type="button"
              className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus)]"
              aria-label={label}
              onClick={() => onOpen(card)}
            >
              <RowName card={card} name={name} />
            </button>
          ) : (
            <RowName card={card} name={name} />
          )}
        </div>
        <div
          className={cn(
            "relative border-b border-dotted",
            rowHeight,
            phone && !locked && "cursor-pointer",
          )}
          // The 44px row opens the card on a phone (BR76); the name is its
          // keyboard control.
          onClick={phone && !locked ? () => onOpen(card) : undefined}
        >
          {wasPlace ? (
            <span
              aria-hidden="true"
              data-testid="gantt-was"
              className="pointer-events-none absolute top-1/2 z-[1] h-6 -translate-y-1/2 rounded-[4px] border border-dashed border-[var(--ink-muted)]"
              style={{ left: x(wasPlace.from), width: x(wasPlace.length) }}
            />
          ) : null}
          {away ? (
            // The bar is out of view: its dates point the way (the name
            // button says them).
            <div
              aria-hidden="true"
              className={cn(
                "flex h-full items-center",
                away.side === "end" ? "justify-end" : "justify-start",
              )}
            >
              <span
                className="text-muted-foreground bg-card sticky z-[1] px-2 text-xs whitespace-nowrap tabular-nums"
                style={away.side === "end" ? { right: 0 } : { left: names }}
              >
                {away.text}
              </span>
            </div>
          ) : null}
          {place && barIsControl ? (
            // The shared tooltip opens on hover and on focus, so a sighted
            // keyboard user reads the arrow keys too (C9).
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={label}
                    aria-describedby={canMove ? describedBy : undefined}
                    className={cn(
                      barClass,
                      "outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus)]",
                      canMove
                        ? "cursor-grab touch-none active:cursor-grabbing"
                        : "cursor-pointer",
                    )}
                    style={barStyle}
                    {...barEvents(card)}
                  />
                }
              >
                {inner}
              </TooltipTrigger>
              <TooltipContent className="flex-col items-start gap-0.5">
                <span>{label}</span>
                {canMove ? (
                  <span className="opacity-80">{GANTT_KEYS_HINT}</span>
                ) : null}
              </TooltipContent>
            </Tooltip>
          ) : place ? (
            <span
              aria-hidden="true"
              title={label}
              className={cn(barClass, "pointer-events-none")}
              style={barStyle}
            >
              {inner}
            </span>
          ) : null}
        </div>
      </Fragment>
    );
  }

  function groupRows(group: GanttGroupRows, index: number) {
    const place = barPlacement(group.span, window);
    return (
      <Fragment key={group.id}>
        {index > 0 ? <Gap /> : null}
        <div
          className={cn(
            nameCell,
            rowHeight,
            "text-foreground border-b border-solid border-[var(--rule-strong)] pl-3 md:pl-3",
          )}
        >
          <h3 className="flex min-w-0 items-baseline gap-1.5 font-semibold">
            <span className="truncate">{group.name}</span>{" "}
            <span className="text-muted-foreground text-xs font-medium tabular-nums">
              {group.cards.length}
            </span>
          </h3>
        </div>
        <div
          className={cn(
            "relative border-b border-solid border-[var(--rule-strong)]",
            rowHeight,
          )}
        >
          {place ? (
            <span
              role="img"
              aria-label={`${group.name}, ${datesWords(
                { startOn: group.span.start, dueOn: group.span.end },
                region,
              )}${
                group.progress === null
                  ? ""
                  : `, ${Math.round(group.progress * 100)}% of the checklist done`
              }`}
              className="absolute top-1/2 z-[2] flex h-[26px] -translate-y-1/2 items-center overflow-hidden rounded-[4px] bg-[color-mix(in_oklab,var(--ink-muted)_28%,var(--card))] shadow-[inset_0_0_0_1px_var(--ink-muted)]"
              style={{
                left: x(place.from),
                width: Math.max(4, x(place.length)),
              }}
            >
              {group.progress ? (
                <span
                  className="absolute inset-y-px left-px bg-[color-mix(in_oklab,var(--ink-muted)_60%,var(--card))]"
                  style={{
                    width: `calc(${Math.round(group.progress * 100)}% - 1px)`,
                  }}
                />
              ) : null}
              {/* The name keeps the body's 28% behind it: ink on the 60%
                  segment is under 4.5:1 in three dark looks. */}
              <span className="text-foreground relative mx-0.5 rounded-[3px] bg-[color-mix(in_oklab,var(--ink-muted)_28%,var(--card))] px-1.5 text-xs font-semibold whitespace-nowrap">
                {group.name}
              </span>
            </span>
          ) : null}
        </div>
        {group.cards.map(cardRow)}
      </Fragment>
    );
  }

  return (
    <section
      aria-label="Gantt"
      className="bg-card flex min-w-0 flex-col overflow-hidden rounded-lg border max-md:max-h-[calc(100dvh-3.5rem)] xl:min-h-0 xl:flex-1"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2.5">
        <span className="text-muted-foreground text-xs tabular-nums">
          {facts}
        </span>
        {legend}
      </div>
      {/* Phones: the panel is at most the screen under the header and
          scrolls inside, so the date axis stays on top (BR76). */}
      <div
        ref={scroller}
        data-testid="gantt-scroller"
        className="relative min-h-0 overflow-auto overscroll-x-contain md:max-xl:h-[38rem] xl:flex-1"
      >
        <div
          className="relative grid"
          style={{ gridTemplateColumns: `${names}px ${track}px` }}
        >
          <div
            aria-hidden="true"
            className="bg-card sticky top-0 left-0 z-[6] border-b"
            style={{ height: axisHeight }}
          />
          <div
            aria-hidden="true"
            className="bg-card sticky top-0 z-[5] border-b"
            style={{ height: axisHeight }}
          >
            {/* A month's name stays at the panel's left edge while any of
                its days are in view (phones scroll the panel sideways). A
                month too narrow for its name keeps only its line. */}
            {axis.months.map((month, index) => {
              const width = x(
                (axis.months[index + 1]?.offset ?? window.days) - month.offset,
              );
              return month.label && width >= MONTH_NAME_MIN ? (
                <span
                  key={month.offset}
                  className="absolute top-0 flex"
                  style={{
                    left: x(month.offset),
                    width,
                    height: MONTH_ROW,
                  }}
                >
                  <span
                    className="sticky flex items-end pb-1 pl-2 text-xs font-semibold whitespace-nowrap"
                    style={{ left: names }}
                  >
                    {month.label}
                  </span>
                </span>
              ) : null;
            })}
            {/* W labels center in their week; a start date reads from its
                week line (BR72). */}
            {axis.weeks.map((week) => (
              <span
                key={week.offset}
                className={cn(
                  "text-muted-foreground absolute grid text-xs whitespace-nowrap tabular-nums",
                  zoom === "quarter"
                    ? "place-items-center"
                    : "items-center justify-items-start pl-1.5",
                )}
                style={{
                  left: x(week.offset),
                  width: x(7),
                  top: MONTH_ROW,
                  height: AXIS - MONTH_ROW,
                }}
              >
                {week.label}
              </span>
            ))}
            {axis.days.map((date) => (
              <span
                key={date.offset}
                className="text-muted-foreground absolute grid place-items-center text-xs tabular-nums"
                style={{
                  left: x(date.offset),
                  width: day,
                  top: AXIS,
                  height: DAY_ROW,
                }}
              >
                {date.label}
              </span>
            ))}
            {/* Today sits in the month row, over its line, so it never
                covers a week label. */}
            {today !== null ? (
              <span
                className="absolute z-[1] -translate-x-1/2 rounded-sm bg-[var(--ink)] px-1 py-px text-xs font-semibold whitespace-nowrap text-[var(--background)]"
                style={{ left: x(today) + day / 2, top: 5 }}
              >
                Today
              </span>
            ) : null}
          </div>
          {/* The today line runs under the rows: bars and summaries cover
              it, so it never crosses a summary's name. */}
          {today !== null ? (
            <div
              aria-hidden="true"
              data-testid="gantt-today"
              className="pointer-events-none absolute bottom-0 z-[1] w-0 border-l-2 border-[var(--ink)]"
              style={{ top: axisHeight, left: names + x(today) + day / 2 }}
            />
          ) : null}
          {groups.map(groupRows)}
          {/* Cards, but none dated: one line in the grid says so, and a
              writer adds dates to the first card from it (C10). */}
          {groups.length === 0 && unscheduled.length > 0 ? (
            <>
              <div
                className={cn(
                  nameCell,
                  rowHeight,
                  "text-muted-foreground border-b border-dotted text-sm",
                )}
              >
                No dated cards
              </div>
              <div
                className={cn(
                  "relative flex items-center border-b border-dotted",
                  rowHeight,
                )}
              >
                {firstDatable ? (
                  <span
                    className="bg-card sticky z-[1] flex h-full items-center px-1.5"
                    style={{ left: names }}
                  >
                    <button
                      type="button"
                      className="text-action-text focus-visible:outline-ring inline-flex h-11 items-center rounded-sm px-1 text-xs font-medium outline-none hover:underline focus-visible:outline-2 xl:h-8"
                      onClick={() => onAddDates(firstDatable)}
                    >
                      Add dates
                    </button>
                  </span>
                ) : null}
              </div>
              <Gap />
            </>
          ) : null}
          {unscheduled.length > 0 ? (
            <>
              {groups.length > 0 ? <Gap /> : null}
              <div
                className={cn(
                  nameCell,
                  rowHeight,
                  "text-foreground border-b border-solid border-[var(--rule-strong)] pl-3 md:pl-3",
                )}
              >
                <h3 className="flex items-baseline gap-1.5 font-semibold">
                  Unscheduled{" "}
                  <span className="text-muted-foreground text-xs font-medium tabular-nums">
                    {unscheduled.length}
                  </span>
                </h3>
              </div>
              <div
                className={cn(
                  "border-b border-solid border-[var(--rule-strong)]",
                  rowHeight,
                )}
              />
              {unscheduled.map((card) => {
                const locked = card.record?.locked === true;
                const name = cardName(card);
                // Readers open the card by its name; on a phone writers
                // do too, and a tap on the row opens it (BR76).
                const opens = !locked && (phone || !canWrite);
                return (
                  <Fragment key={card.id}>
                    <div className={cn(nameCell, rowHeight)} title={name}>
                      {opens ? (
                        <button
                          type="button"
                          className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus)]"
                          aria-label={`${name}, no dates`}
                          onClick={() => onOpen(card)}
                        >
                          <RowName card={card} name={name} />
                        </button>
                      ) : (
                        <RowName card={card} name={name} />
                      )}
                    </div>
                    <div
                      className={cn(
                        "relative border-b border-dotted",
                        rowHeight,
                        phone && opens && "cursor-pointer",
                      )}
                      onClick={
                        phone && opens
                          ? (event) => {
                              // Add dates is its own target.
                              if (
                                (event.target as HTMLElement).closest("button")
                              )
                                return;
                              onOpen(card);
                            }
                          : undefined
                      }
                    >
                      <span
                        className="text-muted-foreground bg-card sticky z-[1] flex h-full w-max items-center gap-2.5 pr-2 pl-2.5 text-xs"
                        style={{ left: names }}
                      >
                        <span>No dates</span>
                        {canWrite && !locked ? (
                          <button
                            type="button"
                            aria-label={`Add dates to ${name}`}
                            className="text-action-text focus-visible:outline-ring inline-flex h-11 items-center rounded-sm px-1 font-medium outline-none hover:underline focus-visible:outline-2 xl:h-8"
                            onClick={() => onAddDates(card)}
                          >
                            Add dates
                          </button>
                        ) : null}
                      </span>
                    </div>
                  </Fragment>
                );
              })}
            </>
          ) : null}
          {/* Week lines dotted, month lines solid; Week zoom adds faint day
              lines (BR72). */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0"
            style={{ top: axisHeight, left: names, width: track }}
          >
            {axis.lines.map((line) => (
              <i
                key={line.offset}
                className={cn(
                  "absolute inset-y-0 border-l",
                  line.kind === "day"
                    ? "border-dotted border-[var(--rule)]"
                    : line.kind === "week"
                      ? "border-dotted border-[var(--rule-strong)]"
                      : "border-solid border-[var(--rule-strong)]",
                )}
                style={{ left: x(line.offset) }}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function RowName({ card, name }: { card: KanbanCard; name: string }) {
  return (
    <>
      {card.kind === "record" ? (
        <FileText aria-hidden="true" className="size-[13px] shrink-0" />
      ) : null}
      <span className="truncate">{name}</span>
    </>
  );
}

function Gap() {
  return (
    <>
      <div aria-hidden="true" className="bg-card sticky left-0 z-[3] h-3" />
      <div aria-hidden="true" className="h-3" />
    </>
  );
}
