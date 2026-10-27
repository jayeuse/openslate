import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../../../src/lib/api";
import type {
  BoardManagementBoard,
  BoardPurgePreview,
} from "../../../src/components/systems/boards/adapters/board-management-api";
import { ServerBoardManagementDisplay } from "../../../src/components/systems/boards/components/board-settings-details";
import {
  boardCreateForDraft,
  boardUpdateForDraft,
  rebaseBoardDraft,
  revokeBoardManagementState,
  type BoardManagementDraft,
  type BoardManagementView,
} from "../../../src/components/systems/boards/domain/board-details";
import { boardLifecycleConfirmation } from "../../../src/components/systems/boards/domain/board-settings";

const boardId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";
const departmentId = "00000000-0000-4000-8000-000000000003";
const board: BoardManagementBoard = {
  id: boardId,
  scope: "project",
  departmentId: null,
  name: "Dispatch",
  description: "Daily handoffs",
  status: "active",
  revision: 4,
  level: "manage",
  createdAt: "2026-09-23T00:00:00Z",
  updatedAt: "2026-09-23T00:00:00Z",
};
const departmentBoard: BoardManagementBoard = {
  ...board,
  scope: "department",
  departmentId,
  name: "Operations",
};
const draft: BoardManagementDraft = {
  name: "Dispatch updated",
  description: "Keep my draft",
};
const baseView: BoardManagementView = {
  board: departmentBoard,
  access: "ready",
  canManage: true,
  draft,
  pending: false,
  conflict: false,
  error: null,
  notice: null,
};

function markup(view: BoardManagementView): string {
  return renderToStaticMarkup(
    createElement(ServerBoardManagementDisplay, { view }),
  );
}

const purgePreview: BoardPurgePreview = {
  impact: {
    target_type: "board",
    target_id: boardId,
    operation: "purge",
    actor_id: actorId,
    rows: [],
    external_impacts: [],
    key_strips: [],
    blockers: [],
    impact_digest: "a".repeat(64),
  },
  token: "server-issued-challenge",
  expires_at: "2026-09-25T00:00:00Z",
  confirmation_name: board.name,
  last_successful_backup_at: "2026-09-23T18:30:00Z",
};

test("a new Board is a project Board with only a name and description", () => {
  expect(boardCreateForDraft(draft)).toEqual({
    name: "Dispatch updated",
    description: "Keep my draft",
  });
  expect(
    boardCreateForDraft({ name: "  Dispatch  ", description: "   " }),
  ).toEqual({ name: "Dispatch", description: null });
});

test("a department Board shows its name as text with the reason and cannot be archived", () => {
  const html = markup({ ...baseView, draft: { ...draft, name: "Operations" } });
  expect(html).toContain("Named after its department");
  expect(html).not.toContain('value="Operations"');
  expect(html).not.toContain("Archive board");
  expect(html).toContain("Archives when Operations closes.");
  expect(boardUpdateForDraft(departmentBoard, draft)).toEqual({
    revision: 4,
    description: "Keep my draft",
  });
  expect(
    boardUpdateForDraft(departmentBoard, {
      name: "Renamed",
      description: "Daily handoffs",
    }),
  ).toBeNull();
});

test("the company Board can be renamed but not archived", () => {
  const company = { ...board, scope: "company" as const, name: "Company" };
  const html = markup({
    ...baseView,
    board: company,
    draft: { name: "Company", description: "Daily handoffs" },
  });
  expect(html).not.toContain("Archive board");
  expect(html).not.toContain("always open");
  expect(html).toContain('value="Company"');
  expect(boardUpdateForDraft(company, { ...draft, name: "Everyone" })).toEqual({
    revision: 4,
    name: "Everyone",
    description: "Keep my draft",
  });
});

test("a project Board's Details rows come before Advanced, which holds Archive", () => {
  const html = markup({ ...baseView, board, draft });
  expect(html.indexOf("Description")).toBeLessThan(html.indexOf("Advanced"));
  expect(html.indexOf("Advanced")).toBeLessThan(html.indexOf("Archive board"));
  expect(html).toContain("Advanced");
  expect(html).toContain("Save changes");
  expect(boardUpdateForDraft(board, draft)).toEqual({
    revision: 4,
    name: "Dispatch updated",
    description: "Keep my draft",
  });
});

test("Save changes says there is nothing to save until the draft changes", () => {
  const html = markup({
    ...baseView,
    board,
    draft: { name: board.name, description: board.description ?? "" },
  });
  expect(html).toContain("No changes to save.");
  expect(html).toMatch(/disabled=""[^>]*>Save changes/);
  expect(markup({ ...baseView, board, draft })).not.toContain(
    "No changes to save.",
  );
});

test("Archive asks once with its consequence and Restore acts at once", () => {
  expect(boardLifecycleConfirmation("archive")).toEqual({
    title: "Archive board?",
    description: "Everyone can still read it; nobody can post.",
    action: "Archive board",
  });
  expect(boardLifecycleConfirmation("restore")).toBeNull();
});

test("existing Board management requires server-confirmed manage access", () => {
  for (const view of [
    { ...baseView, access: "loading" as const, canManage: false },
    { ...baseView, access: "denied" as const, canManage: false },
    { ...baseView, access: "ready" as const, canManage: false },
  ]) {
    const html = markup(view);
    expect(html).not.toContain("Keep my draft");
    expect(html).not.toContain("Save changes");
    expect(html).not.toContain("Archive board");
  }
});

test("revision conflict retains the draft and blocks unreviewed overwrite", () => {
  const html = markup({ ...baseView, conflict: true });
  expect(html).toContain("Keep my draft");
  expect(html).toContain("Someone changed this board first.");
  expect(html).toContain("Refresh latest Board");
  expect(html).toMatch(/disabled=""[^>]*>Save changes/);
});

test("conflict retry reapplies only locally changed fields onto the latest Board", () => {
  const latest = {
    ...board,
    revision: 5,
    description: "Changed remotely",
  };
  const originalDraft = { ...draft, description: "Daily handoffs" };
  expect(rebaseBoardDraft(board, latest, originalDraft)).toEqual({
    name: "Dispatch updated",
    description: "Changed remotely",
  });
});

test("Board access revocation clears private management state and invalidates pending responses", () => {
  const accessRequest = { current: 2 };
  const actionRequest = { current: 4 };
  let currentBoard: BoardManagementBoard | null = board;
  let currentDraft = draft;
  let currentDraftBase: BoardManagementBoard | null = board;
  let access = "ready";
  let conflict = true;
  let latestReady = true;
  let error: string | null = "Old error";
  let notice: string | null = "Private notice";
  let confirmation: string | null = "archive";
  let discardOpen = true;
  let notifications = 0;
  revokeBoardManagementState({
    accessRequest,
    actionRequest,
    setBoard: (value) => {
      currentBoard = value;
    },
    setDraft: (value) => {
      currentDraft = value;
    },
    setDraftBase: (value) => {
      currentDraftBase = value;
    },
    setAccess: (value) => {
      access = value;
    },
    setConflict: (value) => {
      conflict = value;
    },
    setLatestReady: (value) => {
      latestReady = value;
    },
    setError: (value) => {
      error = value;
    },
    setNotice: (value) => {
      notice = value;
    },
    setConfirmation: (value) => {
      confirmation = value;
    },
    setDiscardOpen: (value) => {
      discardOpen = value;
    },
    onAccessDenied: () => {
      notifications += 1;
    },
  });
  expect([currentBoard, currentDraftBase]).toEqual([null, null]);
  expect(currentDraft).toEqual({ name: "", description: "" });
  expect([
    access,
    conflict,
    latestReady,
    error,
    notice,
    confirmation,
    discardOpen,
  ]).toEqual(["denied", false, false, null, null, null, false]);
  expect([accessRequest.current, actionRequest.current]).toEqual([3, 5]);
  expect(notifications).toBe(1);
});

test("manage-only denial clears its editor without revoking the authorized Board", () => {
  let boardRevocations = 0;
  const noOp = () => undefined;
  revokeBoardManagementState(
    {
      accessRequest: { current: 0 },
      actionRequest: { current: 0 },
      setBoard: noOp,
      setDraft: noOp,
      setDraftBase: noOp,
      setAccess: noOp,
      setConflict: noOp,
      setLatestReady: noOp,
      setError: noOp,
      setNotice: noOp,
      setConfirmation: noOp,
      setDiscardOpen: noOp,
      onAccessDenied: () => {
        boardRevocations += 1;
      },
    },
    false,
  );
  expect(boardRevocations).toBe(0);
});

test("archived project Board offers a neutral Restore without editable metadata", () => {
  const html = markup({
    ...baseView,
    board: { ...board, status: "archived" },
  });
  expect(html).toMatch(/data-variant="outline"[^>]*>Restore board</);
  expect(html).not.toContain('data-variant="destructive"');
  expect(html).toContain("Archived boards are read-only.");
  expect(html).not.toContain("Save changes");
});

test("archived Board permanent-deletion controls are hidden from non-admins", () => {
  const html = renderToStaticMarkup(
    createElement(ServerBoardManagementDisplay, {
      view: { ...baseView, board: { ...board, status: "archived" } },
      purgePreview,
      isAdmin: false,
    } as Parameters<typeof ServerBoardManagementDisplay>[0]),
  );
  expect(html).not.toContain("Permanent deletion");
  expect(html).not.toContain("Permanently delete board");
  expect(html).toContain("Restore board");
});

test("Board purge preserves safe lifecycle messages when the server returns their actual status", async () => {
  const management =
    (await import("../../../src/components/systems/boards/domain/board-details")) as unknown as {
      boardPurgeFailureMessage: (
        error: unknown,
        stage: "preview" | "execute",
      ) => string;
    };
  expect(typeof management.boardPurgeFailureMessage).toBe("function");
  expect(
    management.boardPurgeFailureMessage(
      new ApiError(
        403,
        "Permanent delete is turned off for this installation.",
        undefined,
        "purge_disabled",
      ),
      "preview",
    ),
  ).toBe("Permanent delete is turned off for this installation.");
  expect(
    management.boardPurgeFailureMessage(
      new ApiError(
        422,
        "The Board name confirmation did not match",
        undefined,
        "confirmation_name_mismatch",
      ),
      "execute",
    ),
  ).toBe("The Board name confirmation did not match");
});
