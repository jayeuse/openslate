import { z } from "zod";
import { ApiContractError, apiFetch, apiFetchWithMetadata } from "@/lib/api";

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const timestamp = z.iso.datetime({ offset: true }).nullable();
const subjectLink = z
  .string()
  .nullable()
  .refine((value) => {
    if (value === null) return true;
    if (
      !value.startsWith("/") ||
      value.startsWith("//") ||
      /[\\\u0000-\u0020]/.test(value)
    )
      return false;
    try {
      return (
        new URL(value, "https://openslate.invalid").origin ===
        "https://openslate.invalid"
      );
    } catch {
      return false;
    }
  });
const jobSchema = z
  .strictObject({
    kind: z.string().min(1),
    id: uuid,
    subject_label: z.string(),
    subject_link: subjectLink,
    state: z.string(),
    scheduled_for: timestamp,
    last_attempt_at: timestamp,
    next_attempt_at: timestamp,
    attempts: z.number().int().nonnegative(),
    failure_code: z.string().nullable(),
    failure_label: z.string().nullable(),
    can_retry: z.boolean(),
  })
  .transform((row) => ({
    kind: row.kind,
    id: row.id,
    subjectLabel: row.subject_label,
    subjectLink: row.subject_link,
    state: row.state,
    scheduledFor: row.scheduled_for,
    lastAttemptAt: row.last_attempt_at,
    nextAttemptAt: row.next_attempt_at,
    attempts: row.attempts,
    failureCode: row.failure_code,
    failureLabel: row.failure_label,
    canRetry: row.can_retry,
  }));
const pageSchema = z.strictObject({
  items: z.array(jobSchema),
  pagination: z.strictObject({
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    has_more: z.boolean(),
  }),
});
const querySchema = z.strictObject({
  kind: z.string().min(1).max(64).optional(),
  state: z.string().min(1).max(32).optional(),
  limit: z.number().int().min(1).max(100).default(10),
  offset: z.number().int().nonnegative().default(0),
});
export type ManageJob = z.output<typeof jobSchema>;
export type ManageJobsPage = z.output<typeof pageSchema>;
export type ManageJobsRequest = z.input<typeof querySchema>;
export type ManageJobIdentity = Pick<ManageJob, "kind" | "id">;
export function manageJobIdentity(job: ManageJobIdentity): string {
  return `${job.kind}:${job.id}`;
}

export async function listManageJobs(
  input: ManageJobsRequest & { signal?: AbortSignal } = {},
): Promise<ManageJobsPage> {
  const { signal, ...filters } = input;
  const query = querySchema.parse(filters);
  const params = new URLSearchParams({
    sort_by: "priority",
    sort_order: "asc",
  });
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) params.set(key, String(value));
  const result = await apiFetch(`/jobs?${params}`, pageSchema, {
    cache: "no-store",
    signal,
  });
  const p = result.pagination;
  if (
    p.limit !== query.limit ||
    p.offset !== query.offset ||
    p.count !== result.items.length ||
    p.count !== Math.min(p.limit, Math.max(0, p.total - p.offset)) ||
    p.has_more !== p.offset + p.count < p.total ||
    new Set(result.items.map(manageJobIdentity)).size !== p.count
  )
    throw new ApiContractError();
  return result;
}

export async function retryManageJob(
  target: ManageJobIdentity,
  options: { key?: string; signal?: AbortSignal } = {},
): Promise<ManageJob> {
  const kind = z.string().min(1).parse(target.kind);
  const id = uuid.parse(target.id);
  const headers = new Headers();
  if (kind === "backup")
    headers.set(
      "Idempotency-Key",
      z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9._:-]+$/)
        .parse(options.key),
    );
  const receipt = await apiFetchWithMetadata(
    `/jobs/${encodeURIComponent(kind)}/${id}/retry`,
    jobSchema,
    { method: "POST", cache: "no-store", headers, signal: options.signal },
  );
  const row = receipt.data;
  if (
    kind === "backup"
      ? receipt.response.status !== 201 ||
        row.kind !== "backup" ||
        row.id === id ||
        receipt.response.headers.get("Location") !==
          `/api/backups?run_id=${row.id}`
      : receipt.response.status !== 200 || row.kind !== kind || row.id !== id
  )
    throw new ApiContractError();
  return row;
}
