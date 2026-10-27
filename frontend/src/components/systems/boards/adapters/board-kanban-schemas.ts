import { z } from "zod";

/**
 * The board Kanban's wire shapes (BE7): stages, labels, and cards, shared by
 * the Kanban, "Cards · Due" on a board calendar, and "My cards · Due". A
 * record card's summary is computed for this viewer at read time; a record
 * the viewer cannot read arrives locked, with nothing about it (BR63).
 */

export const uuid = z.string().uuid();
const date = z.iso.date();
const stamp = z.iso.datetime({ offset: true });

export const CHART_COLORS = [
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
] as const;
export type ChartColor = (typeof CHART_COLORS)[number];
const chartColor = z.enum(CHART_COLORS);

export const CARD_SORTS = ["manual", "due", "newest", "title"] as const;
export type CardSort = (typeof CARD_SORTS)[number];

export const pagination = z
  .object({
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0),
    count: z.number().int().min(0),
    total: z.number().int().min(0),
    has_more: z.boolean(),
  })
  .strict();

const recordField = z
  .object({ field_id: uuid, name: z.string(), value: z.string() })
  .strict()
  .transform((field) => ({
    fieldId: field.field_id,
    name: field.name,
    value: field.value,
  }));
const recordSummary = z
  .object({
    locked: z.literal(false).default(false),
    record_id: uuid,
    module_id: uuid,
    module_name: z.string(),
    title: z.string(),
    fields: z.array(recordField),
    status: recordField.nullable(),
  })
  .strict()
  .transform((record) => ({
    locked: false as const,
    recordId: record.record_id,
    moduleId: record.module_id,
    moduleName: record.module_name,
    title: record.title,
    fields: record.fields,
    status: record.status,
  }));
const lockedRecord = z
  .object({ locked: z.literal(true) })
  .strict()
  .transform(() => ({ locked: true as const }));

export const cardShape = {
  id: uuid,
  board_id: uuid,
  stage_id: uuid,
  kind: z.enum(["objective", "record"]),
  title: z.string().nullable(),
  rank: z.number().int(),
  assignee_id: uuid.nullable(),
  start_on: date.nullable(),
  due_on: date.nullable(),
  label_ids: z.array(uuid),
  checklist: z
    .object({ done: z.number().int(), total: z.number().int() })
    .strict(),
  archived_at: stamp.nullable(),
  revision: z.number().int(),
  created_at: stamp,
  updated_at: stamp,
  record: z.union([lockedRecord, recordSummary]).nullable(),
};

type CardInput = z.output<z.ZodObject<typeof cardShape>>;

export function toCard(card: CardInput) {
  return {
    id: card.id,
    boardId: card.board_id,
    stageId: card.stage_id,
    kind: card.kind,
    title: card.title,
    rank: card.rank,
    assigneeId: card.assignee_id,
    startOn: card.start_on,
    dueOn: card.due_on,
    labelIds: card.label_ids,
    checklist: card.checklist,
    archivedAt: card.archived_at,
    revision: card.revision,
    createdAt: card.created_at,
    updatedAt: card.updated_at,
    record: card.record,
  };
}

/** A card as the Kanban, the Gantt and the calendars draw it. */
export const cardWire = z.object(cardShape).strict().transform(toCard);
/** `POST /cards` and `PATCH /cards/{id}` answer with the detail. */
export const cardDetailWire = z
  .object({
    ...cardShape,
    description: z.string().nullable(),
    checklist_items: z.array(z.unknown()),
  })
  .strict()
  .transform(toCard);
export type KanbanCard = z.output<typeof cardWire>;

export const checklistItemWire = z
  .object({
    id: uuid,
    card_id: uuid,
    text: z.string().min(1).max(200),
    done: z.boolean(),
    position: z.number().int(),
    revision: z.number().int(),
  })
  .strict()
  .transform((item) => ({
    id: item.id,
    cardId: item.card_id,
    text: item.text,
    done: item.done,
    position: item.position,
    revision: item.revision,
  }));
export type ChecklistItem = z.output<typeof checklistItemWire>;
export const checklistItemsWire = z
  .object({ items: z.array(checklistItemWire).max(50) })
  .strict();

/**
 * A card as its sheet reads it (BR64): the card, its description, and its
 * checklist in order. `PATCH /cards/{id}` answers with the same shape.
 */
export const cardSheetWire = z
  .object({
    ...cardShape,
    description: z.string().nullable(),
    checklist_items: z.array(checklistItemWire).max(50),
  })
  .strict()
  .transform((card) => ({
    card: toCard(card),
    description: card.description,
    checklist: [...card.checklist_items].sort(
      (left, right) => left.position - right.position,
    ),
  }));
export type CardSheet = z.output<typeof cardSheetWire>;
export type KanbanRecord = NonNullable<KanbanCard["record"]>;

/** One page of a card list; `extend` adds fields such as the card's board. */
export function cardPageWire<Item extends z.ZodType>(item: Item) {
  return z
    .object({ items: z.array(item), pagination })
    .strict()
    .refine(
      ({ items, pagination: page }) =>
        items.length === page.count &&
        page.has_more === page.offset + page.count < page.total,
    );
}

export const stageWire = z
  .object({
    id: uuid,
    board_id: uuid,
    name: z.string().min(1),
    color: chartColor.nullable(),
    wip_limit: z.number().int().min(1).nullable(),
    card_sort: z.enum(CARD_SORTS),
    position: z.number().int(),
    revision: z.number().int(),
    archived_at: stamp.nullable(),
    card_count: z.number().int().min(0),
  })
  .strict()
  .transform((stage) => ({
    id: stage.id,
    boardId: stage.board_id,
    name: stage.name,
    color: stage.color,
    wipLimit: stage.wip_limit,
    cardSort: stage.card_sort,
    position: stage.position,
    revision: stage.revision,
    cardCount: stage.card_count,
  }));
export type KanbanStage = z.output<typeof stageWire>;
export const stageListWire = z
  .object({ items: z.array(stageWire).max(100), pagination })
  .strict();
export const stageItemsWire = z
  .object({ items: z.array(stageWire).max(100) })
  .strict();

export const labelWire = z
  .object({
    id: uuid,
    board_id: uuid,
    name: z.string().min(1),
    color: chartColor,
    position: z.number().int(),
    revision: z.number().int(),
  })
  .strict()
  .transform((label) => ({
    id: label.id,
    boardId: label.board_id,
    name: label.name,
    color: label.color,
    position: label.position,
    revision: label.revision,
  }));
export type KanbanLabel = z.output<typeof labelWire>;
export const labelListWire = z
  .object({ items: z.array(labelWire).max(100), pagination })
  .strict();
