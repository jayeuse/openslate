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
export const postWire = z
  .object({
    id: uuid,
    board_id: uuid,
    author_id: uuid,
    title: z.string().min(1).max(100),
    body: z.string().min(1).max(2000),
    links,
    status: z.enum(["draft", "scheduled", "published", "archived"]),
    publish_at: utc.nullable(),
    expires_at: utc.nullable(),
    pinned: z.boolean(),
    post_revision: revision.nullable(),
    board_revision: revision,
    publication_number: revision.nullable(),
    published_at: utc.nullable(),
    edited: z.boolean(),
    created_at: utc,
    updated_at: utc,
  })
  .strict()
  .refine((item) =>
    item.post_revision === null
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
      post_revision,
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
      postRevision: post_revision,
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
export const postListWire = z
  .object({
    items: z.array(postWire),
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
    post_revision: revision,
    board_revision: revision,
  })
  .strict()
  .transform(({ id, post_revision, board_revision }) => ({
    id,
    postRevision: post_revision,
    boardRevision: board_revision,
  }));
export const publicationWire = z
  .object({
    id: uuid,
    post_id: uuid,
    publication_number: revision,
    publication_key: uuid,
    published_at: utc,
  })
  .strict()
  .transform(
    ({ id, post_id, publication_number, publication_key, published_at }) => ({
      id,
      postId: post_id,
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
  expiresAt: utc.nullable(),
  pinned: z.boolean(),
};
export const createInput = z
  .object({
    boardRevision: revision,
    title: contentFields.title,
    body: contentFields.body,
    links: contentFields.links.optional(),
    expiresAt: contentFields.expiresAt.optional(),
    pinned: contentFields.pinned.optional(),
  })
  .strict();
export const patchInput = z
  .object({
    boardRevision: revision,
    postRevision: revision,
    title: contentFields.title.optional(),
    body: contentFields.body.optional(),
    links: contentFields.links.optional(),
    expiresAt: contentFields.expiresAt.optional(),
    pinned: contentFields.pinned.optional(),
  })
  .strict()
  .refine((input) =>
    Object.keys(input).some(
      (key) => key !== "boardRevision" && key !== "postRevision",
    ),
  );
export const scheduleInput = z
  .object({
    boardRevision: revision,
    postRevision: revision,
    publishAt: utc,
  })
  .strict();
export const publishInput = z
  .object({
    boardRevision: revision,
    postRevision: revision,
    publicationKey: uuid,
  })
  .strict();

export const deleteWire = z
  .object({
    id: uuid,
    outcome: z.enum(["deleted", "archived"]),
    post_revision: revision.nullable(),
    board_revision: revision,
  })
  .strict()
  .refine(
    ({ outcome, post_revision }) =>
      (outcome === "deleted") === (post_revision === null),
  )
  .transform(({ id, outcome, post_revision, board_revision }) => ({
    id,
    outcome,
    postRevision: post_revision,
    boardRevision: board_revision,
  }));
const revisionSummaryFields = {
  id: uuid,
  post_id: uuid,
  publication_number: revision,
  author_id: uuid,
  title: z.string().min(1).max(100),
  published_at: utc,
};
function summary<
  T extends {
    id: string;
    post_id: string;
    publication_number: number;
    author_id: string;
    title: string;
    published_at: string;
  },
>(value: T) {
  return {
    id: value.id,
    postId: value.post_id,
    publicationNumber: value.publication_number,
    authorId: value.author_id,
    title: value.title,
    publishedAt: value.published_at,
  };
}
export const revisionListWire = z
  .object({
    post_id: uuid,
    items: z
      .array(z.object(revisionSummaryFields).strict().transform(summary))
      .max(1000),
  })
  .strict()
  .refine(({ post_id, items }) =>
    items.every((item) => item.postId === post_id),
  )
  .transform(({ post_id, items }) => ({ postId: post_id, items }));
export const revisionWire = z
  .object({
    ...revisionSummaryFields,
    body: z.string().min(1).max(2000),
    links,
    expires_at: utc.nullable(),
  })
  .strict()
  .transform((value) => ({
    ...summary(value),
    body: value.body,
    links: value.links,
    expiresAt: value.expires_at,
  }));

export type BoardPost = z.output<typeof postWire>;
export type BoardPostDeletion = z.output<typeof deleteWire>;
export type BoardPostRevisionSummary = z.output<
  typeof revisionListWire
>["items"][number];
export type BoardPostRevisionList = z.output<typeof revisionListWire>;
export type BoardPostRevision = z.output<typeof revisionWire>;
export type BoardPostPage = z.output<typeof postListWire>;
export type BoardPostMutation = z.output<typeof mutationWire>;
export type BoardPostPublication = z.output<typeof publicationWire>;
export type BoardPostView = z.output<typeof view>;
export type BoardPostListOptions = z.input<typeof listOptions>;
export type BoardPostCreateInput = z.input<typeof createInput>;
export type BoardPostPatchInput = z.input<typeof patchInput>;
export type BoardPostScheduleInput = z.input<typeof scheduleInput>;
export type BoardPostPublishInput = z.input<typeof publishInput>;
