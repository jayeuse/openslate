import { z } from "zod";
import { ApiContractError, ApiError } from "./api";
import type {
  LifecycleBlockerCode,
  LifecycleErrorCode,
  LifecycleImpact,
  LifecycleMutationResponse,
  LifecyclePreviewResponse,
  LifecyclePurgePreviewResponse,
  LifecycleTargetType,
} from "./api";

const uuidSchema = z.string().uuid();
const timestampSchema = z.iso.datetime({ offset: true });

const lifecycleTargetTypeSchema = z.enum([
  "department",
  "module",
  "field",
  "record",
  "file",
  "board",
  "report",
  "board_event",
]);

const lifecycleBlockerCodeSchema: z.ZodType<LifecycleBlockerCode> = z.enum([
  "closed_ancestor",
  "module_name_conflict",
  "field_name_conflict",
  "field_position_conflict",
  "schema_invalid",
  "record_data_invalid",
  "title_field_selected",
  "record_close_unsupported",
  "purge_board_dependency",
  "purge_dashboard_dependency",
  "purge_report_dependency",
  "purge_report_run_dependency",
  "purge_trigger_dependency",
  "purge_external_schema_dependency",
  "purge_file_dependency",
]);

const lifecycleRowStateSchema = z
  .object({
    entity_type: z.string().min(1).max(100),
    entity_id: uuidSchema,
    is_deleted: z.boolean(),
    deleted_at: timestampSchema.nullable(),
    updated_at: timestampSchema,
    state_fingerprint: z.string().max(128),
    byte_count: z.number().int().min(0).nullable().optional(),
  })
  .strict();

const lifecycleExternalImpactSchema = z
  .object({
    edge_id: uuidSchema,
    field_id: uuidSchema,
    external_record_id: uuidSchema,
    external_record_label: z.string().min(1),
    external_module_id: uuidSchema,
    external_module_name: z.string().min(1).max(150),
    external_module_label: z.string().max(150).optional(),
    external_department_id: uuidSchema,
    external_department_name: z.string().min(1).max(150),
    external_department_label: z.string().max(150).optional(),
  })
  .strict();

const lifecycleKeyStripSchema = z
  .object({
    record_id: uuidSchema,
    module_id: uuidSchema,
    field_id: uuidSchema,
    key: z.string().min(1).max(150),
  })
  .strict();

const lifecycleBlockerSchema = z
  .object({
    code: lifecycleBlockerCodeSchema,
    entity_type: z.string().min(1).max(100),
    entity_id: uuidSchema,
    detail: z.string().max(500),
    conflicting_entity_type: z.string().max(100).nullable(),
    conflicting_entity_id: uuidSchema.nullable(),
    field_id: uuidSchema.nullable(),
    field_name: z.string().max(150).nullable(),
    module_id: uuidSchema.nullable(),
    module_name: z.string().max(150).nullable(),
    department_id: uuidSchema.nullable(),
    department_name: z.string().max(150).nullable(),
  })
  .strict();

export const lifecycleImpactSchema: z.ZodType<LifecycleImpact> = z
  .object({
    target_type: lifecycleTargetTypeSchema,
    target_id: uuidSchema,
    operation: z.enum(["close", "purge", "reopen"]),
    actor_id: uuidSchema.nullable(),
    rows: z.array(lifecycleRowStateSchema),
    external_impacts: z.array(lifecycleExternalImpactSchema),
    key_strips: z.array(lifecycleKeyStripSchema),
    blockers: z.array(lifecycleBlockerSchema),
    impact_digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const lifecyclePreviewFields = {
  impact: lifecycleImpactSchema,
  token: z.string().min(1).max(128),
  expires_at: timestampSchema,
};

export const lifecycleClosePreviewSchema: z.ZodType<LifecyclePreviewResponse> =
  z.strictObject({
    ...lifecyclePreviewFields,
    confirmation_name: z.string().min(1).max(150),
  });

export const lifecyclePurgePreviewSchema: z.ZodType<LifecyclePurgePreviewResponse> =
  z.strictObject({
    ...lifecyclePreviewFields,
    confirmation_name: z.string().min(1),
    last_successful_backup_at: timestampSchema.nullable(),
  });

export const lifecyclePurgeResultSchema: z.ZodType<LifecycleMutationResponse> =
  z
    .object({
      impact: lifecycleImpactSchema,
      operation_id: uuidSchema.nullable(),
    })
    .strict();

export const lifecyclePurgeInputSchema = z
  .object({
    token: z.string().min(1).max(128),
    confirmationName: z.string().min(1),
    password: z.string().min(1).max(256),
  })
  .strict();

export const lifecycleCloseInputSchema = lifecyclePurgeInputSchema.extend({
  confirmationName: z.string().trim().min(1).max(150),
});

export type LifecyclePurgePreview = z.output<
  typeof lifecyclePurgePreviewSchema
>;
export type LifecyclePurgeResult = z.output<typeof lifecyclePurgeResultSchema>;
export type LifecyclePurgeInput = z.input<typeof lifecyclePurgeInputSchema>;

export function assertLifecyclePurgePreviewFor(
  preview: LifecyclePurgePreview,
  targetType: LifecycleTargetType,
  targetId: string,
): void {
  assertLifecyclePreviewFor(preview, targetType, targetId, "purge");
}

export function assertLifecyclePreviewFor(
  preview: LifecyclePreviewResponse,
  targetType: LifecycleTargetType,
  targetId: string,
  operation: "close" | "purge",
): void {
  if (
    preview.impact.target_type !== targetType ||
    preview.impact.target_id !== targetId ||
    preview.impact.operation !== operation
  )
    throw new ApiContractError();
}

export function assertLifecyclePurgeResultFor(
  result: LifecyclePurgeResult,
  targetType: LifecycleTargetType,
  targetId: string,
): void {
  assertLifecycleResultFor(result, targetType, targetId, "purge");
}

export function assertLifecycleResultFor(
  result: LifecyclePurgeResult,
  targetType: LifecycleTargetType,
  targetId: string,
  operation: "close" | "purge" | "reopen",
): void {
  if (
    result.impact.target_type !== targetType ||
    result.impact.target_id !== targetId ||
    result.impact.operation !== operation
  )
    throw new ApiContractError();
}

const safeLifecycleErrors: Partial<
  Record<LifecycleErrorCode, { status: number; message: string }>
> = {
  purge_disabled: {
    status: 403,
    message: "Permanent delete is turned off for this installation.",
  },
  purge_requires_closed: {
    status: 409,
    message: "Close this item before permanently deleting it.",
  },
  confirmation_name_mismatch: {
    status: 422,
    message: "The name confirmation did not match. Request a new review.",
  },
  challenge_not_found: {
    status: 404,
    message: "The review is unavailable. Request a new review.",
  },
  challenge_binding_mismatch: {
    status: 403,
    message: "The review is unavailable. Request a new review.",
  },
  challenge_expired: {
    status: 409,
    message: "The review expired. Request a new review.",
  },
  challenge_exhausted: {
    status: 409,
    message: "The review is unavailable. Request a new review.",
  },
  verification_in_progress: {
    status: 409,
    message: "Administrator verification is already in progress. Try again.",
  },
  invalid_credentials: {
    status: 403,
    message:
      "Administrator verification failed. Confirm your password and access, then request a new review.",
  },
  actor_blocked: {
    status: 429,
    message: "Too many attempts. Wait before trying again.",
  },
  actor_mismatch: {
    status: 403,
    message: "Your administrator session changed. Request a new review.",
  },
  password_upstream_rate_limited: {
    status: 429,
    message: "Password verification is rate limited. Wait before trying again.",
  },
  password_upstream_unavailable: {
    status: 503,
    message: "Password verification is unavailable. Try again later.",
  },
  preflight_failed: {
    status: 409,
    message: "Dependencies prevent permanent deletion.",
  },
  impact_changed: {
    status: 409,
    message: "This item or its dependencies changed. Request a new review.",
  },
  temporarily_unavailable: {
    status: 503,
    message: "Permanent deletion is temporarily unavailable. Try again later.",
  },
  board_purge_conflict: {
    status: 409,
    message: "Dependencies changed. Request a new review.",
  },
};

/** A fixed user-facing message for known lifecycle errors, never server detail. */
export function lifecycleErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (!(error instanceof ApiError) || !error.code) return fallback;
  const safe = safeLifecycleErrors[error.code];
  return safe?.status === error.status ? safe.message : fallback;
}

/** Structural targets share the server-supplied confirmation name. */
export function structuralLifecycleErrorMessage(
  error: unknown,
  operation: "close" | "purge" | "reopen",
): string {
  const fallback = `This ${operation === "purge" ? "permanent deletion" : operation} could not be confirmed. Request a new review and try again.`;
  if (!(error instanceof ApiError)) return fallback;
  if (error.code === "confirmation_name_mismatch" && error.status === 422)
    return "The name confirmation did not match. Request a new review.";
  if (error.code === "closed_ancestor" && error.status === 409)
    return "Reopen the parent before reopening this item.";
  if (error.code === "preflight_failed" && error.status === 409)
    return `Dependencies prevent this ${operation === "purge" ? "permanent deletion" : operation}. Request a new review.`;
  if (error.code === "temporarily_unavailable" && error.status === 503)
    return "This change is temporarily unavailable. Try again later.";
  return lifecycleErrorMessage(error, fallback);
}
