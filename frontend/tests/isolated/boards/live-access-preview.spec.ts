import { expect, test } from "@playwright/test";
import {
  transitionAccessPreview,
  type AccessPreviewState,
} from "../../../src/components/systems/boards/hooks/use-board-check-person";
import { checkPersonResult } from "../../../src/components/systems/boards/domain/board-settings";

const boardId = "00000000-0000-4000-8000-000000000001";
const otherBoardId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";
const otherUserId = "00000000-0000-4000-8000-000000000004";
const initial: AccessPreviewState = {
  key: null,
  sequence: 0,
  data: null,
  status: "idle",
  error: null,
};
const sales = {
  scope: "department" as const,
  name: "Sales",
  status: "active" as const,
};

test("Check a person states what the person can do on this board and why", () => {
  // Each row reaches a different branch: read with its reason, post, manage,
  // and no access on each kind of board.
  const cases = [
    {
      board: sales,
      access: {
        level: "read" as const,
        view: true,
        edit: false,
        manage: false,
      },
      expected: {
        level: "Read",
        abilities: "can read · cannot post · cannot manage",
        reason: "Posting needs write access to Sales.",
      },
    },
    {
      board: { ...sales, scope: "project" as const, name: "Dispatch" },
      access: {
        level: "read" as const,
        view: true,
        edit: false,
        manage: false,
      },
      expected: {
        level: "Read",
        abilities: "can read · cannot post · cannot manage",
        reason:
          "Posting needs write access through one of this board's groups.",
      },
    },
    {
      board: { ...sales, scope: "company" as const, name: "Company" },
      access: {
        level: "read" as const,
        view: true,
        edit: false,
        manage: false,
      },
      expected: {
        level: "Read",
        abilities: "can read · cannot post · cannot manage",
        reason: "Only admins post on the Company board.",
      },
    },
    {
      board: sales,
      access: {
        level: "write" as const,
        view: true,
        edit: true,
        manage: false,
      },
      expected: {
        level: "Post",
        abilities: "can read · can post · cannot manage",
        reason: null,
      },
    },
    {
      board: sales,
      access: {
        level: "manage" as const,
        view: true,
        edit: true,
        manage: true,
      },
      expected: {
        level: "Manager",
        abilities: "can read · can post · can manage",
        reason: null,
      },
    },
    {
      board: sales,
      access: { level: null, view: false, edit: false, manage: false },
      expected: {
        level: null,
        abilities: "cannot read · cannot post · cannot manage",
        reason: "No access to Sales.",
      },
    },
    {
      board: { ...sales, scope: "project" as const, name: "Dispatch" },
      access: { level: null, view: false, edit: false, manage: false },
      expected: {
        level: null,
        abilities: "cannot read · cannot post · cannot manage",
        reason: "Not in any of this board's groups.",
      },
    },
  ];
  for (const { board, access, expected } of cases)
    expect(checkPersonResult(board, access)).toEqual(expected);
  // An archived board still names why a reader could not post once restored.
  expect(
    checkPersonResult(
      { ...sales, status: "archived" },
      { level: "read", view: true, edit: false, manage: false },
    ).reason,
  ).toBe("Posting needs write access to Sales.");
});

test("Board access preview clears old data on target or Board switch and ignores stale completions", () => {
  const key = `${boardId}:${userId}`;
  const ready = transitionAccessPreview(
    transitionAccessPreview(initial, { type: "begin", key, sequence: 1 }),
    {
      type: "resolve",
      key,
      sequence: 1,
      data: { level: "write", view: true, edit: true, manage: false },
    },
  );
  expect(ready.data?.edit).toBe(true);

  for (const nextKey of [
    `${boardId}:${otherUserId}`,
    `${otherBoardId}:${userId}`,
  ]) {
    const switched = transitionAccessPreview(ready, {
      type: "begin",
      key: nextKey,
      sequence: 2,
    });
    expect(switched.data).toBeNull();
    expect(switched.status).toBe("loading");
    expect(
      transitionAccessPreview(switched, {
        type: "resolve",
        key,
        sequence: 1,
        data: { level: "manage", view: true, edit: true, manage: true },
      }),
    ).toEqual(switched);
  }
});

test("Board access preview clears permission data after a denied or unavailable request", () => {
  const key = `${boardId}:${userId}`;
  const ready: AccessPreviewState = {
    key,
    sequence: 1,
    data: { level: "manage", view: true, edit: true, manage: true },
    status: "ready",
    error: null,
  };
  const refreshing = transitionAccessPreview(ready, {
    type: "begin",
    key,
    sequence: 2,
  });
  expect(refreshing.data).toBeNull();
  const denied = transitionAccessPreview(refreshing, {
    type: "reject",
    key,
    sequence: 2,
    error: "Check a person is unavailable.",
  });
  expect(denied.data).toBeNull();
  expect(denied.status).toBe("error");
  expect(denied.error).toBe("Check a person is unavailable.");
});
