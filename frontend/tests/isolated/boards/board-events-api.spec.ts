import { expect, test } from "@playwright/test";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  archiveBoardEvent,
  createBoardEvent,
  previewBoardEventPurge,
  purgeBoardEvent,
  listBoardEventOccurrences,
  listBoardEvents,
  readBoardEvent,
  restoreBoardEvent,
  updateBoardEvent,
} from "../../../src/components/systems/boards/adapters/board-events-api";
import { installNoArgumentFetch as installFetch } from "../helpers/fake-fetch";

const boardId = "00000000-0000-4000-8000-000000000001";
const eventId = "00000000-0000-4000-8000-000000000002";
const authorId = "00000000-0000-4000-8000-000000000003";
const timestamp = "2026-09-23T00:00:00Z";

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
  reminders: ["1d", "start"],
  archived: false,
  revision: 1,
  board_revision: 3,
  created_at: timestamp,
  updated_at: timestamp,
};
const mutation = { id: eventId, event_revision: 2, board_revision: 4 };

test("Board event series list uses bounded query and parses the event with its reminders", async () => {
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
      reminders: ["1d", "start"],
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

test("Board event create and patch send reminder timings and UTC timed instants with revisions", async () => {
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
        reminders: ["15m"],
        links: [{ label: "  Guide  ", url: "  https://example.org/guide  " }],
      }),
    ).resolves.toEqual({ id: eventId, eventRevision: 2, boardRevision: 4 });
    await expect(
      updateBoardEvent(boardId, eventId, {
        boardRevision: 4,
        eventRevision: 2,
        reminders: [],
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
      reminders: ["15m"],
      links: [{ label: "Guide", url: "https://example.org/guide" }],
    });
    expect(JSON.parse(String(mock.requests[1]?.init?.body))).toEqual({
      board_revision: 4,
      event_revision: 2,
      title: "Updated",
      reminders: [],
      links: [],
    });
    expect(mock.requests.every(({ init }) => init?.cache === "no-store")).toBe(
      true,
    );
  } finally {
    mock.restore();
  }
});

test("Board event detail, archive, and restore use explicit revisions", async () => {
  const responses = [
    jsonResponse(allDayEvent),
    jsonResponse(mutation),
    jsonResponse(mutation),
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
    expect(
      mock.requests.map(({ input, init }) => [String(input), init?.method]),
    ).toEqual([
      [`/api/boards/${boardId}/events/${eventId}`, undefined],
      [`/api/boards/${boardId}/events/${eventId}/archive`, "POST"],
      [`/api/boards/${boardId}/events/${eventId}/restore`, "POST"],
    ]);
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

test("Board event occurrence page exposes the next occurrence after its window", async () => {
  const next = {
    id: `${eventId}:2026-11-02`,
    event_id: eventId,
    start: "2026-11-02",
    end: "2026-11-02",
    date: "2026-11-02",
  };
  const empty = {
    items: [],
    pagination: { limit: 100, offset: 0, count: 0, total: 0, has_more: false },
    board_revision: 3,
  };
  for (const [body, expected] of [
    [
      { ...empty, next_occurrence: next },
      {
        id: next.id,
        eventId,
        start: "2026-11-02",
        end: "2026-11-02",
        date: "2026-11-02",
      },
    ],
    [{ ...empty, next_occurrence: null }, null],
    [empty, null],
  ] as const) {
    const mock = installFetch(() => jsonResponse(body));
    try {
      const result = await listBoardEventOccurrences(boardId, {
        windowStart: "2026-10-01",
        windowEnd: "2026-10-31",
      });
      expect(result.nextOccurrence).toEqual(expected);
    } finally {
      mock.restore();
    }
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
        reminders: ["now"] as never,
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

const purgeImpact = {
  target_type: "board_event",
  target_id: eventId,
  operation: "purge",
  actor_id: authorId,
  rows: [],
  external_impacts: [],
  key_strips: [],
  blockers: [],
  impact_digest: "a".repeat(64),
};
const purgePreview = {
  impact: purgeImpact,
  token: "synthetic-event-challenge",
  expires_at: timestamp,
  confirmation_name: "Planning ".repeat(25).trim(),
  last_successful_backup_at: null,
};

test("Board event purge carries a guarded exact-name challenge and refuses mismatched impact", async () => {
  const responses = [
    jsonResponse(purgePreview),
    jsonResponse({ impact: purgeImpact, operation_id: null }),
    jsonResponse({
      ...purgePreview,
      impact: { ...purgeImpact, target_id: authorId },
    }),
  ];
  const mock = installFetch(() => responses.shift()!);
  try {
    await expect(previewBoardEventPurge(boardId, eventId)).resolves.toEqual(
      purgePreview,
    );
    await expect(
      purgeBoardEvent(boardId, eventId, {
        token: purgePreview.token,
        confirmationName: purgePreview.confirmation_name,
        password: "synthetic-passphrase",
      }),
    ).resolves.toEqual({ impact: purgeImpact, operation_id: null });
    expect(
      mock.requests
        .slice(0, 2)
        .map(({ input, init }) => [String(input), init?.method]),
    ).toEqual([
      [`/api/boards/${boardId}/events/${eventId}/purge/preview`, "POST"],
      [`/api/boards/${boardId}/events/${eventId}/purge`, "POST"],
    ]);
    expect(JSON.parse(String(mock.requests[1]?.init?.body))).toEqual({
      token: purgePreview.token,
      confirmation_name: purgePreview.confirmation_name,
      password: "synthetic-passphrase",
    });
    await expect(
      previewBoardEventPurge(boardId, eventId),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    mock.restore();
  }
});
