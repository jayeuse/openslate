import type { Page, Route } from "./test";
import { wirePagination } from "../../helpers/pagination";
import {
  authorAccess,
  boardId,
  installBoardApi,
  managerAccess,
  readerAccess,
} from "./boards-api";

// The board Kanban's API (BE7) for HTTP specs: stateful stages, cards and
// labels that the journeys change, with the server's move rule (a place
// among the stage's other active cards) and its revision checks.

export const kanbanHref = (params = "") =>
  `/boards?board=${boardId}&section=kanban${params ? `&${params}` : ""}`;

export const stageIds = {
  todo: "00000000-0000-4000-8000-00000000e001",
  doing: "00000000-0000-4000-8000-00000000e002",
  done: "00000000-0000-4000-8000-00000000e003",
};
export const labelIds = {
  expo: "00000000-0000-4000-8000-00000000e101",
  pricing: "00000000-0000-4000-8000-00000000e102",
};
export const peopleIds = {
  ana: "00000000-0000-4000-8000-00000000e201",
  ben: "00000000-0000-4000-8000-00000000e202",
};
export const recordIds = {
  quote: "00000000-0000-4000-8000-00000000e301",
  module: "00000000-0000-4000-8000-00000000e302",
  validFrom: "00000000-0000-4000-8000-00000000e303",
  validUntil: "00000000-0000-4000-8000-00000000e304",
  title: "00000000-0000-4000-8000-00000000e305",
};
const stamp = "2026-09-20T00:00:00Z";
const people: Record<string, string> = {
  [peopleIds.ana]: "Ana Santos",
  [peopleIds.ben]: "Ben Reyes",
};

export type WireStage = {
  id: string;
  board_id: string;
  name: string;
  color: string | null;
  wip_limit: number | null;
  card_sort: string;
  position: number;
  revision: number;
  archived_at: string | null;
  card_count: number;
};
export type WireCard = {
  id: string;
  board_id: string;
  stage_id: string;
  kind: "objective" | "record";
  title: string | null;
  rank: number;
  assignee_id: string | null;
  start_on: string | null;
  due_on: string | null;
  label_ids: string[];
  checklist: { done: number; total: number };
  archived_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  record: unknown;
};

export function wireStage(
  id: string,
  name: string,
  position: number,
  extra: Partial<WireStage> = {},
): WireStage {
  return {
    id,
    board_id: boardId,
    name,
    color: null,
    wip_limit: null,
    card_sort: "manual",
    position,
    revision: 1,
    archived_at: null,
    card_count: 0,
    ...extra,
  };
}

let cardCounter = 0;
export function cardIdFor(index: number) {
  return `00000000-0000-4000-8000-${String(0xf0000 + index)
    .padStart(12, "0")
    .slice(-12)}`;
}

export function wireCard(
  title: string | null,
  stageId: string,
  rank: number,
  extra: Partial<WireCard> = {},
): WireCard {
  cardCounter += 1;
  return {
    id: cardIdFor(cardCounter),
    board_id: boardId,
    stage_id: stageId,
    kind: "objective",
    title,
    rank,
    assignee_id: null,
    start_on: null,
    due_on: null,
    label_ids: [],
    checklist: { done: 0, total: 0 },
    archived_at: null,
    revision: 1,
    created_at: stamp,
    updated_at: stamp,
    record: null,
    ...extra,
  };
}

export const lockedCard = (stageId: string, rank: number) =>
  wireCard(null, stageId, rank, { kind: "record", record: { locked: true } });

export const quoteRecordSummary = {
  locked: false,
  record_id: recordIds.quote,
  module_id: recordIds.module,
  module_name: "Quotes",
  title: "Q-24112",
  fields: [
    {
      field_id: "00000000-0000-4000-8000-00000000e306",
      name: "Customer",
      value: "Pacific Rim Foods",
    },
  ],
  status: {
    field_id: "00000000-0000-4000-8000-00000000e307",
    name: "Status",
    value: "Sent",
  },
};

export const defaultStages = () => [
  wireStage(stageIds.todo, "To do", 0, { color: "chart-1" }),
  wireStage(stageIds.doing, "Doing", 1, { color: "chart-2" }),
  wireStage(stageIds.done, "Done", 2, { color: "chart-3" }),
];
export const defaultLabels = () => [
  {
    id: labelIds.expo,
    board_id: boardId,
    name: "Expo",
    color: "chart-4",
    position: 0,
    revision: 1,
  },
  {
    id: labelIds.pricing,
    board_id: boardId,
    name: "Pricing",
    color: "chart-2",
    position: 1,
    revision: 1,
  },
];

export type KanbanApiOptions = {
  level?: "read" | "write" | "manage";
  stages?: WireStage[];
  cards?: WireCard[];
  labels?: ReturnType<typeof defaultLabels>;
};

const MOVE_KEYS = new Set([
  "revision",
  "stage_id",
  "position",
  "title",
  "description",
  "assignee_id",
  "start_on",
  "due_on",
  "label_ids",
]);

export async function installKanbanApi(
  page: Page,
  options: KanbanApiOptions = {},
) {
  const level = options.level ?? "manage";
  await installBoardApi(
    page,
    () => true,
    level === "manage"
      ? managerAccess
      : level === "write"
        ? authorAccess
        : readerAccess,
  );
  const state = {
    stages: options.stages ?? defaultStages(),
    cards: options.cards ?? [],
    labels: options.labels ?? defaultLabels(),
    writes: [] as { method: string; path: string; body: unknown }[],
    cardReads: 0,
    /** Answer the next card change with a stale revision, as another person's save would. */
    staleNext: false,
  };
  const active = (stageId: string) =>
    state.cards
      .filter((card) => card.stage_id === stageId && card.archived_at === null)
      .sort((left, right) => left.rank - right.rank);
  const withCount = (stage: WireStage) => ({
    ...stage,
    card_count: active(stage.id).length,
  });
  const detail = (card: WireCard) => ({
    ...card,
    description: null,
    checklist_items: [],
  });
  const place = (card: WireCard, stageId: string, position?: number) => {
    const siblings = active(stageId).filter((item) => item.id !== card.id);
    const index =
      position === undefined
        ? siblings.length
        : Math.min(position, siblings.length);
    const ordered = [
      ...siblings.slice(0, index),
      card,
      ...siblings.slice(index),
    ];
    ordered.forEach((item, offset) => {
      item.stage_id = stageId;
      item.rank = (offset + 1) * 1024;
    });
  };

  await page.route(`**/api/users/*/card`, (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3];
    return people[id]
      ? route.fulfill({
          json: {
            display_name: people[id],
            job_title: null,
            avatar_url: null,
            email: null,
            phone: null,
            bio: null,
          },
        })
      : route.fulfill({ status: 404, json: { detail: "Not found" } });
  });

  await page.route(`**/api/boards/${boardId}/**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(`/api/boards/${boardId}`, "");
    const method = request.method();
    const body: Record<string, unknown> =
      method === "GET" ? {} : (request.postDataJSON() ?? {});
    const reply = (status: number, json: unknown) =>
      route.fulfill({ status, json });
    if (method !== "GET") state.writes.push({ method, path, body });
    const writer = level !== "read";
    const manager = level === "manage";

    if (path === "/stages" && method === "GET") {
      const items = state.stages
        .filter((stage) => stage.archived_at === null)
        .sort((left, right) => left.position - right.position)
        .map(withCount);
      return reply(200, {
        items,
        pagination: wirePagination({
          limit: 100,
          count: items.length,
          total: items.length,
        }),
      });
    }
    if (path === "/stages" && method === "POST") {
      if (!manager) return reply(403, { detail: "Forbidden" });
      const stage = wireStage(
        `00000000-0000-4000-8000-0000000e${String(state.stages.length + 10).padStart(4, "0")}`,
        String(body.name),
        state.stages.length,
        { color: (body.color as string | null) ?? null },
      );
      state.stages.push(stage);
      return reply(201, withCount(stage));
    }
    if (path === "/stages/order" && method === "PUT") {
      const ids = body.stage_ids as string[];
      ids.forEach((id, index) => {
        const stage = state.stages.find((item) => item.id === id);
        if (stage) stage.position = index;
      });
      return reply(200, {
        items: state.stages
          .filter((stage) => stage.archived_at === null)
          .sort((left, right) => left.position - right.position)
          .map(withCount),
      });
    }
    const stageMatch = path.match(/^\/stages\/([^/]+)(\/archive)?$/);
    if (stageMatch) {
      const stage = state.stages.find((item) => item.id === stageMatch[1]);
      if (!stage) return reply(404, { detail: "Stage not found" });
      if (body.revision !== stage.revision)
        return reply(409, {
          detail: { code: "stale_stage_revision", message: "Changed" },
        });
      if (stageMatch[2]) {
        for (const card of active(stage.id)) {
          if (body.cards === "move") place(card, String(body.target_stage_id));
          else card.archived_at = stamp;
        }
        stage.archived_at = stamp;
      } else {
        if (body.name !== undefined) stage.name = String(body.name);
        if (body.color !== undefined) stage.color = body.color as string | null;
        if (body.wip_limit !== undefined)
          stage.wip_limit = body.wip_limit as number | null;
        if (body.card_sort !== undefined)
          stage.card_sort = String(body.card_sort);
      }
      stage.revision += 1;
      return reply(200, withCount(stage));
    }

    if (path === "/cards" && method === "GET") {
      state.cardReads += 1;
      const items = state.cards
        .filter((card) => card.archived_at === null)
        .sort((left, right) => left.rank - right.rank);
      const limit = Number(url.searchParams.get("limit") ?? 25);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const slice = items.slice(offset, offset + limit);
      return reply(200, {
        items: slice,
        pagination: wirePagination({
          limit,
          offset,
          count: slice.length,
          total: items.length,
        }),
      });
    }
    if (path === "/cards" && method === "POST") {
      if (!writer) return reply(403, { detail: "Forbidden" });
      const card =
        body.kind === "record"
          ? wireCard(null, String(body.stage_id), 0, {
              kind: "record",
              record: quoteRecordSummary,
              start_on: (body.start_on as string | undefined) ?? null,
              due_on: (body.due_on as string | undefined) ?? null,
            })
          : wireCard(String(body.title), String(body.stage_id), 0);
      state.cards.push(card);
      place(card, card.stage_id);
      return reply(201, detail(card));
    }
    const cardMatch = path.match(/^\/cards\/([^/]+)(\/archive|\/restore)?$/);
    if (cardMatch) {
      const card = state.cards.find((item) => item.id === cardMatch[1]);
      if (!card) return reply(404, { detail: "Card not found" });
      if (method === "GET") return reply(200, detail(card));
      if (!writer) return reply(403, { detail: "Forbidden" });
      if (state.staleNext) {
        state.staleNext = false;
        card.revision += 1;
        return reply(409, {
          detail: {
            code: "stale_card_revision",
            message: "Changed by someone else; reload before saving",
            current_revision: card.revision,
          },
        });
      }
      if (body.revision !== card.revision)
        return reply(409, {
          detail: { code: "stale_card_revision", message: "Changed" },
        });
      if (cardMatch[2] === "/archive") card.archived_at = stamp;
      else if (cardMatch[2] === "/restore") {
        card.archived_at = null;
        place(card, card.stage_id);
      } else {
        if (Object.keys(body).some((key) => !MOVE_KEYS.has(key)))
          return reply(422, { detail: "Unexpected field" });
        if (body.label_ids !== undefined)
          card.label_ids = body.label_ids as string[];
        if (body.stage_id !== undefined || body.position !== undefined)
          place(
            card,
            (body.stage_id as string | undefined) ?? card.stage_id,
            body.position as number | undefined,
          );
      }
      card.revision += 1;
      return reply(200, detail(card));
    }

    if (path === "/labels" && method === "GET")
      return reply(200, {
        items: state.labels,
        pagination: wirePagination({
          limit: 100,
          count: state.labels.length,
          total: state.labels.length,
        }),
      });
    if (path === "/labels" && method === "POST") {
      const label = {
        id: `00000000-0000-4000-8000-0000000e${String(state.labels.length + 200).padStart(4, "0")}`,
        board_id: boardId,
        name: String(body.name),
        color: String(body.color),
        position: state.labels.length,
        revision: 1,
      };
      state.labels.push(label);
      return reply(201, label);
    }
    const labelMatch = path.match(/^\/labels\/([^/]+)$/);
    if (labelMatch) {
      const label = state.labels.find((item) => item.id === labelMatch[1]);
      if (!label) return reply(404, { detail: "Label not found" });
      if (method === "DELETE") {
        state.labels = state.labels.filter((item) => item !== label);
        for (const card of state.cards)
          card.label_ids = card.label_ids.filter((id) => id !== label.id);
        return route.fulfill({ status: 204, body: "" });
      }
      if (body.name !== undefined) label.name = String(body.name);
      if (body.color !== undefined) label.color = String(body.color);
      label.revision += 1;
      return reply(200, label);
    }
    return route.fallback();
  });

  // Find a record: the platform search, the module's fields, and the record.
  await page.route("**/api/search**", (route) => {
    const items = [
      {
        kind: "record",
        id: recordIds.quote,
        title: "Q-24112",
        context_label: "Quotes",
        module_id: recordIds.module,
        board_id: null,
        can_open: true,
      },
    ];
    return route.fulfill({
      json: {
        items,
        pagination: wirePagination({
          limit: 10,
          count: items.length,
          total: items.length,
        }),
      },
    });
  });
  const field = (id: string, name: string, type: string, position: number) => ({
    id,
    module_id: recordIds.module,
    name,
    type,
    required: false,
    position,
    config: {},
  });
  await page.route(
    `**/api/views/data-sources/${recordIds.module}/fields**`,
    (route) => {
      const items = [
        field(recordIds.title, "Quote", "text", 0),
        field(recordIds.validFrom, "Sent on", "date", 1),
        field(recordIds.validUntil, "Valid until", "date", 2),
      ];
      return route.fulfill({
        json: {
          items,
          pagination: wirePagination({
            limit: 100,
            count: items.length,
            total: items.length,
          }),
        },
      });
    },
  );
  await page.route(`**/api/records/${recordIds.quote}`, (route) =>
    route.fulfill({
      json: {
        id: recordIds.quote,
        module_id: recordIds.module,
        data: {
          [recordIds.title]: "Q-24112",
          [recordIds.validFrom]: "2026-09-20",
          [recordIds.validUntil]: "2026-10-13",
        },
        display_values: {},
        created_at: stamp,
        updated_at: stamp,
        deleted_at: null,
        is_deleted: false,
        performed_by: null,
      },
    }),
  );
  return state;
}
