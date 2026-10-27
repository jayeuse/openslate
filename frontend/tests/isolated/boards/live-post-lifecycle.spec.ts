import { expect, test } from "@playwright/test";
import type { BoardPost } from "../../../src/components/systems/boards/adapters/board-posts-api";
import { prepareBoardPostLifecycleAction } from "../../../src/components/systems/boards/hooks/use-server-board-post-lifecycle";

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
test("archive uses the post's current revisions and never guesses a stale one", () => {
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

test("restore uses the archived post's current revisions", () => {
  const archived: BoardPost = {
    ...item,
    status: "archived",
    postRevision: 4,
    publicationNumber: null,
    publishedAt: null,
  };
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
});
