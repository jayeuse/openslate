import { z } from "zod";
import {
  ApiContractError,
  ApiError,
  apiFetch,
  apiRequest,
  type ApiRequestInit,
} from "@/lib/api";

import {
  uuid,
  revision,
  view,
  audienceInput,
  announcementWire,
  announcementListWire,
  mutationWire,
  publicationWire,
  listOptions,
  createInput,
  patchInput,
  scheduleInput,
  publishInput,
} from "./board-announcements-schemas";
import type {
  BoardAnnouncement,
  BoardAnnouncementPage,
  BoardAnnouncementMutation,
  BoardAnnouncementPublication,
  BoardAnnouncementView,
  BoardAnnouncementListOptions,
  BoardAnnouncementCreateInput,
  BoardAnnouncementPatchInput,
  BoardAnnouncementScheduleInput,
  BoardAnnouncementPublishInput,
} from "./board-announcements-schemas";
export type {
  BoardAnnouncement,
  BoardAnnouncementPage,
  BoardAnnouncementMutation,
  BoardAnnouncementPublication,
  BoardAnnouncementView,
  BoardAnnouncementListOptions,
  BoardAnnouncementCreateInput,
  BoardAnnouncementPatchInput,
  BoardAnnouncementScheduleInput,
  BoardAnnouncementPublishInput,
};

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
      : selected === "editable"
        ? (item.status === "draft" ||
            item.status === "scheduled" ||
            item.status === "published") &&
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
