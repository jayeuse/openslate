import type { WorkspaceRegion } from "@/lib/date-time";
import type {
  ChecklistItem,
  KanbanCard,
} from "../adapters/board-kanban-schemas";
import { dueWords } from "./kanban";

/**
 * A card sheet's rules (BR64): its one meta line, the checklist's count,
 * order and limit, who can be the assignee, and the card's own address.
 */

/** A card holds at most this many checklist items (BE7). */
export const MAX_CHECKLIST_ITEMS = 50;

/** "Doing · Due Oct 30"; the due part is in warn when it is overdue. */
export function cardMetaLine(
  card: KanbanCard,
  stageName: string | null,
  region: WorkspaceRegion,
  today: string,
): { stage: string | null; due: string | null; late: boolean; text: string } {
  const due = dueWords(card, region, today);
  return {
    stage: stageName,
    due: due?.text ?? null,
    late: due?.late ?? false,
    text: [stageName, due?.text].filter(Boolean).join(" · "),
  };
}

/** "3/5", or null when the card has no checklist. */
export function checklistCount(items: readonly ChecklistItem[]): string | null {
  if (items.length === 0) return null;
  return `${items.filter((item) => item.done).length}/${items.length}`;
}

export function canAddChecklistItem(items: readonly ChecklistItem[]): boolean {
  return items.length < MAX_CHECKLIST_ITEMS;
}

/**
 * The checklist's order after one item moves up (-1) or down (+1): the ids
 * the server takes, or null when the item is already at that end.
 */
export function movedChecklist(
  items: readonly ChecklistItem[],
  itemId: string,
  offset: -1 | 1,
): string[] | null {
  const ids = items.map((item) => item.id);
  const from = ids.indexOf(itemId);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  [ids[from], ids[to]] = [ids[to], ids[from]];
  return ids;
}

/**
 * The card's own board address (J4): the board, the Kanban, and the card,
 * never the viewer's filters.
 */
export function cardLink(
  origin: string,
  boardId: string,
  cardId: string,
): string {
  const query = new URLSearchParams({
    board: boardId,
    section: "kanban",
    card: cardId,
  });
  return `${origin}/boards?${query.toString()}`;
}
