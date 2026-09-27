import { z } from "zod";

export const uuid = z.string().uuid();
const utc = z.iso
  .datetime({ offset: true })
  .refine((value) => /(?:Z|[+-]00:00)$/i.test(value));
export const revision = z.number().int().min(1);
export const view = z.enum(["published", "draft", "editable", "archive"]);
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

export const announcementWire = z
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
export const announcementListWire = z
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
export const mutationWire = z
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
export const publicationWire = z
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

export const listOptions = z
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
export const createInput = z
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
export const patchInput = z
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
export const scheduleInput = z
  .object({
    boardRevision: revision,
    announcementRevision: revision,
    publishAt: utc,
  })
  .strict();
export const publishInput = z
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
