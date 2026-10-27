import { z } from "zod";
import { ApiContractError, apiFetch } from "@/lib/api";
import { recordSchema } from "../../openview/adapters/views-schemas";
import type { OpenViewRecord } from "../../openview/adapters/views-api";
import {
  cardSheetWire,
  checklistItemWire,
  checklistItemsWire,
  pagination,
  uuid,
  type CardSheet,
  type ChecklistItem,
} from "./board-kanban-schemas";

/**
 * A card sheet's reads and commands (BR64, BR81): the card with its
 * description and checklist, one revisioned field change, the checklist,
 * the card's activity from the audit log, and a record card's record.
 */

function boardPath(boardId: string, rest: string): string {
  return `/boards/${uuid.parse(boardId)}${rest}`;
}

function checkSheet(boardId: string, cardId: string, sheet: CardSheet) {
  if (sheet.card.boardId !== boardId || sheet.card.id !== cardId)
    throw new ApiContractError();
  if (sheet.checklist.some((item) => item.cardId !== cardId))
    throw new ApiContractError();
  return sheet;
}

/** One card with its description and checklist, for its sheet. */
export async function readCardSheet(
  boardId: string,
  cardId: string,
  signal?: AbortSignal,
): Promise<CardSheet> {
  const sheet = await apiFetch(
    boardPath(boardId, `/cards/${uuid.parse(cardId)}`),
    cardSheetWire,
    { cache: "no-store", signal },
  );
  return checkSheet(boardId, cardId, sheet);
}

/** The fields a card sheet changes; each change names only what changed. */
export type CardFieldChanges = Partial<{
  title: string;
  description: string | null;
  assigneeId: string | null;
  startOn: string | null;
  dueOn: string | null;
  labelIds: readonly string[];
}>;

/** The PATCH body: the revision the edit started from, then the changes. */
export function cardFieldsBody(
  revision: number,
  changes: CardFieldChanges,
): Record<string, unknown> {
  const body: Record<string, unknown> = { revision };
  if (changes.title !== undefined) body.title = changes.title.trim();
  if (changes.description !== undefined)
    body.description = changes.description?.trim() || null;
  if (changes.assigneeId !== undefined)
    body.assignee_id =
      changes.assigneeId === null ? null : uuid.parse(changes.assigneeId);
  if (changes.startOn !== undefined) body.start_on = changes.startOn || null;
  if (changes.dueOn !== undefined) body.due_on = changes.dueOn || null;
  if (changes.labelIds !== undefined)
    body.label_ids = changes.labelIds.map((id) => uuid.parse(id));
  return body;
}

/** Save card fields with the revision the edit started from. */
export async function saveCardFields(
  boardId: string,
  card: { id: string; revision: number },
  changes: CardFieldChanges,
): Promise<CardSheet> {
  const sheet = await apiFetch(
    boardPath(boardId, `/cards/${uuid.parse(card.id)}`),
    cardSheetWire,
    {
      method: "PATCH",
      cache: "no-store",
      body: JSON.stringify(cardFieldsBody(card.revision, changes)),
    },
  );
  return checkSheet(boardId, card.id, sheet);
}

export async function addChecklistItem(
  boardId: string,
  cardId: string,
  text: string,
): Promise<ChecklistItem> {
  const item = await apiFetch(
    boardPath(boardId, `/cards/${uuid.parse(cardId)}/checklist`),
    checklistItemWire,
    {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({ text: text.trim() }),
    },
  );
  if (item.cardId !== cardId) throw new ApiContractError();
  return item;
}

/** Tick, untick or rename one item, with the item's own revision. */
export async function updateChecklistItem(
  boardId: string,
  item: { id: string; revision: number },
  changes: Partial<{ text: string; done: boolean }>,
): Promise<ChecklistItem> {
  const body: Record<string, unknown> = { revision: item.revision };
  if (changes.text !== undefined) body.text = changes.text.trim();
  if (changes.done !== undefined) body.done = changes.done;
  const saved = await apiFetch(
    boardPath(boardId, `/checklist/${uuid.parse(item.id)}`),
    checklistItemWire,
    { method: "PATCH", cache: "no-store", body: JSON.stringify(body) },
  );
  if (saved.id !== item.id) throw new ApiContractError();
  return saved;
}

export async function deleteChecklistItem(
  boardId: string,
  item: { id: string; revision: number },
): Promise<void> {
  await apiFetch(
    boardPath(boardId, `/checklist/${uuid.parse(item.id)}`),
    z.null(),
    {
      method: "DELETE",
      cache: "no-store",
      body: JSON.stringify({ revision: item.revision }),
    },
  );
}

/** The whole checklist in its new order; the server refuses a stale list. */
export async function orderChecklist(
  boardId: string,
  cardId: string,
  itemIds: readonly string[],
): Promise<ChecklistItem[]> {
  const { items } = await apiFetch(
    boardPath(boardId, `/cards/${uuid.parse(cardId)}/checklist/order`),
    checklistItemsWire,
    {
      method: "PUT",
      cache: "no-store",
      body: JSON.stringify({ item_ids: itemIds.map((id) => uuid.parse(id)) }),
    },
  );
  if (items.some((item) => item.cardId !== cardId))
    throw new ApiContractError();
  return items;
}

const activityWire = z
  .object({
    id: uuid,
    created_at: z.iso.datetime({ offset: true }),
    kind: z.enum(["card", "label", "checklist"]),
    action: z.enum(["create", "update", "delete"]),
    summary: z.string().min(1),
    actor_label: z.string().nullable(),
  })
  .strict()
  .transform((row) => ({
    id: row.id,
    at: row.created_at,
    summary: row.summary,
    actor: row.actor_label,
  }));
export type CardActivity = z.output<typeof activityWire>;
const activityPageWire = z
  .object({ items: z.array(activityWire), pagination })
  .strict();

export const CARD_ACTIVITY_PAGE = 25;

/** A card's activity, newest first, read from the audit log (BR81). */
export async function listCardActivity(
  boardId: string,
  cardId: string,
  offset: number,
  signal?: AbortSignal,
): Promise<{ items: CardActivity[]; hasMore: boolean }> {
  const query = new URLSearchParams({
    limit: String(CARD_ACTIVITY_PAGE),
    offset: String(z.number().int().min(0).parse(offset)),
    sort_order: "desc",
  });
  const page = await apiFetch(
    boardPath(boardId, `/cards/${uuid.parse(cardId)}/activity?${query}`),
    activityPageWire,
    { cache: "no-store", signal },
  );
  if (page.pagination.offset !== offset) throw new ApiContractError();
  return { items: page.items, hasMore: page.pagination.has_more };
}

/**
 * A record card's record for the shared record sheet (BR64). A plain read:
 * a refusal here must not set OpenView's access latch for the account.
 */
export async function readCardRecord(
  recordId: string,
  signal?: AbortSignal,
): Promise<OpenViewRecord> {
  const record = await apiFetch(
    `/records/${uuid.parse(recordId)}`,
    recordSchema,
    { cache: "no-store", signal },
  );
  if (record.id !== recordId) throw new ApiContractError();
  return record;
}
