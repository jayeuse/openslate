import { expect, test } from "@playwright/test";
import { ApiError } from "../../../src/lib/api";
import type { BoardPost } from "../../../src/components/systems/boards/adapters/board-posts-api";
import {
  postCancellationPatch,
  postPatchForForm,
  postScheduleTimeToUtc,
  validPostLinks,
  editorFailure,
  editorStateForKey,
  resolveEditorRefresh,
  type PostEditorState,
} from "../../../src/components/systems/boards/hooks/use-server-board-post-editor";
import { dirty } from "../../../src/components/systems/boards/hooks/post-editor-state";

const boardId = "00000000-0000-4000-8000-000000000001";
const otherBoardId = "00000000-0000-4000-8000-000000000002";
const actorId = "00000000-0000-4000-8000-000000000003";
const now = "2026-09-24T00:00:00Z";
const draft: BoardPost = {
  id: "00000000-0000-4000-8000-000000000004",
  boardId,
  authorId: actorId,
  title: "Private draft",
  body: "Original text",
  links: [],
  status: "draft",
  publishAt: null,
  expiresAt: null,
  pinned: false,
  postRevision: 1,
  boardRevision: 2,
  publicationNumber: null,
  publishedAt: null,
  edited: false,
  createdAt: now,
  updatedAt: now,
};
const ready: PostEditorState = {
  key: `${boardId}:${actorId}:active`,
  status: "ready",
  access: { level: "write" as const, view: true, edit: true, manage: false },
  page: {
    items: [draft],
    boardRevision: 2,
    pagination: { limit: 25, offset: 0, count: 1, total: 1, hasMore: false },
  },
  boardRevision: 2,
  selected: draft,
  form: {
    pinned: false,
    expiresLocal: "",
    title: "Unsaved title",
    body: "Unsaved body",
    links: [],
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
  expiryError: null,
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
    new ApiError(409, "Post changed; reload before saving"),
  );
  expect(conflicted.form).toEqual(ready.form);
  expect(conflicted.selected).toEqual(draft);
  expect(conflicted.pending).toBe(false);
  expect(conflicted.conflict).toBe(true);
  expect(conflicted.error).toContain("Your text has been kept");
  expect(conflicted.notice).toBeNull();
});

test("a draft update never sends an audience", () => {
  const patch = postPatchForForm(
    draft,
    {
      title: "Updated",
      body: "Changed body",
      links: [],
      pinned: false,
      expiresLocal: "",
    },
    6,
    "UTC",
  );
  expect(patch).toEqual({
    boardRevision: 6,
    postRevision: 1,
    title: "Updated",
    body: "Changed body",
  });
});

test("post links validate before save and omit untouched links from text-only edits", () => {
  const original = [{ label: "Runbook", url: "https://example.test/runbook" }];
  const linked = { ...draft, links: original };
  const form = {
    pinned: false,
    expiresLocal: "",
    title: "New title",
    body: draft.body,
    links: [...original],
  };
  expect(validPostLinks(form.links)).toBe(true);
  expect(postPatchForForm(linked, form, 3, "UTC")).not.toHaveProperty("links");
  expect(
    postPatchForForm(
      linked,
      {
        ...form,
        links: [{ label: "Guide", url: "https://example.test/guide" }],
      },
      3,
      "UTC",
    ).links,
  ).toEqual([{ label: "Guide", url: "https://example.test/guide" }]);
  for (const url of [
    "ftp://example.test/file",
    "https://user:password@example.test/file",
    "https://example.test/\\hidden",
  ])
    expect(validPostLinks([{ label: "Unsafe", url }])).toBe(false);
  expect(validPostLinks([{ label: " ", url: "https://example.test" }])).toBe(
    false,
  );
  expect(validPostLinks(Array.from({ length: 21 }, () => original[0]))).toBe(
    false,
  );
});

test("schedule times are read in the workspace zone and reject past, invalid, or expired times", () => {
  const now = Date.parse("2035-06-01T00:00:00Z");
  // 12:30 in Manila is 04:30 UTC, whatever zone the machine is in.
  expect(postScheduleTimeToUtc("2035-06-01T12:30", "Asia/Manila", now)).toEqual(
    { ok: true, publishAt: "2035-06-01T04:30:00.000Z" },
  );
  expect(postScheduleTimeToUtc("2035-06-01T12:30", "UTC", now)).toEqual({
    ok: true,
    publishAt: "2035-06-01T12:30:00.000Z",
  });
  expect(postScheduleTimeToUtc("", "UTC", now)).toEqual({
    ok: false,
    reason: "required",
  });
  for (const invalid of ["2035-06-01T99:30", "2035-02-30T12:30"])
    expect(postScheduleTimeToUtc(invalid, "UTC", now)).toEqual({
      ok: false,
      reason: "invalid",
    });
  expect(postScheduleTimeToUtc("2035-05-31T12:30", "UTC", now)).toEqual({
    ok: false,
    reason: "past",
  });
  expect(
    postScheduleTimeToUtc(
      "2035-06-01T12:30",
      "Asia/Manila",
      now,
      "2035-06-01T04:30:00Z",
    ),
  ).toEqual({ ok: false, reason: "after_expiration" });
});

test("a workspace-local time a clock change skips is rejected", () => {
  // 02:30 does not exist in New York on 2035-03-11, whatever zone the
  // machine is in.
  expect(
    postScheduleTimeToUtc(
      "2035-03-11T02:30",
      "America/New_York",
      Date.parse("2035-03-01T00:00:00Z"),
    ),
  ).toEqual({ ok: false, reason: "invalid" });
});

test("a concurrent schedule edit conflicts without replacing the local time selection", () => {
  const selected: BoardPost = {
    ...draft,
    status: "scheduled",
    publishAt: "2035-06-01T19:30:00Z",
    postRevision: 2,
  };
  const state: PostEditorState = {
    ...ready,
    selected,
    form: {
      pinned: false,
      expiresLocal: "",
      title: selected.title,
      body: selected.body,
      links: [],
    },
    scheduleLocal: "2035-06-02T12:30",
    pending: false,
  };
  const latest = {
    ...selected,
    publishAt: "2035-06-03T19:30:00Z",
    postRevision: 3,
    boardRevision: 5,
  };
  const refreshed = resolveEditorRefresh(
    state,
    { level: "write" as const, view: true, edit: true, manage: false },
    {
      items: [latest],
      boardRevision: 5,
      pagination: { limit: 25, offset: 0, count: 1, total: 1, hasMore: false },
    },
    latest,
    true,
    "UTC",
  );
  expect(refreshed.conflict).toBe(true);
  expect(refreshed.scheduleLocal).toBe("2035-06-02T12:30");
  expect(refreshed.selected?.postRevision).toBe(2);
  expect(refreshed.boardRevision).toBe(2);
});

test("canceling a scheduled draft sends unchanged text and omits links", () => {
  const scheduled: BoardPost = {
    ...draft,
    title: "Scheduled title",
    body: "Scheduled body",
    status: "scheduled",
    publishAt: "2035-06-01T12:30:00Z",
    postRevision: 2,
    links: [{ label: "Guide", url: "https://example.test/guide" }],
  };
  expect(postCancellationPatch(scheduled, 6)).toEqual({
    boardRevision: 6,
    postRevision: 2,
    title: scheduled.title,
    body: scheduled.body,
  });
});

test("refresh verifies a conflicting draft without silently replacing its retained text or revision", () => {
  const conflicted = editorFailure(
    ready,
    new ApiError(409, "Post changed; reload before saving"),
  );
  const latest = { ...draft, postRevision: 3, boardRevision: 5 };
  const refreshed = resolveEditorRefresh(
    conflicted,
    { level: "write" as const, view: true, edit: true, manage: false },
    {
      items: [latest],
      boardRevision: 5,
      pagination: { limit: 25, offset: 0, count: 1, total: 1, hasMore: false },
    },
    latest,
    true,
    "UTC",
  );
  expect(refreshed.form).toEqual(ready.form);
  expect(refreshed.selected?.postRevision).toBe(1);
  expect(refreshed.boardRevision).toBe(2);
  expect(refreshed.page?.items[0]?.postRevision).toBe(3);
  expect(refreshed.conflict).toBe(true);
});

test("dirty refresh detects a concurrent post edit and keeps old revision tokens", () => {
  const dirtyDraft = { ...ready, pending: false };
  const latest = {
    ...draft,
    title: "Concurrent server title",
    postRevision: 3,
    boardRevision: 5,
  };
  const refreshed = resolveEditorRefresh(
    dirtyDraft,
    { level: "write" as const, view: true, edit: true, manage: false },
    {
      items: [latest],
      boardRevision: 5,
      pagination: { limit: 25, offset: 0, count: 1, total: 1, hasMore: false },
    },
    latest,
    true,
    "UTC",
  );
  expect(refreshed.form).toEqual(dirtyDraft.form);
  expect(refreshed.selected?.postRevision).toBe(1);
  expect(refreshed.boardRevision).toBe(2);
  expect(refreshed.conflict).toBe(true);
  expect(refreshed.page?.items[0]?.title).toBe("Concurrent server title");
});

test("clean refresh adopts the concurrent post edit and its revisions", () => {
  const clean = {
    ...ready,
    pending: false,
    form: {
      pinned: false,
      expiresLocal: "",
      title: draft.title,
      body: draft.body,
      links: [],
    },
  };
  const latest = {
    ...draft,
    title: "Concurrent server title",
    postRevision: 3,
    boardRevision: 5,
  };
  const refreshed = resolveEditorRefresh(
    clean,
    { level: "write" as const, view: true, edit: true, manage: false },
    {
      items: [latest],
      boardRevision: 5,
      pagination: { limit: 25, offset: 0, count: 1, total: 1, hasMore: false },
    },
    latest,
    true,
    "UTC",
  );
  expect(refreshed.form?.title).toBe("Concurrent server title");
  expect(refreshed.selected?.postRevision).toBe(3);
  expect(refreshed.boardRevision).toBe(5);
  expect(refreshed.conflict).toBe(false);
});

test("unrelated Board revision refresh retains local draft text without false post conflict", () => {
  const latest = { ...draft, boardRevision: 5 };
  const refreshed = resolveEditorRefresh(
    { ...ready, pending: false },
    { level: "write" as const, view: true, edit: true, manage: false },
    {
      items: [latest],
      boardRevision: 5,
      pagination: { limit: 25, offset: 0, count: 1, total: 1, hasMore: false },
    },
    latest,
    true,
    "UTC",
  );
  expect(refreshed.form).toEqual(ready.form);
  expect(refreshed.selected?.postRevision).toBe(1);
  expect(refreshed.boardRevision).toBe(5);
  expect(refreshed.conflict).toBe(false);
});

test("a new post counts as changed only once it has content", () => {
  const blank = {
    title: "",
    body: "",
    links: [],
    pinned: false,
    expiresLocal: "",
  };
  expect(dirty(blank, null, "UTC")).toBe(false);
  expect(dirty({ ...blank, title: "  ", body: "\n" }, null, "UTC")).toBe(false);
  // Each of these is content the person would lose on close.
  for (const changed of [
    { ...blank, title: "Dock 3 closes" },
    { ...blank, body: "Use Dock 4." },
    { ...blank, links: [{ label: "", url: "" }] },
    { ...blank, pinned: true },
    { ...blank, expiresLocal: "2035-06-01T12:30" },
  ])
    expect(dirty(changed, null, "UTC")).toBe(true);
});
