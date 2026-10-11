import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BoardPost } from "../../../src/components/systems/boards/adapters/board-posts-api";
import {
  ServerBoardPostLifecycleDisplay,
  prepareBoardPostLifecycleAction,
  type PostLifecycleView,
} from "../../../src/components/systems/boards/components/server-backed-board-post-lifecycle";

const boardId = "00000000-0000-4000-8000-000000000001";
const postId = "00000000-0000-4000-8000-000000000002";
const now = "2026-09-24T00:00:00Z";
const item: BoardPost = {
  id: postId,
  boardId,
  authorId: "00000000-0000-4000-8000-000000000003",
  title: "Private policy notice",
  body: "Private post body",
  links: [],
  status: "published",
  publishAt: now,
  expiresAt: null,
  pinned: false,
  postRevision: null,
  boardRevision: 7,
  publicationNumber: 1,
  publishedAt: now,
  edited: false,
  createdAt: now,
  updatedAt: now,
};
const page = {
  items: [item],
  boardRevision: 7,
  pagination: { limit: 25, offset: 0, count: 1, total: 1, hasMore: false },
};
const ready: PostLifecycleView = {
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

function markup(view: PostLifecycleView): string {
  return renderToStaticMarkup(
    createElement(ServerBoardPostLifecycleDisplay, {
      view,
      onSelectView: () => undefined,
      onRetry: () => undefined,
      onPage: () => undefined,
      onBeginAction: () => undefined,
    }),
  );
}

test("published manager list offers archive but no deletion or revision guess", () => {
  const html = markup(ready);
  expect(html).toContain("Private policy notice");
  expect(html).toContain("Archive post");
  expect(html).not.toContain(">Delete<");
  expect(html).not.toContain("Private post body");
  expect(
    prepareBoardPostLifecycleAction(
      item,
      {
        id: postId,
        status: "published",
        boardRevision: 7,
        postRevision: 3,
        publishedBefore: true,
      },
      "archive",
    ),
  ).toMatchObject({ boardRevision: 7, postRevision: 3 });
  expect(
    prepareBoardPostLifecycleAction(
      item,
      {
        id: postId,
        status: "published",
        boardRevision: 8,
        postRevision: 4,
        publishedBefore: true,
      },
      "archive",
    ),
  ).toBeNull();
  expect(
    prepareBoardPostLifecycleAction(
      item,
      {
        id: postId,
        status: "draft",
        boardRevision: 7,
        postRevision: 4,
        publishedBefore: false,
      },
      "archive",
    ),
  ).toMatchObject({ kind: "archive", postRevision: 4 });
  for (const status of ["draft", "scheduled"] as const) {
    const working: BoardPost = {
      ...item,
      status,
      postRevision: 3,
      publicationNumber: null,
      publishedAt: null,
      publishAt: status === "scheduled" ? now : null,
    };
    expect(
      prepareBoardPostLifecycleAction(
        working,
        {
          id: postId,
          status,
          boardRevision: 7,
          postRevision: 3,
          publishedBefore: false,
        },
        "archive",
      ),
    ).toMatchObject({ kind: "archive", postRevision: 3 });
  }
});

test("archive view offers restore and delete of a never-published post; denial and conflict hide unsafe actions", () => {
  const archived: BoardPost = {
    ...item,
    status: "archived",
    postRevision: 4,
    publicationNumber: null,
    publishedAt: null,
  };
  const archivedView: PostLifecycleView = {
    ...ready,
    view: "archive",
    page: { ...page, items: [archived] },
  };
  const html = markup(archivedView);
  expect(html).toContain("Restore post");
  expect(html).toContain(">Delete<");
  expect(
    prepareBoardPostLifecycleAction(
      archived,
      {
        id: postId,
        status: "archived",
        boardRevision: 7,
        postRevision: 4,
        publishedBefore: false,
      },
      "restore",
    ),
  ).toMatchObject({ kind: "restore", postRevision: 4 });
  for (const view of [
    { ...archivedView, status: "denied" as const },
    { ...archivedView, active: false },
    { ...archivedView, canManage: false },
  ]) {
    const hidden = markup(view);
    expect(hidden).not.toContain("Private policy notice");
    expect(hidden).not.toContain(">Delete<");
  }
  const conflicted = markup({ ...archivedView, conflict: true });
  expect(conflicted).toContain("changed elsewhere");
  expect(conflicted).not.toContain(">Delete<");
});

test("initial loading and retriable read failure show status without private post content", () => {
  const loading = markup({
    ...ready,
    status: "loading",
    canManage: false,
    page: null,
  });
  expect(loading).toContain("Loading posts");
  expect(loading).not.toContain("Private policy notice");

  const failed = markup({
    ...ready,
    status: "error",
    canManage: false,
    page: null,
    error: "Posts are unavailable. Try again.",
  });
  expect(failed).toContain("Posts are unavailable. Try again.");
  expect(failed).toContain("Retry");
  expect(failed).not.toContain("Private policy notice");
});
