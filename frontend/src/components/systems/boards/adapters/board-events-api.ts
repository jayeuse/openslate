import { z } from "zod";
import {
  ApiContractError,
  ApiError,
  apiFetch,
  apiRequest,
  type ApiRequestInit,
} from "@/lib/api";

const uuid = z.string().uuid();
const date = z.iso.date();
const utc = z.iso
  .datetime({ offset: true })
  .refine((value) => /(?:Z|[+-]00:00)$/i.test(value));
const revision = z.number().int().min(1);
const recurrence = z.enum(["none", "daily", "weekly", "monthly"]);
const linkUrl = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    const authority = /^https?:\/\/([^/?#]*)/i.exec(value)?.[1];
    if (
      !authority ||
      authority.includes("@") ||
      /[\\\u0000-\u001f\u007f]/.test(value)
    )
      return false;
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        !parsed.username &&
        !parsed.password &&
        parsed.href.length <= 2048
      );
    } catch {
      return false;
    }
  })
  .transform((value) => new URL(value).href);
const links = z
  .array(
    z
      .object({ label: z.string().trim().min(1).max(100), url: linkUrl })
      .strict(),
  )
  .max(20);
const audienceInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("everyone") }).strict(),
  z.object({ kind: z.literal("author") }).strict(),
  z.object({ kind: z.literal("role"), roleId: uuid }).strict(),
  z.object({ kind: z.literal("user"), userId: uuid }).strict(),
  z.object({ kind: z.literal("department"), departmentId: uuid }).strict(),
]);
const audienceWire = z
  .object({
    kind: z.enum(["everyone", "author", "role", "user", "department"]),
    role_id: uuid.nullable(),
    user_id: uuid.nullable(),
    department_id: uuid.nullable(),
  })
  .strict()
  .refine((audience) => {
    const targets = [
      audience.role_id,
      audience.user_id,
      audience.department_id,
    ];
    const expected =
      audience.kind === "role"
        ? 0
        : audience.kind === "user"
          ? 1
          : audience.kind === "department"
            ? 2
            : undefined;
    return targets.every((target, index) =>
      expected === undefined
        ? target === null
        : (index === expected) === (target !== null),
    );
  })
  .transform(({ kind, role_id, user_id, department_id }) => ({
    kind,
    roleId: role_id,
    userId: user_id,
    departmentId: department_id,
  }));

const eventFields = {
  id: uuid,
  board_id: uuid,
  author_id: uuid,
  title: z.string().min(1).max(100),
  details: z.string().max(4000),
  location: z.string().max(240),
  links,
  timezone_name: z.string().min(1).max(80),
  recurrence,
  repeat_until: date.nullable(),
  audience: audienceWire,
  archived: z.boolean(),
  revision,
  board_revision: revision,
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
};
const eventWire = z
  .discriminatedUnion("all_day", [
    z
      .object({
        ...eventFields,
        all_day: z.literal(true),
        start_date: date,
        end_date: date,
        start_at: z.null(),
        end_at: z.null(),
      })
      .strict(),
    z
      .object({
        ...eventFields,
        all_day: z.literal(false),
        start_date: z.null(),
        end_date: z.null(),
        start_at: utc,
        end_at: utc,
      })
      .strict(),
  ])
  .refine(
    (event) =>
      (event.all_day
        ? event.end_date >= event.start_date
        : Date.parse(event.end_at) > Date.parse(event.start_at)) &&
      (event.recurrence === "none"
        ? event.repeat_until === null
        : event.repeat_until !== null &&
          (!event.all_day || event.repeat_until >= event.start_date)),
  )
  .transform((event) => ({
    id: event.id,
    boardId: event.board_id,
    authorId: event.author_id,
    title: event.title,
    details: event.details,
    location: event.location,
    links: event.links,
    allDay: event.all_day,
    startDate: event.start_date,
    endDate: event.end_date,
    startAt: event.start_at,
    endAt: event.end_at,
    timezoneName: event.timezone_name,
    recurrence: event.recurrence,
    repeatUntil: event.repeat_until,
    audience: event.audience,
    archived: event.archived,
    revision: event.revision,
    boardRevision: event.board_revision,
    createdAt: event.created_at,
    updatedAt: event.updated_at,
  }));
const mutationWire = z
  .object({
    id: uuid,
    event_revision: revision,
    board_revision: revision,
  })
  .strict()
  .transform(({ id, event_revision, board_revision }) => ({
    id,
    eventRevision: event_revision,
    boardRevision: board_revision,
  }));
const pagination = z
  .object({
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0),
    count: z.number().int().min(0),
    total: z.number().int().min(0),
    has_more: z.boolean(),
  })
  .strict()
  .refine(
    ({ count, limit, offset, total, has_more }) =>
      count <= limit &&
      (count === 0 || offset + count <= total) &&
      has_more === offset + count < total,
  )
  .transform(({ has_more, ...page }) => ({ ...page, hasMore: has_more }));
const eventListWire = z
  .object({
    items: z.array(eventWire),
    pagination,
    board_revision: revision,
  })
  .strict()
  .refine(
    ({ items, pagination: page, board_revision }) =>
      items.length === page.count &&
      items.every((item) => item.boardRevision === board_revision),
  )
  .transform(({ items, pagination: page, board_revision }) => ({
    items,
    pagination: page,
    boardRevision: board_revision,
  }));
const occurrenceWire = z
  .object({
    id: z.string().min(1).max(160),
    event_id: uuid,
    start: z.union([date, utc]),
    end: z.union([date, utc]),
    date,
    event: eventWire,
  })
  .strict()
  .refine(
    (item) =>
      item.event_id === item.event.id &&
      item.id ===
        `${item.event_id}:${item.event.allDay || item.event.recurrence !== "none" ? item.date : item.start}` &&
      (!item.event.allDay || item.date === item.start) &&
      (item.event.allDay
        ? date.safeParse(item.start).success && date.safeParse(item.end).success
        : utc.safeParse(item.start).success && utc.safeParse(item.end).success),
  )
  .transform(({ event_id, ...item }) => ({ ...item, eventId: event_id }));
const occurrenceListWire = z
  .object({
    items: z.array(occurrenceWire),
    pagination,
    board_revision: revision,
  })
  .strict()
  .refine(
    ({ items, pagination: page, board_revision }) =>
      items.length === page.count &&
      items.every((item) => item.event.boardRevision === board_revision),
  )
  .transform(({ items, pagination: page, board_revision }) => ({
    items,
    pagination: page,
    boardRevision: board_revision,
  }));

const listOptions = z
  .object({
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
    sortBy: z.enum(["created_at", "title"]).default("created_at"),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
    archived: z.enum(["active", "archived", "all"]).default("active"),
    search: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
const occurrenceOptions = z
  .object({
    windowStart: date,
    windowEnd: date,
    limit: z.number().int().min(1).max(100).default(100),
    offset: z.number().int().min(0).default(0),
    search: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .refine(({ windowStart, windowEnd }) => {
    const days =
      (Date.parse(windowEnd) - Date.parse(windowStart)) / 86_400_000 + 1;
    return days >= 1 && days <= 42;
  });
const definitionFields = {
  title: z.string().trim().min(1).max(100),
  details: z.string().trim().max(4000).optional(),
  location: z.string().trim().max(240).optional(),
  links: links.optional(),
  timezoneName: z.string().trim().min(1).max(80),
  recurrence: recurrence.default("none"),
  repeatUntil: date.nullable().optional(),
  audience: audienceInput.optional(),
};
const createInput = z
  .discriminatedUnion("allDay", [
    z
      .object({
        boardRevision: revision,
        ...definitionFields,
        allDay: z.literal(true),
        startDate: date,
        endDate: date,
      })
      .strict(),
    z
      .object({
        boardRevision: revision,
        ...definitionFields,
        allDay: z.literal(false),
        startAt: utc,
        endAt: utc,
      })
      .strict(),
  ])
  .refine(
    (event) =>
      (event.allDay
        ? event.endDate >= event.startDate
        : Date.parse(event.endAt) > Date.parse(event.startAt)) &&
      (event.recurrence === "none"
        ? event.repeatUntil == null
        : event.repeatUntil != null &&
          (!event.allDay || event.repeatUntil >= event.startDate)),
  );
const patchInput = z
  .object({
    boardRevision: revision,
    eventRevision: revision,
    title: z.string().trim().min(1).max(100).optional(),
    details: z.string().trim().max(4000).optional(),
    location: z.string().trim().max(240).optional(),
    links: links.optional(),
    allDay: z.boolean().optional(),
    startDate: date.nullable().optional(),
    endDate: date.nullable().optional(),
    startAt: utc.nullable().optional(),
    endAt: utc.nullable().optional(),
    timezoneName: z.string().trim().min(1).max(80).optional(),
    recurrence: recurrence.optional(),
    repeatUntil: date.nullable().optional(),
    audience: audienceInput.optional(),
  })
  .strict()
  .refine((value) =>
    Object.keys(value).some(
      (key) => key !== "boardRevision" && key !== "eventRevision",
    ),
  );

export type BoardEvent = z.output<typeof eventWire>;
export type BoardEventMutation = z.output<typeof mutationWire>;
export type BoardEventPage = z.output<typeof eventListWire>;
export type BoardEventOccurrencePage = z.output<typeof occurrenceListWire>;
export type BoardEventListOptions = z.input<typeof listOptions>;
export type BoardEventOccurrenceOptions = z.input<typeof occurrenceOptions>;
export type BoardEventCreateInput = z.input<typeof createInput>;
export type BoardEventPatchInput = z.input<typeof patchInput>;

function wireAudience(audience: z.output<typeof audienceInput>) {
  if (audience.kind === "role")
    return { kind: audience.kind, role_id: audience.roleId };
  if (audience.kind === "user")
    return { kind: audience.kind, user_id: audience.userId };
  if (audience.kind === "department")
    return { kind: audience.kind, department_id: audience.departmentId };
  return { kind: audience.kind };
}

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
    "audience_unavailable",
    { status: 409, message: "The selected audience is unavailable" },
  ],
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
    ...(input.audience !== undefined && {
      audience: wireAudience(input.audience),
    }),
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
  if (input.audience !== undefined)
    body.audience = wireAudience(input.audience);
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

async function boundedErrorDetail(response: Response): Promise<unknown> {
  const maximum = 8192;
  const declared = response.headers.get("Content-Length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > maximum)
  )
    return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const body: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    const envelope = z
      .object({ detail: z.unknown() })
      .passthrough()
      .safeParse(body);
    return envelope.success ? envelope.data.detail : null;
  } catch {
    return null;
  }
}

export async function deleteBoardEvent(
  rawBoardId: string,
  rawEventId: string,
  rawBoardRevision: number,
  rawEventRevision: number,
): Promise<void> {
  const boardId = uuid.parse(rawBoardId);
  const eventId = uuid.parse(rawEventId);
  const boardRevision = revision.parse(rawBoardRevision);
  const eventRevision = revision.parse(rawEventRevision);
  const response = await apiRequest(`/boards/${boardId}/events/${eventId}`, {
    method: "DELETE",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      board_revision: boardRevision,
      event_revision: eventRevision,
    }),
  });
  if (response.status === 204) return;
  if (response.ok) throw new ApiContractError();
  return throwSafeEventError(
    response.status,
    await boundedErrorDetail(response),
  );
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
