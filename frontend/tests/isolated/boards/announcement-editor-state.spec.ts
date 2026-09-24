import { expect, test } from "@playwright/test";
import { ApiError } from "../../../src/lib/api";
import type { BoardAnnouncement } from "../../../src/components/systems/boards/adapters/board-announcements-api";
import {
  announcementCancellationPatch,
  announcementPatchForForm,
  announcementScheduleTimeToUtc,
  validAnnouncementLinks,
  editorFailure,
  editorStateForKey,
  resolveEditorRefresh,
  type AnnouncementEditorState,
} from "../../../src/components/systems/boards/hooks/use-server-board-announcement-editor";

const boardId = "00000000-0000-4000-8000-000000000001";
const otherBoardId = "00000000-0000-4000-8000-000000000002";
const actorId = "00000000-0000-4000-8000-000000000003";
const now = "2026-09-24T00:00:00Z";
const draft: BoardAnnouncement = {
  id: "00000000-0000-4000-8000-000000000004",
  boardId,
  authorId: actorId,
  title: "Private draft",
  body: "Original text",
  links: [],
  audience: {
    kind: "author",
    roleId: null,
    userId: null,
    departmentId: null,
  },
  status: "draft",
  publishAt: null,
  expiresAt: null,
  pinned: false,
  announcementRevision: 1,
  boardRevision: 2,
  publicationNumber: null,
  publishedAt: null,
  createdAt: now,
  updatedAt: now,
};
const ready: AnnouncementEditorState = {
  key: `${boardId}:${actorId}:active`,
  status: "ready",
  access: { view: true, edit: true, manage: false },
  page: {
    items: [draft],
    boardRevision: 2,
    pagination: { limit: 25, offset: 0, count: 1, total: 1, hasMore: false },
  },
  boardRevision: 2,
  selected: draft,
  form: {
    title: "Unsaved title",
    body: "Unsaved body",
    links: [],
    audience: { kind: "author" },
  },
  displayed: null,
  pending: true,
  attachmentPending: false,
  recordLinkPending: false,
  conflict: false,
  error: null,
  notice: null,
  scheduleLocal: "",
  scheduleError: null,
};

test("Board switch and permission denial clear all private editor content", () => {
  const switched = editorStateForKey(
    ready,
    `${otherBoardId}:${actorId}:active`,
    7,
  );
  expect(switched.selected).toBeNull();
  expect(switched.form).toBeNull();
  expect(switched.page).toBeNull();
  expect(switched.access).toBeNull();

  for (const status of [401, 403, 404]) {
    const denied = editorFailure(ready, new ApiError(status, "Denied"));
    expect(denied.status).toBe("denied");
    expect(denied.selected).toBeNull();
    expect(denied.form).toBeNull();
    expect(denied.page).toBeNull();
    expect(denied.displayed).toBeNull();
  }
});

test("revision conflict retains unsaved text and prevents false success", () => {
  const conflicted = editorFailure(
    ready,
    new ApiError(409, "Announcement changed; reload before saving"),
  );
  expect(conflicted.form).toEqual(ready.form);
  expect(conflicted.selected).toEqual(draft);
  expect(conflicted.pending).toBe(false);
  expect(conflicted.conflict).toBe(true);
  expect(conflicted.error).toContain("Your text has been kept");
  expect(conflicted.notice).toBeNull();
});

test("editing a targeted-audience draft omits audience instead of widening it", () => {
  const targeted: BoardAnnouncement = {
    ...draft,
    audience: {
      kind: "department",
      roleId: null,
      userId: null,
      departmentId: "00000000-0000-4000-8000-000000000005",
    },
  };
  const patch = announcementPatchForForm(
    targeted,
    {
      title: "Updated",
      body: "Changed body",
      links: [],
      audience: {
        kind: "department",
        targetId: "00000000-0000-4000-8000-000000000005",
      },
    },
    6,
  );
  expect(patch).toMatchObject({ boardRevision: 6, announcementRevision: 1 });
  expect(patch).not.toHaveProperty("audience");
  expect(
    announcementPatchForForm(
      draft,
      {
        title: "Updated",
        body: "Changed body",
        links: [],
        audience: { kind: "everyone" },
      },
      6,
    ).audience,
  ).toEqual({ kind: "everyone" });
});

test("announcement draft update sends the newly selected person audience", () => {
  const patch = announcementPatchForForm(
    draft,
    {
      title: "Audience changed",
      body: draft.body,
      links: [],
      audience: {
        kind: "user",
        targetId: "00000000-0000-4000-8000-000000000006",
      },
    },
    2,
  );
  expect(patch.audience).toEqual({
    kind: "user",
    userId: "00000000-0000-4000-8000-000000000006",
  });
});

test("announcement links validate before save and omit untouched links from text-only edits", () => {
  const original = [{ label: "Runbook", url: "https://example.test/runbook" }];
  const linked = { ...draft, links: original };
  const form = {
    title: "New title",
    body: draft.body,
    audience: { kind: "author" as const },
    links: [...original],
  };
  expect(validAnnouncementLinks(form.links)).toBe(true);
  expect(announcementPatchForForm(linked, form, 3)).not.toHaveProperty("links");
  expect(
    announcementPatchForForm(
      linked,
      {
        ...form,
        links: [{ label: "Guide", url: "https://example.test/guide" }],
      },
      3,
    ).links,
  ).toEqual([{ label: "Guide", url: "https://example.test/guide" }]);
  for (const url of [
    "ftp://example.test/file",
    "https://user:password@example.test/file",
    "https://example.test/\\hidden",
  ])
    expect(validAnnouncementLinks([{ label: "Unsafe", url }])).toBe(false);
  expect(
    validAnnouncementLinks([{ label: " ", url: "https://example.test" }]),
  ).toBe(false);
  expect(
    validAnnouncementLinks(Array.from({ length: 21 }, () => original[0])),
  ).toBe(false);
});

test("local schedule times convert to UTC and reject past, invalid, or expired times", () => {
  const now = Date.parse("2035-06-01T00:00:00Z");
  const converted = announcementScheduleTimeToUtc("2035-06-01T12:30", now);
  expect(converted).toEqual({
    ok: true,
    publishAt: new Date("2035-06-01T12:30").toISOString(),
  });
  expect(announcementScheduleTimeToUtc("", now)).toEqual({
    ok: false,
    reason: "required",
  });
  expect(announcementScheduleTimeToUtc("2035-06-01T99:30", now)).toEqual({
    ok: false,
    reason: "invalid",
  });
  expect(announcementScheduleTimeToUtc("2035-05-31T12:30", now)).toEqual({
    ok: false,
    reason: "past",
  });
  expect(
    announcementScheduleTimeToUtc(
      "2035-06-01T12:30",
      now,
      "2035-06-01T03:00:00Z",
    ),
  ).toEqual({ ok: false, reason: "after_expiration" });
});

test("a nonexistent device-local time during a clock change is rejected", () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    expect(
      announcementScheduleTimeToUtc(
        "2035-03-11T02:30",
        Date.parse("2035-03-01T00:00:00Z"),
      ),
    ).toEqual({ ok: false, reason: "invalid" });
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test("a concurrent schedule edit conflicts without replacing the local time selection", () => {
  const selected: BoardAnnouncement = {
    ...draft,
    status: "scheduled",
    publishAt: "2035-06-01T19:30:00Z",
    announcementRevision: 2,
  };
  const state: AnnouncementEditorState = {
    ...ready,
    selected,
    form: {
      title: selected.title,
      body: selected.body,
      links: [],
      audience: { kind: "author" },
    },
    scheduleLocal: "2035-06-02T12:30",
    pending: false,
  };
  const latest = {
    ...selected,
    publishAt: "2035-06-03T19:30:00Z",
    announcementRevision: 3,
    boardRevision: 5,
  };
  const refreshed = resolveEditorRefresh(
    state,
    { view: true, edit: true, manage: false },
    {
      items: [latest],
      boardRevision: 5,
      pagination: { limit: 25, offset: 0, count: 1, total: 1, hasMore: false },
    },
    latest,
    true,
  );
  expect(refreshed.conflict).toBe(true);
  expect(refreshed.scheduleLocal).toBe("2035-06-02T12:30");
  expect(refreshed.selected?.announcementRevision).toBe(2);
  expect(refreshed.boardRevision).toBe(2);
});

test("canceling a scheduled draft sends unchanged text and omits links and audience", () => {
  const scheduled: BoardAnnouncement = {
    ...draft,
    title: "Scheduled title",
    body: "Scheduled body",
    status: "scheduled",
    publishAt: "2035-06-01T12:30:00Z",
    announcementRevision: 2,
    links: [{ label: "Guide", url: "https://example.test/guide" }],
    audience: {
      kind: "department",
      roleId: null,
      userId: null,
      departmentId: "00000000-0000-4000-8000-000000000005",
    },
  };
  expect(announcementCancellationPatch(scheduled, 6)).toEqual({
    boardRevision: 6,
    announcementRevision: 2,
    title: scheduled.title,
    body: scheduled.body,
  });
});

test("refresh verifies a conflicting draft without silently replacing its retained text or revision", () => {
  const conflicted = editorFailure(
    ready,
    new ApiError(409, "Announcement changed; reload before saving"),
  );
  const latest = { ...draft, announcementRevision: 3, boardRevision: 5 };
  const refreshed = resolveEditorRefresh(
    conflicted,
    { view: true, edit: true, manage: false },
    {
      items: [latest],
      boardRevision: 5,
      pagination: { limit: 25, offset: 0, count: 1, total: 1, hasMore: false },
    },
    latest,
    true,
  );
  expect(refreshed.form).toEqual(ready.form);
  expect(refreshed.selected?.announcementRevision).toBe(1);
  expect(refreshed.boardRevision).toBe(2);
  expect(refreshed.page?.items[0]?.announcementRevision).toBe(3);
  expect(refreshed.conflict).toBe(true);
});

test("dirty refresh detects a concurrent announcement edit and keeps old revision tokens", () => {
  const dirtyDraft = { ...ready, pending: false };
  const latest = {
    ...draft,
    title: "Concurrent server title",
    announcementRevision: 3,
    boardRevision: 5,
  };
  const refreshed = resolveEditorRefresh(
    dirtyDraft,
    { view: true, edit: true, manage: false },
    {
      items: [latest],
      boardRevision: 5,
      pagination: { limit: 25, offset: 0, count: 1, total: 1, hasMore: false },
    },
    latest,
    true,
  );
  expect(refreshed.form).toEqual(dirtyDraft.form);
  expect(refreshed.selected?.announcementRevision).toBe(1);
  expect(refreshed.boardRevision).toBe(2);
  expect(refreshed.conflict).toBe(true);
  expect(refreshed.page?.items[0]?.title).toBe("Concurrent server title");
});

test("clean refresh adopts the concurrent announcement edit and its revisions", () => {
  const clean = {
    ...ready,
    pending: false,
    form: {
      title: draft.title,
      body: draft.body,
      links: [],
      audience: { kind: "author" as const },
    },
  };
  const latest = {
    ...draft,
    title: "Concurrent server title",
    announcementRevision: 3,
    boardRevision: 5,
  };
  const refreshed = resolveEditorRefresh(
    clean,
    { view: true, edit: true, manage: false },
    {
      items: [latest],
      boardRevision: 5,
      pagination: { limit: 25, offset: 0, count: 1, total: 1, hasMore: false },
    },
    latest,
    true,
  );
  expect(refreshed.form?.title).toBe("Concurrent server title");
  expect(refreshed.selected?.announcementRevision).toBe(3);
  expect(refreshed.boardRevision).toBe(5);
  expect(refreshed.conflict).toBe(false);
});

test("unrelated Board revision refresh retains local draft text without false announcement conflict", () => {
  const latest = { ...draft, boardRevision: 5 };
  const refreshed = resolveEditorRefresh(
    { ...ready, pending: false },
    { view: true, edit: true, manage: false },
    {
      items: [latest],
      boardRevision: 5,
      pagination: { limit: 25, offset: 0, count: 1, total: 1, hasMore: false },
    },
    latest,
    true,
  );
  expect(refreshed.form).toEqual(ready.form);
  expect(refreshed.selected?.announcementRevision).toBe(1);
  expect(refreshed.boardRevision).toBe(5);
  expect(refreshed.conflict).toBe(false);
});
