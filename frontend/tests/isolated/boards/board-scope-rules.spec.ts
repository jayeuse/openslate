import { expect, test } from "@playwright/test";
import type { BoardPost } from "../../../src/components/systems/boards/adapters/board-posts-api";
import type { BoardPostManageState } from "../../../src/components/systems/boards/adapters/board-post-manage-state-api";
import {
  chooseBoardCandidate,
  parseBoardRoute,
  resolveBoardSection,
} from "../../../src/components/systems/boards/hooks/use-server-boards";
import {
  parseCalendarShow,
  parseCalendarView,
} from "../../../src/components/systems/boards/domain/calendar-dates";
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

// IDs of the Board list that the address-less selection rows read.
const listProjectId = "00000000-0000-4000-8000-000000000001";
const listCompanyId = "00000000-0000-4000-8000-000000000002";
const listArchivedCompanyId = "00000000-0000-4000-8000-000000000003";
const scopedBoards = [
  { id: projectId, scope: "project" as const, status: "active" as const },
  {
    id: departmentBoardId,
    scope: "department" as const,
    status: "active" as const,
  },
  { id: companyId, scope: "company" as const, status: "active" as const },
];
const listBoards = [
  {
    id: listArchivedCompanyId,
    scope: "company" as const,
    status: "archived" as const,
  },
  { id: listProjectId, scope: "project" as const, status: "active" as const },
  { id: listCompanyId, scope: "company" as const, status: "active" as const },
];

for (const row of [
  {
    name: "the company Board opens before project and department Boards",
    route: { kind: "none", section: null } as const,
    boards: scopedBoards,
    expected: { id: companyId, source: "list" },
  },
  {
    name: "without a company Board the first active Board opens",
    route: { kind: "none", section: null } as const,
    boards: scopedBoards.slice(0, 2),
    expected: { id: projectId, source: "list" },
  },
  {
    name: "the active company Board opens, not an archived company Board",
    route: parseBoardRoute("?section=posts"),
    boards: listBoards,
    expected: { id: listCompanyId, source: "list" },
  },
  {
    name: "an archived company Board is skipped for the first active Board",
    route: parseBoardRoute("?section=posts"),
    boards: listBoards.slice(0, 2),
    expected: { id: listProjectId, source: "list" },
  },
  {
    name: "a Board in the address opens even when a company Board exists",
    route: { kind: "board", boardId: projectId, section: "posts" } as const,
    boards: scopedBoards,
    expected: { id: projectId, source: "explicit" },
  },
  {
    name: "no active Board opens nothing",
    route: { kind: "none", section: null } as const,
    boards: [
      { id: projectId, scope: "project" as const, status: "archived" as const },
    ],
    expected: null,
  },
]) {
  test(`Board selection: ${row.name}`, () => {
    expect(chooseBoardCandidate(row.route, row.boards)).toEqual(row.expected);
  });
}

for (const row of [
  {
    name: "a supported section in the address is kept",
    route: parseBoardRoute("?section=posts"),
    expected: "posts",
  },
  {
    name: "an unsupported section falls back to Posts",
    route: parseBoardRoute("?section=unsupported"),
    expected: "posts",
  },
  {
    name: "the retired Overview section opens Posts",
    route: parseBoardRoute("?section=overview"),
    expected: "posts",
  },
  {
    name: "no section opens Posts",
    route: { kind: "none", section: null } as const,
    expected: "posts",
  },
]) {
  test(`Board section: ${row.name}`, () => {
    expect(resolveBoardSection(row.route)).toBe(row.expected);
  });
}

for (const row of [
  {
    name: "Month in the address",
    view: "month",
    phone: true,
    expected: "month",
  },
  { name: "Week in the address", view: "week", phone: false, expected: "week" },
  {
    name: "Upcoming in the address",
    view: "upcoming",
    phone: false,
    expected: "upcoming",
  },
  {
    name: "no view opens Month on a desktop",
    view: null,
    phone: false,
    expected: "month",
  },
  {
    name: "no view opens the day list (Week) on a phone",
    view: null,
    phone: true,
    expected: "week",
  },
  {
    name: "the retired Agenda opens the default",
    view: "agenda",
    phone: false,
    expected: "month",
  },
] as const) {
  test(`Calendar view: ${row.name}`, () => {
    expect(parseCalendarView(row.view, row.phone)).toBe(row.expected);
  });
}

for (const row of [
  {
    name: "Created by me for a writer",
    show: "mine",
    allowed: { mine: true, archived: false },
    expected: "mine",
  },
  {
    name: "Created by me falls back for a reader",
    show: "mine",
    allowed: { mine: false, archived: false },
    expected: "all",
  },
  {
    name: "Archived for a manager",
    show: "archived",
    allowed: { mine: true, archived: true },
    expected: "archived",
  },
  {
    name: "Archived falls back without manage",
    show: "archived",
    allowed: { mine: true, archived: false },
    expected: "all",
  },
  {
    name: "a Posts state is not a calendar filter",
    show: "drafts",
    allowed: { mine: true, archived: true },
    expected: "all",
  },
] as const) {
  test(`Calendar show: ${row.name}`, () => {
    expect(parseCalendarShow(row.show, row.allowed)).toBe(row.expected);
  });
}

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
});

// The archive-view rows use the published Board post of the lifecycle list.
const lifecycleBoardId = "00000000-0000-4000-8000-000000000001";
const lifecyclePostId = "00000000-0000-4000-8000-000000000002";
const lifecyclePost: BoardPost = {
  id: lifecyclePostId,
  boardId: lifecycleBoardId,
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

for (const row of [
  {
    name: "a never-published draft is deleted at the current revisions",
    item: post("draft"),
    state: manageState("draft", false),
    expected: {
      kind: "delete",
      boardId: projectId,
      postId,
      title: "Shift change",
      boardRevision: 5,
      postRevision: 2,
    },
  },
  {
    name: "a never-published archived post is deleted",
    item: post("archived"),
    state: manageState("archived", false),
    expected: {
      kind: "delete",
      boardId: projectId,
      postId,
      title: "Shift change",
      boardRevision: 5,
      postRevision: 2,
    },
  },
  {
    name: "a never-published post in the archive view is deleted",
    item: {
      ...lifecyclePost,
      status: "archived" as const,
      postRevision: 4,
      publicationNumber: null,
      publishedAt: null,
    },
    state: {
      id: lifecyclePostId,
      status: "archived" as const,
      boardRevision: 7,
      postRevision: 4,
      publishedBefore: false,
    },
    expected: {
      kind: "delete",
      boardId: lifecycleBoardId,
      postId: lifecyclePostId,
      title: "Private policy notice",
      boardRevision: 7,
      postRevision: 4,
    },
  },
  {
    name: "a draft that was published before is not deleted",
    item: post("draft"),
    state: manageState("draft", true),
    expected: null,
  },
  {
    name: "a published post is not deleted",
    item: lifecyclePost,
    state: {
      id: lifecyclePostId,
      status: "published" as const,
      boardRevision: 7,
      postRevision: 3,
      publishedBefore: true,
    },
    expected: null,
  },
]) {
  test(`post delete: ${row.name}`, () => {
    expect(
      prepareBoardPostLifecycleAction(row.item, row.state, "delete"),
    ).toEqual(row.expected);
  });
}
