import { z } from "zod";
import { ApiContractError, ApiError, apiFetch, apiRequest } from "@/lib/api";
import {
  cardDetailWire,
  cardPageWire,
  cardWire,
  labelListWire,
  labelWire,
  stageItemsWire,
  stageListWire,
  stageWire,
  uuid,
  type CardSort,
  type ChartColor,
  type KanbanCard,
  type KanbanLabel,
  type KanbanStage,
} from "./board-kanban-schemas";
import { recordSchema } from "../../openview/adapters/views-schemas";

/**
 * The board Kanban's reads and commands (BE7). Managers change stages and
 * labels; writers add, move, label and archive cards; readers read. Every
 * change carries the revision it was made on, and a stale one is refused.
 */

const PAGE = 100;
/** A runaway guard: 50 pages is 5,000 active cards on one board. */
const MAX_PAGES = 50;

/** Plain sentences for the refusals the Kanban can meet (the Few Words Rule). */
const MESSAGES: Record<string, string> = {
  stale_card_revision: "Someone changed this card first.",
  stale_stage_revision: "Someone changed this stage first.",
  stale_label_revision: "Someone changed this label first.",
  card_conflict: "The board changed. Reload it and try again.",
  stage_unavailable: "That stage was archived. Reload the board.",
  record_card_exists: "This record already has a card on this board.",
  record_locked: "You can only move or archive this card.",
  card_archived: "This card is archived.",
  board_archived: "Archived boards are read-only.",
  stage_limit: "A board has at most 20 stages.",
  label_limit: "A board has at most 20 labels.",
  label_exists: "A label with this name already exists.",
  label_unavailable: "A label is no longer on this board.",
  assignee_unavailable: "That person cannot read this board.",
  card_dates_invalid: "The start must not be after the due date.",
  stale_checklist_revision: "Someone changed this checklist first.",
  checklist_order_stale: "Someone changed this checklist first.",
  checklist_conflict: "Someone changed this checklist first.",
  checklist_limit: "A card has at most 50 checklist items.",
  checklist_objectives_only: "Only objectives have a checklist.",
  card_objectives_only: "Only objectives have files and linked records.",
};

/** What a failed Kanban request tells the person; never the server's words. */
export function kanbanErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const code =
      typeof error.code === "string"
        ? error.code
        : z.object({ code: z.string() }).passthrough().safeParse(error.details)
            .data?.code;
    if (code && code in MESSAGES) return MESSAGES[code];
    if (error.status === 403 || error.status === 404)
      return "You no longer have access to change this board.";
  }
  return "The change was not saved. Try again.";
}

/** A stale revision: the client reads the board again before anything else. */
export function isStaleKanbanWrite(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    kanbanErrorMessage(error).startsWith("Someone changed")
  );
}

function boardPath(boardId: string, rest = ""): string {
  return `/boards/${uuid.parse(boardId)}${rest}`;
}

/** Every active stage in board order, with its active card count. */
export async function listKanbanStages(
  boardId: string,
): Promise<KanbanStage[]> {
  const page = await apiFetch(
    boardPath(boardId, "/stages?limit=100&offset=0"),
    stageListWire,
    { cache: "no-store" },
  );
  if (page.items.some((stage) => stage.boardId !== boardId))
    throw new ApiContractError();
  return [...page.items].sort((left, right) => left.position - right.position);
}

/** The board's labels in board order. */
export async function listKanbanLabels(
  boardId: string,
): Promise<KanbanLabel[]> {
  const page = await apiFetch(
    boardPath(boardId, "/labels?limit=100&offset=0"),
    labelListWire,
    { cache: "no-store" },
  );
  if (page.items.some((label) => label.boardId !== boardId))
    throw new ApiContractError();
  return [...page.items].sort((left, right) => left.position - right.position);
}

const cardsPage = cardPageWire(cardWire);

/**
 * The board's active cards, read page by page to the end. The Kanban needs
 * the whole order of every stage: a drop names its place in it.
 */
export async function listBoardCards(
  rawBoardId: string,
  filter: { dueFrom: string; dueTo: string } | null = null,
): Promise<KanbanCard[]> {
  const boardId = uuid.parse(rawBoardId);
  const cards: KanbanCard[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      ...(filter ? { due_from: filter.dueFrom, due_to: filter.dueTo } : {}),
      limit: String(PAGE),
      offset: String(cards.length),
    });
    const result = await apiFetch(
      boardPath(boardId, `/cards?${query.toString()}`),
      cardsPage,
      { cache: "no-store" },
    );
    if (result.pagination.offset !== cards.length) throw new ApiContractError();
    for (const card of result.items) {
      if (card.boardId !== boardId) throw new ApiContractError();
      cards.push(card);
    }
    if (!result.pagination.has_more) return cards;
  }
  throw new ApiContractError();
}

function checkCard(boardId: string, card: KanbanCard): KanbanCard {
  if (card.boardId !== boardId) throw new ApiContractError();
  return card;
}

export async function createKanbanStage(
  boardId: string,
  input: { name: string; color: ChartColor | null },
): Promise<KanbanStage> {
  return apiFetch(boardPath(boardId, "/stages"), stageWire, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({ name: input.name, color: input.color }),
  });
}

export type StageChanges = Partial<{
  name: string;
  color: ChartColor | null;
  wipLimit: number | null;
  cardSort: CardSort;
}>;

export async function updateKanbanStage(
  boardId: string,
  stage: { id: string; revision: number },
  changes: StageChanges,
): Promise<KanbanStage> {
  const body: Record<string, unknown> = { revision: stage.revision };
  if (changes.name !== undefined) body.name = changes.name;
  if (changes.color !== undefined) body.color = changes.color;
  if (changes.wipLimit !== undefined) body.wip_limit = changes.wipLimit;
  if (changes.cardSort !== undefined) body.card_sort = changes.cardSort;
  return apiFetch(
    boardPath(boardId, `/stages/${uuid.parse(stage.id)}`),
    stageWire,
    {
      method: "PATCH",
      cache: "no-store",
      body: JSON.stringify(body),
    },
  );
}

export async function orderKanbanStages(
  boardId: string,
  stageIds: readonly string[],
): Promise<KanbanStage[]> {
  const { items } = await apiFetch(
    boardPath(boardId, "/stages/order"),
    stageItemsWire,
    {
      method: "PUT",
      cache: "no-store",
      body: JSON.stringify({ stage_ids: stageIds.map((id) => uuid.parse(id)) }),
    },
  );
  return [...items].sort((left, right) => left.position - right.position);
}

/** Archive a stage; its cards move to another stage or are archived with it. */
export async function archiveKanbanStage(
  boardId: string,
  input: {
    stageId: string;
    revision: number;
    cards: "move" | "archive";
    targetStageId: string | null;
  },
): Promise<KanbanStage> {
  return apiFetch(
    boardPath(boardId, `/stages/${uuid.parse(input.stageId)}/archive`),
    stageWire,
    {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({
        revision: input.revision,
        cards: input.cards,
        ...(input.cards === "move"
          ? { target_stage_id: uuid.parse(input.targetStageId) }
          : {}),
      }),
    },
  );
}

export async function createObjectiveCard(
  boardId: string,
  input: { stageId: string; title: string },
): Promise<KanbanCard> {
  const card = await apiFetch(boardPath(boardId, "/cards"), cardDetailWire, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({
      kind: "objective",
      stage_id: uuid.parse(input.stageId),
      title: input.title,
    }),
  });
  return checkCard(boardId, card);
}

/** A record card; its start and due belong to the card (BR63, BR79). */
export async function createRecordCard(
  boardId: string,
  input: {
    stageId: string;
    recordId: string;
    startOn: string | null;
    dueOn: string | null;
  },
): Promise<KanbanCard> {
  const card = await apiFetch(boardPath(boardId, "/cards"), cardDetailWire, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({
      kind: "record",
      stage_id: uuid.parse(input.stageId),
      record_id: uuid.parse(input.recordId),
      ...(input.startOn ? { start_on: input.startOn } : {}),
      ...(input.dueOn ? { due_on: input.dueOn } : {}),
    }),
  });
  return checkCard(boardId, card);
}

/**
 * One move (BR65): the stage, the place among its other cards, and the
 * revision. A null place appends the card.
 */
export async function moveKanbanCard(
  boardId: string,
  move: {
    cardId: string;
    revision: number;
    stageId: string;
    position: number | null;
  },
): Promise<KanbanCard> {
  const card = await apiFetch(
    boardPath(boardId, `/cards/${uuid.parse(move.cardId)}`),
    cardDetailWire,
    {
      method: "PATCH",
      cache: "no-store",
      body: JSON.stringify({
        revision: move.revision,
        stage_id: uuid.parse(move.stageId),
        ...(move.position === null ? {} : { position: move.position }),
      }),
    },
  );
  return checkCard(boardId, card);
}

/** A writer applies the board's labels to a card (BR70). */
export async function setKanbanCardLabels(
  boardId: string,
  card: { id: string; revision: number },
  labelIds: readonly string[],
): Promise<KanbanCard> {
  const saved = await apiFetch(
    boardPath(boardId, `/cards/${uuid.parse(card.id)}`),
    cardDetailWire,
    {
      method: "PATCH",
      cache: "no-store",
      body: JSON.stringify({
        revision: card.revision,
        label_ids: labelIds.map((id) => uuid.parse(id)),
      }),
    },
  );
  return checkCard(boardId, saved);
}

export async function archiveKanbanCard(
  boardId: string,
  card: { id: string; revision: number },
): Promise<KanbanCard> {
  const saved = await apiFetch(
    boardPath(boardId, `/cards/${uuid.parse(card.id)}/archive`),
    cardDetailWire,
    {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({ revision: card.revision }),
    },
  );
  return checkCard(boardId, saved);
}

/** Restore an archived card into its stage (the Undo of Archive card). */
export async function restoreKanbanCard(
  boardId: string,
  card: { id: string; revision: number },
): Promise<KanbanCard> {
  const saved = await apiFetch(
    boardPath(boardId, `/cards/${uuid.parse(card.id)}/restore`),
    cardDetailWire,
    {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({ revision: card.revision }),
    },
  );
  return checkCard(boardId, saved);
}

export async function createKanbanLabel(
  boardId: string,
  input: { name: string; color: ChartColor },
): Promise<KanbanLabel> {
  return apiFetch(boardPath(boardId, "/labels"), labelWire, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify(input),
  });
}

export async function updateKanbanLabel(
  boardId: string,
  label: { id: string; revision: number },
  changes: Partial<{ name: string; color: ChartColor }>,
): Promise<KanbanLabel> {
  return apiFetch(
    boardPath(boardId, `/labels/${uuid.parse(label.id)}`),
    labelWire,
    {
      method: "PATCH",
      cache: "no-store",
      body: JSON.stringify({ revision: label.revision, ...changes }),
    },
  );
}

export async function deleteKanbanLabel(
  boardId: string,
  label: { id: string; revision: number },
): Promise<void> {
  const response = await apiRequest(
    boardPath(boardId, `/labels/${uuid.parse(label.id)}`),
    {
      method: "DELETE",
      cache: "no-store",
      body: JSON.stringify({ revision: label.revision }),
    },
  );
  if (response.status === 204) return;
  if (response.ok) throw new ApiContractError();
  const body: unknown = await response.json().catch(() => null);
  const detail =
    body && typeof body === "object" && "detail" in body ? body.detail : null;
  const code = z.object({ code: z.string() }).passthrough().safeParse(detail)
    .data?.code;
  throw new ApiError(
    response.status,
    "Request could not be completed",
    detail,
    code as ApiError["code"],
  );
}

/**
 * A found record's values, for a new record card's dates (BR63). A plain
 * read: a refusal here must not set OpenView's access latch for the account.
 */
export async function readKanbanRecordValues(
  recordId: string,
): Promise<Record<string, unknown>> {
  const record = await apiFetch(
    `/records/${uuid.parse(recordId)}`,
    recordSchema,
    { cache: "no-store" },
  );
  if (record.id !== recordId) throw new ApiContractError();
  return record.data;
}
