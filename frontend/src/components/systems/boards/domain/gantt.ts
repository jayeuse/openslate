import type {
  ChartColor,
  KanbanCard,
  KanbanLabel,
  KanbanStage,
} from "../adapters/board-kanban-schemas";
import { formatWorkspaceDate, type WorkspaceRegion } from "@/lib/date-time";
import {
  addDays,
  daysBetween,
  monthEnd,
  monthStart,
  startOfWeek,
  type WeekStart,
} from "./calendar-dates";
import { cardName, sortStageCards, swimlanes } from "./kanban";

/**
 * The board Gantt's rules (BR72–BR76): dates are the columns and cards the
 * rows. A zoom shows whole weeks around its period; a bar runs from a card's
 * start to its due date, or one day when it has one date; groups carry a
 * summary; writers stage date changes that Save changes sends in one batch.
 * Every date is a plain calendar day ("YYYY-MM-DD").
 */

export type GanttZoom = "week" | "month" | "quarter";
export type GanttGroup = "stage" | "assignee" | "label";
export type GanttWindow = { start: string; end: string; days: number };
export type CardDates = { startOn: string | null; dueOn: string | null };
export type CardSpan = { start: string; end: string };

export const GANTT_ZOOMS: readonly GanttZoom[] = ["week", "month", "quarter"];

/** Quarter on desktop, Month on phones (BR72, BR76); unknown words fall back. */
export function parseGanttZoom(
  value: string | null,
  phone: boolean,
): GanttZoom {
  return value === "week" || value === "month" || value === "quarter"
    ? value
    : phone
      ? "month"
      : "quarter";
}

/** Stage by default; assignee and label are the other two (BR73). */
export function parseGanttGroup(value: string | null): GanttGroup {
  return value === "assignee" || value === "label" ? value : "stage";
}

function quarterStart(anchor: string): string {
  const month = Number(anchor.slice(5, 7));
  const first = month - ((month - 1) % 3);
  return `${anchor.slice(0, 4)}-${String(first).padStart(2, "0")}-01`;
}

function shiftMonths(anchor: string, amount: number): string {
  const year = Number(anchor.slice(0, 4));
  const month = Number(anchor.slice(5, 7)) - 1 + amount;
  const date = new Date(Date.UTC(year, month, 1, 12));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** Week zoom shows the anchor's week and the two after it. */
const WEEK_ZOOM_WEEKS = 3;

/** The whole weeks that hold the period: a quarter, a month, or three weeks. */
export function ganttWindow(
  zoom: GanttZoom,
  anchor: string,
  weekStart: WeekStart,
): GanttWindow {
  let first: string;
  let last: string;
  if (zoom === "week") {
    first = anchor;
    last = addDays(startOfWeek(anchor, weekStart), WEEK_ZOOM_WEEKS * 7 - 1);
  } else {
    first = zoom === "quarter" ? quarterStart(anchor) : monthStart(anchor);
    last = monthEnd(zoom === "quarter" ? shiftMonths(first, 2) : first);
  }
  const start = startOfWeek(first, weekStart);
  const end = addDays(startOfWeek(last, weekStart), 6);
  return { start, end, days: daysBetween(start, end) + 1 };
}

/** Previous and next move a quarter, a month, or a week. */
export function shiftGanttAnchor(
  zoom: GanttZoom,
  anchor: string,
  amount: number,
): string {
  if (zoom === "week") return addDays(anchor, amount * 7);
  return zoom === "quarter"
    ? shiftMonths(quarterStart(anchor), amount * 3)
    : shiftMonths(anchor, amount);
}

const shortDay = (date: string, region: WorkspaceRegion) =>
  formatWorkspaceDate(date, region, { month: "short", day: "numeric" });

/** "Q4 2026", "October 2026" ("Oct 2026" on phones), "Oct 26 – Nov 15, 2026". */
export function ganttTitle(
  zoom: GanttZoom,
  anchor: string,
  weekStart: WeekStart,
  region: WorkspaceRegion,
  phone: boolean,
): string {
  if (zoom === "quarter")
    return `Q${Math.floor((Number(anchor.slice(5, 7)) - 1) / 3) + 1} ${anchor.slice(0, 4)}`;
  if (zoom === "month")
    return formatWorkspaceDate(monthStart(anchor), region, {
      month: phone ? "short" : "long",
      year: "numeric",
    });
  const window = ganttWindow(zoom, anchor, weekStart);
  const range = `${shortDay(window.start, region)} – ${shortDay(window.end, region)}`;
  return phone ? range : `${range}, ${window.end.slice(0, 4)}`;
}

/**
 * The week row (BR72). At Quarter a week reads W1–W5 by its place in the
 * month that holds its middle day (the ISO Thursday for Monday weeks); at
 * Week and Month it reads its start date, aligned at its week line.
 */
export function ganttWeeks(
  window: GanttWindow,
  zoom: GanttZoom,
  region: WorkspaceRegion,
): { offset: number; label: string }[] {
  const weeks: { offset: number; label: string }[] = [];
  for (let offset = 0; offset < window.days; offset += 7) {
    const start = addDays(window.start, offset);
    const middle = addDays(start, 3);
    weeks.push({
      offset,
      label:
        zoom === "quarter"
          ? `W${Math.floor((Number(middle.slice(8, 10)) - 1) / 7) + 1}`
          : shortDay(start, region),
    });
  }
  return weeks;
}

/**
 * The month row: each month starts at its first day. At Quarter a month
 * with 3 or more days in view reads its short name ("Oct"), so a trailing
 * "W1" sits under the month it counts in; at Month and Week a month needs a
 * week in view for its long name. A shorter month keeps its line but no
 * name, so names never overlap.
 */
export function ganttMonths(
  window: GanttWindow,
  region: WorkspaceRegion,
  zoom: GanttZoom,
): { offset: number; label: string | null }[] {
  const months: { offset: number; label: string | null }[] = [];
  let first = monthStart(window.start);
  while (first <= window.end) {
    const from = first < window.start ? window.start : first;
    const to = monthEnd(first) > window.end ? window.end : monthEnd(first);
    const visible = daysBetween(from, to) + 1;
    const quarter = zoom === "quarter";
    const label =
      visible >= (quarter ? 3 : 7)
        ? formatWorkspaceDate(first, region, {
            month: quarter ? "short" : "long",
          })
        : null;
    if (first >= window.start || label)
      months.push({ offset: daysBetween(window.start, from), label });
    first = shiftMonths(first, 1);
  }
  return months;
}

/**
 * Dotted week lines and solid month lines; a month line wins a shared day.
 * Week zoom also draws a faint line at each day (BR72).
 */
export function ganttLines(
  window: GanttWindow,
  zoom: GanttZoom,
): { offset: number; kind: "day" | "week" | "month" }[] {
  const lines = new Map<number, "day" | "week" | "month">();
  if (zoom === "week")
    for (let offset = 1; offset < window.days; offset += 1)
      lines.set(offset, "day");
  for (let offset = 0; offset < window.days; offset += 7)
    lines.set(offset, "week");
  let first = monthStart(window.start);
  if (first < window.start) first = shiftMonths(first, 1);
  while (first <= window.end) {
    lines.set(daysBetween(window.start, first), "month");
    first = shiftMonths(first, 1);
  }
  return [...lines]
    .sort(([left], [right]) => left - right)
    .map(([offset, kind]) => ({ offset, kind }));
}

/** Week zoom's day row: each day's number under its week (BR72). */
export function ganttDays(
  window: GanttWindow,
  zoom: GanttZoom,
): { offset: number; label: string }[] {
  if (zoom !== "week") return [];
  return Array.from({ length: window.days }, (_, offset) => ({
    offset,
    label: String(Number(addDays(window.start, offset).slice(8, 10))),
  }));
}

/** The narrowest day each zoom allows, in CSS pixels. */
const MIN_DAY: Record<GanttZoom, number> = { quarter: 6, month: 14, week: 40 };

/** A day's width: the panel's width shared by the days, never under the zoom's floor. */
export function dayWidth(
  zoom: GanttZoom,
  available: number,
  days: number,
): number {
  return Math.max(MIN_DAY[zoom], available / days);
}

/** Start to due; a card with one date is one day on it; none is unscheduled. */
export function cardSpan(dates: CardDates): CardSpan | null {
  const start = dates.startOn ?? dates.dueOn;
  const end = dates.dueOn ?? dates.startOn;
  return start && end ? { start, end } : null;
}

/** A bar's days in the window, clipped at its edges; null when out of view. */
export function barPlacement(
  span: CardSpan,
  window: GanttWindow,
): {
  from: number;
  length: number;
  clippedStart: boolean;
  clippedEnd: boolean;
} | null {
  if (span.end < window.start || span.start > window.end) return null;
  const clippedStart = span.start < window.start;
  const clippedEnd = span.end > window.end;
  const start = clippedStart ? window.start : span.start;
  const end = clippedEnd ? window.end : span.end;
  return {
    from: daysBetween(window.start, start),
    length: daysBetween(start, end) + 1,
    clippedStart,
    clippedEnd,
  };
}

/**
 * A drag or arrow key may move a bar to the window's edge but not past it,
 * so the bar, its focus and its pointer stay (BR75). A move keeps one day of
 * the span in view; a resize keeps the end in view when the start is out.
 */
export function clampShift(
  dates: CardDates,
  mode: "move" | "resize",
  days: number,
  window: GanttWindow,
): number {
  const span = cardSpan(dates);
  if (!span) return days;
  const low =
    mode === "move" || span.start < window.start
      ? daysBetween(span.end, window.start)
      : -Infinity;
  const high = mode === "move" ? daysBetween(span.start, window.end) : Infinity;
  return Math.min(high, Math.max(low, days));
}

/**
 * The words for a bar held at the edge: "Book the expo booth crew is at the
 * end of the view. Use Next month to move it further."
 */
export function edgeWords(
  name: string,
  side: "start" | "end",
  zoom: GanttZoom,
): string {
  const button = `${side === "end" ? "Next" : "Previous"} ${zoom}`;
  return `${name} is at the ${side} of the view. Use ${button} to move it further.`;
}

/**
 * Where a bar out of view is: "Oct 12 →" past the window's end (its start),
 * "← Jun 3" before its start (its due date). Null when the bar is in view.
 */
export function outOfView(
  span: CardSpan,
  window: GanttWindow,
  region: WorkspaceRegion,
): { side: "start" | "end"; text: string } | null {
  if (span.start > window.end)
    return { side: "end", text: `${shortDay(span.start, region)} →` };
  if (span.end < window.start)
    return { side: "start", text: `← ${shortDay(span.end, region)}` };
  return null;
}

/** The today line's day in the window, or null when today is not in view. */
export function todayOffset(window: GanttWindow, today: string): number | null {
  if (!today || today < window.start || today > window.end) return null;
  return daysBetween(window.start, today);
}

/**
 * A bar's label (BR74): the card's first label in board order, as the
 * Kanban's label lanes read it. A locked card shows nothing of itself.
 */
export function firstLabel(
  card: KanbanCard,
  labels: readonly KanbanLabel[],
): KanbanLabel | null {
  if (card.record?.locked) return null;
  return (
    [...labels]
      .sort((left, right) => left.position - right.position)
      .find((label) => card.labelIds.includes(label.id)) ?? null
  );
}

/** A bar's color: its first label's chart series, or neutral (BR74). */
export function barColor(
  card: KanbanCard,
  labels: readonly KanbanLabel[],
): ChartColor | null {
  return firstLabel(card, labels)?.color ?? null;
}

/** An objective's checklist share; record cards and empty checklists have none. */
export function cardProgress(card: KanbanCard): number | null {
  if (card.kind !== "objective" || card.checklist.total === 0) return null;
  return card.checklist.done / card.checklist.total;
}

/** "Oct 5 to Nov 2", one day "Oct 27", or "No dates". */
export function datesWords(dates: CardDates, region: WorkspaceRegion): string {
  const span = cardSpan(dates);
  if (!span) return "No dates";
  return span.start === span.end
    ? shortDay(span.start, region)
    : `${shortDay(span.start, region)} to ${shortDay(span.end, region)}`;
}

/**
 * A bar's accessible name and tooltip (BR69, the Gantt exception to Name
 * Beside Color): "Update the Q4 price list, Pricing, Sep 1 to Sep 30,
 * checklist 1 of 4 done", and ", unsaved, was Aug 28 to Sep 27" while a
 * change to it is staged.
 */
export function barLabel(
  card: KanbanCard,
  labels: readonly KanbanLabel[],
  region: WorkspaceRegion,
  was: CardDates | null = null,
): string {
  const label = firstLabel(card, labels);
  const checklist =
    cardProgress(card) === null
      ? ""
      : `, checklist ${card.checklist.done} of ${card.checklist.total} done`;
  const staged = was ? `, unsaved, was ${datesWords(was, region)}` : "";
  return `${cardName(card)}${label ? `, ${label.name}` : ""}, ${datesWords(card, region)}${checklist}${staged}`;
}

export type GanttGroupRows = {
  id: string;
  name: string;
  cards: KanbanCard[];
  span: CardSpan;
  progress: number | null;
};

function summary(
  id: string,
  name: string,
  cards: KanbanCard[],
): GanttGroupRows | null {
  const spans = cards.flatMap((card) => {
    const span = cardSpan(card);
    return span ? [span] : [];
  });
  if (spans.length === 0) return null;
  let done = 0;
  let total = 0;
  for (const card of cards)
    if (cardProgress(card) !== null) {
      done += card.checklist.done;
      total += card.checklist.total;
    }
  return {
    id,
    name,
    cards,
    span: {
      start: spans.reduce(
        (low, span) => (span.start < low ? span.start : low),
        spans[0].start,
      ),
      end: spans.reduce(
        (high, span) => (span.end > high ? span.end : high),
        spans[0].end,
      ),
    },
    progress: total === 0 ? null : done / total,
  };
}

/**
 * The rows (BR73, BR75): groups of dated cards with their summaries, by
 * stage in board order (each stage in its own sort) or by the Kanban's
 * assignee and label lanes; groups without a dated card are left out. Cards
 * with no date are Unscheduled, at the end, in the same order.
 */
export function ganttGroups({
  cards,
  stages,
  labels,
  group,
  personName,
}: {
  cards: readonly KanbanCard[];
  stages: readonly KanbanStage[];
  labels: readonly KanbanLabel[];
  group: GanttGroup;
  personName: (id: string) => string | null;
}): { groups: GanttGroupRows[]; unscheduled: KanbanCard[] } {
  const ordered = [...stages]
    .sort((left, right) => left.position - right.position)
    .flatMap((stage) =>
      sortStageCards(
        cards.filter((card) => card.stageId === stage.id),
        stage.cardSort,
      ),
    );
  const dated = ordered.filter((card) => cardSpan(card) !== null);
  const unscheduled = ordered.filter((card) => cardSpan(card) === null);
  const lanes =
    group === "stage"
      ? stages.map((stage) => ({
          id: stage.id,
          name: stage.name,
          cards: dated.filter((card) => card.stageId === stage.id),
        }))
      : swimlanes(dated, group, labels, personName);
  return {
    groups: lanes.flatMap((lane) => {
      const rows = summary(lane.id, lane.name, lane.cards);
      return rows ? [rows] : [];
    }),
    unscheduled,
  };
}

/** A move shifts the dates the card has (BR75). */
export function moveDates(dates: CardDates, days: number): CardDates {
  return {
    startOn: dates.startOn ? addDays(dates.startOn, days) : null,
    dueOn: dates.dueOn ? addDays(dates.dueOn, days) : null,
  };
}

/**
 * A resize moves the bar's end, the due date, and never before its start.
 * A one-day bar grows from its day, which becomes the start.
 */
export function resizeDue(dates: CardDates, days: number): CardDates {
  const span = cardSpan(dates);
  if (!span) return dates;
  const due = addDays(span.end, days);
  const end = due < span.start ? span.start : due;
  if (end === span.end) return dates;
  return { startOn: span.start, dueOn: end };
}

export type DateChange = {
  cardId: string;
  /** The card's revision when its first change was staged. */
  revision: number;
  from: CardDates;
  to: CardDates;
};
export type StagedDates = ReadonlyMap<string, DateChange>;
/** `batch-dates` takes at most this many cards at once. */
export const MAX_STAGED = 100;

const sameDates = (left: CardDates, right: CardDates) =>
  left.startOn === right.startOn && left.dueOn === right.dueOn;

/**
 * Stages a card's new dates (BR65). The change keeps the revision and the
 * dates the card had when its first change was staged; a change back to
 * them leaves the set. A card beyond the 100th waits for a save.
 */
export function stageDates(
  staged: StagedDates,
  card: KanbanCard,
  to: CardDates,
): { staged: StagedDates; refused: boolean } {
  const known = staged.get(card.id);
  if (!known && staged.size >= MAX_STAGED) return { staged, refused: true };
  const from = known?.from ?? { startOn: card.startOn, dueOn: card.dueOn };
  const next = new Map(staged);
  if (sameDates(from, to)) next.delete(card.id);
  else
    next.set(card.id, {
      cardId: card.id,
      revision: known?.revision ?? card.revision,
      from,
      to,
    });
  return { staged: next, refused: false };
}

/** The cards as the Gantt draws them: staged dates over the saved ones. */
export function withStaged(
  cards: readonly KanbanCard[],
  staged: StagedDates,
): KanbanCard[] {
  return cards.map((card) => {
    const change = staged.get(card.id);
    return change ? { ...card, ...change.to } : card;
  });
}

/**
 * The staged set and the set a Discard put aside: Undo brings it back
 * until the next change (Four Moments: after).
 */
export type GanttDraft = {
  staged: StagedDates;
  discarded: StagedDates | null;
};

/** Stages a change; the discarded set is gone once a new change starts. */
export function stageDraft(
  draft: GanttDraft,
  card: KanbanCard,
  to: CardDates,
): { draft: GanttDraft; refused: boolean } {
  const result = stageDates(draft.staged, card, to);
  if (result.refused) return { draft, refused: true };
  return { draft: { staged: result.staged, discarded: null }, refused: false };
}

/** Discard empties the set and keeps it for Undo. */
export function discardDraft(draft: GanttDraft): GanttDraft {
  return draft.staged.size === 0
    ? draft
    : { staged: new Map(), discarded: draft.staged };
}

/**
 * Undo brings the discarded set back with each change's first revision, so
 * a card someone saved since is stale at Save; a card that left the board
 * stays out.
 */
export function undoDiscard(
  draft: GanttDraft,
  cards: readonly KanbanCard[],
): GanttDraft {
  if (!draft.discarded) return draft;
  return { staged: pruneStaged(draft.discarded, cards), discarded: null };
}

/** A card that left the board (archived elsewhere) leaves the staged set. */
export function pruneStaged(
  staged: StagedDates,
  cards: readonly KanbanCard[],
): StagedDates {
  const present = new Set(cards.map((card) => card.id));
  if ([...staged.keys()].every((cardId) => present.has(cardId))) return staged;
  return new Map([...staged].filter(([cardId]) => present.has(cardId)));
}

/** The `batch-dates` body: each card with the revision its change began on. */
export function batchPayload(staged: StagedDates): {
  items: {
    card_id: string;
    revision: number;
    start_on: string | null;
    due_on: string | null;
  }[];
} {
  return {
    items: [...staged.values()].map((change) => ({
      card_id: change.cardId,
      revision: change.revision,
      start_on: change.to.startOn,
      due_on: change.to.dueOn,
    })),
  };
}

export type CardDatesResult =
  | ({ status: "updated"; cardId: string; revision: number } & CardDates)
  | { status: "stale" | "forbidden"; cardId: string };

export const STALE_CARD = "Someone changed this card first.";
export const FORBIDDEN_CARD =
  "This card is no longer on this board, or you cannot read its record.";

/**
 * Settles each card's result: an updated card is saved; a stale or
 * forbidden one says why and leaves the set, since its revision is spent.
 * A card the answer did not name stays staged.
 */
export function settleResults(
  staged: StagedDates,
  results: readonly CardDatesResult[],
): {
  staged: StagedDates;
  updated: ({ cardId: string; revision: number } & CardDates)[];
  problems: { cardId: string; message: string }[];
} {
  const next = new Map(staged);
  const updated: ({ cardId: string; revision: number } & CardDates)[] = [];
  const problems: { cardId: string; message: string }[] = [];
  for (const result of results) {
    next.delete(result.cardId);
    if (result.status === "updated")
      updated.push({
        cardId: result.cardId,
        revision: result.revision,
        startOn: result.startOn,
        dueOn: result.dueOn,
      });
    else
      problems.push({
        cardId: result.cardId,
        message: result.status === "stale" ? STALE_CARD : FORBIDDEN_CARD,
      });
  }
  return { staged: next, updated, problems };
}

export function unsavedWords(count: number): string {
  return count === 0
    ? "No unsaved changes"
    : `${count} unsaved ${count === 1 ? "change" : "changes"}`;
}

/** "Book the expo booth crew: Oct 27 to Oct 31. 1 unsaved change." */
export function ganttAnnouncement(
  name: string,
  dates: CardDates,
  count: number,
  region: WorkspaceRegion,
): string {
  return `${name}: ${datesWords(dates, region)}. ${unsavedWords(count)}.`;
}
