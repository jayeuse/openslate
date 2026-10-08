import { ApiContractError, type ApiRequestInit } from "@/lib/api";
import {
  assertLifecyclePurgePreviewFor,
  assertLifecyclePurgeResultFor,
  lifecyclePurgeInputSchema,
  lifecyclePurgePreviewSchema,
  lifecyclePurgeResultSchema,
} from "@/lib/lifecycle";
import type {
  LifecyclePurgeInput,
  LifecyclePurgePreview,
  LifecyclePurgeResult,
} from "@/lib/lifecycle";
import { queryString, safeBoardJson } from "./board-management-requests";
import {
  uuidSchema,
  boardSchema,
  boardListSchema,
  boardGroupsSchema,
  boardGroupsInputSchema,
  boardListOptionsSchema,
  boardCreateSchema,
  revisionSchema,
  boardUpdateSchema,
} from "./board-management-schemas";
import type {
  BoardManagementBoard,
  BoardManagementPage,
  BoardListOptions,
  BoardCreateInput,
  BoardUpdateInput,
  BoardGroups,
  BoardGroupsInput,
} from "./board-management-schemas";
export type BoardPurgePreview = LifecyclePurgePreview;
export type BoardPurgeInput = LifecyclePurgeInput;
export type BoardPurgeResult = LifecyclePurgeResult;
export type {
  BoardManagementBoard,
  BoardManagementPage,
  BoardListOptions,
  BoardCreateInput,
  BoardUpdateInput,
  BoardGroups,
  BoardGroupsInput,
};
export type {
  PortableBoardBundle,
  BoardConfigurationDownload,
  BoardScope,
  BoardAccessLevel,
} from "./board-management-schemas";
export {
  downloadBoardConfiguration,
  importBoardConfiguration,
} from "./board-configuration-api";

export async function listBoards(
  raw: BoardListOptions = {},
): Promise<BoardManagementPage> {
  const options = boardListOptionsSchema.parse(raw);
  const values: Record<string, string | number> = {
    limit: options.limit,
    offset: options.offset,
    sort_by: options.sortBy,
    sort_order: options.sortOrder,
    status: options.status,
  };
  if (options.search !== undefined) values.search = options.search;
  if (options.scope !== undefined) values.scope = options.scope;
  if (options.departmentId !== undefined)
    values.department_id = options.departmentId;
  return safeBoardJson(`/boards?${queryString(values)}`, boardListSchema);
}

export async function createBoard(
  raw: BoardCreateInput,
): Promise<BoardManagementBoard> {
  const input = boardCreateSchema.parse(raw);
  return safeBoardJson("/boards", boardSchema, {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      description: input.description,
    }),
  });
}

async function boardById(
  boardId: string,
  path: string,
  init: ApiRequestInit = {},
): Promise<BoardManagementBoard> {
  const board = await safeBoardJson(path, boardSchema, init);
  if (board.id !== boardId) throw new ApiContractError();
  return board;
}

export async function readBoard(
  rawBoardId: string,
): Promise<BoardManagementBoard> {
  const boardId = uuidSchema.parse(rawBoardId);
  return boardById(boardId, `/boards/${encodeURIComponent(boardId)}`);
}

export async function updateBoard(
  rawBoardId: string,
  raw: BoardUpdateInput,
): Promise<BoardManagementBoard> {
  const boardId = uuidSchema.parse(rawBoardId);
  const input = boardUpdateSchema.parse(raw);
  return boardById(boardId, `/boards/${encodeURIComponent(boardId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      revision: input.revision,
      name: input.name,
      description: input.description,
    }),
  });
}

export async function archiveBoard(
  rawBoardId: string,
  rawRevision: number,
): Promise<BoardManagementBoard> {
  const boardId = uuidSchema.parse(rawBoardId);
  const revision = revisionSchema.parse(rawRevision);
  return boardById(boardId, `/boards/${encodeURIComponent(boardId)}/archive`, {
    method: "POST",
    body: JSON.stringify({ revision }),
  });
}

export async function restoreBoard(
  rawBoardId: string,
  rawRevision: number,
): Promise<BoardManagementBoard> {
  const boardId = uuidSchema.parse(rawBoardId);
  const revision = revisionSchema.parse(rawRevision);
  return boardById(boardId, `/boards/${encodeURIComponent(boardId)}/restore`, {
    method: "POST",
    body: JSON.stringify({ revision }),
  });
}

export async function previewBoardPurge(
  rawBoardId: string,
): Promise<BoardPurgePreview> {
  const boardId = uuidSchema.parse(rawBoardId);
  const preview = await safeBoardJson(
    `/boards/${encodeURIComponent(boardId)}/purge/preview`,
    lifecyclePurgePreviewSchema,
    { method: "POST" },
  );
  assertLifecyclePurgePreviewFor(preview, "board", boardId);
  return preview;
}

export async function purgeBoard(
  rawBoardId: string,
  rawInput: BoardPurgeInput,
): Promise<BoardPurgeResult> {
  const boardId = uuidSchema.parse(rawBoardId);
  const input = lifecyclePurgeInputSchema.parse(rawInput);
  const result = await safeBoardJson(
    `/boards/${encodeURIComponent(boardId)}/purge`,
    lifecyclePurgeResultSchema,
    {
      method: "POST",
      body: JSON.stringify({
        token: input.token,
        confirmation_name: input.confirmationName,
        password: input.password,
      }),
    },
  );
  assertLifecyclePurgeResultFor(result, "board", boardId);
  return result;
}

export async function duplicateBoardStructure(
  rawBoardId: string,
): Promise<BoardManagementBoard> {
  const boardId = uuidSchema.parse(rawBoardId);
  const board = await safeBoardJson(
    `/boards/${encodeURIComponent(boardId)}/duplicate`,
    boardSchema,
    {
      method: "POST",
    },
  );
  if (board.id === boardId) throw new ApiContractError();
  return board;
}

export async function readBoardGroups(
  rawBoardId: string,
): Promise<BoardGroups> {
  const boardId = uuidSchema.parse(rawBoardId);
  const groups = await safeBoardJson(
    `/boards/${encodeURIComponent(boardId)}/groups`,
    boardGroupsSchema,
  );
  if (groups.boardId !== boardId) throw new ApiContractError();
  return groups;
}

/** Replaces the whole set of groups of a project Board; administrators only. */
export async function replaceBoardGroups(
  rawBoardId: string,
  raw: BoardGroupsInput,
): Promise<BoardGroups> {
  const boardId = uuidSchema.parse(rawBoardId);
  const input = boardGroupsInputSchema.parse(raw);
  const groups = await safeBoardJson(
    `/boards/${encodeURIComponent(boardId)}/groups`,
    boardGroupsSchema,
    {
      method: "PUT",
      body: JSON.stringify({
        revision: input.revision,
        groups: input.groups.map((group) => ({
          group_id: group.groupId,
          level: group.level,
        })),
      }),
    },
  );
  if (groups.boardId !== boardId) throw new ApiContractError();
  return groups;
}
