import { z } from "zod";

export const uuid = z.string().uuid();
const date = z.iso.date();
const utc = z.iso
  .datetime({ offset: true })
  .refine((value) => /(?:Z|[+-]00:00)$/i.test(value));
export const revision = z.number().int().min(1);
export const recurrence = z.enum(["none", "daily", "weekly", "monthly"]);
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
export const links = z
  .array(
    z
      .object({ label: z.string().trim().min(1).max(100), url: linkUrl })
      .strict(),
  )
  .max(20);
export const audienceInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("everyone") }).strict(),
  z.object({ kind: z.literal("author") }).strict(),
  z.object({ kind: z.literal("user"), userId: uuid }).strict(),
  z.object({ kind: z.literal("department"), departmentId: uuid }).strict(),
]);
const audienceWire = z
  .object({
    kind: z.enum(["everyone", "author", "user", "department"]),
    user_id: uuid.nullable(),
    department_id: uuid.nullable(),
  })
  .strict()
  .refine(({ kind, user_id, department_id }) => {
    const targets = [user_id, department_id];
    const expected = kind === "user" ? 0 : kind === "department" ? 1 : -1;
    return targets.every((target, index) =>
      expected === -1
        ? target === null
        : (index === expected) === (target !== null),
    );
  })
  .transform(({ kind, user_id, department_id }) => ({
    kind,
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
export const eventWire = z
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
export const mutationWire = z
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
export const eventListWire = z
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
export const occurrenceListWire = z
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

export const listOptions = z
  .object({
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
    sortBy: z.enum(["created_at", "title"]).default("created_at"),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
    archived: z.enum(["active", "archived", "all"]).default("active"),
    search: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export const occurrenceOptions = z
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
export const createInput = z
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
export const patchInput = z
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
