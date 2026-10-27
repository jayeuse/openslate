import type {
  CardSort,
  ChartColor,
  KanbanCard,
  KanbanLabel,
} from "../adapters/board-kanban-schemas";
import {
  formatWorkspaceDate,
  formatWorkspaceDateTime,
  type WorkspaceRegion,
} from "@/lib/date-time";
import { addDays, startOfWeek, type WeekStart } from "./calendar-dates";

/**
 * The board Kanban's rules (BR61–BR68): card names, stage sorting and
 * paging, the WIP count, drop places, filters in the URL, and swimlanes.
 * The Kanban holds the board's complete card list, so it filters and sorts
 * before it pages, and every drop place is an index into the stage's whole
 * order, whatever the viewer has filtered.
 */

/** A long stage shows this many cards, then the rest in pages of this many. */
export const KANBAN_PAGE = 25;
export const LOCKED_CARD_NAME = "No access to this record";

/** The three stages "Start with To do · Doing · Done" adds (BR80). Doing is not
 * amber (`chart-2`): amber is the WIP warn color. */
export const STARTER_STAGES: readonly { name: string; color: ChartColor }[] = [
  { name: "To do", color: "chart-1" },
  { name: "Doing", color: "chart-4" },
  { name: "Done", color: "chart-3" },
];

export function cardName(card: KanbanCard): string {
  if (card.record?.locked) return LOCKED_CARD_NAME;
  if (card.record) return card.record.title;
  return card.title ?? "";
}

/** The cards of each stage in rank order (the server's manual order). */
export function cardsByStage(
  cards: readonly KanbanCard[],
): Map<string, KanbanCard[]> {
  const stages = new Map<string, KanbanCard[]>();
  for (const card of [...cards].sort(byRank)) {
    const list = stages.get(card.stageId);
    if (list) list.push(card);
    else stages.set(card.stageId, [card]);
  }
  return stages;
}

function byRank(left: KanbanCard, right: KanbanCard): number {
  return left.rank - right.rank || left.id.localeCompare(right.id);
}

const collator = new Intl.Collator("en", { sensitivity: "base" });

/**
 * A stage's display order. `cards` is in rank order; the sort keeps it for
 * ties, so a sorted stage stays steady between reads.
 */
export function sortStageCards(
  cards: readonly KanbanCard[],
  sort: CardSort,
): KanbanCard[] {
  const ranked = [...cards].sort(byRank);
  if (sort === "manual") return ranked;
  const place = new Map(ranked.map((card, index) => [card.id, index]));
  const steady = (left: KanbanCard, right: KanbanCard) =>
    (place.get(left.id) ?? 0) - (place.get(right.id) ?? 0);
  if (sort === "due")
    return ranked.sort((left, right) =>
      left.dueOn === right.dueOn
        ? steady(left, right)
        : left.dueOn === null
          ? 1
          : right.dueOn === null
            ? -1
            : left.dueOn.localeCompare(right.dueOn),
    );
  if (sort === "newest")
    return ranked.sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || steady(left, right),
    );
  return ranked.sort((left, right) => {
    const a = left.record?.locked ? null : cardName(left);
    const b = right.record?.locked ? null : cardName(right);
    if (a === null || b === null)
      return a === b ? steady(left, right) : a === null ? 1 : -1;
    return collator.compare(a, b) || steady(left, right);
  });
}

/** "9 / 8" over its WIP limit (warn), "5" without one. */
export function stageCount(
  count: number,
  limit: number | null,
): { text: string; over: boolean; label: string } {
  const cards = `${count} ${count === 1 ? "card" : "cards"}`;
  if (limit === null) return { text: String(count), over: false, label: cards };
  const over = count > limit;
  return {
    text: `${count} / ${limit}`,
    over,
    label: over
      ? `${cards}, over its limit of ${limit}`
      : `${cards}, limit ${limit}`,
  };
}

/** "25 of 41 · Show 16 more" under a long stage (BR67). */
export function stagePage(
  total: number,
  shown: number,
): { shown: number; line: string | null; more: string | null; next: number } {
  const visible = Math.min(total, shown);
  if (visible >= total)
    return { shown: visible, line: null, more: null, next: visible };
  const step = Math.min(KANBAN_PAGE, total - visible);
  return {
    shown: visible,
    line: `${visible} of ${total}`,
    more: `Show ${step} more`,
    next: visible + step,
  };
}

/**
 * The server place for a drop (`PATCH position`): the index, among the
 * stage's whole rank order without the moving card, of the visible card
 * below the slot. `visible` is the stage's filtered display order and
 * `slot` counts its places without the moving card. With no card below,
 * or in a sorted stage, the card is appended (null).
 */
export function dropPosition({
  full,
  visible,
  movingId,
  slot,
  manual,
}: {
  full: readonly string[];
  visible: readonly string[];
  movingId: string;
  slot: number;
  manual: boolean;
}): number | null {
  if (!manual) return null;
  const below = visible.filter((id) => id !== movingId)[slot];
  if (below === undefined) return null;
  const index = full.filter((id) => id !== movingId).indexOf(below);
  return index < 0 ? null : index;
}

/**
 * The board as it looks right after a move, before the server answers: the
 * card takes a rank between its new neighbours, so rank order draws it in
 * place. The server's answer replaces it.
 */
export function applyMove(
  cards: readonly KanbanCard[],
  cardId: string,
  stageId: string,
  position: number | null,
): KanbanCard[] {
  const moving = cards.find((card) => card.id === cardId);
  if (!moving) return [...cards];
  const siblings = cards
    .filter((card) => card.stageId === stageId && card.id !== cardId)
    .sort(byRank);
  const index =
    position === null ? siblings.length : Math.min(position, siblings.length);
  const before = index > 0 ? siblings[index - 1].rank : null;
  const after = index < siblings.length ? siblings[index].rank : null;
  const rank =
    before === null && after === null
      ? 1024
      : before === null
        ? (after as number) - 1024
        : after === null
          ? before + 1024
          : (before + after) / 2;
  return cards.map((card) =>
    card.id === cardId ? { ...card, stageId, rank } : card,
  );
}

export type KanbanDue = "overdue" | "week";
export type KanbanGroup = "assignee" | "label";
export type KanbanFilters = {
  search: string;
  assignee: string | null;
  labels: string[];
  due: KanbanDue | null;
  group: KanbanGroup | null;
};
export const NO_FILTERS: KanbanFilters = {
  search: "",
  assignee: null,
  labels: [],
  due: null,
  group: null,
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The viewer's filters, from the URL (BR68); unknown words are ignored. */
export function parseKanbanFilters(search: string): KanbanFilters {
  const params = new URLSearchParams(search);
  const assignee = params.get("assignee");
  const due = params.get("due");
  const group = params.get("group");
  return {
    search: (params.get("search") ?? "").slice(0, 100),
    assignee: assignee && uuidPattern.test(assignee) ? assignee : null,
    labels: [
      ...new Set(params.getAll("label").filter((id) => uuidPattern.test(id))),
    ].slice(0, 20),
    due: due === "overdue" || due === "week" ? due : null,
    group: group === "assignee" || group === "label" ? group : null,
  };
}

/** The URL words for the filters; null removes a word. */
export function kanbanFilterParams(filters: KanbanFilters): {
  search: string | null;
  assignee: string | null;
  label: string[];
  due: KanbanDue | null;
  group: KanbanGroup | null;
} {
  return {
    search: filters.search || null,
    assignee: filters.assignee,
    label: filters.labels,
    due: filters.due,
    group: filters.group,
  };
}

export function hasCardFilters(filters: KanbanFilters): boolean {
  return Boolean(
    filters.search ||
    filters.assignee ||
    filters.labels.length > 0 ||
    filters.due,
  );
}

/**
 * The cards a filter keeps. Search reads the name the viewer sees, so a
 * locked card never matches it. "This week" is the workspace's week.
 */
export function filterCards(
  cards: readonly KanbanCard[],
  filters: KanbanFilters,
  calendar: { today: string; weekStart: WeekStart },
): KanbanCard[] {
  const needle = filters.search.trim().toLocaleLowerCase();
  // Due filters wait for the workspace's day; until then they keep cards.
  const due = calendar.today ? filters.due : null;
  const weekStart =
    due === "week" ? startOfWeek(calendar.today, calendar.weekStart) : "";
  const weekEnd = due === "week" ? addDays(weekStart, 6) : "";
  return cards.filter((card) => {
    if (
      needle &&
      (card.record?.locked ||
        !cardName(card).toLocaleLowerCase().includes(needle))
    )
      return false;
    if (filters.assignee && card.assigneeId !== filters.assignee) return false;
    if (
      filters.labels.length > 0 &&
      !card.labelIds.some((id) => filters.labels.includes(id))
    )
      return false;
    if (due === "overdue")
      return card.dueOn !== null && card.dueOn < calendar.today;
    if (due === "week")
      return (
        card.dueOn !== null && card.dueOn >= weekStart && card.dueOn <= weekEnd
      );
    return true;
  });
}

/** An overdue date reads in warn (BR67). */
export function isOverdue(card: KanbanCard, today: string): boolean {
  return card.dueOn !== null && card.dueOn < today;
}

export function shortDate(date: string, region: WorkspaceRegion): string {
  return formatWorkspaceDate(date, region, { month: "short", day: "numeric" });
}

/** "Due Oct 30", or "Overdue · Oct 22" in warn (BR67). */
export function dueWords(
  card: KanbanCard,
  region: WorkspaceRegion,
  today: string,
): { text: string; late: boolean } | null {
  if (!card.dueOn) return null;
  const late = isOverdue(card, today);
  const day = shortDate(card.dueOn, region);
  return { text: late ? `Overdue · ${day}` : `Due ${day}`, late };
}

export type Swimlane = { id: string; name: string; cards: KanbanCard[] };

/**
 * Swimlanes (BR68): one lane per assignee by name, or per label in board
 * order (a card sits in the lane of its first label); the lane of cards
 * with none comes last. Lanes with no card are left out.
 */
export function swimlanes(
  cards: readonly KanbanCard[],
  group: KanbanGroup,
  labels: readonly KanbanLabel[],
  personName: (id: string) => string | null,
): Swimlane[] {
  const lanes = new Map<string, Swimlane>();
  const add = (id: string, name: string, card: KanbanCard) => {
    const lane = lanes.get(id);
    if (lane) lane.cards.push(card);
    else lanes.set(id, { id, name, cards: [card] });
  };
  const ordered = [...labels].sort(
    (left, right) => left.position - right.position,
  );
  for (const card of cards) {
    if (group === "assignee") {
      if (card.assigneeId)
        add(
          `assignee:${card.assigneeId}`,
          personName(card.assigneeId) ?? "Assignee",
          card,
        );
      else add("assignee:none", "No assignee", card);
      continue;
    }
    const first = ordered.find((label) => card.labelIds.includes(label.id));
    if (first) add(`label:${first.id}`, first.name, card);
    else add("label:none", "No label", card);
  }
  const empty = group === "assignee" ? "assignee:none" : "label:none";
  const named = [...lanes.values()].filter((lane) => lane.id !== empty);
  if (group === "assignee")
    named.sort((left, right) => collator.compare(left.name, right.name));
  else {
    const rank = new Map(
      ordered.map((label, index) => [`label:${label.id}`, index]),
    );
    named.sort(
      (left, right) => (rank.get(left.id) ?? 0) - (rank.get(right.id) ?? 0),
    );
  }
  const last = lanes.get(empty);
  return last ? [...named, last] : named;
}

export type RecordDateChoice = { fieldId: string; name: string; date: string };

function dateInZone(value: string, timezone: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * The record's date and datetime values a new record card can take as its
 * start and due (BR63), in field order. A datetime is read as its day in
 * the workspace's zone.
 */
export function recordDateChoices(
  fields: readonly {
    id: string;
    name: string;
    type: string;
    position: number;
  }[],
  data: Record<string, unknown>,
  timezone: string,
): RecordDateChoice[] {
  return [...fields]
    .filter((field) => field.type === "date" || field.type === "datetime")
    .sort((left, right) => left.position - right.position)
    .flatMap((field) => {
      const value = data[field.id];
      const date =
        typeof value === "string" ? dateInZone(value, timezone) : null;
      return date ? [{ fieldId: field.id, name: field.name, date }] : [];
    });
}

/** The first date is the start and the second the due; one date is the due. */
export function defaultCardDates(choices: readonly RecordDateChoice[]): {
  start: string | null;
  due: string | null;
} {
  if (choices.length === 0) return { start: null, due: null };
  if (choices.length === 1) return { start: null, due: choices[0].fieldId };
  return { start: choices[0].fieldId, due: choices[1].fieldId };
}

const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The record field values a card shows (BR67), in the workspace's words:
 * a date reads "Nov 5" and a datetime "Nov 5, 9:00 AM" in the workspace
 * zone, never the stored ISO text. A date that is the card's due date is
 * left out, since the fact line already says "Due Nov 5".
 */
export function recordFieldTexts(
  card: KanbanCard,
  region: WorkspaceRegion,
): string[] {
  const record = card.record && !card.record.locked ? card.record : null;
  if (!record) return [];
  return record.fields.slice(0, 2).flatMap(({ value }) => {
    const plainDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const datetime = !plainDate && ISO_DATETIME.test(value);
    if (!plainDate && !datetime) return [value];
    if (plainDate && value === card.dueOn) return [];
    return [
      plainDate
        ? shortDate(value, region)
        : formatWorkspaceDateTime(value, region, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          }),
    ];
  });
}

/**
 * The accessible name of a card: its name first, then what it is, then
 * what its face shows (labels, a record's status and fields, the due date,
 * the checklist, the assignee), so the face reads the same to everyone.
 */
export function cardLabel(
  card: KanbanCard,
  face: {
    region: WorkspaceRegion;
    today: string;
    labelNames: readonly string[];
    assignee: string | null;
  },
): string {
  const due = dueWords(card, face.region, face.today);
  const record = card.record && !card.record.locked ? card.record : null;
  const parts = [
    cardName(card),
    record ? `${record.moduleName} record` : "objective",
    face.labelNames.length > 0 ? `labels ${face.labelNames.join(", ")}` : null,
    record?.status ? `${record.status.name} ${record.status.value}` : null,
    ...recordFieldTexts(card, face.region),
    due ? due.text.toLocaleLowerCase() : null,
    card.checklist.total > 0
      ? `${card.checklist.done} of ${card.checklist.total} done`
      : null,
    face.assignee ? `assigned to ${face.assignee}` : null,
  ];
  return parts.filter(Boolean).join(", ");
}
