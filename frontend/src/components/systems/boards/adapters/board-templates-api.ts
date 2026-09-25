import { z } from "zod";
import { ApiContractError } from "@/lib/api";
import { queryString, safeBoardJson } from "./board-management-requests";
import {
  uuidSchema,
  boardSchema,
  templateSchema,
  templateListSchema,
  templateListOptionsSchema,
  templateCreateSchema,
} from "./board-management-schemas";
import type {
  BoardManagementBoard,
  BoardTemplate,
  BoardTemplateListOptions,
} from "./board-management-schemas";

export async function listBoardTemplates(raw: BoardTemplateListOptions = {}) {
  const options = templateListOptionsSchema.parse(raw);
  const values: Record<string, string | number> = {
    limit: options.limit,
    offset: options.offset,
    sort_by: options.sortBy,
    sort_order: options.sortOrder,
  };
  if (options.search) values.search = options.search;
  return safeBoardJson(
    `/board-templates?${queryString(values)}`,
    templateListSchema,
  );
}

export async function saveBoardTemplate(raw: {
  boardId: string;
  name: string;
}): Promise<BoardTemplate> {
  const input = templateCreateSchema.parse(raw);
  return safeBoardJson("/board-templates", templateSchema, {
    method: "POST",
    body: JSON.stringify({ board_id: input.boardId, name: input.name }),
  });
}

export async function getBoardTemplate(
  rawTemplateId: string,
): Promise<BoardTemplate> {
  const templateId = uuidSchema.parse(rawTemplateId);
  const template = await safeBoardJson(
    `/board-templates/${encodeURIComponent(templateId)}`,
    templateSchema,
  );
  if (template.id !== templateId) throw new ApiContractError();
  return template;
}

export async function deleteBoardTemplate(
  rawTemplateId: string,
): Promise<void> {
  const templateId = uuidSchema.parse(rawTemplateId);
  await safeBoardJson(
    `/board-templates/${encodeURIComponent(templateId)}`,
    z.null(),
    {
      method: "DELETE",
    },
  );
}

export async function instantiateBoardTemplate(
  rawTemplateId: string,
): Promise<BoardManagementBoard> {
  const templateId = uuidSchema.parse(rawTemplateId);
  return safeBoardJson(
    `/board-templates/${encodeURIComponent(templateId)}/boards`,
    boardSchema,
    {
      method: "POST",
    },
  );
}
