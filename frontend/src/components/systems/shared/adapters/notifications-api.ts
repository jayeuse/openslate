import { z } from "zod";
import { currentOrganizationId } from "@/lib/organization-context";
import {
  ApiContractError,
  ApiError,
  apiFetch,
  type ApiRequestInit,
} from "@/lib/api";

const uuidSchema = z.string().uuid();
const utcTimestampSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z") || value.endsWith("+00:00"));

const commonNotification = {
  id: uuidSchema,
  subject_id: uuidSchema,
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
        kind: z.enum([
          "comms-mention",
          "comms-direct",
          "comms-thread-reply",
          "comms-keyword",
        ]),
        subject_type: z.literal("comms_message"),
        org_id: uuidSchema,
        conversation_id: uuidSchema,
        message_id: uuidSchema,
        scheduled_for: z.null(),
      })
      .strict()
      .refine(
        (notification) => notification.subject_id === notification.message_id,
      ),
    z
      .object({
        ...commonNotification,
        kind: z.literal("report-run"),
        subject_type: z.literal("report_run"),
        report_id: uuidSchema,
        run_id: uuidSchema,
      })
      .strict()
      .refine(
        (notification) => notification.subject_id === notification.run_id,
      ),
    z
      .object({
        ...commonNotification,
        kind: z.literal("report-run-failed"),
        subject_type: z.literal("scheduled_work"),
        report_id: uuidSchema,
      })
      .strict(),
    z
      .object({
        ...commonNotification,
        kind: z.literal("backup-failed"),
        subject_type: z.literal("backup_run"),
        scheduled_for: z.null(),
      })
      .strict(),
    z
      .object({
        ...commonNotification,
        kind: z.literal("record-assigned"),
        subject_type: z.literal("record"),
        scheduled_for: z.null(),
        module_id: uuidSchema,
      })
      .strict(),
    z
      .object({
        ...commonNotification,
        kind: z.literal("invitation-accepted"),
        subject_type: z.literal("user"),
        scheduled_for: z.null(),
      })
      .strict(),
    z
      .object({
        ...commonNotification,
        kind: z.literal("sandbox-published"),
        subject_type: z.literal("sandbox_version"),
        scheduled_for: z.null(),
        version_sequence: z.number().int().positive(),
      })
      .strict(),
    z
      .object({
        ...commonNotification,
        kind: z.literal("access-changed"),
        subject_type: z.literal("user"),
        scheduled_for: z.null(),
      })
      .strict(),
    z
      .object({
        ...commonNotification,
        kind: z.literal("post-publish"),
        subject_type: z.literal("board_post"),
        board_id: uuidSchema,
        post_id: uuidSchema,
        publication_revision_id: uuidSchema,
      })
      .strict()
      .refine(
        (notification) => notification.subject_id === notification.post_id,
      ),
    z
      .object({
        ...commonNotification,
        kind: z.literal("event-reminder"),
        subject_type: z.literal("board_event"),
        board_id: uuidSchema,
        event_id: uuidSchema,
        occurrence_id: z.string().min(1).max(100),
        occurrence_start_at: utcTimestampSchema,
      })
      .strict()
      .refine(
        (notification) => notification.subject_id === notification.event_id,
      ),
  ])
  .transform((notification) => {
    const common = {
      id: notification.id,
      subjectId: notification.subject_id,
      kind: notification.kind,
      status: notification.status,
      createdAt: notification.created_at,
      readAt: notification.read_at,
    };
    if (notification.subject_type === "comms_message")
      return {
        ...common,
        kind: notification.kind,
        subjectType: notification.subject_type,
        scheduledFor: null,
        orgId: notification.org_id,
        conversationId: notification.conversation_id,
        messageId: notification.message_id,
      };
    if (notification.kind === "report-run-failed")
      return {
        ...common,
        kind: notification.kind,
        subjectType: notification.subject_type,
        scheduledFor: notification.scheduled_for,
        reportId: notification.report_id,
      };
    if (notification.kind === "record-assigned")
      return {
        ...common,
        kind: notification.kind,
        subjectType: notification.subject_type,
        scheduledFor: null,
        moduleId: notification.module_id,
      };
    if (notification.kind === "sandbox-published")
      return {
        ...common,
        kind: notification.kind,
        subjectType: notification.subject_type,
        scheduledFor: null,
        versionSequence: notification.version_sequence,
      };
    if (notification.kind === "backup-failed")
      return {
        ...common,
        kind: notification.kind,
        subjectType: notification.subject_type,
        scheduledFor: null,
      };
    if (notification.kind === "invitation-accepted")
      return {
        ...common,
        kind: notification.kind,
        subjectType: notification.subject_type,
        scheduledFor: null,
      };
    if (notification.kind === "access-changed")
      return {
        ...common,
        kind: notification.kind,
        subjectType: notification.subject_type,
        scheduledFor: null,
      };
    if (notification.kind === "report-run")
      return {
        ...common,
        kind: notification.kind,
        subjectType: notification.subject_type,
        scheduledFor: notification.scheduled_for,
        reportId: notification.report_id,
        runId: notification.run_id,
      };
    if (notification.kind === "post-publish")
      return {
        ...common,
        kind: notification.kind,
        subjectType: notification.subject_type,
        scheduledFor: notification.scheduled_for,
        boardId: notification.board_id,
        postId: notification.post_id,
        publicationRevisionId: notification.publication_revision_id,
      };
    return {
      ...common,
      kind: notification.kind,
      subjectType: notification.subject_type,
      scheduledFor: notification.scheduled_for,
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
    status: z.literal("unread").optional(),
  })
  .strict();

export type Notification = z.output<typeof wireNotificationSchema>;
export type NotificationListOptions = z.input<typeof listOptionsSchema>;

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

export async function listNotifications(
  rawOptions: NotificationListOptions = {},
  signal?: AbortSignal,
): Promise<NotificationPage> {
  const organizationId = currentOrganizationId();
  const options = listOptionsSchema.parse(rawOptions);
  const parameters = new URLSearchParams({
    limit: String(options.limit),
    offset: String(options.offset),
  });
  if (options.status) parameters.set("status", options.status);
  const page = await safeNotificationJson(
    `/notifications?${parameters.toString()}`,
    wireNotificationListSchema,
    { cache: "no-store", signal },
  );
  const { pagination } = page;
  if (
    pagination.limit !== options.limit ||
    pagination.offset !== options.offset ||
    pagination.count !== page.items.length ||
    pagination.count > pagination.limit ||
    (pagination.count > 0 &&
      pagination.offset + pagination.count > pagination.total) ||
    (pagination.hasMore && pagination.count === 0) ||
    pagination.hasMore !==
      pagination.offset + pagination.count < pagination.total ||
    new Set(page.items.map((item) => item.id)).size !== page.items.length ||
    (options.status === "unread" &&
      page.items.some((item) => item.status !== "unread")) ||
    page.items.some(
      (item) =>
        item.subjectType === "comms_message" &&
        (item.orgId !== organizationId ||
          organizationId !== currentOrganizationId()),
    )
  )
    throw new ApiContractError();
  return page;
}

export async function markNotificationRead(
  rawNotificationId: string,
): Promise<Notification> {
  const organizationId = currentOrganizationId();
  const notificationId = uuidSchema.parse(rawNotificationId);
  const notification = await safeNotificationJson(
    `/notifications/${encodeURIComponent(notificationId)}/read`,
    wireNotificationSchema,
    { method: "POST", cache: "no-store" },
  );
  if (
    notification.id !== notificationId ||
    notification.status !== "read" ||
    notification.readAt === null ||
    (notification.subjectType === "comms_message" &&
      (notification.orgId !== organizationId ||
        organizationId !== currentOrganizationId()))
  )
    throw new ApiContractError();
  return notification;
}

export type NotificationPage = z.output<typeof wireNotificationListSchema>;
const countSchema = z
  .object({ unread_count: z.number().int().min(0) })
  .strict();
const readAllSchema = z
  .object({ updated_count: z.number().int().min(0) })
  .strict();
export async function getNotificationUnreadCount(
  signal?: AbortSignal,
): Promise<number> {
  const result = await safeNotificationJson(
    "/notifications/unread-count",
    countSchema,
    { cache: "no-store", signal },
  );
  return result.unread_count;
}
export async function markAllNotificationsRead(): Promise<number> {
  const result = await safeNotificationJson(
    "/notifications/read-all",
    readAllSchema,
    { method: "POST", cache: "no-store" },
  );
  return result.updated_count;
}
