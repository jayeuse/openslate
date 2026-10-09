import {
  archiveBoard,
  createBoard,
  duplicateBoardStructure,
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
  downloadBoardConfiguration,
  importBoardConfiguration,
} from "../../../src/components/systems/boards/adapters/board-configuration-api";
import {
  getBoardAccessPreview,
  getMyBoardAccess,
  listBoardActivity,
  listBoardPreviewUsers,
} from "../../../src/components/systems/boards/adapters/board-tools-api";
import {
  createBoardWidget,
  deleteBoardWidget,
  duplicateBoardWidget,
  listBoardWidgets,
  reorderBoardWidgets,
  updateBoardWidget,
  type BoardWidgetInput,
} from "../../../src/components/systems/boards/adapters/board-widgets-api";
import { getBoardWorkspaceToday } from "../../../src/components/systems/boards/adapters/board-workspace-date-api";
import { describeContracts } from "./openapi-contract";

const boardId = "00000000-0000-4000-8000-000000000001";
const departmentId = "00000000-0000-4000-8000-000000000002";
const groupId = "00000000-0000-4000-8000-000000000003";
const userId = "00000000-0000-4000-8000-000000000004";
const widgetId = "00000000-0000-4000-8000-000000000005";
const moduleId = "00000000-0000-4000-8000-000000000006";
const chartId = "00000000-0000-4000-8000-000000000009";

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
// A referenced source keeps XOR valid in both generated nullable-response modes.
// The harness deliberately preserves generated nulls rather than replacing them with objects.
const widget = {
  board_id: boardId,
  position: 0,
  chart_id: chartId,
  config: null,
};
// The portable count-all bundle stays valid with both generated nullable modes.
// Dedicated Board portability regressions cover non-null numeric/primitive metrics.
const bundle = {
  kind: "openslate-board",
  version: 3,
  configuration: {
    widgets: [
      {
        config: {
          fields: [{ expected_type: "text" }],
          filters: [
            { expected_type: "text", operator: "contains", value: "pump" },
          ],
          aggregation: "count",
          metric: null,
        },
      },
    ],
  },
};
const widgetInput: BoardWidgetInput = {
  name: "Open work",
  widgetType: "chart",
  moduleId,
  size: "M",
  pinned: false,
  chartId,
  config: null,
};
const bundleFile = new Blob([
  JSON.stringify({
    kind: "openslate-board",
    version: 3,
    configuration: { name: "Front desk", description: null, widgets: [] },
  }),
]);

describeContracts("Boards: management, tools and widgets", [
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
    name: "duplicateBoardStructure",
    run: () => duplicateBoardStructure(boardId),
    // A duplicate is a new Board, so its id must differ from the source.
    responses: {
      "POST /api/boards/{board_id}/duplicate": { ...board, id: groupId },
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
    name: "downloadBoardConfiguration",
    run: () => downloadBoardConfiguration(boardId),
    responseHeaders: {
      "Content-Disposition": 'attachment; filename="board-configuration.json"',
    },
    responses: { "GET /api/boards/{board_id}/configuration": bundle },
  },
  {
    name: "importBoardConfiguration",
    run: () => importBoardConfiguration(bundleFile),
    responses: { "POST /api/boards/import": board },
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
    name: "listBoardActivity",
    run: () => listBoardActivity(boardId, { limit: 25, offset: 0 }),
    responses: { "GET /api/boards/{board_id}/activity": { pagination: page } },
  },
  {
    name: "listBoardWidgets",
    run: () =>
      listBoardWidgets(boardId, {
        limit: 12,
        offset: 0,
        sortBy: "created_at",
        sortOrder: "desc",
      }),
    responses: {
      "GET /api/boards/{board_id}/widgets": {
        items: [widget],
        pagination: page,
      },
    },
  },
  {
    name: "createBoardWidget",
    run: () => createBoardWidget(boardId, 2, widgetInput),
    responses: { "POST /api/boards/{board_id}/widgets": { widget } },
  },
  {
    name: "updateBoardWidget",
    run: () => updateBoardWidget(boardId, widgetId, 2, widgetInput),
    responses: {
      "PATCH /api/boards/{board_id}/widgets/{widget_id}": {
        widget: { ...widget, id: widgetId },
      },
    },
  },
  {
    name: "duplicateBoardWidget",
    run: () => duplicateBoardWidget(boardId, widgetId, 2),
    responses: {
      "POST /api/boards/{board_id}/widgets/{widget_id}/duplicate": { widget },
    },
  },
  {
    name: "reorderBoardWidgets",
    run: () => reorderBoardWidgets(boardId, 2, [widgetId]),
    // The response must list the widgets in the requested order.
    responses: {
      "PUT /api/boards/{board_id}/widgets/order": {
        items: [{ ...widget, id: widgetId }],
      },
    },
  },
  {
    name: "deleteBoardWidget",
    run: () => deleteBoardWidget(boardId, widgetId, 2),
  },
  { name: "getBoardWorkspaceToday", run: () => getBoardWorkspaceToday() },
]);
