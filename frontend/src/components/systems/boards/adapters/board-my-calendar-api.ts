import { z } from "zod";
import { ApiContractError, ApiError, apiFetch } from "@/lib/api";
import {
  crossBoardOccurrenceWire,
  nextOccurrenceWire,
  occurrencePagination,
  occurrenceOptions,
  uuid,
} from "./board-events-schemas";

/**
 * My calendar's window read (BR22): event occurrences across every active
 * board the person reads, in one merged list that the server pages at 100.
 * Each covered board also reports its own status, so one refused or capped
 * board never blanks the others.
 */

const PAGE = 100;
/** A runaway guard: 50 pages is 5,000 occurrences in one window. */
const MAX_PAGES = 50;

const boardStateWire = z
  .object({
    board_id: uuid,
    revision: z.number().int().min(1).nullable(),
    status: z.enum([
      "ok",
      "candidate_limit",
      "occurrence_limit",
      "unavailable",
    ]),
    next_occurrence: nextOccurrenceWire.nullable(),
  })
  .strict()
  .refine((state) =>
    state.status === "unavailable"
      ? state.revision === null && state.next_occurrence === null
      : state.revision !== null,
  )
  .transform((state) => ({
    boardId: state.board_id,
    revision: state.revision,
    status: state.status,
    nextOccurrence: state.next_occurrence,
  }));

const pageWire = z
  .object({
    items: z.array(crossBoardOccurrenceWire),
    pagination: occurrencePagination,
    boards: z.array(boardStateWire),
  })
  .strict()
  .refine(({ items, pagination }) => items.length === pagination.count);

export type CrossBoardOccurrence = z.output<typeof crossBoardOccurrenceWire>;
export type BoardOccurrenceState = z.output<typeof boardStateWire>;
export type CrossBoardOccurrences = {
  items: CrossBoardOccurrence[];
  boards: BoardOccurrenceState[];
};

function safe(error: unknown): unknown {
  return error instanceof ApiError
    ? new ApiError(error.status, "Request could not be completed")
    : error;
}

/** Every occurrence in the window, read page by page to the end. */
export async function listCrossBoardOccurrences(raw: {
  windowStart: string;
  windowEnd: string;
  search?: string;
}): Promise<CrossBoardOccurrences> {
  const options = occurrenceOptions.parse({
    windowStart: raw.windowStart,
    windowEnd: raw.windowEnd,
    ...(raw.search?.trim() ? { search: raw.search } : {}),
  });
  const items: CrossBoardOccurrence[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      window_start: options.windowStart,
      window_end: options.windowEnd,
      limit: String(PAGE),
      offset: String(items.length),
    });
    if (options.search !== undefined) query.set("search", options.search);
    let result: z.output<typeof pageWire>;
    try {
      result = await apiFetch(
        `/boards/occurrences?${query.toString()}`,
        pageWire,
        { cache: "no-store" },
      );
    } catch (error) {
      throw safe(error);
    }
    if (result.pagination.offset !== items.length) throw new ApiContractError();
    items.push(...result.items);
    if (!result.pagination.hasMore) {
      const covered = new Set(result.boards.map((state) => state.boardId));
      if (items.some((item) => !covered.has(item.board.id)))
        throw new ApiContractError();
      return { items, boards: result.boards };
    }
  }
  throw new ApiContractError();
}
