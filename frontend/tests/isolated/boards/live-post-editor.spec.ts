import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BoardPost } from "../../../src/components/systems/boards/adapters/board-posts-api";
import {
  ServerBoardPostEditorDisplay,
  publishBlockedReason,
  type PostEditorView,
} from "../../../src/components/systems/boards/components/server-backed-board-post-editor";

const boardId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";
const now = "2026-09-24T00:00:00Z";
const draft: BoardPost = {
  id: "00000000-0000-4000-8000-000000000003",
  boardId,
  authorId: actorId,
  title: "Private change",
  body: "Keep this draft private.",
  links: [],
  status: "draft",
  publishAt: null,
  expiresAt: null,
  pinned: false,
  postRevision: 2,
  boardRevision: 5,
  publicationNumber: null,
  publishedAt: null,
  edited: false,
  createdAt: now,
  updatedAt: now,
};
const baseView: PostEditorView = {
  status: "ready",
  active: true,
  canStart: true,
  canEdit: true,
  regionFailed: false,
  canManage: false,
  selected: draft,
  form: {
    pinned: false,
    expiresLocal: "",
    title: draft.title,
    body: draft.body,
    links: [],
  },
  dirty: false,
  scheduleDirty: false,
  scheduleLocal: "2035-06-01T12:30",
  region: { timezone: "Asia/Manila", locale: "en-US" },
  scheduleError: null,
  expiryError: null,
  conflict: false,
  pending: false,
  error: null,
  notice: null,
};

function markup(view: PostEditorView, scheduleOpen = false): string {
  return renderToStaticMarkup(
    createElement(ServerBoardPostEditorDisplay, {
      boardId,
      view,
      audience: "Everyone who reads Sales sees this post.",
      scheduleOpen,
      onToggleSchedule: () => undefined,
      onChange: () => undefined,
      onSave: () => undefined,
      onPublish: () => undefined,
      onSchedule: () => undefined,
      onCancelSchedule: () => undefined,
      onScheduleTimeChange: () => undefined,
      onRetry: () => undefined,
      onAttachmentBusyChange: () => undefined,
      onRecordLinkBusyChange: () => undefined,
      refreshAttachmentVersions: async () => ({
        boardRevision: 5,
        contentRevision: 2,
      }),
    }),
  );
}

test("the editor's footer holds Publish, Schedule and Save draft beside one consequence line", () => {
  const html = markup(baseView);
  expect(html).toContain(">Publish<");
  expect(html).toContain("Schedule…");
  expect(html).toContain("Save draft");
  expect(html).toContain("Everyone who reads Sales sees this post.");
  expect(html).toContain("Draft saved");
  expect(html).toContain("Private change");
  expect(html).not.toContain("audience");
  expect(html).not.toContain("Publish now");
});

test("the editor carries no rule sentences", () => {
  const html = markup({ ...baseView, selected: null }, true);
  for (const sentence of [
    "sent to the server in UTC",
    "Save this draft before",
    "Up to 20 HTTP or HTTPS links",
    "Save your changes as a draft",
    "Save changes before publishing",
    "Saving this draft cancels",
  ])
    expect(html).not.toContain(sentence);
});

test("a post that is not saved as a draft offers to save before files and record links", () => {
  const unsaved = markup({ ...baseView, selected: null, dirty: true });
  expect(unsaved).toContain("Save draft to attach");
  expect(unsaved).toContain("Save draft to link");
  const published = markup({
    ...baseView,
    selected: { ...draft, status: "published", publishAt: now },
  });
  expect(published).toContain("Save draft to attach");
});

test("Schedule… opens a local date and time with the zone beside it", () => {
  expect(markup(baseView)).not.toContain(
    'type="datetime-local" step="1" value="2035',
  );
  const html = markup(baseView, true);
  expect(html).toContain("Publish at");
  expect(html).toContain('value="2035-06-01T12:30"');
  expect(html).toContain("Asia/Manila");
  expect(html).toContain(">Schedule<");
});

test("a scheduled post shows when it publishes, with Reschedule and Cancel schedule", () => {
  const scheduled: BoardPost = {
    ...draft,
    status: "scheduled",
    publishAt: "2035-06-01T04:30:00Z",
    postRevision: 3,
  };
  // The time is the workspace zone's, like the Publish at field and the
  // post list, whatever zone the machine is in.
  const html = markup(
    {
      ...baseView,
      selected: scheduled,
      region: { timezone: "America/New_York", locale: "en-US" },
    },
    true,
  );
  expect(html).toContain("Publishes Fri, Jun 1, 12:30 AM");
  expect(html).toContain("Reschedule");
  expect(html).toContain("Cancel schedule");
});

test("schedule validation is linked to its field", () => {
  const html = markup(
    { ...baseView, scheduleError: "Choose a publication time in the future." },
    true,
  );
  expect(html).toContain("Choose a publication time in the future.");
  expect(html).toContain(
    'aria-describedby="board-post-schedule-zone board-post-schedule-error"',
  );
});

test("denial and an archived Board render no private draft or action", () => {
  for (const view of [
    { ...baseView, status: "denied" as const, canEdit: false },
    { ...baseView, active: false },
  ]) {
    const html = markup(view);
    expect(html).not.toContain("Private change");
    expect(html).not.toContain("Keep this draft private.");
    expect(html).not.toContain(">Publish<");
    expect(html).not.toContain("Schedule…");
  }
});

test("a first load and a retriable failure show status without drafts", () => {
  const loading = markup({
    ...baseView,
    status: "loading",
    canEdit: false,
    form: null,
  });
  expect(loading).toContain("Opening the post");
  expect(loading).not.toContain("Private change");
  const failed = markup({
    ...baseView,
    status: "error",
    canEdit: false,
    form: null,
    error: "Draft posts are unavailable.",
  });
  expect(failed).toContain("Draft posts are unavailable.");
  expect(failed).toContain("Retry");
  expect(failed).not.toContain("Private change");
});

test("a revision conflict keeps the text and blocks an unreviewed overwrite", () => {
  const view = {
    ...baseView,
    dirty: true,
    conflict: true,
    form: { ...baseView.form!, title: "My competing edit" },
  };
  const html = markup(view);
  expect(html).toContain("My competing edit");
  expect(html).toContain("Someone changed this post first.");
  // Save draft waits, and says why (DisabledReason).
  expect(html).toMatch(/aria-disabled="true"[^>]*>Save draft</);
  expect(html).toContain("Review the latest version first.");
  expect(publishBlockedReason(view)).toBe("Review the latest version first.");
});

test("Publish says why it cannot act yet", () => {
  for (const [form, expected] of [
    [{ title: "", body: "Text" }, "Add a title and a message."],
    [{ title: "Title", body: "   " }, "Add a title and a message."],
    [
      { title: "x".repeat(101), body: "Text" },
      "Shorten the title or the message.",
    ],
    [{ title: "Title", body: "Text" }, null],
  ] as const)
    expect(
      publishBlockedReason({
        ...baseView,
        form: { ...baseView.form!, ...form },
      }),
    ).toBe(expected);
  expect(
    publishBlockedReason({
      ...baseView,
      form: { ...baseView.form!, links: [{ label: "", url: "ftp://x" }] },
    }),
  ).toBe("Fix the link labels and URLs.");
});

test("links are edited as label and URL pairs", () => {
  const linked = [{ label: "Guide", url: "https://example.test/guide" }];
  const html = markup({
    ...baseView,
    selected: { ...draft, links: linked },
    form: { ...baseView.form!, links: linked },
  });
  expect(html).toContain("Add link");
  expect(html).toContain('aria-label="Remove link 1"');
  expect(html).toContain("Link 1 label");
  expect(html).toContain("Link 1 URL");
  expect(html).toContain("https://example.test/guide");
});

test("only a board manager can pin; a writer sees why", () => {
  expect(markup(baseView)).toContain("Only board managers pin posts.");
  expect(markup({ ...baseView, canManage: true })).not.toContain(
    "Only board managers pin posts.",
  );
});
