import { z } from "zod";
import {
  ApiContractError,
  ApiError,
  apiFetch,
  type ApiRequestInit,
} from "@/lib/api";

import {
  assertLifecyclePurgePreviewFor,
  assertLifecyclePurgeResultFor,
  lifecyclePurgeInputSchema,
  lifecyclePurgePreviewSchema,
  lifecyclePurgeResultSchema,
  type LifecyclePurgeInput,
  type LifecyclePurgePreview,
  type LifecyclePurgeResult,
} from "@/lib/lifecycle";

import {
  uuid,
  revision,
  eventWire,
  mutationWire,
  eventListWire,
  occurrenceListWire,
  listOptions,
  occurrenceOptions,
  createInput,
  patchInput,
} from "./board-events-schemas";
import type {
  BoardEvent,
  BoardEventMutation,
  BoardEventPage,
  BoardEventOccurrencePage,
  BoardEventListOptions,
  BoardEventOccurrenceOptions,
  BoardEventCreateInput,
  BoardEventPatchInput,
  BoardEventReminderTiming,
} from "./board-events-schemas";
export type {
  BoardEvent,
  BoardEventMutation,
  BoardEventPage,
  BoardEventOccurrencePage,
  BoardEventListOptions,
  BoardEventOccurrenceOptions,
  BoardEventCreateInput,
  BoardEventPatchInput,
  BoardEventReminderTiming,
};

const safeCodes = new Map<string, { status: number; message: string }>([
  [
    "stale_board_revision",
    { status: 409, message: "Board changed; reload before saving" },
  ],
  [
    "stale_event_revision",
    { status: 409, message: "Event changed; reload before saving" },
  ],
  [
    "board_archived",
    { status: 409, message: "Restore the Board before changing events" },
  ],
  [
    "event_archived",
    { status: 409, message: "Restore the event before editing it" },
  ],
  ["event_not_archived", { status: 409, message: "Archive the event first" }],
  [
    "event_limit_reached",
    { status: 409, message: "The Board has too many active events" },
  ],
  [
    "event_candidate_limit",
    { status: 409, message: "Too many visible event series" },
  ],
  [
    "event_occurrence_limit",
    { status: 409, message: "Narrow the event window" },
  ],
  ["event_conflict", { status: 409, message: "Unable to save Board event" }],
  ["event_invalid", { status: 409, message: "Stored Board event is invalid" }],
]);

function throwSafeEventError(status: number, detail: unknown): never {
  if (
    status === 404 &&
    (detail === "Board not found" || detail === "Board event not found")
  )
    throw new ApiError(status, detail);
  const parsed = z.object({ code: z.string() }).passthrough().safeParse(detail);
  if (parsed.success) {
    const safe = safeCodes.get(parsed.data.code);
    if (safe?.status === status)
      throw new ApiError(
        status,
        safe.message,
        { code: parsed.data.code, message: safe.message },
        parsed.data.code,
      );
    if (status === 422 && parsed.data.code === "event_invalid")
      throw new ApiError(
        status,
        "Event fields are invalid",
        { code: "event_invalid", message: "Event fields are invalid" },
        "event_invalid",
      );
  }
  throw new ApiError(status, "Request could not be completed");
}

async function eventJson<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  init: ApiRequestInit = {},
): Promise<z.output<Schema>> {
  try {
    return await apiFetch(path, schema, { cache: "no-store", ...init });
  } catch (error) {
    if (error instanceof ApiError)
      return throwSafeEventError(error.status, error.details);
    throw error;
  }
}

function queryString(values: Record<string, string | number>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    query.set(key, String(value));
  return query.toString();
}

async function listEvents(
  rawBoardId: string,
  mine: boolean,
  raw: BoardEventListOptions = {},
): Promise<BoardEventPage> {
  const boardId = uuid.parse(rawBoardId);
  const options = listOptions.parse(raw);
  const values: Record<string, string | number> = {
    limit: options.limit,
    offset: options.offset,
    sort_by: options.sortBy,
    sort_order: options.sortOrder,
    archived: options.archived,
  };
  if (options.search !== undefined) values.search = options.search;
  const page = await eventJson(
    `/boards/${boardId}/events${mine ? "/mine" : ""}?${queryString(values)}`,
    eventListWire,
  );
  if (page.items.some((item) => item.boardId !== boardId))
    throw new ApiContractError();
  return page;
}

export function listBoardEvents(
  boardId: string,
  options: BoardEventListOptions = {},
): Promise<BoardEventPage> {
  return listEvents(boardId, false, options);
}

export function listMyBoardEvents(
  boardId: string,
  options: BoardEventListOptions = {},
): Promise<BoardEventPage> {
  return listEvents(boardId, true, options);
}

export async function readBoardEvent(
  rawBoardId: string,
  rawEventId: string,
): Promise<BoardEvent> {
  const boardId = uuid.parse(rawBoardId);
  const eventId = uuid.parse(rawEventId);
  const event = await eventJson(
    `/boards/${boardId}/events/${eventId}`,
    eventWire,
  );
  if (event.id !== eventId || event.boardId !== boardId)
    throw new ApiContractError();
  return event;
}

export async function createBoardEvent(
  rawBoardId: string,
  raw: BoardEventCreateInput,
): Promise<BoardEventMutation> {
  const boardId = uuid.parse(rawBoardId);
  const input = createInput.parse(raw);
  const body = {
    board_revision: input.boardRevision,
    title: input.title,
    ...(input.details !== undefined && { details: input.details }),
    ...(input.location !== undefined && { location: input.location }),
    ...(input.links !== undefined && { links: input.links }),
    all_day: input.allDay,
    ...(input.allDay
      ? { start_date: input.startDate, end_date: input.endDate }
      : { start_at: input.startAt, end_at: input.endAt }),
    timezone_name: input.timezoneName,
    recurrence: input.recurrence,
    ...(input.repeatUntil !== undefined && { repeat_until: input.repeatUntil }),
    ...(input.reminders !== undefined && { reminders: input.reminders }),
  };
  return eventJson(`/boards/${boardId}/events`, mutationWire, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const patchWireNames = {
  title: "title",
  details: "details",
  location: "location",
  links: "links",
  allDay: "all_day",
  startDate: "start_date",
  endDate: "end_date",
  startAt: "start_at",
  endAt: "end_at",
  timezoneName: "timezone_name",
  recurrence: "recurrence",
  repeatUntil: "repeat_until",
} as const;

export async function updateBoardEvent(
  rawBoardId: string,
  rawEventId: string,
  raw: BoardEventPatchInput,
): Promise<BoardEventMutation> {
  const boardId = uuid.parse(rawBoardId);
  const eventId = uuid.parse(rawEventId);
  const input = patchInput.parse(raw);
  const body: Record<string, unknown> = {
    board_revision: input.boardRevision,
    event_revision: input.eventRevision,
  };
  for (const [key, wireName] of Object.entries(patchWireNames)) {
    const value = input[key as keyof typeof patchWireNames];
    if (value !== undefined) body[wireName] = value;
  }
  if (input.reminders !== undefined) body.reminders = input.reminders;
  const result = await eventJson(
    `/boards/${boardId}/events/${eventId}`,
    mutationWire,
    {
      method: "PATCH",
      body: JSON.stringify(body),
    },
  );
  if (result.id !== eventId) throw new ApiContractError();
  return result;
}

async function lifecyclePost(
  rawBoardId: string,
  rawEventId: string,
  rawBoardRevision: number,
  rawEventRevision: number,
  action: "archive" | "restore",
): Promise<BoardEventMutation> {
  const boardId = uuid.parse(rawBoardId);
  const eventId = uuid.parse(rawEventId);
  const boardRevision = revision.parse(rawBoardRevision);
  const eventRevision = revision.parse(rawEventRevision);
  const result = await eventJson(
    `/boards/${boardId}/events/${eventId}/${action}`,
    mutationWire,
    {
      method: "POST",
      body: JSON.stringify({
        board_revision: boardRevision,
        event_revision: eventRevision,
      }),
    },
  );
  if (result.id !== eventId) throw new ApiContractError();
  return result;
}

export function archiveBoardEvent(
  boardId: string,
  eventId: string,
  boardRevision: number,
  eventRevision: number,
): Promise<BoardEventMutation> {
  return lifecyclePost(
    boardId,
    eventId,
    boardRevision,
    eventRevision,
    "archive",
  );
}

export function restoreBoardEvent(
  boardId: string,
  eventId: string,
  boardRevision: number,
  eventRevision: number,
): Promise<BoardEventMutation> {
  return lifecyclePost(
    boardId,
    eventId,
    boardRevision,
    eventRevision,
    "restore",
  );
}

export async function previewBoardEventPurge(
  rawBoardId: string,
  rawEventId: string,
): Promise<LifecyclePurgePreview> {
  const boardId = uuid.parse(rawBoardId);
  const eventId = uuid.parse(rawEventId);
  const preview = await apiFetch(
    `/boards/${boardId}/events/${eventId}/purge/preview`,
    lifecyclePurgePreviewSchema,
    { method: "POST", cache: "no-store" },
  );
  assertLifecyclePurgePreviewFor(preview, "board_event", eventId);
  return preview;
}

export async function purgeBoardEvent(
  rawBoardId: string,
  rawEventId: string,
  rawInput: LifecyclePurgeInput,
): Promise<LifecyclePurgeResult> {
  const boardId = uuid.parse(rawBoardId);
  const eventId = uuid.parse(rawEventId);
  const input = lifecyclePurgeInputSchema.parse(rawInput);
  const result = await apiFetch(
    `/boards/${boardId}/events/${eventId}/purge`,
    lifecyclePurgeResultSchema,
    {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({
        token: input.token,
        confirmation_name: input.confirmationName,
        password: input.password,
      }),
    },
  );
  assertLifecyclePurgeResultFor(result, "board_event", eventId);
  return result;
}

export async function listBoardEventOccurrences(
  rawBoardId: string,
  raw: BoardEventOccurrenceOptions,
): Promise<BoardEventOccurrencePage> {
  const boardId = uuid.parse(rawBoardId);
  const options = occurrenceOptions.parse(raw);
  const values: Record<string, string | number> = {
    window_start: options.windowStart,
    window_end: options.windowEnd,
    limit: options.limit,
    offset: options.offset,
  };
  if (options.search !== undefined) values.search = options.search;
  const page = await eventJson(
    `/boards/${boardId}/events/occurrences?${queryString(values)}`,
    occurrenceListWire,
  );
  if (page.items.some((item) => item.event.boardId !== boardId))
    throw new ApiContractError();
  return page;
}
