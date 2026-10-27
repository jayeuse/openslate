import {
  archiveBoard,
  createBoard,
  listBoards,
  previewBoardPurge,
  purgeBoard,
  readBoard,
  readBoardGroups,
  replaceBoardGroups,
  restoreBoard,
  updateBoard,
} from "../../../src/components/systems/boards/adapters/board-management-api";
import {
  getBoardAccessPreview,
  getMyBoardAccess,
  listBoardActivity,
  listBoardPreviewUsers,
} from "../../../src/components/systems/boards/adapters/board-tools-api";
import { getBoardWorkspaceToday } from "../../../src/components/systems/boards/adapters/board-workspace-date-api";
import { listBoardPeople } from "../../../src/components/systems/boards/adapters/board-people-api";
import { describeContracts } from "./openapi-contract";

const boardId = "00000000-0000-4000-8000-000000000001";
const departmentId = "00000000-0000-4000-8000-000000000002";
const groupId = "00000000-0000-4000-8000-000000000003";
const userId = "00000000-0000-4000-8000-000000000004";

// Overrides below keep the frontend's cross-field rules true: echoed ids, a
// department Board has a department, page counts match the items sent.
const board = {
  id: boardId,
  name: "Operations",
  scope: "department",
  department_id: departmentId,
};
const page = { limit: 25, offset: 0, count: 1, total: 1, has_more: false };
const purgeImpact = {
  target_type: "board",
  target_id: boardId,
  operation: "purge",
  // The frontend narrows the digest to the SHA-256 hex the backend emits.
  impact_digest: "a".repeat(64),
};
describeContracts("Boards: management and tools", [
  {
    name: "listBoards",
    run: () =>
      listBoards({
        limit: 25,
        offset: 0,
        sortBy: "name",
        sortOrder: "asc",
        status: "all",
        search: "desk",
        scope: "department",
        departmentId,
      }),
    responses: { "GET /api/boards": { items: [board], pagination: page } },
  },
  {
    name: "createBoard",
    run: () => createBoard({ name: "Front desk", description: "Daily work" }),
    responses: { "POST /api/boards": board },
  },
  {
    name: "readBoard",
    run: () => readBoard(boardId),
    responses: { "GET /api/boards/{board_id}": board },
  },
  {
    name: "updateBoard",
    run: () =>
      updateBoard(boardId, {
        revision: 2,
        name: "Front desk",
        description: null,
      }),
    responses: { "PATCH /api/boards/{board_id}": board },
  },
  {
    name: "archiveBoard",
    run: () => archiveBoard(boardId, 2),
    responses: { "POST /api/boards/{board_id}/archive": board },
  },
  {
    name: "restoreBoard",
    run: () => restoreBoard(boardId, 2),
    responses: { "POST /api/boards/{board_id}/restore": board },
  },
  {
    name: "previewBoardPurge",
    run: () => previewBoardPurge(boardId),
    responses: {
      "POST /api/boards/{board_id}/purge/preview": {
        impact: purgeImpact,
        confirmation_name: board.name,
        last_successful_backup_at: null,
      },
    },
  },
  {
    name: "purgeBoard",
    run: () =>
      purgeBoard(boardId, {
        token: "token",
        confirmationName: board.name,
        password: "password",
      }),
    responses: {
      "POST /api/boards/{board_id}/purge": { impact: purgeImpact },
    },
  },
  {
    name: "readBoardGroups",
    run: () => readBoardGroups(boardId),
    responses: { "GET /api/boards/{board_id}/groups": { board_id: boardId } },
  },
  {
    name: "replaceBoardGroups",
    run: () =>
      replaceBoardGroups(boardId, {
        revision: 2,
        groups: [{ groupId, level: "write" }],
      }),
    responses: { "PUT /api/boards/{board_id}/groups": { board_id: boardId } },
  },
  {
    name: "getMyBoardAccess",
    run: () => getMyBoardAccess(boardId),
    // The flags must agree with the level, and a reader can always view.
    responses: {
      "GET /api/boards/{board_id}/my-access": {
        level: "read",
        read: true,
        write: false,
        manage: false,
      },
    },
  },
  {
    name: "getBoardAccessPreview",
    run: () => getBoardAccessPreview(boardId, userId),
    // The flags must agree with the level.
    responses: {
      "GET /api/boards/{board_id}/access-preview": {
        level: "write",
        read: true,
        write: true,
        manage: false,
      },
    },
  },
  {
    name: "listBoardPreviewUsers",
    run: () =>
      listBoardPreviewUsers(boardId, {
        limit: 25,
        offset: 0,
        sortOrder: "desc",
        search: "ana",
      }),
    responses: {
      "GET /api/boards/{board_id}/preview-users": { pagination: page },
    },
  },
  {
    name: "listBoardPeople",
    run: () => listBoardPeople(boardId, { offset: 100, search: "ana" }),
    responses: {
      // The adapter checks the page it asked for: 100 from offset 100.
      "GET /api/boards/{board_id}/people": {
        pagination: { ...page, limit: 100, offset: 100, total: 101 },
      },
    },
  },
  {
    name: "listBoardActivity",
    run: () => listBoardActivity(boardId, { limit: 25, offset: 0 }),
    responses: { "GET /api/boards/{board_id}/activity": { pagination: page } },
  },
  { name: "getBoardWorkspaceToday", run: () => getBoardWorkspaceToday() },
]);
