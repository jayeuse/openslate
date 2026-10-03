import Papa from "papaparse";
import { z } from "zod";
import { ApiContractError, ApiError, apiFetch, apiRequest } from "@/lib/api";
import { serializeOpenViewQueryDefinition } from "../../openview/adapters/views-serialization";
import type { OpenViewQueryDefinition } from "../../openview/adapters/views-api";

export type CsvRow = { row_number: number; cells: string[] };
export type ImportEnvelope = {
  mode: "preview" | "import";
  module_id: string;
  headers: string[];
  mapping: { column_index: number; field_id: string }[];
  defaults: Record<string, unknown>;
  schema_digest: string | null;
};
export type ImportRequest = ImportEnvelope & { rows: CsvRow[] };
const rowSchema = z
  .object({
    row_number: z.number().int().min(2),
    status: z.enum(["valid", "invalid", "created"]),
    record_id: z.uuid().nullable(),
    data: z.record(
      z.uuid(),
      z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
    ),
    errors: z.array(
      z
        .object({
          code: z.string(),
          message: z.string(),
          field_id: z.uuid().nullable(),
          column_index: z.number().int().nonnegative().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
const resultSchema = z
  .object({
    mode: z.enum(["preview", "import"]),
    schema_digest: z.string().regex(/^[0-9a-f]{64}$/),
    rows: z.array(rowSchema).max(100),
    valid_count: z.number().int().nonnegative(),
    invalid_count: z.number().int().nonnegative(),
    created_count: z.number().int().nonnegative(),
  })
  .strict();
export type ImportResultRow = z.output<typeof rowSchema>;
export type ImportResult = z.output<typeof resultSchema>;

export function importBatches(
  envelope: ImportEnvelope,
  rows: readonly CsvRow[],
): ImportRequest[] {
  const batches: ImportRequest[] = [];
  let current: CsvRow[] = [];
  const size = (items: CsvRow[]) =>
    new TextEncoder().encode(JSON.stringify({ ...envelope, rows: items }))
      .byteLength;
  if (size([]) > 900 * 1024)
    throw new Error(
      "The import headers, mapping and defaults exceed 900 KiB. Reduce the CSV columns or defaults.",
    );
  for (const row of rows) {
    if (size([row]) > 900 * 1024)
      throw new Error(
        `Row ${row.row_number} exceeds the 900 KiB request limit. Reduce this row before previewing.`,
      );
    if (current.length === 100 || size([...current, row]) > 900 * 1024) {
      batches.push({ ...envelope, rows: current });
      current = [];
    }
    current.push(row);
  }
  if (current.length) batches.push({ ...envelope, rows: current });
  return batches;
}

export async function sendImportBatch(
  request: ImportRequest,
  signal?: AbortSignal,
): Promise<ImportResult> {
  const result = await apiFetch("/records/import", resultSchema, {
    method: "POST",
    body: JSON.stringify(request),
    cache: "no-store",
    signal,
    // A creation command cannot be replayed after an ambiguous outcome.
    refreshOnUnauthorized: request.mode === "preview",
  });
  const valid = result.rows.filter((row) => row.status !== "invalid");
  const ids = valid.flatMap((row) => (row.record_id ? [row.record_id] : []));
  if (
    result.mode !== request.mode ||
    result.rows.length !== request.rows.length ||
    result.rows.some(
      (row, index) =>
        row.row_number !== request.rows[index].row_number ||
        (row.status === "invalid"
          ? row.record_id !== null || !row.errors.length
          : row.errors.length > 0 ||
            (request.mode === "preview"
              ? row.status !== "valid" || row.record_id !== null
              : row.status !== "created" || row.record_id === null)),
    ) ||
    result.valid_count !== valid.length ||
    result.invalid_count !== result.rows.length - valid.length ||
    result.created_count !== (request.mode === "import" ? valid.length : 0) ||
    new Set(ids).size !== ids.length ||
    (request.mode === "import" &&
      result.schema_digest !== request.schema_digest)
  )
    throw new ApiContractError();
  return result;
}

export type RecordCsv = {
  blob: Blob;
  headers: string[];
  rows: string[][];
  count: number;
};
export async function prepareRecordCsv(
  moduleId: string,
  definition: OpenViewQueryDefinition,
  signal: AbortSignal,
): Promise<RecordCsv> {
  const response = await apiRequest("/records/export", {
    method: "POST",
    cache: "no-store",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      module_id: moduleId,
      definition: serializeOpenViewQueryDefinition(definition),
    }),
  });
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const detail = z
      .object({
        detail: z.union([
          z.string(),
          z.object({ code: z.string(), message: z.string() }),
        ]),
      })
      .safeParse(body);
    const code =
      detail.success && typeof detail.data.detail !== "string"
        ? detail.data.detail.code
        : undefined;
    throw new ApiError(
      response.status,
      code === "export_limit_exceeded"
        ? "Export exceeds 10,000 rows or 8 MiB; choose a narrower saved view."
        : "The export could not be prepared. Try again.",
      undefined,
      code,
    );
  }
  if (!/^text\/csv(?:;|$)/i.test(response.headers.get("Content-Type") ?? ""))
    throw new ApiContractError();
  const blob = await response.blob();
  if (blob.size > 8 * 1024 * 1024) throw new ApiContractError();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      await blob.arrayBuffer(),
    );
  } catch {
    throw new ApiContractError();
  }
  const parsed = Papa.parse<string[]>(text, {
    dynamicTyping: false,
    skipEmptyLines: false,
  });
  const cells = parsed.data;
  if (
    /\r?\n$/.test(text) &&
    cells.at(-1)?.length === 1 &&
    cells.at(-1)?.[0] === ""
  )
    cells.pop();
  const headers = cells.shift();
  if (
    parsed.errors.some((error) => error.code !== "UndetectableDelimiter") ||
    !headers ||
    headers[0] !== "Record ID" ||
    cells.length > 10000 ||
    cells.some(
      (row) =>
        row.length !== headers.length || !z.uuid().safeParse(row[0]).success,
    )
  )
    throw new ApiContractError();
  return { blob, headers, rows: cells.slice(0, 10), count: cells.length };
}
