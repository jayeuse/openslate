import { expect, test } from "@playwright/test";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  archiveBoardEvent,
  createBoardEvent,
  deleteBoardEvent,
  listBoardEventOccurrences,
  listBoardEvents,
  readBoardEvent,
  restoreBoardEvent,
  updateBoardEvent,
  type BoardEventPage,
} from "../../../src/components/systems/boards/adapters/board-events-api";

const boardId = "00000000-0000-4000-8000-000000000001";
const eventId = "00000000-0000-4000-8000-000000000002";
const authorId = "00000000-0000-4000-8000-000000000003";
const departmentId = "00000000-0000-4000-8000-000000000004";
const timestamp = "2026-09-23T00:00:00Z";

type CapturedRequest = { input: RequestInfo | URL; init?: RequestInit };

function installFetch(responder: () => Response) {
  const original = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return Promise.resolve(responder());
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

const page = { limit: 25, offset: 0, count: 1, total: 1, has_more: false };
const allDayEvent = {
  id: eventId,
  board_id: boardId,
  author_id: authorId,
  title: "Planning",
  details: "Agenda",
  location: "Hall",
  links: [],
  all_day: true,
  start_date: "2026-09-14",
  end_date: "2026-09-14",
  start_at: null,
  end_at: null,
  timezone_name: "Asia/Manila",
  recurrence: "weekly",
  repeat_until: "2026-10-12",
  audience: {
    kind: "department",
    user_id: null,
    department_id: departmentId,
  },
  archived: false,
  revision: 1,
  board_revision: 3,
  created_at: timestamp,
  updated_at: timestamp,
};
const mutation = { id: eventId, event_revision: 2, board_revision: 4 };

test("Board event series list uses bounded query and parses only the audience-visible DTO", async () => {
  const mock = installFetch(() =>
    jsonResponse({ items: [allDayEvent], pagination: page, board_revision: 3 }),
  );
  try {
    const result = await listBoardEvents(boardId, {
      search: "  Plan  ",
      archived: "all",
    });
    expect(result.boardRevision).toBe(3);
    expect(result.items[0]).toMatchObject({
      id: eventId,
      boardId,
      allDay: true,
      startDate: "2026-09-14",
      startAt: null,
      audience: { kind: "department", departmentId },
    });
    expect(result.pagination).toEqual({
      limit: 25,
      offset: 0,
      count: 1,
      total: 1,
      hasMore: false,
    });
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/boards/${boardId}/events?limit=25&offset=0&sort_by=created_at&sort_order=desc&archived=all&search=Plan`,
    );
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

test("My events uses its own bounded paged endpoint", async () => {
  const mock = installFetch(() =>
    jsonResponse({
      items: [allDayEvent],
      pagination: {
        limit: 25,
        offset: 25,
        count: 1,
        total: 26,
        has_more: false,
      },
      board_revision: 3,
    }),
  );
  try {
    const events =
      (await import("../../../src/components/systems/boards/adapters/board-events-api")) as unknown as {
        listMyBoardEvents: (
          id: string,
          options: { limit: number; offset: number; search: string },
        ) => Promise<BoardEventPage>;
      };
    const result = await events.listMyBoardEvents(boardId, {
      limit: 25,
      offset: 25,
      search: "  Planning  ",
    });
    expect(result.items[0]?.id).toBe(eventId);
    expect(result.pagination).toMatchObject({
      total: 26,
      offset: 25,
      hasMore: false,
    });
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/boards/${boardId}/events/mine?limit=25&offset=25&sort_by=created_at&sort_order=desc&archived=active&search=Planning`,
    );
  } finally {
    mock.restore();
  }
});

test("Board event create and patch send exclusive audiences and UTC timed instants with revisions", async () => {
  const responses = [jsonResponse(mutation, 201), jsonResponse(mutation)];
  const mock = installFetch(() => responses.shift()!);
  try {
    await expect(
      createBoardEvent(boardId, {
        boardRevision: 3,
        title: "  Planning  ",
        allDay: false,
        startAt: "2026-09-14T08:00:00Z",
        endAt: "2026-09-14T09:00:00Z",
        timezoneName: "Asia/Manila",
        audience: { kind: "department", departmentId },
        links: [{ label: "  Guide  ", url: "  https://example.org/guide  " }],
      }),
    ).resolves.toEqual({ id: eventId, eventRevision: 2, boardRevision: 4 });
    await expect(
      updateBoardEvent(boardId, eventId, {
        boardRevision: 4,
        eventRevision: 2,
        audience: { kind: "author" },
        title: "Updated",
        links: [],
      }),
    ).resolves.toEqual({ id: eventId, eventRevision: 2, boardRevision: 4 });
    expect(
      mock.requests.map(({ input, init }) => [String(input), init?.method]),
    ).toEqual([
      [`/api/boards/${boardId}/events`, "POST"],
      [`/api/boards/${boardId}/events/${eventId}`, "PATCH"],
    ]);
    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toEqual({
      board_revision: 3,
      title: "Planning",
      all_day: false,
      start_at: "2026-09-14T08:00:00Z",
      end_at: "2026-09-14T09:00:00Z",
      timezone_name: "Asia/Manila",
      recurrence: "none",
      audience: { kind: "department", department_id: departmentId },
      links: [{ label: "Guide", url: "https://example.org/guide" }],
    });
    expect(JSON.parse(String(mock.requests[1]?.init?.body))).toEqual({
      board_revision: 4,
      event_revision: 2,
      title: "Updated",
      audience: { kind: "author" },
      links: [],
    });
    expect(mock.requests.every(({ init }) => init?.cache === "no-store")).toBe(
      true,
    );
  } finally {
    mock.restore();
  }
});

test("Board event detail, archive, restore, and DELETE 204 use explicit revisions", async () => {
  const responses = [
    jsonResponse(allDayEvent),
    jsonResponse(mutation),
    jsonResponse(mutation),
    new Response(null, { status: 204 }),
  ];
  const mock = installFetch(() => responses.shift()!);
  try {
    await expect(readBoardEvent(boardId, eventId)).resolves.toMatchObject({
      id: eventId,
      recurrence: "weekly",
      repeatUntil: "2026-10-12",
    });
    await expect(archiveBoardEvent(boardId, eventId, 3, 1)).resolves.toEqual({
      id: eventId,
      eventRevision: 2,
      boardRevision: 4,
    });
    await expect(restoreBoardEvent(boardId, eventId, 4, 2)).resolves.toEqual({
      id: eventId,
      eventRevision: 2,
      boardRevision: 4,
    });
    await expect(
      deleteBoardEvent(boardId, eventId, 5, 3),
    ).resolves.toBeUndefined();
    expect(
      mock.requests.map(({ input, init }) => [String(input), init?.method]),
    ).toEqual([
      [`/api/boards/${boardId}/events/${eventId}`, undefined],
      [`/api/boards/${boardId}/events/${eventId}/archive`, "POST"],
      [`/api/boards/${boardId}/events/${eventId}/restore`, "POST"],
      [`/api/boards/${boardId}/events/${eventId}`, "DELETE"],
    ]);
    expect(JSON.parse(String(mock.requests[3]?.init?.body))).toEqual({
      board_revision: 5,
      event_revision: 3,
    });
  } finally {
    mock.restore();
  }
});

test("Board event occurrence window is inclusive, bounded, paged and carries its series", async () => {
  const eventWithLink = {
    ...allDayEvent,
    links: [{ label: "Guide", url: "https://example.org/guide" }],
  };
  const mock = installFetch(() =>
    jsonResponse({
      items: [
        {
          id: `${eventId}:2026-09-14`,
          event_id: eventId,
          start: "2026-09-14",
          end: "2026-09-14",
          date: "2026-09-14",
          event: eventWithLink,
        },
      ],
      pagination: { limit: 10, offset: 5, count: 1, total: 6, has_more: false },
      board_revision: 3,
    }),
  );
  try {
    const result = await listBoardEventOccurrences(boardId, {
      windowStart: "2026-09-14",
      windowEnd: "2026-09-20",
      limit: 10,
      offset: 5,
      search: "  Budget%_ ",
    });
    expect(result.items[0]).toMatchObject({
      id: `${eventId}:2026-09-14`,
      eventId,
      event: {
        id: eventId,
        boardId,
        links: [{ label: "Guide", url: "https://example.org/guide" }],
      },
    });
    expect(result.pagination).toMatchObject({ total: 6, hasMore: false });
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/boards/${boardId}/events/occurrences?window_start=2026-09-14&window_end=2026-09-20&limit=10&offset=5&search=Budget%25_`,
    );
  } finally {
    mock.restore();
  }
});

test("Board event adapter keeps timed UTC instants separate from local occurrence dates", async () => {
  const timedEvent = {
    ...allDayEvent,
    all_day: false,
    start_date: null,
    end_date: null,
    start_at: "2026-03-07T07:30:00Z",
    end_at: "2026-03-07T08:30:00Z",
    timezone_name: "America/New_York",
    recurrence: "none",
    repeat_until: null,
  };
  const mock = installFetch(() =>
    jsonResponse({
      items: [
        {
          id: `${eventId}:2026-03-07T07:30:00Z`,
          event_id: eventId,
          start: "2026-03-07T07:30:00Z",
          end: "2026-03-07T08:30:00Z",
          date: "2026-03-07",
          event: timedEvent,
        },
      ],
      pagination: page,
      board_revision: 3,
    }),
  );
  try {
    const result = await listBoardEventOccurrences(boardId, {
      windowStart: "2026-03-07",
      windowEnd: "2026-03-07",
    });
    expect(result.items[0]).toMatchObject({
      start: "2026-03-07T07:30:00Z",
      date: "2026-03-07",
      event: {
        allDay: false,
        startDate: null,
        startAt: "2026-03-07T07:30:00Z",
      },
    });
  } finally {
    mock.restore();
  }
});

test("Board event adapter rejects malformed input and unsupported fields before sending", async () => {
  const mock = installFetch(() => jsonResponse(mutation));
  try {
    await expect(listBoardEvents("../elsewhere")).rejects.toThrow();
    await expect(listBoardEvents(boardId, { limit: 101 })).rejects.toThrow();
    await expect(
      listBoardEvents(boardId, { deleted: "include" } as never),
    ).rejects.toThrow();
    await expect(
      createBoardEvent(boardId, {
        boardRevision: 1,
        title: "Plan",
        allDay: true,
        startDate: "2026-09-14",
        endDate: "2026-09-14",
        timezoneName: "UTC",
        audience: { kind: "role" } as never,
      }),
    ).rejects.toThrow();
    await expect(
      createBoardEvent(boardId, {
        boardRevision: 1,
        title: "Plan",
        allDay: false,
        startAt: "2026-09-14T16:00:00+08:00",
        endAt: "2026-09-14T17:00:00+08:00",
        timezoneName: "Asia/Manila",
      }),
    ).rejects.toThrow();
    await expect(
      updateBoardEvent(boardId, eventId, {
        boardRevision: 1,
        eventRevision: 1,
      }),
    ).rejects.toThrow();
    await expect(archiveBoardEvent(boardId, eventId, 0, 1)).rejects.toThrow();
    await expect(
      listBoardEventOccurrences(boardId, {
        windowStart: "2026-09-14",
        windowEnd: "2026-10-27",
      }),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

test("Board event adapter fails closed on leaked fields, cross-Board IDs, and malformed time", async () => {
  const privateDto = installFetch(() =>
    jsonResponse({ ...allDayEvent, private_token: "secret" }),
  );
  try {
    await expect(readBoardEvent(boardId, eventId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    privateDto.restore();
  }
  const wrongBoard = installFetch(() =>
    jsonResponse({ ...allDayEvent, board_id: authorId }),
  );
  try {
    await expect(readBoardEvent(boardId, eventId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    wrongBoard.restore();
  }
  const malformedTime = installFetch(() =>
    jsonResponse({
      ...allDayEvent,
      all_day: false,
      start_date: null,
      end_date: null,
      start_at: "2026-09-14T16:00:00+08:00",
      end_at: "2026-09-14T17:00:00+08:00",
    }),
  );
  try {
    await expect(readBoardEvent(boardId, eventId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    malformedTime.restore();
  }
});

test("Board event link boundary rejects missing, malformed, unsafe, or oversized remote links", async () => {
  for (const links of [
    undefined,
    [{ label: "Unsafe", url: "javascript:alert(1)" }],
    [{ label: "Credential", url: "https://user:pass@example.org/path" }],
    [{ label: "Empty credential", url: "https://@example.org/path" }],
    [{ label: "Empty", url: "https://example.org", private_token: "secret" }],
    [{ label: "", url: "https://example.org" }],
    [{ label: "Long", url: `https://example.org/${"x".repeat(2050)}` }],
    Array.from({ length: 21 }, () => ({
      label: "Excess",
      url: "https://example.org",
    })),
  ]) {
    const payload = { ...allDayEvent, links };
    const mock = installFetch(() => jsonResponse(payload));
    try {
      await expect(readBoardEvent(boardId, eventId)).rejects.toBeInstanceOf(
        ApiContractError,
      );
    } finally {
      mock.restore();
    }
  }
});

test("Board event link input rejects unsafe and oversized values before fetch", async () => {
  const mock = installFetch(() => jsonResponse(mutation));
  try {
    for (const links of [
      [{ label: "Unsafe", url: "data:text/html,unsafe" }],
      [{ label: "Credential", url: "https://user@example.org" }],
      [{ label: "Empty credential", url: "https://@example.org" }],
      [{ label: "", url: "https://example.org" }],
      Array.from({ length: 21 }, () => ({
        label: "Excess",
        url: "https://example.org",
      })),
    ]) {
      await expect(
        createBoardEvent(boardId, {
          boardRevision: 3,
          title: "Planning",
          allDay: true,
          startDate: "2026-09-14",
          endDate: "2026-09-14",
          timezoneName: "Asia/Manila",
          links,
        }),
      ).rejects.toThrow();
    }
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

test("Board event occurrence rejects inconsistent totals and forged series keys", async () => {
  const badTotal = installFetch(() =>
    jsonResponse({
      items: [allDayEvent],
      pagination: { ...page, total: 0 },
      board_revision: 3,
    }),
  );
  try {
    await expect(listBoardEvents(boardId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    badTotal.restore();
  }
  const forgedKey = installFetch(() =>
    jsonResponse({
      items: [
        {
          id: `${eventId}:2026-09-15`,
          event_id: eventId,
          start: "2026-09-14",
          end: "2026-09-14",
          date: "2026-09-14",
          event: allDayEvent,
        },
      ],
      pagination: page,
      board_revision: 3,
    }),
  );
  try {
    await expect(
      listBoardEventOccurrences(boardId, {
        windowStart: "2026-09-14",
        windowEnd: "2026-09-14",
      }),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    forgedKey.restore();
  }
});

test("Board event adapter redacts server detail while retaining safe status and conflict code", async () => {
  const secret = "private audience and SQL detail";
  const conflict = installFetch(() =>
    jsonResponse(
      {
        detail: {
          code: "stale_event_revision",
          message: secret,
          current_revision: 8,
        },
      },
      409,
    ),
  );
  try {
    const error = await updateBoardEvent(boardId, eventId, {
      boardRevision: 3,
      eventRevision: 1,
      title: "Updated",
    }).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "stale_event_revision",
      message: "Event changed; reload before saving",
    });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain("current_revision");
  } finally {
    conflict.restore();
  }
  const denied = installFetch(() => jsonResponse({ detail: secret }, 403));
  try {
    await expect(readBoardEvent(boardId, eventId)).rejects.toMatchObject({
      status: 403,
      message: "Request could not be completed",
    });
  } finally {
    denied.restore();
  }
});
