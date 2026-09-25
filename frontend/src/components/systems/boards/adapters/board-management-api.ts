import { z } from "zod";
import { ApiContractError, type ApiRequestInit } from "@/lib/api";
import { queryString, safeBoardJson } from "./board-management-requests";
import {
  uuidSchema,
  boardSchema,
  boardListSchema,
  boardPurgePreviewSchema,
  boardPurgeResultSchema,
  boardPurgeInputSchema,
  personalSchema,
  boardListOptionsSchema,
  boardCreateSchema,
  revisionSchema,
  boardUpdateSchema,
} from "./board-management-schemas";
import type {
  BoardManagementBoard,
  BoardManagementPage,
  BoardPurgePreview,
  BoardListOptions,
  BoardCreateInput,
  BoardUpdateInput,
  BoardPersonalState,
} from "./board-management-schemas";
export type {
  BoardManagementBoard,
  BoardManagementPage,
  BoardPurgePreview,
  BoardListOptions,
  BoardCreateInput,
  BoardUpdateInput,
  BoardPersonalState,
};
export type {
  PortableBoardBundle,
  BoardTemplate,
  BoardTemplateListOptions,
  BoardConfigurationDownload,
} from "./board-management-schemas";
export {
  downloadBoardConfiguration,
  importBoardConfiguration,
} from "./board-configuration-api";
export {
  deleteBoardTemplate,
  getBoardTemplate,
  instantiateBoardTemplate,
  listBoardTemplates,
  saveBoardTemplate,
} from "./board-templates-api";

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
    favorites_only: String(options.favoritesOnly),
  };
  if (options.search !== undefined) values.search = options.search;
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
      department_id: input.departmentId,
      default_section: input.defaultSection,
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
      department_id: input.departmentId,
      default_section: input.defaultSection,
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
    boardPurgePreviewSchema,
    { method: "POST" },
  );
  if (
    preview.confirmation_name !== boardId ||
    preview.impact.target_id !== boardId
  )
    throw new ApiContractError();
  return preview;
}

export async function purgeBoard(
  rawBoardId: string,
  rawInput: z.input<typeof boardPurgeInputSchema>,
): Promise<z.output<typeof boardPurgeResultSchema>> {
  const boardId = uuidSchema.parse(rawBoardId);
  const input = boardPurgeInputSchema.parse(rawInput);
  if (input.confirmationName !== boardId) throw new ApiContractError();
  const result = await safeBoardJson(
    `/boards/${encodeURIComponent(boardId)}/purge`,
    boardPurgeResultSchema,
    {
      method: "POST",
      body: JSON.stringify({
        token: input.token,
        confirmation_name: input.confirmationName,
        password: input.password,
      }),
    },
  );
  if (
    result.impact.target_id !== boardId ||
    result.impact.operation !== "purge"
  )
    throw new ApiContractError();
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

export async function getBoardPersonalState(): Promise<BoardPersonalState> {
  return safeBoardJson("/boards/personal", personalSchema);
}

export async function setBoardFavorite(
  rawBoardId: string,
  rawFavorite: boolean,
): Promise<BoardPersonalState> {
  const boardId = uuidSchema.parse(rawBoardId);
  const favorite = z.boolean().parse(rawFavorite);
  return safeBoardJson(
    `/boards/personal/favorites/${encodeURIComponent(boardId)}`,
    personalSchema,
    {
      method: "PUT",
      body: JSON.stringify({ favorite }),
    },
  );
}

export async function setBoardHome(
  rawBoardId: string | null,
): Promise<BoardPersonalState> {
  const boardId = uuidSchema.nullable().parse(rawBoardId);
  return safeBoardJson("/boards/personal/home", personalSchema, {
    method: "PUT",
    body: JSON.stringify({ board_id: boardId }),
  });
}
