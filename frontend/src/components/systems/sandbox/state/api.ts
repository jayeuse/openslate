import { z } from "zod";
import { ApiContractError, ApiError, apiFetch, apiRequest } from "@/lib/api";
import {
  trackSandboxHistoryList,
  trackSandboxHistoryVersion,
} from "./sandbox-history-access";
import {
  parseSandboxDocument,
  parseSandboxDocumentForApi,
  SANDBOX_DOCUMENT_SCHEMA_VERSION,
  type SandboxFieldValue,
  type SandboxDocumentV4,
} from "../domain/document";

export type SandboxValidationIssue = {
  code: string;
  message: string;
  targetId: string | null;
};

export type SandboxDocumentResponse = {
  document: SandboxDocumentV4;
  revision: number;
  contentHash: string;
  byteCount: number;
  issues: SandboxValidationIssue[];
  latestPublishedVersion: SandboxPublishedVersion | null;
  publishedHash: string | null;
  hasUnpublishedChanges?: boolean;
};

export type SandboxPublishedVersion = {
  id: string;
  sequence: number;
  label: string;
  createdAt: string;
};

export type SandboxVersionKind = "checkpoint" | "published" | "imported";

export type SandboxVersion = {
  id: string;
  sequence: number;
  kind: SandboxVersionKind;
  label: string;
  note: string | null;
  sourceDocumentRevision: number;
  sourceVersionId: string | null;
  contentHash: string;
  byteCount: number;
  metadataRevision: number;
  createdAt: string;
  performedBy: string | null;
  isDeleted: boolean;
  deletedAt: string | null;
};

export type SandboxVersionDetail = SandboxVersion & {
  document: SandboxDocumentV4;
};

export type SandboxVersionPage = {
  items: SandboxVersion[];
  limit: number;
  offset: number;
  count: number;
  total: number;
  hasMore: boolean;
};

export type SandboxExport = {
  document: SandboxDocumentV4;
  filename: string;
};

type RequestOptions = { signal?: AbortSignal };
type RevisionRequest = RequestOptions & { expectedRevision: number };
type VersionMetadataUpdate =
  | { label: string; note?: string | null }
  | { label?: undefined; note: string | null };

const defaultExportFilename = "openslate-sandbox.json";
export const SANDBOX_REQUEST_BODY_LIMIT_BYTES = 5 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const sandboxDocumentSchema = z.unknown().transform((value, context) => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== SANDBOX_DOCUMENT_SCHEMA_VERSION
  ) {
    context.addIssue({
      code: "custom",
      message: `Sandbox document must use schema version ${SANDBOX_DOCUMENT_SCHEMA_VERSION}`,
    });
    return z.NEVER;
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    context.addIssue({
      code: "custom",
      message: "Sandbox document is invalid",
    });
    return z.NEVER;
  }
  const parsed = parseSandboxDocumentForApi(serialized);
  if (!parsed.ok) {
    context.addIssue({
      code: "custom",
      message: "Sandbox document is invalid",
    });
    return z.NEVER;
  }
  return parsed.document;
});

const issueSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  targetId: z.string().min(1).nullable(),
});

const publishedVersionSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string().min(1).max(80),
    sequence: z.number().int().positive(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .passthrough();

const documentResponseSchema = z.strictObject({
  document: sandboxDocumentSchema,
  revision: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
  byteCount: z.number().int().nonnegative(),
  issues: z.array(issueSchema),
  latestPublishedVersion: publishedVersionSchema.nullable(),
  publishedHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .nullable(),
  hasUnpublishedChanges: z.boolean().optional(),
});

const sandboxFieldValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const nonNullSandboxFieldValueSchema: z.ZodType<
  Exclude<SandboxFieldValue, null>
> = z.union([z.string(), z.number().finite(), z.boolean()]);
const sandboxValuesSchema = z.record(
  z.string().min(1),
  sandboxFieldValueSchema,
);

export type SandboxTestEvent =
  | { kind: "record-created" }
  | {
      kind: "field-changed";
      fieldId: string;
      previousValue?: SandboxFieldValue;
    }
  | {
      kind: "threshold-crossed";
      fieldId: string;
      previousValue: Exclude<SandboxFieldValue, null>;
    }
  | {
      kind: "schedule";
      frequency: "daily" | "weekly";
      time: string;
      weekday?: number;
    };

export type SandboxTestRequest = {
  expectedRevision: number;
  moduleId: string;
  values: Record<string, SandboxFieldValue>;
  event: SandboxTestEvent;
  triggerIds?: string[];
};

export type SandboxTestResult = {
  values: Record<string, SandboxFieldValue>;
  routes: Array<{ label: string; detail?: string }>;
  triggerTraces: Array<{
    triggerId: string;
    label: string;
    outcome: string;
  }>;
  issues: SandboxValidationIssue[];
};

export type SandboxTestRun = {
  id: string;
  createdAt: string;
  documentRevision: number;
  input: { moduleId: string; values: Record<string, SandboxFieldValue> };
  event: SandboxTestEvent;
  triggerIds: string[] | null;
  result: SandboxTestResult;
};

export type SandboxPublicationChange = {
  kind: "department" | "module" | "field" | "relationship" | "trigger";
  action: "create" | "update" | "close" | "reopen";
  sandboxId: string;
  label: string;
};
export type SandboxPublicationBlocker = {
  code: string;
  message: string;
  targetId?: string;
};

export type SandboxPublicationPreview = {
  previewToken: string;
  impactDigest: string;
  documentRevision: number;
  documentHash: string;
  expiresAt: string;
  changes: SandboxPublicationChange[];
  counts: {
    departments: number;
    modules: number;
    fields: number;
    relationships: number;
    triggers: number;
  };
  warnings: string[];
  blockers: SandboxPublicationBlocker[];
};

export type SandboxPublicationRequest = {
  expectedRevision: number;
  previewToken: string;
  impactDigest: string;
  password: string;
  note?: string;
};

export type SandboxPublication = {
  id: string;
  version: { id: string; sequence: number; kind: "published"; label: string };
  documentRevision: number;
  documentHash: string;
  impactDigest: string;
  publishedAt: string;
};

export type SandboxTriggerRun = {
  id: string;
  createdAt: string;
  triggerId: string;
  triggerName: string;
  eventKind: "record-created" | "field-changed" | "schedule";
  state: "succeeded" | "skipped" | "suspended" | "failed";
  details: Record<string, unknown>;
  attempts: number;
};

const testEventSchema: z.ZodType<SandboxTestEvent> = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({ kind: z.literal("record-created") }),
    z.strictObject({
      kind: z.literal("field-changed"),
      fieldId: z.string().min(1),
      previousValue: sandboxFieldValueSchema.optional(),
    }),
    z.strictObject({
      kind: z.literal("threshold-crossed"),
      fieldId: z.string().min(1),
      previousValue: nonNullSandboxFieldValueSchema,
    }),
    z.strictObject({
      kind: z.literal("schedule"),
      frequency: z.enum(["daily", "weekly"]),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      weekday: z
        .number()
        .int()
        .min(1)
        .max(7)
        .nullable()
        .optional()
        .transform((value) => value ?? undefined),
    }),
  ],
);

const testRunSchema: z.ZodType<SandboxTestRun> = z.strictObject({
  id: z.string().uuid(),
  createdAt: z.string().datetime({ offset: true }),
  documentRevision: z.number().int().positive(),
  input: z.strictObject({
    moduleId: z.string().min(1),
    values: sandboxValuesSchema,
  }),
  event: testEventSchema,
  triggerIds: z.array(z.string().min(1)).nullable(),
  result: z.strictObject({
    values: sandboxValuesSchema,
    routes: z.array(
      z
        .object({ label: z.string().min(1), detail: z.string().optional() })
        .passthrough(),
    ),
    triggerTraces: z.array(
      z
        .object({
          triggerId: z.string().min(1),
          label: z.string().min(1),
          outcome: z.string().min(1),
        })
        .passthrough(),
    ),
    issues: z.array(issueSchema),
  }),
});

const publicationChangeSchema: z.ZodType<SandboxPublicationChange> =
  z.strictObject({
    kind: z.enum(["department", "module", "field", "relationship", "trigger"]),
    action: z.enum(["create", "update", "close", "reopen"]),
    sandboxId: z.string().min(1),
    label: z.string().min(1).max(150),
  });
const publicationBlockerSchema: z.ZodType<SandboxPublicationBlocker> =
  z.strictObject({
    code: z.string().min(1),
    message: z.string().min(1),
    targetId: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .transform((value) => value ?? undefined),
  });
const publicationPreviewSchema: z.ZodType<SandboxPublicationPreview> =
  z.strictObject({
    previewToken: z.string().min(1),
    impactDigest: z.string().min(1),
    documentRevision: z.number().int().positive(),
    documentHash: z.string().regex(/^[a-f0-9]{64}$/i),
    expiresAt: z.string().datetime({ offset: true }),
    changes: z.array(publicationChangeSchema),
    counts: z.strictObject({
      departments: z.number().int().nonnegative(),
      modules: z.number().int().nonnegative(),
      fields: z.number().int().nonnegative(),
      relationships: z.number().int().nonnegative(),
      triggers: z.number().int().nonnegative(),
    }),
    warnings: z.array(z.string().min(1)),
    blockers: z.array(publicationBlockerSchema),
  });
const publicationSchema: z.ZodType<SandboxPublication> = z
  .object({
    id: z.string().uuid(),
    version: z.strictObject({
      id: z.string().uuid(),
      sequence: z.number().int().positive(),
      kind: z.literal("published"),
      label: z.string().min(1).max(80),
    }),
    documentRevision: z.number().int().positive(),
    documentHash: z.string().regex(/^[a-f0-9]{64}$/i),
    impactDigest: z.string().regex(/^[a-f0-9]{64}$/i),
    publishedAt: z.string().datetime({ offset: true }),
  })
  .passthrough();
const triggerRunSchema: z.ZodType<SandboxTriggerRun> = z.strictObject({
  id: z.string().uuid(),
  createdAt: z.string().datetime({ offset: true }),
  triggerId: z.string().uuid(),
  triggerName: z.string().min(1).max(80),
  eventKind: z.enum(["record-created", "field-changed", "schedule"]),
  state: z.enum(["succeeded", "skipped", "suspended", "failed"]),
  details: z.record(z.string(), z.unknown()),
  attempts: z.number().int().min(0).max(5),
});

const versionSchema = z.strictObject({
  id: z.string().uuid(),
  sequence: z.number().int().positive(),
  kind: z.enum(["checkpoint", "published", "imported"]),
  label: z.string().min(1).max(80),
  note: z.string().max(1_000).nullable(),
  sourceDocumentRevision: z.number().int().positive(),
  sourceVersionId: z.string().uuid().nullable(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
  byteCount: z.number().int().nonnegative(),
  metadataRevision: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
  performedBy: z.string().uuid().nullable(),
  isDeleted: z.boolean(),
  deletedAt: z.string().datetime({ offset: true }).nullable(),
});

const versionDetailSchema = versionSchema.extend({
  document: sandboxDocumentSchema,
});

const versionPageSchema = z.strictObject({
  items: z.array(versionSchema),
  limit: z.number().int().positive().max(100),
  offset: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

export function encodeSandboxRequestBody(value: unknown): string {
  const body = jsonBody(value);
  if (
    new TextEncoder().encode(body).byteLength > SANDBOX_REQUEST_BODY_LIMIT_BYTES
  )
    throw new RangeError(
      "Sandbox document request exceeds the 5 MiB limit. Reduce the document or its version history before saving or importing.",
    );
  return body;
}

function versionPath(versionId: string): string {
  return `/sandbox/versions/${encodeURIComponent(versionId)}`;
}

function documentRequest(
  path: string,
  init: RequestInit & RequestOptions = {},
): Promise<SandboxDocumentResponse> {
  return apiFetch(path, documentResponseSchema, init);
}

function versionRequest(
  path: string,
  init: RequestInit & RequestOptions = {},
): Promise<SandboxVersionDetail> {
  return apiFetch(path, versionDetailSchema, init);
}

export function loadSandboxDocument(
  options: RequestOptions = {},
): Promise<SandboxDocumentResponse> {
  return documentRequest("/sandbox/document", {
    cache: "no-store",
    signal: options.signal,
  });
}

export function replaceSandboxDocument(
  request: RevisionRequest & { document: SandboxDocumentV4 },
): Promise<SandboxDocumentResponse> {
  return documentRequest("/sandbox/document", {
    method: "PUT",
    body: encodeSandboxRequestBody({
      expectedRevision: request.expectedRevision,
      document: request.document,
    }),
    signal: request.signal,
  });
}

export function createSandboxPublicationPreview(
  request: RevisionRequest,
): Promise<SandboxPublicationPreview> {
  return apiFetch("/sandbox/publication-previews", publicationPreviewSchema, {
    method: "POST",
    body: jsonBody({ expectedRevision: request.expectedRevision }),
    signal: request.signal,
  });
}

export function publishSandbox(
  request: SandboxPublicationRequest &
    RequestOptions & { idempotencyKey: string },
): Promise<SandboxPublication> {
  if (!request.idempotencyKey.trim())
    throw new RangeError("An idempotency key is required to publish");
  return apiFetch("/sandbox/publications", publicationSchema, {
    method: "POST",
    headers: { "Idempotency-Key": request.idempotencyKey },
    body: jsonBody({
      expectedRevision: request.expectedRevision,
      previewToken: request.previewToken,
      impactDigest: request.impactDigest,
      password: request.password,
      ...(request.note?.trim() ? { note: request.note.trim() } : {}),
    }),
    signal: request.signal,
  });
}

export function createSandboxTest(
  request: SandboxTestRequest & RequestOptions,
): Promise<SandboxTestRun> {
  return apiFetch("/sandbox/tests", testRunSchema, {
    method: "POST",
    body: jsonBody({
      expectedRevision: request.expectedRevision,
      moduleId: request.moduleId,
      values: request.values,
      event: request.event,
      ...(request.triggerIds === undefined
        ? {}
        : { triggerIds: request.triggerIds }),
    }),
    signal: request.signal,
  });
}

export function listSandboxTests(
  options: RequestOptions & { limit?: number; offset?: number } = {},
): Promise<{ items: SandboxTestRun[] }> {
  const query = new URLSearchParams({
    limit: String(options.limit ?? 20),
    offset: String(options.offset ?? 0),
  });
  return apiFetch(
    `/sandbox/tests?${query}`,
    z.object({ items: z.array(testRunSchema) }).passthrough(),
    { cache: "no-store", signal: options.signal },
  );
}

export function listSandboxTriggerRuns(
  options: RequestOptions & { limit?: number; offset?: number } = {},
): Promise<{ items: SandboxTriggerRun[] }> {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new RangeError("Trigger run limit must be between 1 and 50");
  if (!Number.isInteger(offset) || offset < 0)
    throw new RangeError("Trigger run offset must be non-negative");
  const query = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  return apiFetch(
    `/sandbox/trigger-runs?${query}`,
    z.object({ items: z.array(triggerRunSchema) }).passthrough(),
    { cache: "no-store", signal: options.signal },
  );
}

export async function clearSandboxTests(
  options: RequestOptions = {},
): Promise<void> {
  await apiFetch("/sandbox/tests", z.null(), {
    method: "DELETE",
    signal: options.signal,
  });
}

export type SandboxVersionListOptions = RequestOptions & {
  limit?: number;
  offset?: number;
  search?: string;
  kind?: SandboxVersionKind;
};

export async function listSandboxVersions(
  options: SandboxVersionListOptions = {},
): Promise<SandboxVersionPage> {
  const request = z
    .object({
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
      search: z.string().trim().max(100).optional(),
      kind: z.enum(["checkpoint", "published", "imported"]).optional(),
    })
    .parse(options);
  const query = new URLSearchParams({
    limit: String(request.limit),
    offset: String(request.offset),
  });
  if (request.search) query.set("search", request.search);
  if (request.kind) query.set("kind", request.kind);
  return trackSandboxHistoryList(async () => {
    const page = await apiFetch(
      `/sandbox/versions?${query}`,
      versionPageSchema,
      {
        cache: "no-store",
        signal: options.signal,
      },
    );
    if (
      page.limit !== request.limit ||
      page.offset !== request.offset ||
      page.count !== page.items.length ||
      page.count > page.limit ||
      (page.count > 0 && page.offset + page.count > page.total) ||
      page.hasMore !== page.offset + page.count < page.total ||
      (page.hasMore && page.count === 0) ||
      new Set(page.items.map((item) => item.id)).size !== page.count
    )
      throw new ApiContractError();
    return page;
  });
}

export function getSandboxVersion(
  versionId: string,
  options: RequestOptions = {},
): Promise<SandboxVersionDetail> {
  return trackSandboxHistoryVersion(versionId, () =>
    versionRequest(versionPath(versionId), {
      cache: "no-store",
      signal: options.signal,
    }),
  );
}

/** Cached History selections need metadata; full comparison documents stay local. */
export async function getSandboxVersionMetadata(
  versionId: string,
  options: RequestOptions = {},
): Promise<SandboxVersion> {
  const detail = await getSandboxVersion(versionId, options);
  return versionSchema.parse(
    Object.fromEntries(
      Object.entries(detail).filter(([name]) => name !== "document"),
    ),
  );
}

export function createSandboxVersion(
  request: RevisionRequest & {
    kind: Extract<SandboxVersionKind, "checkpoint">;
    label: string;
    note?: string | null;
  },
): Promise<SandboxVersionDetail> {
  return versionRequest("/sandbox/versions", {
    method: "POST",
    body: jsonBody({
      expectedRevision: request.expectedRevision,
      kind: request.kind,
      label: request.label,
      ...(request.note === undefined ? {} : { note: request.note }),
    }),
    signal: request.signal,
  });
}

export function updateSandboxVersion(
  request: RevisionRequest & { versionId: string } & VersionMetadataUpdate,
): Promise<SandboxVersionDetail> {
  const payload = {
    expectedRevision: request.expectedRevision,
    ...(request.label === undefined ? {} : { label: request.label }),
    ...(request.note === undefined ? {} : { note: request.note }),
  };
  return versionRequest(versionPath(request.versionId), {
    method: "PATCH",
    body: jsonBody(payload),
    signal: request.signal,
  });
}

export async function deleteSandboxVersion(
  request: RevisionRequest & { versionId: string },
): Promise<void> {
  await apiFetch(versionPath(request.versionId), z.null(), {
    method: "DELETE",
    body: jsonBody({ expectedRevision: request.expectedRevision }),
    signal: request.signal,
  });
}

export function restoreSandboxVersion(
  request: RevisionRequest & { versionId: string },
): Promise<SandboxDocumentResponse> {
  return documentRequest(`${versionPath(request.versionId)}/restorations`, {
    method: "POST",
    body: jsonBody({ expectedRevision: request.expectedRevision }),
    signal: request.signal,
  });
}

export function importSandboxBundle(
  request: RevisionRequest & { bundle: SandboxDocumentV4 },
): Promise<SandboxDocumentResponse> {
  return documentRequest("/sandbox/imports", {
    method: "POST",
    body: encodeSandboxRequestBody({
      expectedRevision: request.expectedRevision,
      bundle: request.bundle,
    }),
    signal: request.signal,
  });
}

function exportFilename(response: Response): string {
  const header = response.headers.get("Content-Disposition");
  const match = header?.match(/filename="([^"\\/\r\n]+)"/i);
  return match?.[1] || defaultExportFilename;
}

async function throwExportError(response: Response): Promise<never> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // An API error may be an empty response. Preserve a safe generic message.
  }
  const detail =
    isRecord(body) && "detail" in body
      ? body.detail
      : "Request could not be completed";
  const detailObject = isRecord(detail) ? detail : null;
  const message =
    typeof detail === "string"
      ? detail
      : typeof detailObject?.message === "string"
        ? detailObject.message
        : "Request could not be completed";
  const code =
    typeof detailObject?.code === "string" ? detailObject.code : undefined;
  throw new ApiError(response.status, message, detail, code);
}

export async function exportSandboxBundle(
  options: RequestOptions & { includeVersions?: boolean } = {},
): Promise<SandboxExport> {
  const includeVersions = options.includeVersions ?? false;
  const response = await apiRequest(
    `/sandbox/export?includeVersions=${String(includeVersions)}`,
    { cache: "no-store", signal: options.signal },
  );
  if (!response.ok) await throwExportError(response);
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiContractError();
  }
  const parsed = parseSandboxDocument(text);
  if (!parsed.ok) throw new ApiContractError();
  return { document: parsed.document, filename: exportFilename(response) };
}
