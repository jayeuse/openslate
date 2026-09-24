import { z } from "zod";
import { ApiContractError, apiFetch } from "@/lib/api";

const uuid = z.string().uuid();
const utcTimestamp = z.iso
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z") || value.endsWith("+00:00"));
const timing = z.enum(["now", "start", "15m", "1d"]);
const reminderSchema = z
  .object({
    id: uuid,
    event_id: uuid,
    occurrence_id: z.string().min(1).max(100),
    timing,
    occurrence_start_at: utcTimestamp,
    due_at: utcTimestamp,
    state: z.enum(["pending", "running", "succeeded", "failed", "canceled"]),
  })
  .strict()
  .transform((item) => ({
    id: item.id,
    eventId: item.event_id,
    occurrenceId: item.occurrence_id,
    timing: item.timing,
    occurrenceStartAt: item.occurrence_start_at,
    dueAt: item.due_at,
    state: item.state,
  }));
const pageSchema = z
  .object({
    items: z.array(reminderSchema).max(100),
    pagination: z
      .object({
        limit: z.number().int().min(1).max(100),
        offset: z.number().int().min(0),
        count: z.number().int().min(0),
        total: z.number().int().min(0),
        has_more: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type BoardEventReminder = z.output<typeof reminderSchema>;
export type BoardReminderTiming = z.infer<typeof timing>;

export async function listBoardReminders(
  rawBoardId: string,
  rawOffset = 0,
): Promise<{ items: BoardEventReminder[]; hasMore: boolean; total: number }> {
  const boardId = uuid.parse(rawBoardId);
  const offset = z.number().int().min(0).parse(rawOffset);
  const page = await apiFetch(
    `/boards/${boardId}/reminders?limit=25&offset=${offset}`,
    pageSchema,
    { cache: "no-store" },
  );
  if (
    page.pagination.limit !== 25 ||
    page.pagination.offset !== offset ||
    page.pagination.count !== page.items.length ||
    page.pagination.total < offset + page.items.length ||
    page.items.some((item) => item.state !== "pending")
  )
    throw new ApiContractError();
  return {
    items: page.items,
    hasMore: page.pagination.has_more,
    total: page.pagination.total,
  };
}

export async function setBoardEventReminder(
  rawBoardId: string,
  rawEventId: string,
  rawOccurrenceId: string,
  rawTiming: BoardReminderTiming,
): Promise<BoardEventReminder> {
  const boardId = uuid.parse(rawBoardId);
  const eventId = uuid.parse(rawEventId);
  const occurrenceId = z.string().min(1).max(100).parse(rawOccurrenceId);
  const selectedTiming = timing.parse(rawTiming);
  const reminder = await apiFetch(
    `/boards/${boardId}/events/${eventId}/reminders`,
    reminderSchema,
    {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({
        occurrence_id: occurrenceId,
        timing: selectedTiming,
      }),
    },
  );
  if (
    reminder.eventId !== eventId ||
    reminder.occurrenceId !== occurrenceId ||
    reminder.timing !== selectedTiming
  )
    throw new ApiContractError();
  return reminder;
}

export async function cancelBoardReminder(
  rawBoardId: string,
  rawReminderId: string,
): Promise<void> {
  const boardId = uuid.parse(rawBoardId);
  const reminderId = uuid.parse(rawReminderId);
  await apiFetch(`/boards/${boardId}/reminders/${reminderId}`, z.null(), {
    method: "DELETE",
    cache: "no-store",
  });
}
