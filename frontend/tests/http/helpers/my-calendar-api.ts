import type { Page, Route } from "@playwright/test";
import { isEventStream, signedInAs } from "./test";
import { wireBoard } from "../../helpers/wire";
import { wirePagination } from "../../helpers/pagination";

/**
 * A My calendar backend (P3b): the Company board, the Sales department's
 * board, and the Fleet Reliability project board, read across boards by
 * `GET /api/boards/occurrences`, with the person's own record sources and
 * "My cards · Due". Today is Wed, Nov 18, 2026.
 */

export const viewerId = "00000000-0000-4000-8000-000000000e01";
export const otherAuthorId = "00000000-0000-4000-8000-000000000e02";
export const companyBoardId = "00000000-0000-4000-8000-000000000e03";
export const salesBoardId = "00000000-0000-4000-8000-000000000e04";
export const fleetBoardId = "00000000-0000-4000-8000-000000000e05";
export const inventoryBoardId = "00000000-0000-4000-8000-000000000e06";
export const salesDepartmentId = "00000000-0000-4000-8000-000000000e07";
export const inventoryDepartmentId = "00000000-0000-4000-8000-000000000e08";
export const townHallEventId = "00000000-0000-4000-8000-000000000f01";
export const reviewEventId = "00000000-0000-4000-8000-000000000f02";
export const forkliftEventId = "00000000-0000-4000-8000-000000000f03";
export const countEventId = "00000000-0000-4000-8000-000000000f04";
export const ordersModuleId = "00000000-0000-4000-8000-000000000f05";
export const promisedFieldId = "00000000-0000-4000-8000-000000000f06";
export const orderTitleFieldId = "00000000-0000-4000-8000-000000000f07";
export const ordersSourceId = "00000000-0000-4000-8000-000000000f08";
export const salesStageId = "00000000-0000-4000-8000-000000000f09";
export const priceCardId = "00000000-0000-4000-8000-000000000f0a";
export const lockedCardId = "00000000-0000-4000-8000-000000000f0b";
export const createdEventId = "00000000-0000-4000-8000-000000000f0c";

const stamp = "2026-10-01T00:00:00Z";

type BoardShape = {
  id: string;
  name: string;
  scope: "company" | "department" | "project";
  departmentId: string | null;
  level: "read" | "write" | "manage";
  revision: number;
};

const boardShapes: BoardShape[] = [
  {
    id: companyBoardId,
    name: "Company",
    scope: "company",
    departmentId: null,
    level: "read",
    revision: 3,
  },
  {
    id: salesBoardId,
    name: "Sales",
    scope: "department",
    departmentId: salesDepartmentId,
    level: "write",
    revision: 5,
  },
  {
    id: fleetBoardId,
    name: "Fleet Reliability",
    scope: "project",
    departmentId: null,
    level: "manage",
    revision: 7,
  },
  {
    id: inventoryBoardId,
    name: "Inventory",
    scope: "department",
    departmentId: inventoryDepartmentId,
    level: "read",
    revision: 2,
  },
];

function mark(board: BoardShape) {
  return {
    id: board.id,
    name: board.name,
    scope: board.scope,
    department_id: board.departmentId,
  };
}

function wireEvent(
  board: BoardShape,
  shape: {
    id: string;
    title: string;
    author: string;
    start: string;
    end: string;
    location?: string;
  },
) {
  return {
    id: shape.id,
    board_id: board.id,
    author_id: shape.author,
    title: shape.title,
    details: "",
    location: shape.location ?? "",
    links: [],
    all_day: false,
    start_date: null,
    end_date: null,
    start_at: shape.start,
    end_at: shape.end,
    timezone_name: "UTC",
    recurrence: "none",
    repeat_until: null,
    reminders: [],
    archived: false,
    revision: 1,
    board_revision: board.revision,
    created_at: stamp,
    updated_at: stamp,
  };
}

const [company, sales, fleet, inventory] = boardShapes;
const events = [
  {
    board: company,
    event: wireEvent(company, {
      id: townHallEventId,
      title: "Q4 town hall",
      author: otherAuthorId,
      start: "2026-11-13T16:00:00Z",
      end: "2026-11-13T17:00:00Z",
      location: "Hall",
    }),
  },
  {
    board: sales,
    event: wireEvent(sales, {
      id: reviewEventId,
      title: "Customer account review",
      author: viewerId,
      start: "2026-11-16T09:00:00Z",
      end: "2026-11-16T10:00:00Z",
      location: "Room 2",
    }),
  },
  {
    board: fleet,
    event: wireEvent(fleet, {
      id: forkliftEventId,
      title: "Forklift breakdown review",
      author: otherAuthorId,
      start: "2026-11-18T11:00:00Z",
      end: "2026-11-18T12:00:00Z",
    }),
  },
  {
    board: inventory,
    event: wireEvent(inventory, {
      id: countEventId,
      title: "Quarterly cycle count",
      author: otherAuthorId,
      start: "2026-11-19T08:00:00Z",
      end: "2026-11-19T12:00:00Z",
    }),
  },
];

function occurrence({
  board,
  event,
}: {
  board: BoardShape;
  event: ReturnType<typeof wireEvent>;
}) {
  return {
    id: `${event.id}:${event.start_at}`,
    event_id: event.id,
    date: event.start_at.slice(0, 10),
    start: event.start_at,
    end: event.end_at,
    event,
    board: mark(board),
  };
}

export const ordersSourceWire = {
  id: ordersSourceId,
  module_id: ordersModuleId,
  module_name: "Sales Orders",
  department_id: salesDepartmentId,
  date_field_id: promisedFieldId,
  field_name: "Promised delivery",
  field_type: "date",
  position: 0,
};

function dueCard(
  board: BoardShape,
  id: string,
  patch: Record<string, unknown> = {},
) {
  return {
    id,
    board_id: board.id,
    stage_id: salesStageId,
    kind: "objective",
    title: "Update the Q4 price list",
    rank: 1,
    assignee_id: viewerId,
    start_on: null,
    due_on: "2026-11-20",
    label_ids: [],
    checklist: { done: 0, total: 0 },
    archived_at: null,
    revision: 1,
    created_at: stamp,
    updated_at: stamp,
    record: null,
    board: mark(board),
    ...patch,
  };
}

export type MyCalendarApiOptions = {
  /** The person's level on Sales and Fleet; read leaves them nowhere to post. */
  levels?: Partial<Record<"sales" | "fleet", "read" | "write" | "manage">>;
  /** Board statuses other than ok, by board id. */
  statuses?: Record<
    string,
    "candidate_limit" | "occurrence_limit" | "unavailable"
  >;
  /** Clears the statuses after this many occurrence reads (a Retry). */
  statusReads?: number;
};

export async function installMyCalendarApi(
  page: Page,
  options: MyCalendarApiOptions = {},
) {
  const boards = boardShapes.map((board) =>
    board.id === salesBoardId && options.levels?.sales
      ? { ...board, level: options.levels.sales }
      : board.id === fleetBoardId && options.levels?.fleet
        ? { ...board, level: options.levels.fleet }
        : board,
  );
  const state = {
    occurrenceReads: [] as string[],
    dueReads: [] as string[],
    sourceReads: 0,
    recordReads: [] as Record<string, unknown>[],
    sourceDeletes: [] as string[],
    eventWrites: [] as { path: string; body: unknown }[],
    created: null as ReturnType<typeof wireEvent> | null,
    sources: [ordersSourceWire],
  };
  await page.route("**/api/**", (route) =>
    isEventStream(route)
      ? route.fallback()
      : route.fulfill({ status: 404, json: { detail: "Not in this test" } }),
  );
  await signedInAs(page, { id: viewerId, role: "member" });
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        display_name: "OpenSlate",
        mark: "OS",
        logo_file_id: null,
        revision: 1,
        today: "2026-11-18",
        week_start: "monday",
        locale: "en-US",
        timezone: "UTC",
      },
    }),
  );
  await page.route(`**/api/modules/${ordersModuleId}`, (route) =>
    route.fulfill({
      json: {
        id: ordersModuleId,
        department_id: salesDepartmentId,
        module_name: "Sales Orders",
        title_field_id: orderTitleFieldId,
        is_deleted: false,
      },
    }),
  );
  await page.route(`**/api/fields/${orderTitleFieldId}`, (route) =>
    route.fulfill({
      json: {
        id: orderTitleFieldId,
        module_id: ordersModuleId,
        name: "Order",
        type: "text",
        required: true,
        position: 0,
        config: {},
        is_deleted: false,
      },
    }),
  );
  await page.route("**/api/records/window-query", (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    state.recordReads.push(body);
    const records = [
      {
        id: "00000000-0000-4000-8000-000000000f10",
        module_id: ordersModuleId,
        data: {
          [promisedFieldId]: "2026-11-24",
          [orderTitleFieldId]: "SO-31057 Cebu Coldchain",
        },
        display_values: {},
        created_at: stamp,
        updated_at: stamp,
        deleted_at: null,
        is_deleted: false,
        performed_by: null,
      },
    ].filter(
      (record) =>
        record.data[promisedFieldId] >= String(body.from_date) &&
        record.data[promisedFieldId] <= String(body.to_date),
    );
    return route.fulfill({
      json: {
        items: records,
        pagination: wirePagination({
          limit: 100,
          count: records.length,
          total: records.length,
        }),
        timezone: null,
      },
    });
  });
  await page.route("**/api/me/calendar-sources**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "DELETE") {
      state.sourceDeletes.push(path);
      state.sources = state.sources.filter(
        (source) => !path.endsWith(source.id),
      );
      return route.fulfill({ status: 204, body: "" });
    }
    state.sourceReads += 1;
    return route.fulfill({ json: { items: state.sources } });
  });
  await page.route("**/api/boards**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/api/boards")
      return route.fulfill({
        json: {
          items: boards.map((board) =>
            wireBoard({
              id: board.id,
              scope: board.scope,
              department_id: board.departmentId,
              name: board.name,
              description: null,
              revision: board.revision,
              level: board.level,
              created_at: stamp,
              updated_at: stamp,
            }),
          ),
          pagination: wirePagination({
            limit: 100,
            count: boards.length,
            total: boards.length,
          }),
        },
      });
    if (path === "/api/boards/occurrences") {
      state.occurrenceReads.push(url.search);
      const start = url.searchParams.get("window_start") ?? "";
      const end = url.searchParams.get("window_end") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const statuses =
        options.statusReads !== undefined &&
        state.occurrenceReads.length > options.statusReads
          ? {}
          : (options.statuses ?? {});
      const covered = boards.filter((board) => !statuses[board.id]);
      const items = [
        ...events,
        ...(state.created ? [{ board: fleet, event: state.created }] : []),
      ]
        .filter(
          (entry) =>
            covered.some((board) => board.id === entry.board.id) &&
            entry.event.start_at.slice(0, 10) >= start &&
            entry.event.start_at.slice(0, 10) <= end,
        )
        .map(occurrence);
      const page = items.slice(offset, offset + limit);
      return route.fulfill({
        json: {
          items: page,
          pagination: wirePagination({
            limit,
            offset,
            count: page.length,
            total: items.length,
            has_more: offset + page.length < items.length,
          }),
          boards: boards.map((board) => ({
            board_id: board.id,
            revision:
              statuses[board.id] === "unavailable" ? null : board.revision,
            status: statuses[board.id] ?? "ok",
            next_occurrence: null,
          })),
        },
      });
    }
    if (path === "/api/boards/cards/due") {
      state.dueReads.push(url.search);
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      const cards = [
        dueCard(sales, priceCardId),
        dueCard(fleet, lockedCardId, {
          kind: "record",
          title: null,
          record: { locked: true },
        }),
      ].filter((card) => card.due_on >= from && card.due_on <= to);
      return route.fulfill({
        json: {
          items: cards,
          pagination: wirePagination({
            limit: 100,
            count: cards.length,
            total: cards.length,
          }),
        },
      });
    }
    const board = boards.find((entry) =>
      path.startsWith(`/api/boards/${entry.id}`),
    );
    if (!board)
      return route.fulfill({
        status: 404,
        json: { detail: "Board not found" },
      });
    const prefix = `/api/boards/${board.id}`;
    if (path === `${prefix}/events` && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.eventWrites.push({ path, body });
      state.created = wireEvent(board, {
        id: createdEventId,
        title: String(body.title),
        author: viewerId,
        start: "2026-11-25T09:00:00Z",
        end: "2026-11-25T10:00:00Z",
      });
      return route.fulfill({
        status: 201,
        json: {
          id: createdEventId,
          event_revision: 1,
          board_revision: board.revision,
        },
      });
    }
    const eventMatch = /\/events\/([0-9a-f-]{36})$/.exec(path);
    if (eventMatch) {
      const event =
        events.find(
          (entry) =>
            entry.board.id === board.id && entry.event.id === eventMatch[1],
        )?.event ??
        (state.created?.id === eventMatch[1] && board.id === fleetBoardId
          ? state.created
          : undefined);
      return event
        ? route.fulfill({ json: event })
        : route.fulfill({
            status: 404,
            json: { detail: "Board event not found" },
          });
    }
    if (path.endsWith("/attachments") || path.endsWith("/record-links"))
      return route.fulfill({
        json: { items: [], limit: 20, offset: 0, has_more: false },
      });
    if (path === `${prefix}/stages`)
      return route.fulfill({
        json: {
          items: [
            {
              id: salesStageId,
              board_id: board.id,
              name: "Doing",
              color: null,
              wip_limit: null,
              card_sort: "manual",
              position: 0,
              revision: 1,
              archived_at: null,
              card_count: 1,
            },
          ],
          pagination: wirePagination({ limit: 100, count: 1, total: 1 }),
        },
      });
    if (path === prefix)
      return route.fulfill({
        json: wireBoard({
          id: board.id,
          scope: board.scope,
          department_id: board.departmentId,
          name: board.name,
          description: null,
          revision: board.revision,
          level: board.level,
          created_at: stamp,
          updated_at: stamp,
        }),
      });
    return route.fulfill({ status: 404, json: { detail: "Not in this test" } });
  });
  return state;
}

export function myCalendarHref(params = "") {
  return `/boards?section=my-calendar${params}`;
}
