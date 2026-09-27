import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BoardAnnouncement } from "../../src/components/systems/boards/adapters/board-announcements-api";
import {
  ServerBoardAnnouncementEditorDisplay,
  type AnnouncementEditorView,
} from "../../src/components/systems/boards/components/server-backed-board-announcement-editor";

const boardId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";
const now = "2026-09-24T00:00:00Z";
const draft: BoardAnnouncement = {
  id: "00000000-0000-4000-8000-000000000003",
  boardId,
  authorId: actorId,
  title: "Private change",
  body: "Keep this draft private.",
  links: [],
  audience: {
    kind: "department",
    userId: null,
    departmentId: "00000000-0000-4000-8000-000000000004",
  },
  status: "draft",
  publishAt: null,
  expiresAt: null,
  pinned: false,
  announcementRevision: 2,
  boardRevision: 5,
  publicationNumber: null,
  publishedAt: null,
  createdAt: now,
  updatedAt: now,
};
const baseView: AnnouncementEditorView = {
  status: "ready",
  active: true,
  canEdit: true,
  canManage: false,
  drafts: [draft],
  offset: 0,
  total: 1,
  hasMore: false,
  selected: draft,
  form: {
    title: draft.title,
    body: draft.body,
    links: [],
    audience: { kind: "department", targetId: draft.audience.departmentId },
  },
  dirty: false,
  scheduleDirty: false,
  scheduleLocal: "2035-06-01T12:30",
  deviceTimeZone: "Asia/Manila",
  scheduleError: null,
  conflict: false,
  pending: false,
  error: null,
  notice: null,
  displayed: null,
};

function markup(view: AnnouncementEditorView): string {
  return renderToStaticMarkup(
    createElement(ServerBoardAnnouncementEditorDisplay, {
      boardId,
      view,
      onNew: () => undefined,
      onSelect: () => undefined,
      onChange: () => undefined,
      onSave: () => undefined,
      onPublish: () => undefined,
      onSchedule: () => undefined,
      onCancelSchedule: () => undefined,
      onScheduleTimeChange: () => undefined,
      onRetry: () => undefined,
      onClose: () => undefined,
      onPage: () => undefined,
      onAttachmentBusyChange: () => undefined,
      onRecordLinkBusyChange: () => undefined,
      refreshAttachmentVersions: async () => ({
        boardRevision: 5,
        contentRevision: 2,
      }),
    }),
  );
}

test("editable draft shows save, publish, and a pending audience control", () => {
  const html = markup(baseView);
  expect(html).toContain("New announcement");
  expect(html).toContain("Save draft");
  expect(html).toContain("Publish now");
  expect(html).toContain("Loading audience choices");
  expect(html).toContain("Private change");
});

test("author can choose and edit a published announcement from the authoring list", () => {
  const ownPublished: BoardAnnouncement = {
    ...draft,
    status: "published",
    publishAt: now,
  };
  const html = markup({
    ...baseView,
    drafts: [ownPublished],
    selected: ownPublished,
    dirty: true,
  });
  expect(html).toContain("Private change");
  expect(html).toContain("Published");
  expect(html).toContain("Edit announcement");
  expect(html).toContain("Save draft");
  expect(html).toContain(
    "Save your changes as a draft before managing attachments and Record links.",
  );
});

test("saved drafts offer device-local scheduling with an explicit UTC conversion", () => {
  const html = markup(baseView);
  expect(html).toContain("Publication date and time");
  expect(html).toContain('type="datetime-local"');
  expect(html).toContain("Asia/Manila");
  expect(html).toContain("sent to the server in UTC");
  expect(html).toContain("Schedule publication");
  expect(html).not.toContain("notification sent");
});

test("scheduled drafts offer revision-safe rescheduling and cancellation", () => {
  const scheduled: BoardAnnouncement = {
    ...draft,
    status: "scheduled",
    publishAt: "2035-06-01T04:30:00Z",
    announcementRevision: 3,
  };
  const html = markup({
    ...baseView,
    drafts: [scheduled],
    selected: scheduled,
    form: {
      title: scheduled.title,
      body: scheduled.body,
      links: [],
      audience: { kind: "department", targetId: draft.audience.departmentId },
    },
    scheduleLocal: "2035-06-01T12:30",
  });
  expect(html).toContain("Reschedule publication");
  expect(html).toContain("Cancel scheduled publication");
  expect(html).toContain("Saving this draft cancels its scheduled publication");
  expect(html).not.toContain("notification sent");
});

test("unsaved content or a revision conflict blocks schedule mutations", () => {
  const dirty = markup({ ...baseView, dirty: true });
  expect(dirty).toMatch(/disabled=""[^>]*>Schedule publication/);

  const conflict = markup({ ...baseView, conflict: true });
  expect(conflict).toMatch(/disabled=""[^>]*>Schedule publication/);
});

test("schedule validation explains invalid local clock times accessibly", () => {
  const html = markup({
    ...baseView,
    scheduleError:
      "This local time does not exist because of a clock change. Choose another time.",
  });
  expect(html).toContain(
    "This local time does not exist because of a clock change",
  );
  expect(html).toContain(
    'aria-describedby="board-announcement-schedule-help board-announcement-schedule-error"',
  );
});

test("denial and archived Board render no private draft or action", () => {
  for (const view of [
    { ...baseView, status: "denied" as const, canEdit: false },
    { ...baseView, active: false },
  ]) {
    const html = markup(view);
    expect(html).not.toContain("Private change");
    expect(html).not.toContain("Keep this draft private.");
    expect(html).not.toContain("Publish now");
    expect(html).not.toContain("Schedule publication");
    expect(html).not.toContain("Cancel scheduled publication");
  }
});

test("initial load and retriable failure explain status without exposing drafts", () => {
  const loading = markup({
    ...baseView,
    status: "loading",
    canEdit: false,
  });
  expect(loading).toContain("Loading editable announcements");
  expect(loading).not.toContain("Private change");

  const failed = markup({
    ...baseView,
    status: "error",
    canEdit: false,
    error: "Draft announcements are unavailable.",
  });
  expect(failed).toContain("Draft announcements are unavailable.");
  expect(failed).toContain("Retry");
  expect(failed).not.toContain("Private change");
});

test("unsaved text cannot be displaced by switching drafts without an explicit discard", () => {
  const html = markup({
    ...baseView,
    dirty: true,
    form: {
      title: "Unsaved change",
      body: draft.body,
      links: [],
      audience: { kind: "department", targetId: draft.audience.departmentId },
    },
  });
  expect(html).toContain("Unsaved change");
  expect(html).toContain("Refresh announcements");
  expect(html).toContain("Discard changes");
  expect(html).toContain(
    "Save changes before publishing or choosing another draft.",
  );
  expect(html).toMatch(/disabled=""[^>]*>New announcement/);
  expect(html).toMatch(/disabled=""[^>]*>Publish now/);
});

test("revision conflict keeps text visible but blocks an unreviewed overwrite", () => {
  const html = markup({
    ...baseView,
    dirty: true,
    conflict: true,
    form: {
      title: "My competing edit",
      body: draft.body,
      links: [],
      audience: { kind: "department", targetId: draft.audience.departmentId },
    },
  });
  expect(html).toContain("My competing edit");
  expect(html).toContain("This draft changed elsewhere");
  expect(html).toContain("Discard changes");
  expect(html).toMatch(/disabled=""[^>]*>Save draft/);
});

test("published confirmation renders only immutable displayed content", () => {
  const published: BoardAnnouncement = {
    ...draft,
    title: "Published revision",
    body: "Immutable display text.",
    audience: {
      kind: "everyone",
      userId: null,
      departmentId: null,
    },
    status: "published",
    publishAt: now,
    announcementRevision: null,
    publicationNumber: 1,
    publishedAt: now,
  };
  const html = markup({
    ...baseView,
    drafts: [],
    selected: null,
    form: null,
    displayed: published,
    notice: "Published successfully.",
  });
  expect(html).toContain("Published revision");
  expect(html).toContain("Immutable display text.");
  expect(html).not.toContain("Keep this draft private.");

  const excluded = markup({
    ...baseView,
    drafts: [],
    selected: null,
    form: null,
    displayed: null,
    notice:
      "Published, but the displayed revision is unavailable to your account.",
  });
  expect(excluded).toContain("unavailable to your account");
  expect(excluded).not.toContain("Keep this draft private.");
});

test("draft editor exposes bounded external-link editing and published links without changing audience", () => {
  const linked = [{ label: "Guide", url: "https://example.test/guide" }];
  const draftHtml = markup({
    ...baseView,
    selected: { ...draft, links: linked },
    form: {
      title: draft.title,
      body: draft.body,
      audience: { kind: "department", targetId: draft.audience.departmentId },
      links: linked,
    },
  });
  expect(draftHtml).toContain("Add link");
  expect(draftHtml).toContain("Remove link 1");
  expect(draftHtml).toContain("External link 1 label");
  expect(draftHtml).toContain("External link 1 URL");
  expect(draftHtml).toContain("https://example.test/guide");
  expect(draftHtml).toContain("Loading audience choices");
  expect(draftHtml).not.toContain("link editing is unavailable");

  const publishedHtml = markup({
    ...baseView,
    drafts: [],
    selected: null,
    form: null,
    displayed: {
      ...draft,
      links: linked,
      status: "published",
      publishAt: now,
      announcementRevision: null,
      publicationNumber: 1,
      publishedAt: now,
    },
  });
  expect(publishedHtml).toContain("https://example.test/guide");
  expect(publishedHtml).toContain("Guide");
});
