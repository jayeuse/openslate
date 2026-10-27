import { z } from "zod";
import { ApiContractError, ApiError, apiFetch } from "@/lib/api";
import { occurrenceBoardWire } from "./board-events-schemas";
import { listBoardCards, listKanbanStages } from "./board-kanban-api";
import {
  cardPageWire,
  cardShape,
  toCard,
  type KanbanCard,
} from "./board-kanban-schemas";

type OccurrenceBoard = z.output<typeof occurrenceBoardWire>;

/**
 * "Cards · Due" on a board calendar (BR58): the board's cards whose due date
 * falls in the visible window, and the stage names its summary popover
 * shows. A record card the viewer cannot read arrives locked, with no name.
 * The Kanban (P4) owns the rest of the card contract.
 */

const date = z.iso.date();
const PAGE = 100;
/** A runaway guard: 50 pages is 5,000 due cards in one window. */
const MAX_PAGES = 50;

export type DueCard = {
  id: string;
  kind: "objective" | "record";
  title: string | null;
  dueOn: string;
  stageId: string;
  assigneeId: string | null;
  record:
    | { locked: true }
    | {
        locked: false;
        recordId: string;
        moduleId: string;
        moduleName: string;
        title: string;
      }
    | null;
};

function safe(error: unknown): unknown {
  return error instanceof ApiError
    ? new ApiError(error.status, "Request could not be completed")
    : error;
}

/** A due card's record, as the calendars name it. */
function dueRecord(record: KanbanCard["record"]): DueCard["record"] {
  if (record === null || record.locked) return record;
  return {
    locked: false,
    recordId: record.recordId,
    moduleId: record.moduleId,
    moduleName: record.moduleName,
    title: record.title,
  };
}

function dueCard(card: KanbanCard): DueCard {
  if (card.dueOn === null) throw new ApiContractError();
  return {
    id: card.id,
    kind: card.kind,
    title: card.title,
    dueOn: card.dueOn,
    stageId: card.stageId,
    assigneeId: card.assigneeId,
    record: dueRecord(card.record),
  };
}

/** Every card due in the window, read page by page to the end. */
export async function listDueBoardCards(
  boardId: string,
  window: { from: string; to: string },
): Promise<DueCard[]> {
  const filter = {
    dueFrom: date.parse(window.from),
    dueTo: date.parse(window.to),
  };
  try {
    return (await listBoardCards(boardId, filter)).map(dueCard);
  } catch (error) {
    throw safe(error);
  }
}

/** The board's stage names, for a due card's summary. */
export async function listBoardStageNames(
  boardId: string,
): Promise<{ id: string; name: string }[]> {
  try {
    return (await listKanbanStages(boardId)).map(({ id, name }) => ({
      id,
      name,
    }));
  } catch (error) {
    throw safe(error);
  }
}

export type MyDueCard = DueCard & { board: OccurrenceBoard };

const myCardPageWire = cardPageWire(
  z
    .object({ ...cardShape, board: occurrenceBoardWire })
    .strict()
    .transform(({ board, ...card }) => ({ ...toCard(card), board })),
);

/**
 * "My cards · Due" (BR58): the person's cards due in the window on every
 * board they read, in one merged list read page by page to the end.
 */
export async function listMyDueCards(window: {
  from: string;
  to: string;
}): Promise<MyDueCard[]> {
  const from = date.parse(window.from);
  const to = date.parse(window.to);
  const cards: MyDueCard[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      from,
      to,
      limit: String(PAGE),
      offset: String(cards.length),
    });
    let result: z.output<typeof myCardPageWire>;
    try {
      result = await apiFetch(
        `/boards/cards/due?${query.toString()}`,
        myCardPageWire,
        { cache: "no-store" },
      );
    } catch (error) {
      throw safe(error);
    }
    if (result.pagination.offset !== cards.length) throw new ApiContractError();
    for (const card of result.items) {
      if (card.boardId !== card.board.id) throw new ApiContractError();
      cards.push({ ...dueCard(card), board: card.board });
    }
    if (!result.pagination.has_more) return cards;
  }
  throw new ApiContractError();
}
