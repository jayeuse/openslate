import { expect, test } from "@playwright/test";
import type { BoardPost } from "../../../src/components/systems/boards/adapters/board-posts-api";
import type { BoardPostManageState } from "../../../src/components/systems/boards/adapters/board-post-manage-state-api";
import {
  chooseBoardCandidate,
  resolveBoardSection,
} from "../../../src/components/systems/boards/hooks/use-server-boards";
import {
  prepareBoardPostLifecycleAction,
  resolveDeleteKind,
} from "../../../src/components/systems/boards/hooks/use-server-board-post-lifecycle";

const companyId = "00000000-0000-4000-8000-000000000001";
const departmentBoardId = "00000000-0000-4000-8000-000000000002";
const projectId = "00000000-0000-4000-8000-000000000003";
const postId = "00000000-0000-4000-8000-000000000004";
const authorId = "00000000-0000-4000-8000-000000000005";
const now = "2026-09-24T00:00:00Z";

test("without a Board in the address the company Board opens first", () => {
  const boards = [
    { id: projectId, scope: "project" as const, status: "active" as const },
    {
      id: departmentBoardId,
      scope: "department" as const,
      status: "active" as const,
    },
    { id: companyId, scope: "company" as const, status: "active" as const },
  ];
  expect(chooseBoardCandidate({ kind: "none", section: null }, boards)).toEqual(
    { id: companyId, source: "list" },
  );
  expect(
    chooseBoardCandidate({ kind: "none", section: null }, boards.slice(0, 2)),
  ).toEqual({ id: projectId, source: "list" });
  expect(
    chooseBoardCandidate(
      { kind: "board", boardId: projectId, section: "posts" },
      boards,
    ),
  ).toEqual({ id: projectId, source: "explicit" });
  expect(
    chooseBoardCandidate({ kind: "none", section: null }, [
      { id: projectId, scope: "project", status: "archived" },
    ]),
  ).toBeNull();
  expect(resolveBoardSection({ kind: "none", section: null })).toBe("overview");
});

function post(status: BoardPost["status"]): BoardPost {
  return {
    id: postId,
    boardId: projectId,
    authorId,
    title: "Shift change",
    body: "New times",
    links: [],
    status,
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
}

function manageState(
  status: BoardPostManageState["status"],
  publishedBefore: boolean,
): BoardPostManageState {
  return {
    id: postId,
    status,
    boardRevision: 5,
    postRevision: 2,
    publishedBefore,
  };
}

test("delete removes only a post that was never published", () => {
  expect(resolveDeleteKind("delete", manageState("draft", false))).toBe(
    "delete",
  );
  expect(resolveDeleteKind("delete", manageState("draft", true))).toBe(
    "archive",
  );
  expect(resolveDeleteKind("delete", manageState("archived", true))).toBeNull();
  expect(resolveDeleteKind("archive", manageState("published", true))).toBe(
    "archive",
  );
  expect(
    prepareBoardPostLifecycleAction(
      post("draft"),
      manageState("draft", false),
      "delete",
    ),
  ).toMatchObject({ kind: "delete", postId, boardRevision: 5 });
  expect(
    prepareBoardPostLifecycleAction(
      post("draft"),
      manageState("draft", true),
      "delete",
    ),
  ).toBeNull();
  expect(
    prepareBoardPostLifecycleAction(
      post("archived"),
      manageState("archived", false),
      "delete",
    ),
  ).toMatchObject({ kind: "delete" });
});
