import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BoardManagementBoard } from "../../src/components/systems/boards/adapters/board-management-api";
import { listBoardDepartments } from "../../src/components/systems/boards/adapters/board-departments-api";
import {
  ServerBoardManagementDisplay,
  boardCreateForDraft,
  boardUpdateForDraft,
  rebaseBoardDraft,
  revokeBoardManagementState,
  type BoardManagementDraft,
  type BoardManagementView,
} from "../../src/components/systems/boards/components/server-backed-board-management";

const boardId = "00000000-0000-4000-8000-000000000001";
const ownerId = "00000000-0000-4000-8000-000000000002";
const departmentId = "00000000-0000-4000-8000-000000000003";
const board: BoardManagementBoard = {
  id: boardId,
  ownerId,
  departmentId,
  name: "Dispatch",
  description: "Daily handoffs",
  status: "active",
  defaultSection: "overview",
  revision: 4,
  createdAt: "2026-09-23T00:00:00Z",
  updatedAt: "2026-09-23T00:00:00Z",
};
const draft: BoardManagementDraft = {
  name: "Dispatch updated",
  description: "Keep my draft",
  defaultSection: "calendar",
  departmentId,
};
const baseView: BoardManagementView = {
  mode: "manage",
  board,
  access: "ready",
  canManage: true,
  departmentsStatus: "ready",
  departments: [{ id: departmentId, name: "Operations" }],
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

test("Department denial leaves Board creation available without leaking IDs or claiming an assignment", () => {
  const view: BoardManagementView = {
    ...baseView,
    mode: "create",
    board: null,
    departmentsStatus: "unavailable",
    departments: [],
  };
  const html = markup(view);
  expect(html).toContain("Create Board");
  expect(html).toContain("Department choices are unavailable");
  expect(html).toContain("No department will be assigned");
  expect(html).not.toContain(departmentId);
  expect(boardCreateForDraft(draft, false)).toEqual({
    name: "Dispatch updated",
    description: "Keep my draft",
    defaultSection: "calendar",
  });
});

test("Department denial preserves an existing assignment when editing metadata", () => {
  const html = markup({
    ...baseView,
    departmentsStatus: "unavailable",
    departments: [],
  });
  expect(html).toContain("Current department will stay unchanged");
  expect(html).toContain("Save changes");
  expect(html).not.toContain(departmentId);
  expect(boardUpdateForDraft(board, draft, false)).toEqual({
    revision: 4,
    name: "Dispatch updated",
    description: "Keep my draft",
    defaultSection: "calendar",
  });
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
    expect(html).not.toContain("Archive Board");
  }
});

test("revision conflict retains the draft and blocks unreviewed overwrite", () => {
  const html = markup({ ...baseView, conflict: true });
  expect(html).toContain("Keep my draft");
  expect(html).toContain("Board changed elsewhere");
  expect(html).toContain("Refresh latest Board");
  expect(html).toMatch(/disabled=""[^>]*>Save changes/);
});

test("conflict retry reapplies only locally changed fields onto the latest Board", () => {
  const latest = {
    ...board,
    revision: 5,
    description: "Changed remotely",
    defaultSection: "announcements" as const,
    departmentId: null,
  };
  const originalDraft = {
    ...draft,
    description: "Daily handoffs",
    defaultSection: "overview" as const,
  };
  expect(rebaseBoardDraft(board, latest, originalDraft, false)).toEqual({
    name: "Dispatch updated",
    description: "Changed remotely",
    defaultSection: "announcements",
    departmentId: null,
  });
});

test("Board access revocation clears private management state and invalidates pending responses", () => {
  const abort = new AbortController();
  const accessRequest = { current: 2 };
  const departmentsRequest = { current: 3 };
  const actionRequest = { current: 4 };
  const departmentsAbort = { current: abort as AbortController | null };
  let currentBoard: BoardManagementBoard | null = board;
  let currentDraft = draft;
  let currentDraftBase: BoardManagementBoard | null = board;
  let currentDepartments = [{ id: departmentId, name: "Operations" }];
  let departmentsStatus = "ready";
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
    departmentsRequest,
    actionRequest,
    departmentsAbort,
    setBoard: (value) => {
      currentBoard = value;
    },
    setDraft: (value) => {
      currentDraft = value;
    },
    setDraftBase: (value) => {
      currentDraftBase = value;
    },
    setDepartments: (value) => {
      currentDepartments = value;
    },
    setDepartmentsStatus: (value) => {
      departmentsStatus = value;
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
  expect([currentBoard, currentDraftBase, currentDepartments]).toEqual([
    null,
    null,
    [],
  ]);
  expect(currentDraft).toEqual({
    name: "",
    description: "",
    defaultSection: "overview",
    departmentId: null,
  });
  expect([
    departmentsStatus,
    access,
    conflict,
    latestReady,
    error,
    notice,
    confirmation,
    discardOpen,
  ]).toEqual(["unavailable", "denied", false, false, null, null, null, false]);
  expect([
    accessRequest.current,
    departmentsRequest.current,
    actionRequest.current,
  ]).toEqual([3, 4, 5]);
  expect(abort.signal.aborted).toBe(true);
  expect(departmentsAbort.current).toBeNull();
  expect(notifications).toBe(1);
});

test("archived Board offers restore without editable Department or metadata", () => {
  const html = markup({
    ...baseView,
    board: { ...board, status: "archived" },
  });
  expect(html).toContain("Restore Board");
  expect(html).not.toContain("Save changes");
  expect(html).not.toContain("Remove department");
});

test("Department chooser labels come only from the permission-gated Department API", async () => {
  const original = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    paths.push(String(input));
    return Response.json({
      items: [
        {
          id: departmentId,
          department_name: "Operations",
          created_at: "2026-09-23T00:00:00Z",
          updated_at: "2026-09-23T00:00:00Z",
          deleted_at: null,
          is_deleted: false,
          performed_by: ownerId,
        },
      ],
      pagination: {
        limit: 100,
        offset: 0,
        count: 1,
        total: 1,
        has_more: false,
      },
    });
  }) as typeof fetch;
  try {
    await expect(listBoardDepartments()).resolves.toEqual([
      { id: departmentId, name: "Operations" },
    ]);
    expect(paths).toEqual([
      "/api/departments?limit=100&offset=0&sort_by=department_name&sort_order=asc&deleted=exclude",
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
