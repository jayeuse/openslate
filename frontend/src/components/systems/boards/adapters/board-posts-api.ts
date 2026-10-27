import { z } from "zod";
import {
  ApiContractError,
  ApiError,
  apiFetch,
  type ApiRequestInit,
} from "@/lib/api";

import {
  uuid,
  revision,
  view,
  postWire,
  deleteWire,
  revisionListWire,
  revisionWire,
  postListWire,
  mutationWire,
  publicationWire,
  listOptions,
  createInput,
  patchInput,
  scheduleInput,
  publishInput,
} from "./board-posts-schemas";
import type {
  BoardPost,
  BoardPostPage,
  BoardPostMutation,
  BoardPostPublication,
  BoardPostView,
  BoardPostListOptions,
  BoardPostCreateInput,
  BoardPostPatchInput,
  BoardPostScheduleInput,
  BoardPostPublishInput,
  BoardPostDeletion,
  BoardPostRevision,
  BoardPostRevisionList,
  BoardPostRevisionSummary,
} from "./board-posts-schemas";
export type {
  BoardPostDeletion,
  BoardPostRevision,
  BoardPostRevisionList,
  BoardPostRevisionSummary,
  BoardPost,
  BoardPostPage,
  BoardPostMutation,
  BoardPostPublication,
  BoardPostView,
  BoardPostListOptions,
  BoardPostCreateInput,
  BoardPostPatchInput,
  BoardPostScheduleInput,
  BoardPostPublishInput,
};

const safeCodes: Record<string, { status: number; message: string }> = {
  stale_board_revision: {
    status: 409,
    message: "Board changed; reload before saving",
  },
  stale_post_revision: {
    status: 409,
    message: "Post changed; reload before saving",
  },
  board_archived: {
    status: 409,
    message: "Restore the board before editing it",
  },
  post_archived: {
    status: 409,
    message: "Restore the post before editing it",
  },
  post_not_archived: {
    status: 409,
    message: "Archive the post first",
  },
  post_not_published: {
    status: 409,
    message: "There is no published post",
  },
  post_unavailable: {
    status: 409,
    message: "Restore before publishing",
  },
  post_limit_reached: {
    status: 409,
    message: "The board has too many posts",
  },
  post_conflict: {
    status: 409,
    message: "Unable to save post",
  },
  publication_key_conflict: {
    status: 409,
    message: "Publication key was already used",
  },
  publication_invalid: {
    status: 409,
    message: "Published post is unavailable",
  },
  post_invalid: {
    status: 422,
    message: "Post fields are invalid",
  },
  post_schedule_invalid: {
    status: 422,
    message: "Choose a future publication before expiration",
  },
  post_expired: {
    status: 422,
    message: "Expiration must follow publication",
  },
};

function throwSafePostError(status: number, detail: unknown): never {
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

async function postJson<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  init: ApiRequestInit = {},
): Promise<z.output<Schema>> {
  try {
    return await apiFetch(path, schema, { cache: "no-store", ...init });
  } catch (error) {
    if (error instanceof ApiError)
      return throwSafePostError(error.status, error.details);
    throw error;
  }
}

function itemPath(boardId: string, postId: string): string {
  return `/boards/${boardId}/posts/${postId}`;
}

function revisionBody(boardRevision: number, postRevision: number) {
  return {
    board_revision: revision.parse(boardRevision),
    post_revision: revision.parse(postRevision),
  };
}

function contentBody(
  input: z.output<typeof createInput> | z.output<typeof patchInput>,
) {
  return {
    ...(input.title !== undefined && { title: input.title }),
    ...(input.body !== undefined && { body: input.body }),
    ...(input.links !== undefined && { links: input.links }),
    ...(input.expiresAt !== undefined && { expires_at: input.expiresAt }),
    ...(input.pinned !== undefined && { pinned: input.pinned }),
  };
}

function matchesView(item: BoardPost, selected: BoardPostView): boolean {
  return selected === "published"
    ? item.status === "published" && item.postRevision === null
    : selected === "draft"
      ? (item.status === "draft" || item.status === "scheduled") &&
        item.postRevision !== null
      : selected === "editable"
        ? (item.status === "draft" ||
            item.status === "scheduled" ||
            item.status === "published") &&
          item.postRevision !== null
        : item.status === "archived" && item.postRevision !== null;
}

export async function listBoardPosts(
  rawBoardId: string,
  raw: BoardPostListOptions = {},
): Promise<BoardPostPage> {
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
  const result = await postJson(
    `/boards/${boardId}/posts?${query}`,
    postListWire,
  );
  if (
    result.items.some(
      (item) => item.boardId !== boardId || !matchesView(item, options.view),
    )
  )
    throw new ApiContractError();
  return result;
}

export async function readBoardPost(
  rawBoardId: string,
  rawPostId: string,
  rawView: BoardPostView = "published",
): Promise<BoardPost> {
  const boardId = uuid.parse(rawBoardId);
  const postId = uuid.parse(rawPostId);
  const selected = view.parse(rawView);
  const result = await postJson(
    `${itemPath(boardId, postId)}?view=${selected}`,
    postWire,
  );
  if (
    result.id !== postId ||
    result.boardId !== boardId ||
    !matchesView(result, selected)
  )
    throw new ApiContractError();
  return result;
}

export async function createBoardPost(
  rawBoardId: string,
  raw: BoardPostCreateInput,
): Promise<BoardPostMutation> {
  const boardId = uuid.parse(rawBoardId);
  const input = createInput.parse(raw);
  return postJson(`/boards/${boardId}/posts`, mutationWire, {
    method: "POST",
    body: JSON.stringify({
      board_revision: input.boardRevision,
      ...contentBody(input),
    }),
  });
}

export async function updateBoardPost(
  rawBoardId: string,
  rawPostId: string,
  raw: BoardPostPatchInput,
): Promise<BoardPostMutation> {
  const boardId = uuid.parse(rawBoardId);
  const postId = uuid.parse(rawPostId);
  const input = patchInput.parse(raw);
  const result = await postJson(itemPath(boardId, postId), mutationWire, {
    method: "PATCH",
    body: JSON.stringify({
      ...revisionBody(input.boardRevision, input.postRevision),
      ...contentBody(input),
    }),
  });
  if (result.id !== postId) throw new ApiContractError();
  return result;
}

export async function scheduleBoardPost(
  rawBoardId: string,
  rawPostId: string,
  raw: BoardPostScheduleInput,
): Promise<BoardPostMutation> {
  const boardId = uuid.parse(rawBoardId);
  const postId = uuid.parse(rawPostId);
  const input = scheduleInput.parse(raw);
  const result = await postJson(
    `${itemPath(boardId, postId)}/schedule`,
    mutationWire,
    {
      method: "POST",
      body: JSON.stringify({
        ...revisionBody(input.boardRevision, input.postRevision),
        publish_at: input.publishAt,
      }),
    },
  );
  if (result.id !== postId) throw new ApiContractError();
  return result;
}

export async function publishBoardPost(
  rawBoardId: string,
  rawPostId: string,
  raw: BoardPostPublishInput,
): Promise<BoardPostPublication> {
  const boardId = uuid.parse(rawBoardId);
  const postId = uuid.parse(rawPostId);
  const input = publishInput.parse(raw);
  const result = await postJson(
    `${itemPath(boardId, postId)}/publish`,
    publicationWire,
    {
      method: "POST",
      body: JSON.stringify({
        ...revisionBody(input.boardRevision, input.postRevision),
        publication_key: input.publicationKey,
      }),
    },
  );
  if (
    result.postId !== postId ||
    result.publicationKey !== input.publicationKey
  )
    throw new ApiContractError();
  return result;
}

async function lifecyclePost(
  rawBoardId: string,
  rawPostId: string,
  rawBoardRevision: number,
  rawPostRevision: number,
  action: "unpublish" | "archive" | "restore",
): Promise<BoardPostMutation> {
  const boardId = uuid.parse(rawBoardId);
  const postId = uuid.parse(rawPostId);
  const body = revisionBody(rawBoardRevision, rawPostRevision);
  const result = await postJson(
    `${itemPath(boardId, postId)}/${action}`,
    mutationWire,
    { method: "POST", body: JSON.stringify(body) },
  );
  if (result.id !== postId) throw new ApiContractError();
  return result;
}

export function unpublishBoardPost(
  boardId: string,
  postId: string,
  boardRevision: number,
  postRevision: number,
): Promise<BoardPostMutation> {
  return lifecyclePost(
    boardId,
    postId,
    boardRevision,
    postRevision,
    "unpublish",
  );
}

export function archiveBoardPost(
  boardId: string,
  postId: string,
  boardRevision: number,
  postRevision: number,
): Promise<BoardPostMutation> {
  return lifecyclePost(boardId, postId, boardRevision, postRevision, "archive");
}

export function restoreBoardPost(
  boardId: string,
  postId: string,
  boardRevision: number,
  postRevision: number,
): Promise<BoardPostMutation> {
  return lifecyclePost(boardId, postId, boardRevision, postRevision, "restore");
}

/**
 * Deletes a post that was never published, or archives a published one so its
 * edit history stays. The outcome says which happened.
 */
export async function deleteBoardPost(
  rawBoardId: string,
  rawPostId: string,
  rawBoardRevision: number,
  rawPostRevision: number,
): Promise<BoardPostDeletion> {
  const boardId = uuid.parse(rawBoardId);
  const postId = uuid.parse(rawPostId);
  const result = await postJson(itemPath(boardId, postId), deleteWire, {
    method: "DELETE",
    body: JSON.stringify(revisionBody(rawBoardRevision, rawPostRevision)),
  });
  if (result.id !== postId) throw new ApiContractError();
  return result;
}

/** Every published version of a post, newest first. */
export async function listBoardPostRevisions(
  rawBoardId: string,
  rawPostId: string,
  signal?: AbortSignal,
): Promise<BoardPostRevisionList> {
  const boardId = uuid.parse(rawBoardId);
  const postId = uuid.parse(rawPostId);
  const result = await postJson(
    `${itemPath(boardId, postId)}/revisions`,
    revisionListWire,
    { signal },
  );
  if (result.postId !== postId) throw new ApiContractError();
  return result;
}

export async function readBoardPostRevision(
  rawBoardId: string,
  rawPostId: string,
  rawRevisionId: string,
  signal?: AbortSignal,
): Promise<BoardPostRevision> {
  const boardId = uuid.parse(rawBoardId);
  const postId = uuid.parse(rawPostId);
  const revisionId = uuid.parse(rawRevisionId);
  const result = await postJson(
    `${itemPath(boardId, postId)}/revisions/${revisionId}`,
    revisionWire,
    { signal },
  );
  if (result.id !== revisionId || result.postId !== postId)
    throw new ApiContractError();
  return result;
}
