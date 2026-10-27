import { z } from "zod";
import { ApiContractError, ApiError, apiFetch } from "@/lib/api";
import { occurrenceBoardWire } from "./board-events-schemas";

type OccurrenceBoard = z.output<typeof occurrenceBoardWire>;

/**
 * "Cards · Due" on a board calendar (BR58): the board's cards whose due date
 * falls in the visible window, and the stage names its summary popover
 * shows. A record card the viewer cannot read arrives locked, with no name.
 * The Kanban (P4) owns the rest of the card contract.
 */

const uuid = z.string().uuid();
const date = z.iso.date();
const PAGE = 100;
/** A runaway guard: 50 pages is 5,000 due cards in one window. */
const MAX_PAGES = 50;

const pagination = z
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
  .strict();
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
  }));
const lockedRecord = z
  .object({ locked: z.literal(true) })
  .strict()
  .transform(() => ({ locked: true as const }));

const cardWire = z
  .object({
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
    archived_at: z.iso.datetime({ offset: true }).nullable(),
    revision: z.number().int(),
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
    record: z.union([lockedRecord, recordSummary]).nullable(),
  })
  .strict();
const cardPageWire = z
  .object({ items: z.array(cardWire), pagination })
  .strict()
  .refine(
    ({ items, pagination: page }) =>
      items.length === page.count &&
      page.has_more === page.offset + page.count < page.total,
  );

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

/** Every card due in the window, read page by page to the end. */
export async function listDueBoardCards(
  rawBoardId: string,
  window: { from: string; to: string },
): Promise<DueCard[]> {
  const boardId = uuid.parse(rawBoardId);
  const from = date.parse(window.from);
  const to = date.parse(window.to);
  const cards: DueCard[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      due_from: from,
      due_to: to,
      limit: String(PAGE),
      offset: String(cards.length),
    });
    let result: z.output<typeof cardPageWire>;
    try {
      result = await apiFetch(
        `/boards/${boardId}/cards?${query.toString()}`,
        cardPageWire,
        { cache: "no-store" },
      );
    } catch (error) {
      throw safe(error);
    }
    if (result.pagination.offset !== cards.length) throw new ApiContractError();
    for (const card of result.items) {
      if (card.board_id !== boardId || card.due_on === null)
        throw new ApiContractError();
      cards.push({
        id: card.id,
        kind: card.kind,
        title: card.title,
        dueOn: card.due_on,
        stageId: card.stage_id,
        assigneeId: card.assignee_id,
        record: card.record,
      });
    }
    if (!result.pagination.has_more) return cards;
  }
  throw new ApiContractError();
}

const stageListWire = z
  .object({
    items: z.array(
      z.object({ id: uuid, board_id: uuid, name: z.string() }).passthrough(),
    ),
    pagination,
  })
  .strict();

/** The board's stage names, for a due card's summary. */
export async function listBoardStageNames(
  rawBoardId: string,
): Promise<{ id: string; name: string }[]> {
  const boardId = uuid.parse(rawBoardId);
  try {
    const page = await apiFetch(
      `/boards/${boardId}/stages?limit=100&offset=0`,
      stageListWire,
      { cache: "no-store" },
    );
    if (page.items.some((stage) => stage.board_id !== boardId))
      throw new ApiContractError();
    return page.items.map(({ id, name }) => ({ id, name }));
  } catch (error) {
    throw safe(error);
  }
}

export type MyDueCard = DueCard & { board: OccurrenceBoard };

const myCardPageWire = z
  .object({
    items: z.array(cardWire.extend({ board: occurrenceBoardWire }).strict()),
    pagination,
  })
  .strict()
  .refine(
    ({ items, pagination: page }) =>
      items.length === page.count &&
      page.has_more === page.offset + page.count < page.total,
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
      if (card.board_id !== card.board.id || card.due_on === null)
        throw new ApiContractError();
      cards.push({
        id: card.id,
        kind: card.kind,
        title: card.title,
        dueOn: card.due_on,
        stageId: card.stage_id,
        assigneeId: card.assignee_id,
        record: card.record,
        board: card.board,
      });
    }
    if (!result.pagination.has_more) return cards;
  }
  throw new ApiContractError();
}
