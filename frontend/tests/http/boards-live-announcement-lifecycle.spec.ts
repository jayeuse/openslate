import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BoardAnnouncement } from "../../src/components/systems/boards/adapters/board-announcements-api";
import {
  ServerBoardAnnouncementLifecycleDisplay,
  prepareBoardAnnouncementLifecycleAction,
  type AnnouncementLifecycleView,
} from "../../src/components/systems/boards/components/server-backed-board-announcement-lifecycle";

const boardId = "00000000-0000-4000-8000-000000000001";
const announcementId = "00000000-0000-4000-8000-000000000002";
const now = "2026-09-24T00:00:00Z";
const item: BoardAnnouncement = {
  id: announcementId,
  boardId,
  authorId: "00000000-0000-4000-8000-000000000003",
  title: "Private policy notice",
  body: "Private announcement body",
  links: [],
  audience: {
    kind: "everyone",
    roleId: null,
    userId: null,
    departmentId: null,
  },
  status: "published",
  publishAt: now,
  expiresAt: null,
  pinned: false,
  announcementRevision: null,
  boardRevision: 7,
  publicationNumber: 1,
  publishedAt: now,
  createdAt: now,
  updatedAt: now,
};
const page = {
  items: [item],
  boardRevision: 7,
  pagination: { limit: 25, offset: 0, count: 1, total: 1, hasMore: false },
};
const ready: AnnouncementLifecycleView = {
  status: "ready",
  active: true,
  canManage: true,
  view: "published",
  page,
  pending: false,
  conflict: false,
  error: null,
  notice: null,
  confirmation: null,
};

function markup(view: AnnouncementLifecycleView): string {
  return renderToStaticMarkup(
    createElement(ServerBoardAnnouncementLifecycleDisplay, {
      view,
      onSelectView: () => undefined,
      onRetry: () => undefined,
      onPage: () => undefined,
      onBeginAction: () => undefined,
    }),
  );
}

test("published manager list offers archive but no permanent deletion or revision guess", () => {
  const html = markup(ready);
  expect(html).toContain("Private policy notice");
  expect(html).toContain("Archive announcement");
  expect(html).not.toContain("Delete permanently");
  expect(html).not.toContain("Private announcement body");
  expect(
    prepareBoardAnnouncementLifecycleAction(
      item,
      {
        id: announcementId,
        status: "published",
        boardRevision: 7,
        announcementRevision: 3,
      },
      "archive",
    ),
  ).toMatchObject({ boardRevision: 7, announcementRevision: 3 });
  expect(
    prepareBoardAnnouncementLifecycleAction(
      item,
      {
        id: announcementId,
        status: "published",
        boardRevision: 8,
        announcementRevision: 4,
      },
      "archive",
    ),
  ).toBeNull();
  expect(
    prepareBoardAnnouncementLifecycleAction(
      item,
      {
        id: announcementId,
        status: "draft",
        boardRevision: 7,
        announcementRevision: 4,
      },
      "archive",
    ),
  ).toMatchObject({ kind: "archive", announcementRevision: 4 });
  for (const status of ["draft", "scheduled"] as const) {
    const working: BoardAnnouncement = {
      ...item,
      status,
      announcementRevision: 3,
      publicationNumber: null,
      publishedAt: null,
      publishAt: status === "scheduled" ? now : null,
    };
    expect(
      prepareBoardAnnouncementLifecycleAction(
        working,
        {
          id: announcementId,
          status,
          boardRevision: 7,
          announcementRevision: 3,
        },
        "archive",
      ),
    ).toMatchObject({ kind: "archive", announcementRevision: 3 });
  }
});

test("archive view offers restore and confirmed delete; denial and conflict hide unsafe actions", () => {
  const archived: BoardAnnouncement = {
    ...item,
    status: "archived",
    announcementRevision: 4,
    publicationNumber: null,
    publishedAt: null,
  };
  const archivedView: AnnouncementLifecycleView = {
    ...ready,
    view: "archive",
    page: { ...page, items: [archived] },
  };
  const html = markup(archivedView);
  expect(html).toContain("Restore announcement");
  expect(html).toContain("Delete permanently");
  expect(
    prepareBoardAnnouncementLifecycleAction(
      archived,
      {
        id: announcementId,
        status: "archived",
        boardRevision: 7,
        announcementRevision: 4,
      },
      "delete",
    ),
  ).not.toBeNull();
  expect(
    prepareBoardAnnouncementLifecycleAction(
      archived,
      {
        id: announcementId,
        status: "archived",
        boardRevision: 7,
        announcementRevision: 4,
      },
      "restore",
    ),
  ).toMatchObject({ kind: "restore", announcementRevision: 4 });
  expect(
    prepareBoardAnnouncementLifecycleAction(
      item,
      {
        id: announcementId,
        status: "published",
        boardRevision: 7,
        announcementRevision: 3,
      },
      "delete",
    ),
  ).toBeNull();
  for (const view of [
    { ...archivedView, status: "denied" as const },
    { ...archivedView, active: false },
    { ...archivedView, canManage: false },
  ]) {
    const hidden = markup(view);
    expect(hidden).not.toContain("Private policy notice");
    expect(hidden).not.toContain("Delete permanently");
  }
  const conflicted = markup({ ...archivedView, conflict: true });
  expect(conflicted).toContain("changed elsewhere");
  expect(conflicted).not.toContain("Delete permanently");
});

test("initial loading and retriable read failure show status without private announcement content", () => {
  const loading = markup({
    ...ready,
    status: "loading",
    canManage: false,
    page: null,
  });
  expect(loading).toContain("Loading announcements");
  expect(loading).not.toContain("Private policy notice");

  const failed = markup({
    ...ready,
    status: "error",
    canManage: false,
    page: null,
    error: "Announcements are unavailable. Try again.",
  });
  expect(failed).toContain("Announcements are unavailable. Try again.");
  expect(failed).toContain("Retry");
  expect(failed).not.toContain("Private policy notice");
});
