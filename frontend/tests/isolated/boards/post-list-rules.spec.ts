import { expect, test } from "@playwright/test";
import type { BoardPost } from "../../../src/components/systems/boards/adapters/board-posts-api";
import {
  canEditPost,
  parsePostShow,
  postAudienceLine,
  postListEmpty,
  postMenuActions,
  postRowMeta,
  postStatesFor,
  postViewForState,
  postingReason,
  readsPostManageState,
  type PostViewer,
} from "../../../src/components/systems/boards/domain/post-list";

const boardId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";
const otherId = "00000000-0000-4000-8000-000000000003";
const region = { timezone: "UTC", locale: "en-US" };
const now = Date.parse("2026-10-26T12:00:00Z");

const published: BoardPost = {
  id: "00000000-0000-4000-8000-000000000010",
  boardId,
  authorId: actorId,
  title: "Packaging price increase",
  body: "Supplier costs went up.",
  links: [],
  status: "published",
  publishAt: "2026-10-24T09:15:00Z",
  expiresAt: null,
  pinned: false,
  postRevision: null,
  boardRevision: 4,
  publicationNumber: 1,
  publishedAt: "2026-10-24T09:15:00Z",
  edited: false,
  createdAt: "2026-10-24T09:15:00Z",
  updatedAt: "2026-10-24T09:15:00Z",
};
const draft: BoardPost = {
  ...published,
  status: "draft",
  postRevision: 2,
  publicationNumber: null,
  publishedAt: null,
  publishAt: null,
  updatedAt: "2026-10-02T08:00:00Z",
};

test("the state filter grows with the viewer's level and the address keeps only allowed states", () => {
  expect(postStatesFor("read")).toEqual(["published"]);
  expect(postStatesFor("write")).toEqual(["published", "scheduled", "drafts"]);
  expect(postStatesFor("manage")).toEqual([
    "published",
    "scheduled",
    "drafts",
    "archived",
  ]);
  for (const [value, level, expected] of [
    ["drafts", "write", "drafts"],
    ["archived", "write", "published"],
    ["archived", "manage", "archived"],
    ["drafts", "read", "published"],
    ["published", "manage", "published"],
    ["unknown", "manage", "published"],
    [null, "manage", "published"],
  ] as const)
    expect(parsePostShow(value, level)).toBe(expected);
  expect(postViewForState("published")).toBe("published");
  expect(postViewForState("scheduled")).toBe("draft");
  expect(postViewForState("drafts")).toBe("draft");
  expect(postViewForState("archived")).toBe("archive");
});

test("a list row's second line names the author, a short date and the state words", () => {
  expect(postRowMeta(published, "Marina Reyes", region, now)).toEqual([
    "Marina Reyes",
    "Oct 24",
  ]);
  expect(
    postRowMeta(
      {
        ...published,
        pinned: true,
        edited: true,
        expiresAt: "2026-12-31T00:00:00Z",
      },
      "Marina Reyes",
      region,
      now,
    ),
  ).toEqual(["Pinned", "Marina Reyes", "Oct 24", "Edited", "Expires Dec 31"]);
  expect(
    postRowMeta(
      { ...published, expiresAt: "2026-10-25T00:00:00Z" },
      "Avery",
      region,
      now,
    ),
  ).toEqual(["Avery", "Oct 24", "Expired"]);
  expect(
    postRowMeta(
      { ...draft, status: "scheduled", publishAt: "2026-10-30T09:00:00Z" },
      "Avery",
      region,
      now,
    ),
  ).toEqual(["Avery", "Publishes Fri, Oct 30, 9:00 AM"]);
  expect(postRowMeta(draft, "Avery", region, now)).toEqual([
    "Avery",
    "Oct 2",
    "Draft",
  ]);
  expect(postRowMeta(published, "Avery", undefined, now)).toEqual([
    "Avery",
    "Date unavailable",
  ]);
});

test("an empty list names its state's reason, and a reader gets the board's reason", () => {
  expect(postListEmpty("published", false, null).title).toBe(
    "No published posts yet",
  );
  expect(
    postListEmpty("published", false, "Only admins post on the Company board.")
      .description,
  ).toBe("Only admins post on the Company board.");
  expect(postListEmpty("scheduled", false, null).title).toBe(
    "Nothing scheduled",
  );
  expect(postListEmpty("drafts", false, null).title).toBe("No drafts");
  expect(postListEmpty("archived", false, null).title).toBe(
    "No archived posts",
  );
  expect(postListEmpty("drafts", true, null).title).toBe("No posts match");
});

test("the reason a viewer cannot post follows the board's scope", () => {
  const sales = {
    scope: "department" as const,
    name: "Sales",
    status: "active" as const,
  };
  expect(postingReason(sales, false)).toBe(
    "Posting needs write access to Sales.",
  );
  expect(postingReason({ ...sales, scope: "company" }, false)).toBe(
    "Only admins post on the Company board.",
  );
  expect(postingReason({ ...sales, scope: "project" }, false)).toBe(
    "Posting needs write access through one of this board's groups.",
  );
  expect(postingReason(sales, true)).toBe("Guests can read only.");
  expect(postingReason({ ...sales, status: "archived" }, true)).toBe(
    "Archived boards are read-only.",
  );
  expect(postAudienceLine(sales)).toBe(
    "Everyone who reads Sales sees this post.",
  );
  expect(postAudienceLine({ scope: "company", name: "Company" })).toBe(
    "Everyone in the organization sees this post.",
  );
});

test("the post menu offers only the actions the viewer may take", () => {
  const author: PostViewer = {
    actorId,
    canWrite: true,
    canManage: false,
    boardActive: true,
  };
  const manager: PostViewer = { ...author, actorId: otherId, canManage: true };
  const reader: PostViewer = {
    ...author,
    actorId: otherId,
    canWrite: false,
  };
  const otherWriter: PostViewer = { ...author, actorId: otherId };
  const archived: BoardPost = { ...draft, status: "archived" };
  const edited: BoardPost = { ...published, edited: true };

  expect(postMenuActions(published, reader, true)).toEqual(["copy-link"]);
  expect(postMenuActions(edited, reader, true)).toEqual([
    "copy-link",
    "history",
  ]);
  expect(postMenuActions(published, otherWriter, true)).toEqual(["copy-link"]);
  expect(postMenuActions(published, author, true)).toEqual([
    "copy-link",
    "unpublish",
    "archive",
  ]);
  expect(postMenuActions(draft, author, false)).toEqual(["archive", "delete"]);
  expect(postMenuActions(archived, manager, false)).toEqual([
    "restore",
    "delete",
  ]);
  expect(postMenuActions(archived, author, false)).toEqual(["delete"]);
  expect(
    postMenuActions(published, { ...manager, boardActive: false }, true),
  ).toEqual(["copy-link"]);

  expect(canEditPost(published, author)).toBe(true);
  expect(canEditPost(published, manager)).toBe(true);
  expect(canEditPost(published, otherWriter)).toBe(false);
  expect(canEditPost(published, reader)).toBe(false);
  expect(canEditPost(archived, manager)).toBe(false);
});

test("Delete draft shows only for a post that was never published", () => {
  const author: PostViewer = {
    actorId,
    canWrite: true,
    canManage: false,
    boardActive: true,
  };
  const manager: PostViewer = { ...author, actorId: otherId, canManage: true };
  const archived: BoardPost = { ...draft, status: "archived" };
  // A draft of a post that was published before, and its archived copy.
  expect(postMenuActions(draft, author, true)).toEqual(["archive"]);
  expect(postMenuActions(archived, manager, true)).toEqual(["restore"]);
  // Until the manage state is read, Delete draft waits.
  expect(postMenuActions(draft, author, null)).toEqual(["archive"]);
});

test("only a menu that can offer Delete draft reads the manage state", () => {
  const author: PostViewer = {
    actorId,
    canWrite: true,
    canManage: false,
    boardActive: true,
  };
  const manager: PostViewer = { ...author, actorId: otherId, canManage: true };
  const reader: PostViewer = { ...author, actorId: otherId, canWrite: false };
  const otherWriter: PostViewer = { ...author, actorId: otherId };
  const archived: BoardPost = { ...draft, status: "archived" };
  // A reader or another writer would be refused (403): no read.
  expect(readsPostManageState(published, reader)).toBe(false);
  expect(readsPostManageState(published, otherWriter)).toBe(false);
  expect(readsPostManageState(draft, otherWriter)).toBe(false);
  // A published post never offers Delete draft, even to its author.
  expect(readsPostManageState(published, author)).toBe(false);
  expect(readsPostManageState(draft, author)).toBe(true);
  expect(readsPostManageState(archived, manager)).toBe(true);
  expect(readsPostManageState(draft, { ...author, boardActive: false })).toBe(
    false,
  );
});
