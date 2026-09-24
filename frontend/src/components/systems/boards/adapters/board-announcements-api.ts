import { z } from "zod";
import {
  ApiContractError,
  ApiError,
  apiFetch,
  apiRequest,
  type ApiRequestInit,
} from "@/lib/api";

const uuid = z.string().uuid();
const utc = z.iso
  .datetime({ offset: true })
  .refine((value) => /(?:Z|[+-]00:00)$/i.test(value));
const revision = z.number().int().min(1);
const view = z.enum(["published", "draft", "archive"]);
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
  .refine(({ kind, role_id, user_id, department_id }) => {
    const targets = [role_id, user_id, department_id];
    const expected =
      kind === "role"
        ? 0
        : kind === "user"
          ? 1
          : kind === "department"
            ? 2
            : -1;
    return targets.every((target, index) =>
      expected === -1
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

const announcementWire = z
  .object({
    id: uuid,
    board_id: uuid,
    author_id: uuid,
    title: z.string().min(1).max(100),
    body: z.string().min(1).max(2000),
    links,
    audience: audienceWire,
    status: z.enum(["draft", "scheduled", "published", "archived"]),
    publish_at: utc.nullable(),
    expires_at: utc.nullable(),
    pinned: z.boolean(),
    announcement_revision: revision.nullable(),
    board_revision: revision,
    publication_number: revision.nullable(),
    published_at: utc.nullable(),
    created_at: utc,
    updated_at: utc,
  })
  .strict()
  .refine((item) =>
    item.announcement_revision === null
      ? item.status === "published" &&
        item.publication_number !== null &&
        item.published_at !== null &&
        item.publish_at !== null
      : item.publication_number === null && item.published_at === null,
  )
  .transform(
    ({
      board_id,
      author_id,
      publish_at,
      expires_at,
      announcement_revision,
      board_revision,
      publication_number,
      published_at,
      created_at,
      updated_at,
      ...item
    }) => ({
      ...item,
      boardId: board_id,
      authorId: author_id,
      publishAt: publish_at,
      expiresAt: expires_at,
      announcementRevision: announcement_revision,
      boardRevision: board_revision,
      publicationNumber: publication_number,
      publishedAt: published_at,
      createdAt: created_at,
      updatedAt: updated_at,
    }),
  );
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
const announcementListWire = z
  .object({
    items: z.array(announcementWire),
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
const mutationWire = z
  .object({
    id: uuid,
    announcement_revision: revision,
    board_revision: revision,
  })
  .strict()
  .transform(({ id, announcement_revision, board_revision }) => ({
    id,
    announcementRevision: announcement_revision,
    boardRevision: board_revision,
  }));
const publicationWire = z
  .object({
    id: uuid,
    announcement_id: uuid,
    publication_number: revision,
    publication_key: uuid,
    published_at: utc,
  })
  .strict()
  .transform(
    ({
      id,
      announcement_id,
      publication_number,
      publication_key,
      published_at,
    }) => ({
      id,
      announcementId: announcement_id,
      publicationNumber: publication_number,
      publicationKey: publication_key,
      publishedAt: published_at,
    }),
  );

const listOptions = z
  .object({
    view: view.default("published"),
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
    sortBy: z.enum(["created_at", "updated_at", "title"]).default("updated_at"),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
    search: z.string().trim().min(1).max(100).optional(),
    authorId: uuid.optional(),
  })
  .strict();
const contentFields = {
  title: z.string().trim().min(1).max(100),
  body: z.string().trim().min(1).max(2000),
  links,
  audience: audienceInput,
  expiresAt: utc.nullable(),
  pinned: z.boolean(),
};
const createInput = z
  .object({
    boardRevision: revision,
    title: contentFields.title,
    body: contentFields.body,
    links: contentFields.links.optional(),
    audience: contentFields.audience.optional(),
    expiresAt: contentFields.expiresAt.optional(),
    pinned: contentFields.pinned.optional(),
  })
  .strict();
const patchInput = z
  .object({
    boardRevision: revision,
    announcementRevision: revision,
    title: contentFields.title.optional(),
    body: contentFields.body.optional(),
    links: contentFields.links.optional(),
    audience: contentFields.audience.optional(),
    expiresAt: contentFields.expiresAt.optional(),
    pinned: contentFields.pinned.optional(),
  })
  .strict()
  .refine((input) =>
    Object.keys(input).some(
      (key) => key !== "boardRevision" && key !== "announcementRevision",
    ),
  );
const scheduleInput = z
  .object({
    boardRevision: revision,
    announcementRevision: revision,
    publishAt: utc,
  })
  .strict();
const publishInput = z
  .object({
    boardRevision: revision,
    announcementRevision: revision,
    publicationKey: uuid,
  })
  .strict();

export type BoardAnnouncement = z.output<typeof announcementWire>;
export type BoardAnnouncementPage = z.output<typeof announcementListWire>;
export type BoardAnnouncementMutation = z.output<typeof mutationWire>;
export type BoardAnnouncementPublication = z.output<typeof publicationWire>;
export type BoardAnnouncementView = z.output<typeof view>;
export type BoardAnnouncementListOptions = z.input<typeof listOptions>;
export type BoardAnnouncementCreateInput = z.input<typeof createInput>;
export type BoardAnnouncementPatchInput = z.input<typeof patchInput>;
export type BoardAnnouncementScheduleInput = z.input<typeof scheduleInput>;
export type BoardAnnouncementPublishInput = z.input<typeof publishInput>;

function wireAudience(audience: z.output<typeof audienceInput>) {
  if (audience.kind === "role")
    return { kind: audience.kind, role_id: audience.roleId };
  if (audience.kind === "user")
    return { kind: audience.kind, user_id: audience.userId };
  if (audience.kind === "department")
    return { kind: audience.kind, department_id: audience.departmentId };
  return { kind: audience.kind };
}

const safeCodes: Record<string, { status: number; message: string }> = {
  stale_board_revision: {
    status: 409,
    message: "Board changed; reload before saving",
  },
  stale_announcement_revision: {
    status: 409,
    message: "Announcement changed; reload before saving",
  },
  board_archived: {
    status: 409,
    message: "Restore the Board before editing it",
  },
  announcement_archived: {
    status: 409,
    message: "Restore the announcement before editing it",
  },
  announcement_not_archived: {
    status: 409,
    message: "Archive the announcement first",
  },
  announcement_not_published: {
    status: 409,
    message: "There is no published announcement",
  },
  announcement_unavailable: {
    status: 409,
    message: "Restore before publishing",
  },
  announcement_limit_reached: {
    status: 409,
    message: "The Board has too many announcements",
  },
  announcement_conflict: {
    status: 409,
    message: "Unable to save announcement",
  },
  publication_key_conflict: {
    status: 409,
    message: "Publication key was already used",
  },
  publication_invalid: {
    status: 409,
    message: "Published announcement is unavailable",
  },
  audience_unavailable: {
    status: 409,
    message: "The selected audience is unavailable",
  },
  announcement_invalid: {
    status: 422,
    message: "Announcement fields are invalid",
  },
  announcement_schedule_invalid: {
    status: 422,
    message: "Choose a future publication before expiration",
  },
  announcement_expired: {
    status: 422,
    message: "Expiration must follow publication",
  },
};

function throwSafeAnnouncementError(status: number, detail: unknown): never {
  const parsed = z.object({ code: z.string() }).passthrough().safeParse(detail);
  if (parsed.success) {
    const safe = safeCodes[parsed.data.code];
    if (safe?.status === status)
      throw new ApiError(
        status,
        safe.message,
        { code: parsed.data.code, message: safe.message },
        parsed.data.code,
      );
  }
  throw new ApiError(status, "Request could not be completed");
}

async function announcementJson<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  init: ApiRequestInit = {},
): Promise<z.output<Schema>> {
  try {
    return await apiFetch(path, schema, { cache: "no-store", ...init });
  } catch (error) {
    if (error instanceof ApiError)
      return throwSafeAnnouncementError(error.status, error.details);
    throw error;
  }
}

function itemPath(boardId: string, announcementId: string): string {
  return `/boards/${boardId}/announcements/${announcementId}`;
}

function revisionBody(boardRevision: number, announcementRevision: number) {
  return {
    board_revision: revision.parse(boardRevision),
    announcement_revision: revision.parse(announcementRevision),
  };
}

function contentBody(
  input: z.output<typeof createInput> | z.output<typeof patchInput>,
) {
  return {
    ...(input.title !== undefined && { title: input.title }),
    ...(input.body !== undefined && { body: input.body }),
    ...(input.links !== undefined && { links: input.links }),
    ...(input.audience !== undefined && {
      audience: wireAudience(input.audience),
    }),
    ...(input.expiresAt !== undefined && { expires_at: input.expiresAt }),
    ...(input.pinned !== undefined && { pinned: input.pinned }),
  };
}

function matchesView(
  item: BoardAnnouncement,
  selected: BoardAnnouncementView,
): boolean {
  return selected === "published"
    ? item.status === "published" && item.announcementRevision === null
    : selected === "draft"
      ? (item.status === "draft" || item.status === "scheduled") &&
        item.announcementRevision !== null
      : item.status === "archived" && item.announcementRevision !== null;
}

export async function listBoardAnnouncements(
  rawBoardId: string,
  raw: BoardAnnouncementListOptions = {},
): Promise<BoardAnnouncementPage> {
  const boardId = uuid.parse(rawBoardId);
  const options = listOptions.parse(raw);
  const query = new URLSearchParams({
    view: options.view,
    limit: String(options.limit),
    offset: String(options.offset),
    sort_by: options.sortBy,
    sort_order: options.sortOrder,
  });
  if (options.search !== undefined) query.set("search", options.search);
  if (options.authorId !== undefined) query.set("author_id", options.authorId);
  const result = await announcementJson(
    `/boards/${boardId}/announcements?${query}`,
    announcementListWire,
  );
  if (
    result.items.some(
      (item) => item.boardId !== boardId || !matchesView(item, options.view),
    )
  )
    throw new ApiContractError();
  return result;
}

export async function readBoardAnnouncement(
  rawBoardId: string,
  rawAnnouncementId: string,
  rawView: BoardAnnouncementView = "published",
): Promise<BoardAnnouncement> {
  const boardId = uuid.parse(rawBoardId);
  const announcementId = uuid.parse(rawAnnouncementId);
  const selected = view.parse(rawView);
  const result = await announcementJson(
    `${itemPath(boardId, announcementId)}?view=${selected}`,
    announcementWire,
  );
  if (
    result.id !== announcementId ||
    result.boardId !== boardId ||
    !matchesView(result, selected)
  )
    throw new ApiContractError();
  return result;
}

export async function createBoardAnnouncement(
  rawBoardId: string,
  raw: BoardAnnouncementCreateInput,
): Promise<BoardAnnouncementMutation> {
  const boardId = uuid.parse(rawBoardId);
  const input = createInput.parse(raw);
  return announcementJson(`/boards/${boardId}/announcements`, mutationWire, {
    method: "POST",
    body: JSON.stringify({
      board_revision: input.boardRevision,
      ...contentBody(input),
    }),
  });
}

export async function updateBoardAnnouncement(
  rawBoardId: string,
  rawAnnouncementId: string,
  raw: BoardAnnouncementPatchInput,
): Promise<BoardAnnouncementMutation> {
  const boardId = uuid.parse(rawBoardId);
  const announcementId = uuid.parse(rawAnnouncementId);
  const input = patchInput.parse(raw);
  const result = await announcementJson(
    itemPath(boardId, announcementId),
    mutationWire,
    {
      method: "PATCH",
      body: JSON.stringify({
        ...revisionBody(input.boardRevision, input.announcementRevision),
        ...contentBody(input),
      }),
    },
  );
  if (result.id !== announcementId) throw new ApiContractError();
  return result;
}

export async function scheduleBoardAnnouncement(
  rawBoardId: string,
  rawAnnouncementId: string,
  raw: BoardAnnouncementScheduleInput,
): Promise<BoardAnnouncementMutation> {
  const boardId = uuid.parse(rawBoardId);
  const announcementId = uuid.parse(rawAnnouncementId);
  const input = scheduleInput.parse(raw);
  const result = await announcementJson(
    `${itemPath(boardId, announcementId)}/schedule`,
    mutationWire,
    {
      method: "POST",
      body: JSON.stringify({
        ...revisionBody(input.boardRevision, input.announcementRevision),
        publish_at: input.publishAt,
      }),
    },
  );
  if (result.id !== announcementId) throw new ApiContractError();
  return result;
}

export async function publishBoardAnnouncement(
  rawBoardId: string,
  rawAnnouncementId: string,
  raw: BoardAnnouncementPublishInput,
): Promise<BoardAnnouncementPublication> {
  const boardId = uuid.parse(rawBoardId);
  const announcementId = uuid.parse(rawAnnouncementId);
  const input = publishInput.parse(raw);
  const result = await announcementJson(
    `${itemPath(boardId, announcementId)}/publish`,
    publicationWire,
    {
      method: "POST",
      body: JSON.stringify({
        ...revisionBody(input.boardRevision, input.announcementRevision),
        publication_key: input.publicationKey,
      }),
    },
  );
  if (
    result.announcementId !== announcementId ||
    result.publicationKey !== input.publicationKey
  )
    throw new ApiContractError();
  return result;
}

async function lifecyclePost(
  rawBoardId: string,
  rawAnnouncementId: string,
  rawBoardRevision: number,
  rawAnnouncementRevision: number,
  action: "unpublish" | "archive" | "restore",
): Promise<BoardAnnouncementMutation> {
  const boardId = uuid.parse(rawBoardId);
  const announcementId = uuid.parse(rawAnnouncementId);
  const body = revisionBody(rawBoardRevision, rawAnnouncementRevision);
  const result = await announcementJson(
    `${itemPath(boardId, announcementId)}/${action}`,
    mutationWire,
    { method: "POST", body: JSON.stringify(body) },
  );
  if (result.id !== announcementId) throw new ApiContractError();
  return result;
}

export function unpublishBoardAnnouncement(
  boardId: string,
  announcementId: string,
  boardRevision: number,
  announcementRevision: number,
): Promise<BoardAnnouncementMutation> {
  return lifecyclePost(
    boardId,
    announcementId,
    boardRevision,
    announcementRevision,
    "unpublish",
  );
}

export function archiveBoardAnnouncement(
  boardId: string,
  announcementId: string,
  boardRevision: number,
  announcementRevision: number,
): Promise<BoardAnnouncementMutation> {
  return lifecyclePost(
    boardId,
    announcementId,
    boardRevision,
    announcementRevision,
    "archive",
  );
}

export function restoreBoardAnnouncement(
  boardId: string,
  announcementId: string,
  boardRevision: number,
  announcementRevision: number,
): Promise<BoardAnnouncementMutation> {
  return lifecyclePost(
    boardId,
    announcementId,
    boardRevision,
    announcementRevision,
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

export async function deleteBoardAnnouncement(
  rawBoardId: string,
  rawAnnouncementId: string,
  rawBoardRevision: number,
  rawAnnouncementRevision: number,
): Promise<void> {
  const boardId = uuid.parse(rawBoardId);
  const announcementId = uuid.parse(rawAnnouncementId);
  const body = revisionBody(rawBoardRevision, rawAnnouncementRevision);
  const response = await apiRequest(itemPath(boardId, announcementId), {
    method: "DELETE",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 204) return;
  if (response.ok) throw new ApiContractError();
  return throwSafeAnnouncementError(
    response.status,
    await boundedErrorDetail(response),
  );
}
