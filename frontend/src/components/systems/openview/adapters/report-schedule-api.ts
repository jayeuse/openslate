import { z } from "zod";
import {
  ApiContractError,
  ApiError,
  apiFetch,
  apiRequest,
  type ApiRequestInit,
} from "@/lib/api";
import { isReadRequest, openViewReadFetch } from "./openview-access";

const uuidSchema = z.string().uuid();
const canonicalUuidSchema = uuidSchema.transform((value) =>
  value.toLowerCase(),
);
const utcTimestampSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z") || value.endsWith("+00:00"));
const cadenceSchema = z.enum(["daily", "weekly", "monthly"]);
const localTimeSchema = z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/);
const weekdaySchema = z.number().int().min(0).max(6);
const monthDaySchema = z.number().int().min(1).max(31);

function canonicalIanaTimezone(value: string): string | null {
  // Intl also accepts fixed offsets; those are not IANA names or valid ZoneInfo keys.
  if (!/^[A-Za-z][A-Za-z0-9._+/-]*$/.test(value)) return null;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions()
      .timeZone;
  } catch {
    return null;
  }
}

const timezoneInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((value, context) => {
    const canonical = canonicalIanaTimezone(value);
    if (canonical !== null) return canonical;
    context.addIssue({ code: "custom", message: "Use an IANA timezone name" });
    return z.NEVER;
  });
const timezoneResponseSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => canonicalIanaTimezone(value) !== null);

const policyFields = {
  enabled: z.boolean(),
  cadence: cadenceSchema,
  timezoneName: timezoneInputSchema,
  localTime: localTimeSchema,
  weekday: weekdaySchema.nullable().optional(),
  monthDay: monthDaySchema.nullable().optional(),
};

function validAnchors(policy: {
  cadence: z.infer<typeof cadenceSchema>;
  weekday?: number | null;
  monthDay?: number | null;
}): boolean {
  return (
    (policy.cadence === "daily" &&
      policy.weekday == null &&
      policy.monthDay == null) ||
    (policy.cadence === "weekly" &&
      policy.weekday != null &&
      policy.monthDay == null) ||
    (policy.cadence === "monthly" &&
      policy.weekday == null &&
      policy.monthDay != null)
  );
}

const createInputSchema = z
  .object({ reportId: canonicalUuidSchema, ...policyFields })
  .strict()
  .refine(validAnchors, "Schedule anchor must match cadence");
const patchInputSchema = z
  .object({
    reportId: canonicalUuidSchema,
    revision: z.number().int().min(1),
    enabled: policyFields.enabled.optional(),
    cadence: policyFields.cadence.optional(),
    timezoneName: policyFields.timezoneName.optional(),
    localTime: policyFields.localTime.optional(),
    weekday: policyFields.weekday,
    monthDay: policyFields.monthDay,
  })
  .strict()
  .refine(
    (input) =>
      Object.keys(input).some(
        (key) => key !== "reportId" && key !== "revision",
      ),
    "At least one schedule change is required",
  );

const wireScheduleSchema = z
  .object({
    id: uuidSchema,
    report_id: uuidSchema,
    revision: z.number().int().min(1),
    enabled: z.boolean(),
    cadence: cadenceSchema,
    timezone_name: timezoneResponseSchema,
    local_time: localTimeSchema,
    weekday: weekdaySchema.nullable(),
    month_day: monthDaySchema.nullable(),
    next_due_at: utcTimestampSchema.nullable(),
    created_at: utcTimestampSchema,
    updated_at: utcTimestampSchema,
  })
  .strict()
  .refine(
    (schedule) =>
      validAnchors({
        cadence: schedule.cadence,
        weekday: schedule.weekday,
        monthDay: schedule.month_day,
      }) &&
      (schedule.enabled
        ? schedule.next_due_at !== null
        : schedule.next_due_at === null),
    "Invalid schedule response",
  )
  .transform((schedule) => ({
    id: schedule.id,
    reportId: schedule.report_id,
    revision: schedule.revision,
    enabled: schedule.enabled,
    cadence: schedule.cadence,
    timezoneName: schedule.timezone_name,
    localTime: schedule.local_time,
    weekday: schedule.weekday,
    monthDay: schedule.month_day,
    nextDueAt: schedule.next_due_at,
    createdAt: schedule.created_at,
    updatedAt: schedule.updated_at,
  }));

const conflictCodeSchema = z.enum([
  "schedule_exists",
  "schedule_conflict",
  "stale_revision",
  "schedule_ineligible",
  "report_archived",
]);
const conflictDetailSchema = z
  .object({
    code: conflictCodeSchema,
    current_revision: z.number().int().min(1).optional(),
  })
  .passthrough();
const conflictMessages: Record<z.infer<typeof conflictCodeSchema>, string> = {
  schedule_exists: "The Report already has a schedule",
  schedule_conflict: "Schedule changed; reload before saving",
  stale_revision: "Schedule changed; reload before saving",
  schedule_ineligible: "The Report is unavailable for scheduling",
  report_archived: "Restore the Report before managing its schedule",
};

export type OpenViewReportSchedule = z.output<typeof wireScheduleSchema>;
export type OpenViewReportScheduleCreateInput = z.input<
  typeof createInputSchema
>;
export type OpenViewReportSchedulePatchInput = z.input<typeof patchInputSchema>;
export type OpenViewReportScheduleConflict = {
  code: z.infer<typeof conflictCodeSchema>;
  message: string;
  currentRevision?: number;
};

function schedulePath(reportId: string): string {
  return `/reports/${encodeURIComponent(reportId)}/schedule`;
}

function safeScheduleError(status: number, detail: unknown): never {
  if (status === 409) {
    const parsed = conflictDetailSchema.safeParse(detail);
    if (parsed.success) {
      const { code, current_revision } = parsed.data;
      const message = conflictMessages[code];
      const safeDetail = {
        code,
        message,
        ...(code === "stale_revision" && current_revision !== undefined
          ? { current_revision }
          : {}),
      };
      throw new ApiError(status, message, safeDetail, code);
    }
  }
  if (status === 404) throw new ApiError(status, "Report schedule not found");
  if (status === 422)
    throw new ApiError(status, "Schedule details are invalid");
  throw new ApiError(status, "Request could not be completed");
}

async function safeScheduleJson(
  path: string,
  init: ApiRequestInit,
): Promise<OpenViewReportSchedule> {
  try {
    return await (isReadRequest(init) ? openViewReadFetch : apiFetch)(
      path,
      wireScheduleSchema,
      init,
    );
  } catch (error) {
    if (error instanceof ApiError)
      return safeScheduleError(error.status, error.details);
    throw error;
  }
}

function assertReportIdentity(
  schedule: OpenViewReportSchedule,
  reportId: string,
): OpenViewReportSchedule {
  if (schedule.reportId !== reportId) throw new ApiContractError();
  return schedule;
}

async function parseCreatedSchedule(
  response: Response,
  reportId: string,
): Promise<OpenViewReportSchedule> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.ok) throw new ApiContractError();
    return safeScheduleError(response.status, undefined);
  }
  if (!response.ok) {
    const detail = z
      .object({ detail: z.unknown() })
      .passthrough()
      .safeParse(body);
    return safeScheduleError(
      response.status,
      detail.success ? detail.data.detail : undefined,
    );
  }
  if (
    response.status !== 201 ||
    response.headers.get("Location") !== `/api${schedulePath(reportId)}`
  ) {
    throw new ApiContractError();
  }
  const parsed = wireScheduleSchema.safeParse(body);
  if (!parsed.success) throw new ApiContractError();
  return assertReportIdentity(parsed.data, reportId);
}

export async function getOpenViewReportSchedule(
  rawReportId: string,
): Promise<OpenViewReportSchedule> {
  const reportId = canonicalUuidSchema.parse(rawReportId);
  return assertReportIdentity(
    await safeScheduleJson(schedulePath(reportId), { cache: "no-store" }),
    reportId,
  );
}

export async function createOpenViewReportSchedule(
  raw: OpenViewReportScheduleCreateInput,
): Promise<OpenViewReportSchedule> {
  const input = createInputSchema.parse(raw);
  const body = {
    enabled: input.enabled,
    cadence: input.cadence,
    timezone_name: input.timezoneName,
    local_time: input.localTime,
    ...(input.weekday === undefined ? {} : { weekday: input.weekday }),
    ...(input.monthDay === undefined ? {} : { month_day: input.monthDay }),
  };
  const response = await apiRequest(schedulePath(input.reportId), {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });
  return parseCreatedSchedule(response, input.reportId);
}

export async function updateOpenViewReportSchedule(
  raw: OpenViewReportSchedulePatchInput,
): Promise<OpenViewReportSchedule> {
  const input = patchInputSchema.parse(raw);
  const body = {
    revision: input.revision,
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.cadence === undefined ? {} : { cadence: input.cadence }),
    ...(input.timezoneName === undefined
      ? {}
      : { timezone_name: input.timezoneName }),
    ...(input.localTime === undefined ? {} : { local_time: input.localTime }),
    ...(input.weekday === undefined ? {} : { weekday: input.weekday }),
    ...(input.monthDay === undefined ? {} : { month_day: input.monthDay }),
  };
  return assertReportIdentity(
    await safeScheduleJson(schedulePath(input.reportId), {
      method: "PATCH",
      body: JSON.stringify(body),
      cache: "no-store",
    }),
    input.reportId,
  );
}

export function getOpenViewReportScheduleConflict(
  error: unknown,
): OpenViewReportScheduleConflict | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const parsed = conflictDetailSchema.safeParse(error.details);
  if (!parsed.success) return null;
  const { code, current_revision } = parsed.data;
  return {
    code,
    message: conflictMessages[code],
    ...(code === "stale_revision" && current_revision !== undefined
      ? { currentRevision: current_revision }
      : {}),
  };
}
