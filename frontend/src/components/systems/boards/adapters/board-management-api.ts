import { z } from "zod";
import {
  ApiContractError,
  ApiError,
  apiFetch,
  apiRequest,
  type ApiRequestInit,
} from "@/lib/api";

const MAX_BUNDLE_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const EXPORT_FILENAME = "board-configuration.json";
const uuidSchema = z.string().uuid();
const timestampSchema = z.iso.datetime({ offset: true });
const named = (limit: number) =>
  z
    .string()
    .min(1)
    .max(limit)
    .refine((value) => value.trim().length > 0);
const fieldTypeSchema = z.enum([
  "text",
  "long_text",
  "email",
  "url",
  "number",
  "decimal",
  "int",
  "boolean",
  "date",
  "datetime",
  "select",
]);
const fieldSchema = z
  .object({
    name: named(150),
    expected_type: fieldTypeSchema,
  })
  .strict();
const scalarSchema = z.union([
  z.string().max(4000),
  z.boolean(),
  z.number().finite(),
]);
const filterOperatorSchema = z.enum([
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "prefix",
  "suffix",
  "in",
  "empty",
  "not_empty",
  "blank",
  "not_blank",
]);
const filterSchema = fieldSchema
  .extend({
    operator: filterOperatorSchema,
    value: z
      .union([scalarSchema, z.array(scalarSchema).min(1).max(100)])
      .nullish(),
  })
  .strict()
  .superRefine((filter, context) => {
    const withoutValue = ["empty", "not_empty", "blank", "not_blank"];
    if (withoutValue.includes(filter.operator)) {
      if (filter.value != null)
        context.addIssue({ code: "custom", message: "Invalid filter value" });
    } else if (
      filter.value == null ||
      (filter.operator === "in") !== Array.isArray(filter.value)
    ) {
      context.addIssue({ code: "custom", message: "Invalid filter value" });
    }
    const allowed = new Set<string>(["eq", "neq", ...withoutValue]);
    if (["text", "long_text", "email", "url"].includes(filter.expected_type)) {
      ["contains", "prefix", "suffix"].forEach((operator) =>
        allowed.add(operator),
      );
    } else if (filter.expected_type === "select") {
      ["contains", "in"].forEach((operator) => allowed.add(operator));
    } else if (
      ["number", "decimal", "int", "date", "datetime"].includes(
        filter.expected_type,
      )
    ) {
      ["lt", "lte", "gt", "gte"].forEach((operator) => allowed.add(operator));
    }
    if (!allowed.has(filter.operator)) {
      context.addIssue({
        code: "custom",
        message: "Unsupported filter operator",
      });
    }
  });
const widgetConfigSchema = z
  .object({
    fields: z.array(fieldSchema).max(24),
    filters: z.array(filterSchema).max(8),
    logic: z.enum(["and", "or"]),
    metric: fieldSchema.nullable(),
    visualization: z.enum(["bar", "line", "pie"]),
    size: z.enum(["half", "full"]),
    refresh: z.enum(["manual", "one-minute", "five-minutes"]),
    pinned: z.boolean(),
  })
  .strict()
  .superRefine((config, context) => {
    if (
      new Set(config.fields.map((field) => field.name)).size !==
      config.fields.length
    ) {
      context.addIssue({ code: "custom", message: "Duplicate widget fields" });
    }
    if (
      config.metric &&
      !["number", "decimal", "int"].includes(config.metric.expected_type)
    ) {
      context.addIssue({ code: "custom", message: "Metric must be numeric" });
    }
  });
const sourceSchema = z
  .object({
    department_name: named(150),
    module_name: named(150),
  })
  .strict();
const widgetSchema = z
  .object({
    name: named(80),
    widget_type: z.enum(["summary", "workload", "records", "chart"]),
    source: sourceSchema,
    config: widgetConfigSchema,
  })
  .strict();
const bundleSchema = z
  .object({
    kind: z.literal("openslate-board"),
    version: z.literal(2),
    configuration: z
      .object({
        name: named(200),
        description: z.string().max(240).nullable(),
        department_name: named(150).nullable(),
        default_section: z.enum(["overview", "calendar", "announcements"]),
        widgets: z.array(widgetSchema).max(12),
      })
      .strict(),
  })
  .strict();
const boardSchema = z
  .object({
    id: uuidSchema,
    owner_id: uuidSchema,
    department_id: uuidSchema.nullable(),
    name: named(200),
    description: z.string().nullable(),
    status: z.enum(["active", "archived"]),
    default_section: z.enum(["overview", "calendar", "announcements"]),
    revision: z.number().int().min(1),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict()
  .transform((board) => ({
    id: board.id,
    ownerId: board.owner_id,
    departmentId: board.department_id,
    name: board.name,
    description: board.description,
    status: board.status,
    defaultSection: board.default_section,
    revision: board.revision,
    createdAt: board.created_at,
    updatedAt: board.updated_at,
  }));
const templateSchema = z
  .object({
    id: uuidSchema,
    name: named(80),
    widget_count: z.number().int().min(0).max(12),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict()
  .transform(({ widget_count, created_at, updated_at, ...template }) => ({
    ...template,
    widgetCount: widget_count,
    createdAt: created_at,
    updatedAt: updated_at,
  }));
const paginationSchema = z
  .object({
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0),
    count: z.number().int().min(0),
    total: z.number().int().min(0),
    has_more: z.boolean(),
  })
  .strict()
  .refine(({ count, limit }) => count <= limit)
  .transform(({ has_more, ...page }) => ({ ...page, hasMore: has_more }));
const templateListSchema = z
  .object({
    items: z.array(templateSchema),
    pagination: paginationSchema,
  })
  .strict()
  .refine(({ items, pagination }) => items.length === pagination.count);
const boardListSchema = z
  .object({ items: z.array(boardSchema), pagination: paginationSchema })
  .strict()
  .refine(({ items, pagination }) => items.length === pagination.count);
const personalSchema = z
  .object({
    favorite_board_ids: z
      .array(uuidSchema)
      .refine((ids) => new Set(ids).size === ids.length),
    home_board_id: uuidSchema.nullable(),
  })
  .strict()
  .transform(({ favorite_board_ids, home_board_id }) => ({
    favoriteBoardIds: favorite_board_ids,
    homeBoardId: home_board_id,
  }));
const templateListOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
    sortBy: z.enum(["name", "created_at", "updated_at"]).default("name"),
    sortOrder: z.enum(["asc", "desc"]).default("asc"),
    search: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
const templateCreateSchema = z
  .object({ boardId: uuidSchema, name: named(80) })
  .strict();
const boardListOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
    sortBy: z.enum(["name", "created_at", "updated_at"]).default("name"),
    sortOrder: z.enum(["asc", "desc"]).default("asc"),
    status: z.enum(["active", "archived", "all"]).default("active"),
    search: z.string().trim().min(1).max(100).optional(),
    departmentId: uuidSchema.optional(),
  })
  .strict();
const boardCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().nullable().optional(),
    departmentId: uuidSchema.nullable().optional(),
    defaultSection: z
      .enum(["overview", "calendar", "announcements"])
      .optional(),
  })
  .strict();
const revisionSchema = z.number().int().min(1);
const boardUpdateSchema = boardCreateSchema
  .partial()
  .extend({ revision: revisionSchema })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== "revision"));

export type PortableBoardBundle = z.output<typeof bundleSchema>;
export type BoardManagementBoard = z.output<typeof boardSchema>;
export type BoardManagementPage = z.output<typeof boardListSchema>;
export type BoardListOptions = z.input<typeof boardListOptionsSchema>;
export type BoardCreateInput = z.input<typeof boardCreateSchema>;
export type BoardUpdateInput = z.input<typeof boardUpdateSchema>;
export type BoardTemplate = z.output<typeof templateSchema>;
export type BoardPersonalState = z.output<typeof personalSchema>;
export type BoardTemplateListOptions = z.input<
  typeof templateListOptionsSchema
>;
export type BoardConfigurationDownload = {
  blob: Blob;
  filename: typeof EXPORT_FILENAME;
  bundle: PortableBoardBundle;
};

const safeCodes: Record<string, { status: number; message: string }> = {
  board_bundle_too_large: {
    status: 413,
    message: "Board configuration is too large",
  },
  board_bundle_invalid: {
    status: 422,
    message: "Board configuration is invalid",
  },
  board_source_unavailable: {
    status: 409,
    message: "A Board source is unavailable",
  },
  board_import_conflict: { status: 409, message: "Unable to create Board" },
  board_archived: {
    status: 409,
    message: "Restore the Board before continuing",
  },
  board_not_archived: {
    status: 409,
    message: "The Board is not archived",
  },
  stale_revision: {
    status: 409,
    message: "Board changed; reload before saving",
  },
  department_unavailable: {
    status: 409,
    message: "The selected department is unavailable",
  },
  board_invalid: { status: 409, message: "Unable to save Board" },
  template_limit_reached: {
    status: 409,
    message: "The workspace has 50 active templates",
  },
  template_conflict: { status: 409, message: "Unable to save Board template" },
  template_invalid: { status: 409, message: "Saved Board template is invalid" },
  home_board_archived: {
    status: 409,
    message: "Restore the Board before setting it as home",
  },
  personal_state_conflict: {
    status: 409,
    message: "Board preferences changed; retry",
  },
};

function throwSafeBoardError(status: number, detail: unknown): never {
  if (
    status === 404 &&
    (detail === "Board not found" || detail === "Board template not found")
  ) {
    throw new ApiError(status, detail);
  }
  const parsed = z.object({ code: z.string() }).passthrough().safeParse(detail);
  if (parsed.success) {
    const safe = safeCodes[parsed.data.code];
    if (safe && safe.status === status) {
      throw new ApiError(
        status,
        safe.message,
        {
          code: parsed.data.code,
          message: safe.message,
        },
        parsed.data.code,
      );
    }
  }
  throw new ApiError(status, "Request could not be completed");
}

async function safeBoardJson<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  init: ApiRequestInit = {},
): Promise<z.output<Schema>> {
  try {
    return await apiFetch(path, schema, { cache: "no-store", ...init });
  } catch (error) {
    if (error instanceof ApiError)
      return throwSafeBoardError(error.status, error.details);
    throw error;
  }
}

async function readBoundedBytes(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const declared = response.headers.get("Content-Length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > limit)
  ) {
    throw new ApiContractError();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new ApiContractError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function inspectBundleJson(text: string): string | null {
  let cursor = 0;
  let versionToken: string | null = null;
  const whitespace = () => {
    while (/\s/.test(text[cursor] ?? "")) cursor += 1;
  };
  const readString = (): string => {
    const begin = cursor++;
    while (cursor < text.length) {
      if (text[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (text[cursor++] === '"') break;
    }
    const value: unknown = JSON.parse(text.slice(begin, cursor));
    if (typeof value !== "string") throw new ApiContractError();
    return value;
  };
  const visit = (root = false): void => {
    whitespace();
    if (text[cursor] === "{") {
      cursor += 1;
      const keys = new Set<string>();
      whitespace();
      while (text[cursor] !== "}") {
        const key = readString();
        if (keys.has(key)) throw new ApiContractError();
        keys.add(key);
        whitespace();
        cursor += 1;
        whitespace();
        const valueStart = cursor;
        visit();
        if (root && key === "version")
          versionToken = text.slice(valueStart, cursor);
        whitespace();
        if (text[cursor] === ",") {
          cursor += 1;
          whitespace();
        } else break;
      }
      cursor += 1;
    } else if (text[cursor] === "[") {
      cursor += 1;
      whitespace();
      while (text[cursor] !== "]") {
        visit();
        whitespace();
        if (text[cursor] === ",") {
          cursor += 1;
          whitespace();
        } else break;
      }
      cursor += 1;
    } else if (text[cursor] === '"') readString();
    else
      while (cursor < text.length && !/[\s,}\]]/.test(text[cursor] ?? ""))
        cursor += 1;
  };
  visit(true);
  return versionToken;
}

function parseBundleBytes(bytes: Uint8Array): PortableBoardBundle {
  if (
    bytes.byteLength > MAX_BUNDLE_BYTES ||
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
  ) {
    throw new ApiContractError();
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (inspectBundleJson(text) !== "2") throw new ApiContractError();
    const parsed = bundleSchema.safeParse(value);
    if (!parsed.success) throw new ApiContractError();
    return parsed.data;
  } catch {
    throw new ApiContractError();
  }
}

async function throwRawResponseError(response: Response): Promise<never> {
  try {
    const bytes = await readBoundedBytes(response, MAX_ERROR_BYTES);
    const body: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    const envelope = z
      .object({ detail: z.unknown() })
      .passthrough()
      .safeParse(body);
    return throwSafeBoardError(
      response.status,
      envelope.success ? envelope.data.detail : undefined,
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(response.status, "Request could not be completed");
  }
}

async function parseRawJson<Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
): Promise<z.output<Schema>> {
  if (!response.ok) return throwRawResponseError(response);
  const type = response.headers.get("Content-Type") ?? "";
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(type))
    throw new ApiContractError();
  const bytes = await readBoundedBytes(response, MAX_BUNDLE_BYTES);
  try {
    const body: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiContractError();
    return parsed.data;
  } catch {
    throw new ApiContractError();
  }
}

function queryString(values: Record<string, string | number>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    query.set(key, String(value));
  return query.toString();
}

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

export async function downloadBoardConfiguration(
  rawBoardId: string,
): Promise<BoardConfigurationDownload> {
  const boardId = uuidSchema.parse(rawBoardId);
  const response = await apiRequest(
    `/boards/${encodeURIComponent(boardId)}/configuration`,
    {
      cache: "no-store",
    },
  );
  if (!response.ok) return throwRawResponseError(response);
  const type = response.headers.get("Content-Type") ?? "";
  if (
    !/^application\/json(?:;\s*charset=utf-8)?$/i.test(type) ||
    response.headers.get("Content-Disposition") !==
      `attachment; filename="${EXPORT_FILENAME}"`
  ) {
    throw new ApiContractError();
  }
  const bytes = await readBoundedBytes(response, MAX_BUNDLE_BYTES);
  const bundle = parseBundleBytes(bytes);
  const exact = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  exact.set(bytes);
  return {
    blob: new Blob([exact.buffer], { type: "application/json" }),
    filename: EXPORT_FILENAME,
    bundle,
  };
}

export async function importBoardConfiguration(
  raw: Blob,
): Promise<BoardManagementBoard> {
  if (!(raw instanceof Blob) || raw.size > MAX_BUNDLE_BYTES) {
    throw new Error("Choose a valid Board configuration no larger than 1 MiB");
  }
  const bytes = new Uint8Array(await raw.arrayBuffer());
  try {
    parseBundleBytes(bytes);
  } catch {
    throw new Error("Choose a valid Board configuration no larger than 1 MiB");
  }
  const response = await apiRequest("/boards/import", {
    method: "POST",
    cache: "no-store",
    body: raw,
    headers: { "Content-Type": "application/octet-stream" },
  });
  return parseRawJson(response, boardSchema);
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
