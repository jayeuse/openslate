import { expect, test } from "@playwright/test";
import {
  BOARD_INPUT_LIMITS,
  DEFAULT_BOARD_ID,
  INITIAL_ANNOUNCEMENTS,
  INITIAL_BOARDS,
  INITIAL_EVENTS,
  decodeBoardAnnouncements,
  decodeBoardEvents,
  decodeBoardRecordPlacements,
  decodeBoards,
  decodeBoardAudience,
  decodeBoardTemplates,
  decodeBoardPersonalState,
  decodeBoardActivity,
  type BoardAudienceLookup,
} from "../../../src/components/systems/boards/domain/model";
import { getAnnouncementLifecycle } from "../../../src/components/systems/boards/domain/content";

const audienceLookup: BoardAudienceLookup = {
  roles: [
    { id: "sample-admin", name: "Administrator" },
    { id: "sample-member", name: "Member" },
  ],
  identities: [{ id: "sample-mara", name: "Mara Santos" }],
  departments: [{ id: "operations", name: "Operations" }],
};

test("board decoding keeps canonical visibility ahead of legacy role labels", () => {
  const [board] = decodeBoards(
    [
      {
        id: "sample-board-operations",
        name: "Operations board",
        department: "Operations",
        status: "active",
        defaultSection: "Calendar",
        visibleRoleIds: ["sample-member", "sample-member", "unsafe value"],
        roles: ["Administrator", "Member"],
        permission: "Members can view",
        widgets: [],
      },
    ],
    { audienceLookup },
  );

  expect(board).toEqual(
    expect.objectContaining({
      id: "sample-board-operations",
      status: "active",
      defaultSection: "calendar",
      visibleRoleIds: ["sample-member"],
      roles: ["Administrator", "Member"],
      widgets: [],
    }),
  );
  expect(board?.description).toBe("");
  expect(board?.permission).toBe("Members can view");
});

test("legacy board role names map only to unique known role IDs", () => {
  const [board] = decodeBoards(
    [
      {
        id: "sample-board-legacy",
        name: "Legacy",
        department: "Operations",
        roles: ["Administrator", "Missing role"],
        widgets: [],
      },
    ],
    { audienceLookup },
  );

  expect(board?.visibleRoleIds).toEqual(["sample-admin"]);

  const [ambiguous] = decodeBoards(
    [
      {
        id: "sample-board-ambiguous",
        name: "Ambiguous",
        department: "Operations",
        roles: ["Member"],
        widgets: [],
      },
    ],
    {
      audienceLookup: {
        ...audienceLookup,
        roles: [
          { id: "role-a", name: "Member" },
          { id: "role-b", name: "Member" },
        ],
      },
    },
  );
  expect(ambiguous?.visibleRoleIds).toEqual([]);
});

test("events migrate missing board IDs, legacy labels, and invalid audiences safely", () => {
  const [missingBoard, namedBoard, invalidAudience] = decodeBoardEvents(
    [
      {
        id: "event-missing-board",
        title: "Briefing",
        date: "2026-09-14",
        visibility: "Organization",
        recurrence: "Weekly",
        recordId: "sample-sr-1004",
      },
      {
        id: "event-named-board",
        title: "Handoff",
        board: "Operations board",
        date: "2026-09-15",
      },
      {
        id: "event-invalid-audience",
        title: "Private fallback",
        audience: "Role: Unknown",
        start: "2026-09-16",
      },
    ],
    {
      boards: [
        { id: DEFAULT_BOARD_ID, name: "Organization board" },
        { id: "sample-board-operations", name: "Operations board" },
      ],
      audienceLookup,
    },
  );

  expect(missingBoard).toEqual(
    expect.objectContaining({
      boardId: DEFAULT_BOARD_ID,
      start: "2026-09-14",
      end: "2026-09-14",
      allDay: true,
      recurrence: "weekly",
      links: [expect.objectContaining({ recordId: "sample-sr-1004" })],
      audience: { kind: "everyone" },
    }),
  );
  expect(namedBoard?.boardId).toBe("sample-board-operations");
  expect(invalidAudience?.audience).toEqual({
    kind: "private",
    unresolved: { kind: "role", id: "unknown" },
  });
});

test("announcement decoding keeps published content separate from a draft revision", () => {
  const [announcement] = decodeBoardAnnouncements(
    [
      {
        id: "announcement-draft",
        title: "Updated title",
        body: "Updated body",
        boardId: DEFAULT_BOARD_ID,
        authorId: "sample-mara",
        status: "draft",
        audience: "Everyone",
        attachments: [],
        links: [],
        publishedRevision: {
          id: "announcement-draft:published:1",
          title: "Published title",
          body: "Published body",
          audience: "Everyone",
          expiresAt: null,
          authorId: "sample-mara",
          publishedAt: "2026-09-13T08:00:00.000Z",
          createdAt: "2026-09-13T08:00:00.000Z",
          updatedAt: "2026-09-13T08:00:00.000Z",
        },
      },
    ],
    { audienceLookup },
  );

  expect(announcement).toEqual(
    expect.objectContaining({
      status: "draft",
      title: "Updated title",
      body: "Updated body",
      attachments: [],
      links: [],
      publishedRevision: expect.objectContaining({
        title: "Published title",
        body: "Published body",
      }),
    }),
  );

  const [legacy] = decodeBoardAnnouncements([
    {
      id: "announcement-legacy",
      title: "Legacy notice",
      body: "Legacy body",
      audience: "Everyone",
    },
  ]);
  expect(legacy).toEqual(
    expect.objectContaining({
      status: "published",
      publishAt: expect.any(String),
      publishedRevision: expect.objectContaining({
        title: "Legacy notice",
        audience: { kind: "everyone" },
      }),
    }),
  );
});

test("legacy date-only announcement expiry keeps its end-of-day lifecycle across round trips", () => {
  const [announcement] = decodeBoardAnnouncements([
    {
      id: "announcement-date-only-expiry",
      boardId: DEFAULT_BOARD_ID,
      authorId: "sample-mara",
      title: "Date-only expiry",
      body: "This should remain visible through the stored date.",
      status: "published",
      expires: "2026-09-30",
    },
  ]);

  expect(announcement).toBeDefined();
  if (!announcement) throw new Error("Expected the announcement to decode.");
  expect(announcement?.expiresAt).toBe("2026-10-01T00:00:00.000Z");
  expect(announcement?.publishedRevision?.expiresAt).toBe(
    "2026-10-01T00:00:00.000Z",
  );
  expect(
    getAnnouncementLifecycle(announcement, "2026-09-30T23:59:59.999Z").visible,
  ).toBe(true);
  expect(
    getAnnouncementLifecycle(announcement, "2026-10-01T00:00:00.000Z").visible,
  ).toBe(false);

  const [roundTripped] = decodeBoardAnnouncements(
    JSON.parse(JSON.stringify([announcement])),
  );
  expect(roundTripped?.expiresAt).toBe("2026-10-01T00:00:00.000Z");
  expect(roundTripped?.publishedRevision?.expiresAt).toBe(
    "2026-10-01T00:00:00.000Z",
  );

  const [timestampExpiry] = decodeBoardAnnouncements([
    {
      id: "announcement-timestamp-expiry",
      boardId: DEFAULT_BOARD_ID,
      authorId: "sample-mara",
      title: "Timestamp expiry",
      body: "This exact instant should remain canonical.",
      status: "published",
      expiresAt: "2026-09-30T12:34:56+08:00",
    },
  ]);
  expect(timestampExpiry?.expiresAt).toBe("2026-09-30T04:34:56.000Z");
  expect(timestampExpiry?.publishedRevision?.expiresAt).toBe(
    "2026-09-30T04:34:56.000Z",
  );

  const [invalidExpiry] = decodeBoardAnnouncements([
    {
      id: "announcement-invalid-date-expiry",
      boardId: DEFAULT_BOARD_ID,
      authorId: "sample-mara",
      title: "Invalid date expiry",
      body: "An invalid date must not become a different valid instant.",
      status: "published",
      expires: "2026-02-30",
    },
  ]);
  expect(invalidExpiry?.expiresAt).toBeNull();
  expect(invalidExpiry?.publishedRevision?.expiresAt).toBeNull();
});

test("decoding preserves canonical internal record links in events and announcement revisions", () => {
  const internalUrl = "/openview?record=sample-sr-1004";
  const [event] = decodeBoardEvents([
    {
      id: "event-with-record-link",
      title: "Linked event",
      start: "2026-09-14",
      links: [
        {
          id: "event-record-link",
          label: "Service request",
          url: internalUrl,
          recordId: "sample-sr-1004",
        },
        {
          id: "event-external-link",
          label: "External guide",
          url: "https://example.com/guide",
        },
        { id: "unsafe-relative-link", label: "Unsafe", url: "/settings" },
      ],
    },
  ]);
  const [announcement] = decodeBoardAnnouncements([
    {
      id: "announcement-with-record-link",
      title: "Linked announcement",
      body: "Review this request.",
      links: [
        {
          id: "draft-record-link",
          label: "Draft request",
          url: internalUrl,
          recordId: "sample-sr-1004",
        },
      ],
      publishedRevision: {
        id: "announcement-with-record-link:published",
        title: "Published announcement",
        body: "Review this published request.",
        audience: "Everyone",
        expiresAt: null,
        publishedAt: "2026-09-14T00:00:00.000Z",
        links: [
          {
            id: "published-record-link",
            label: "Published request",
            url: internalUrl,
            recordId: "sample-sr-1004",
          },
        ],
      },
    },
  ]);

  expect(event?.links).toEqual([
    {
      id: "event-record-link",
      label: "Service request",
      url: internalUrl,
      recordId: "sample-sr-1004",
    },
    {
      id: "event-external-link",
      label: "External guide",
      url: "https://example.com/guide",
    },
  ]);
  expect(announcement?.links).toEqual([
    {
      id: "draft-record-link",
      label: "Draft request",
      url: internalUrl,
      recordId: "sample-sr-1004",
    },
  ]);
  expect(announcement?.publishedRevision?.links).toEqual([
    {
      id: "published-record-link",
      label: "Published request",
      url: internalUrl,
      recordId: "sample-sr-1004",
    },
  ]);
});

test("legacy personal, activity, template, and placement state is bounded and deterministic", () => {
  const [placementFromString, placementFromObject] =
    decodeBoardRecordPlacements(
      [
        "sample-sr-1004",
        {
          id: "placement-2",
          board: "Operations board",
          recordId: "sample-sr-1005",
          position: 4,
        },
      ],
      {
        boards: [
          { id: DEFAULT_BOARD_ID, name: "Organization board" },
          { id: "sample-board-operations", name: "Operations board" },
        ],
      },
    );
  expect(placementFromString).toEqual(
    expect.objectContaining({
      boardId: DEFAULT_BOARD_ID,
      recordId: "sample-sr-1004",
      pinned: true,
    }),
  );
  expect(placementFromObject?.boardId).toBe("sample-board-operations");

  const personal = decodeBoardPersonalState({
    identityId: "sample-mara",
    favoriteBoardIds: [DEFAULT_BOARD_ID, DEFAULT_BOARD_ID, "bad id"],
    calendarView: "Month",
    readAnnouncementIds: ["notice-1"],
    bookmarkedAnnouncementIds: ["notice-1"],
    reminders: [],
  });
  expect(personal).toEqual(
    expect.objectContaining({
      identityId: "sample-mara",
      favoriteBoardIds: [DEFAULT_BOARD_ID],
      calendarView: "month",
    }),
  );

  expect(
    decodeBoardActivity([
      { id: "activity-1", boardId: DEFAULT_BOARD_ID, actorId: "sample-mara" },
      { id: "activity-1", boardId: DEFAULT_BOARD_ID, actorId: "sample-mara" },
    ]),
  ).toHaveLength(1);
  expect(
    decodeBoardTemplates([
      { id: "template-1", name: "Operations", widgets: [] },
    ])[0],
  ).toEqual(expect.objectContaining({ id: "template-1", widgets: [] }));
});

test("bundled model defaults are canonical and expose bounded input limits", () => {
  expect(INITIAL_BOARDS[0]).toEqual(
    expect.objectContaining({
      id: DEFAULT_BOARD_ID,
      visibleRoleIds: ["sample-admin", "sample-member"],
      status: "active",
      defaultSection: "overview",
    }),
  );
  expect(INITIAL_EVENTS[0]).toEqual(
    expect.objectContaining({ boardId: DEFAULT_BOARD_ID }),
  );
  expect(INITIAL_ANNOUNCEMENTS[0]).toEqual(
    expect.objectContaining({
      boardId: DEFAULT_BOARD_ID,
      publishedRevision: expect.any(Object),
    }),
  );
  expect(BOARD_INPUT_LIMITS.maxWidgets).toBe(12);
  expect(BOARD_INPUT_LIMITS.maxAttachments).toBe(5);
});

test("board audience accepts departments and fails closed for unknown legacy names", () => {
  expect(decodeBoardAudience("Department: Operations", audienceLookup)).toEqual(
    { kind: "department", id: "operations" },
  );
  expect(decodeBoardAudience("User: Unknown", audienceLookup)).toEqual({
    kind: "private",
    unresolved: { kind: "identity", id: "unknown" },
  });
});
