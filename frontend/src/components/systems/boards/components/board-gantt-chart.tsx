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
import type { KanbanCard, KanbanLabel } from "../adapters/board-kanban-schemas";
import {
  barColor,
  barLabel,
  barPlacement,
  cardProgress,
  cardSpan,
  datesWords,
  dayWidth,
  moveDates,
  resizeDue,
  type CardDates,
  type GanttGroupRows,
  type GanttWindow,
  type GanttZoom,
  type StagedDates,
} from "../domain/gantt";
import { cardName } from "../domain/kanban";
import { chartVar } from "./board-kanban-card";

/** The axis: a month row over a week row. */
const AXIS = 52;
const MONTH_ROW = 28;

export type GanttAxis = {
  weeks: { offset: number; label: string }[];
  months: { offset: number; label: string | null }[];
  lines: { offset: number; kind: "week" | "month" }[];
  today: number | null;
};

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
export function GanttChart({
  window,
  zoom,
  axis,
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
  onOpen,
  onAddDates,
  onDragging,
}: {
  window: GanttWindow;
  zoom: GanttZoom;
  axis: GanttAxis;
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
  const day = dayWidth(zoom, Math.max(0, width - names), window.days);
  const track = Math.round(day * window.days);
  const x = (offset: number) => offset * day;

  // Today in view on the first paint of a period (BR76: phones scroll);
  // a drag or a live refresh never moves the view.
  const today = axis.today;
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    const node = scroller.current;
    const key = `${zoom}:${window.start}`;
    if (!node || width === 0 || scrolledFor.current === key) return;
    scrolledFor.current = key;
    if (today === null) return;
    const view = node.clientWidth - names;
    const at = today * day;
    if (at < node.scrollLeft || at > node.scrollLeft + view - day)
      node.scrollLeft = Math.max(0, at - view / 3);
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
        const days = moved ? Math.round(dx / day) : 0;
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
        const days = event.key === "ArrowRight" ? 1 : -1;
        onStage(
          card,
          event.shiftKey ? resizeDue(card, days) : moveDates(card, days),
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
    const fill: CSSProperties = {
      background: color
        ? `color-mix(in oklab, ${chartVar(color)} 52%, var(--card))`
        : "color-mix(in oklab, var(--ink-muted) 34%, var(--card))",
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
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-0"
            style={{
              width: `${Math.round(progress * 100)}%`,
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
      change && "shadow-[0_0_0_2px_var(--warn)]",
      drag?.cardId === card.id && "shadow-[var(--shadow-lg)]",
    );
    return (
      <Fragment key={card.id}>
        <div className={cn(nameCell, rowHeight)} title={name}>
          {nameIsControl ? (
            <button
              type="button"
              className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus)]"
              aria-label={barLabel({ ...card, ...dates }, region)}
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
          {place && barIsControl ? (
            <button
              type="button"
              aria-label={barLabel({ ...card, ...dates }, region)}
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
            >
              {inner}
            </button>
          ) : place ? (
            <span
              aria-hidden="true"
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
            <span className="text-muted-foreground text-[13px] font-medium tabular-nums">
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
              className="absolute top-1/2 z-[1] flex h-[26px] -translate-y-1/2 items-center overflow-hidden rounded-[4px] bg-[color-mix(in_oklab,var(--ink-muted)_16%,var(--card))] shadow-[inset_0_0_0_1px_var(--rule-strong)]"
              style={{
                left: x(place.from),
                width: Math.max(4, x(place.length)),
              }}
            >
              {group.progress ? (
                <span
                  className="absolute inset-y-0 left-0 bg-[color-mix(in_oklab,var(--ink-muted)_36%,var(--card))]"
                  style={{ width: `${Math.round(group.progress * 100)}%` }}
                />
              ) : null}
              <span className="text-foreground relative px-2 text-xs font-semibold whitespace-nowrap">
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
      className="bg-card flex min-w-0 flex-col overflow-hidden rounded-lg border xl:min-h-0 xl:flex-1"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2.5">
        <span className="text-muted-foreground text-[13px] tabular-nums">
          {facts}
        </span>
        {legend}
      </div>
      <div
        ref={scroller}
        className="relative min-h-0 overflow-x-auto overscroll-x-contain md:overflow-y-auto md:max-xl:h-[38rem] xl:flex-1"
      >
        <div
          className="relative grid"
          style={{ gridTemplateColumns: `${names}px ${track}px` }}
        >
          <div
            aria-hidden="true"
            className="bg-card sticky top-0 left-0 z-[6] border-b"
            style={{ height: AXIS }}
          />
          <div
            aria-hidden="true"
            className="bg-card sticky top-0 z-[5] border-b"
            style={{ height: AXIS }}
          >
            {/* A month's name stays at the panel's left edge while any of
                its days are in view (phones scroll the panel sideways). */}
            {axis.months.map((month, index) =>
              month.label ? (
                <span
                  key={month.offset}
                  className="absolute top-0 flex"
                  style={{
                    left: x(month.offset),
                    width: x(
                      (axis.months[index + 1]?.offset ?? window.days) -
                        month.offset,
                    ),
                    height: MONTH_ROW,
                  }}
                >
                  <span
                    className="sticky flex items-end pb-1 pl-2 text-[13px] font-semibold whitespace-nowrap"
                    style={{ left: names }}
                  >
                    {month.label}
                  </span>
                </span>
              ) : null,
            )}
            {axis.weeks.map((week) => (
              <span
                key={week.offset}
                className="text-muted-foreground absolute grid place-items-center text-xs whitespace-nowrap tabular-nums"
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
          </div>
          {groups.map(groupRows)}
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
                  <span className="text-muted-foreground text-[13px] font-medium tabular-nums">
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
                return (
                  <Fragment key={card.id}>
                    <div className={cn(nameCell, rowHeight)} title={name}>
                      {!locked && !canWrite ? (
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
                      )}
                    >
                      <span
                        className="text-muted-foreground sticky flex h-full w-max items-center gap-2.5 pl-2.5 text-xs"
                        style={{ left: names }}
                      >
                        <span>No dates</span>
                        {canWrite && !locked ? (
                          <button
                            type="button"
                            aria-label={`Add dates to ${name}`}
                            className="inline-flex h-11 items-center rounded-sm px-1 font-medium text-[var(--action-text)] outline-none hover:underline focus-visible:outline-2 focus-visible:outline-[var(--focus)] xl:h-8"
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
          {/* Week lines dotted, month lines solid (BR72). */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0"
            style={{ top: AXIS, left: names, width: track }}
          >
            {axis.lines.map((line) => (
              <i
                key={line.offset}
                className={cn(
                  "absolute inset-y-0 border-l border-[var(--rule-strong)]",
                  line.kind === "week" ? "border-dotted" : "border-solid",
                )}
                style={{ left: x(line.offset) }}
              />
            ))}
          </div>
          {today !== null ? (
            <div
              aria-hidden="true"
              data-testid="gantt-today"
              className="pointer-events-none absolute bottom-0 z-[2] w-0 border-l-2 border-[var(--ink)]"
              style={{ top: MONTH_ROW, left: names + x(today) + day / 2 }}
            />
          ) : null}
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
