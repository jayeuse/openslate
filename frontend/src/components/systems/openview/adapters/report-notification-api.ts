import { z } from "zod";
import {
  ApiContractError,
  ApiError,
  apiFetch,
  type ApiRequestInit,
} from "@/lib/api";
import type { OpenViewPage } from "./views-api";

const uuidSchema = z.string().uuid();
const utcTimestampSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z") || value.endsWith("+00:00"));

const commonNotification = {
  id: uuidSchema,
  status: z.enum(["unread", "read"]),
  scheduled_for: utcTimestampSchema,
  created_at: utcTimestampSchema,
  read_at: utcTimestampSchema.nullable(),
};
const wireNotificationSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...commonNotification,
        kind: z.literal("report-run"),
        report_id: uuidSchema,
        run_id: uuidSchema,
      })
      .strict(),
    z
      .object({
        ...commonNotification,
        kind: z.literal("post-publish"),
        board_id: uuidSchema,
        post_id: uuidSchema,
        publication_revision_id: uuidSchema,
      })
      .strict(),
    z
      .object({
        ...commonNotification,
        kind: z.literal("event-reminder"),
        board_id: uuidSchema,
        event_id: uuidSchema,
        occurrence_id: z.string().min(1).max(100),
        occurrence_start_at: utcTimestampSchema,
      })
      .strict(),
  ])
  .transform((notification) => {
    const common = {
      id: notification.id,
      kind: notification.kind,
      status: notification.status,
      scheduledFor: notification.scheduled_for,
      createdAt: notification.created_at,
      readAt: notification.read_at,
    };
    if (notification.kind === "report-run")
      return {
        ...common,
        kind: notification.kind,
        reportId: notification.report_id,
        runId: notification.run_id,
      };
    if (notification.kind === "post-publish")
      return {
        ...common,
        kind: notification.kind,
        boardId: notification.board_id,
        postId: notification.post_id,
        publicationRevisionId: notification.publication_revision_id,
      };
    return {
      ...common,
      kind: notification.kind,
      boardId: notification.board_id,
      eventId: notification.event_id,
      occurrenceId: notification.occurrence_id,
      occurrenceStartAt: notification.occurrence_start_at,
    };
  });

const paginationSchema = z
  .object({
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0),
    count: z.number().int().min(0),
    total: z.number().int().min(0),
    has_more: z.boolean(),
  })
  .strict()
  .transform(({ has_more, ...pagination }) => ({
    ...pagination,
    hasMore: has_more,
  }));

const wireNotificationListSchema = z
  .object({
    items: z.array(wireNotificationSchema),
    pagination: paginationSchema,
  })
  .strict();

const listOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

export type OpenViewReportNotification = z.output<
  typeof wireNotificationSchema
>;
export type OpenViewReportNotificationListOptions = z.input<
  typeof listOptionsSchema
>;

function throwSafeNotificationError(status: number, detail: unknown): never {
  if (status === 404 && detail === "Notification not found") {
    throw new ApiError(status, "Notification not found");
  }
  throw new ApiError(status, "Request could not be completed");
}

async function safeNotificationJson<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  init: ApiRequestInit,
): Promise<z.output<Schema>> {
  try {
    return await apiFetch(path, schema, init);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return throwSafeNotificationError(error.status, error.details);
  }
}

export async function listOpenViewReportNotifications(
  rawOptions: OpenViewReportNotificationListOptions = {},
): Promise<OpenViewPage<OpenViewReportNotification>> {
  const options = listOptionsSchema.parse(rawOptions);
  const parameters = new URLSearchParams({
    limit: String(options.limit),
    offset: String(options.offset),
  });
  return safeNotificationJson(
    `/notifications?${parameters.toString()}`,
    wireNotificationListSchema,
    { cache: "no-store" },
  );
}

export async function markOpenViewReportNotificationRead(
  rawNotificationId: string,
): Promise<OpenViewReportNotification> {
  const notificationId = uuidSchema.parse(rawNotificationId);
  const notification = await safeNotificationJson(
    `/notifications/${encodeURIComponent(notificationId)}/read`,
    wireNotificationSchema,
    { method: "POST", cache: "no-store" },
  );
  if (notification.id !== notificationId) throw new ApiContractError();
  return notification;
}
