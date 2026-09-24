import { expect, test } from "@playwright/test";
import { ApiContractError } from "../../../src/lib/api";
import {
  cancelBoardReminder,
  listBoardReminders,
  setBoardEventReminder,
} from "../../../src/components/systems/boards/adapters/board-reminders-api";

const boardId = "00000000-0000-4000-8000-000000000001";
const eventId = "00000000-0000-4000-8000-000000000002";
const reminderId = "00000000-0000-4000-8000-000000000003";
const occurrenceId = `${eventId}:2026-09-24`;
const timestamp = "2026-09-24T00:00:00Z";
const reminder = {
  id: reminderId,
  event_id: eventId,
  occurrence_id: occurrenceId,
  timing: "15m",
  occurrence_start_at: timestamp,
  due_at: timestamp,
  state: "pending",
};

test("private Board reminder choices are scoped to one Event occurrence", async () => {
  const original = globalThis.fetch;
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ path: String(input), init });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (init?.method === "POST") return Response.json(reminder);
    return Response.json({
      items: [reminder],
      pagination: {
        limit: 25,
        offset: 0,
        count: 1,
        total: 1,
        has_more: false,
      },
    });
  }) as typeof fetch;
  try {
    const created = await setBoardEventReminder(
      boardId,
      eventId,
      occurrenceId,
      "15m",
    );
    expect(created).toMatchObject({
      id: reminderId,
      eventId,
      occurrenceId,
      timing: "15m",
    });
    expect(requests[0].path).toBe(
      `/api/boards/${boardId}/events/${eventId}/reminders`,
    );
    expect(requests[0].init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      occurrence_id: occurrenceId,
      timing: "15m",
    });
    await expect(listBoardReminders(boardId)).resolves.toMatchObject({
      items: [created],
      total: 1,
      hasMore: false,
    });
    await cancelBoardReminder(boardId, reminderId);
    expect(requests[2].path).toBe(
      `/api/boards/${boardId}/reminders/${reminderId}`,
    );
    expect(requests[2].init?.method).toBe("DELETE");
  } finally {
    globalThis.fetch = original;
  }
});

test("Board reminders reject a server response for another occurrence", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({
      ...reminder,
      occurrence_id: `${eventId}:2026-09-25`,
    })) as typeof fetch;
  try {
    await expect(
      setBoardEventReminder(boardId, eventId, occurrenceId, "15m"),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    globalThis.fetch = original;
  }
});
