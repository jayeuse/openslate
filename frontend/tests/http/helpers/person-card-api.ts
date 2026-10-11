import { heldResponse, type Page } from "./test";
import { ids, mockAccessApi } from "./access-api";
import { boardId, board, installBoardApi } from "./boards-api";
import { installOpenViewEventSource } from "./openview-event-source";
import { avatarPng, profilePreferences } from "./profile-api";

export const cardTarget = ids.ana;
export const secondTarget = ids.ben;
export const cardViewer = ids.rosa;
export const secondViewer = "00000000-0000-4000-8000-000000000901";
export const cardPost = "00000000-0000-4000-8000-000000000902";
export const cardEvent = "00000000-0000-4000-8000-000000000903";
export const cardModule = "00000000-0000-4000-8000-000000000904";
export const cardView = "00000000-0000-4000-8000-000000000905";
export const cardRecord = "00000000-0000-4000-8000-000000000906";
const titleField = "00000000-0000-4000-8000-000000000907";
const userField = "00000000-0000-4000-8000-000000000908";
const stamp = "2026-09-25T00:00:00Z";

// Literal person card DTOs: no backend id, no department, no schema imports.
export const publicCard = {
  display_name: "Ana Santos",
  job_title: "Equipment coordinator" as string | null,
  avatar_url: null as string | null,
};
export const memberCard = {
  ...publicCard,
  email: "ana@example.test" as string | null,
  phone: "+1 555 0123" as string | null,
  bio: "Coordinates equipment and maintenance." as string | null,
};
export function cardPage(items: unknown[], limit = 100) {
  return {
    items,
    pagination: {
      limit,
      offset: 0,
      count: items.length,
      total: items.length,
      has_more: false,
    },
  };
}

export type CardSurface =
  "access" | "posts" | "openview" | "calendar" | "platform";

async function installSurface(
  page: Page,
  surface: CardSurface,
  primaryUser: boolean,
) {
  if (surface === "access") {
    await mockAccessApi(page);
    return "/access?view=people";
  }
  if (surface === "platform") {
    await page.route("**/api/search?*", (route) => {
      const url = new URL(route.request().url());
      const second = url.searchParams.get("search")?.includes("Ben");
      return route.fulfill({
        json: cardPage(
          url.searchParams.get("kind") === "person"
            ? [
                {
                  kind: "person",
                  id: second ? secondTarget : cardTarget,
                  title: second ? "Ben Cruz" : "Ana Santos",
                  context_label: "Equipment team",
                  module_id: null,
                  board_id: null,
                  can_open: true,
                },
              ]
            : [],
          10,
        ),
      });
    });
    return "/platform?section=search";
  }
  if (surface === "openview") {
    await page.route("**/api/departments?*", (route) =>
      route.fulfill({ json: cardPage([]) }),
    );
    const fields = [
      { id: titleField, name: "Title", type: "text", required: true },
      { id: userField, name: "Assignee", type: "user", required: false },
    ].map((field, position) => ({
      ...field,
      module_id: cardModule,
      position,
      config: {},
    }));
    const view = {
      id: cardView,
      module_id: cardModule,
      name: "Assigned equipment",
      is_default: false,
      definition: {
        version: 1,
        logic: "and",
        columns: [
          { field_id: titleField, expected_type: "text" },
          { field_id: userField, expected_type: "user" },
        ],
        filters: [],
        sort: [],
        deleted: "exclude",
        search: null,
        search_fields: [],
      },
      presentation: {
        version: 1,
        layout: "table",
        column_field_ids: [titleField, userField],
        pinned_field_ids: [],
        density: "comfortable",
        wrap: true,
        card_size: "comfortable",
        primary_field_id: titleField,
        secondary_field_id: userField,
        date_field_id: null,
        group_by_field_id: null,
        date_range: "month",
        scale: null,
      },
      revision: 1,
      is_deleted: false,
      can_edit: true,
      created_at: stamp,
      updated_at: stamp,
    };
    if (primaryUser) {
      view.definition.columns.reverse();
      view.presentation.column_field_ids.reverse();
      view.presentation.primary_field_id = userField;
      view.presentation.secondary_field_id = titleField;
    }
    const record = {
      id: cardRecord,
      module_id: cardModule,
      data: { [titleField]: "Pump inspection", [userField]: cardTarget },
      display_values: { [userField]: "Ana Santos" },
      created_at: stamp,
      updated_at: stamp,
      deleted_at: null,
      is_deleted: false,
      performed_by: cardViewer,
    };
    await page.route("**/api/views**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/views/data-sources")
        return route.fulfill({
          json: cardPage([
            {
              id: cardModule,
              name: "Equipment",
              department_id: ids.inventory,
              title_field_id: titleField,
            },
          ]),
        });
      if (path === `/api/views/data-sources/${cardModule}/fields`)
        return route.fulfill({ json: cardPage(fields) });
      if (path === "/api/views")
        return route.fulfill({ json: cardPage([view]) });
      if (path === `/api/views/${cardView}`)
        return route.fulfill({ json: view });
      return route.fallback();
    });
    await page.route("**/api/records/query", (route) =>
      route.fulfill({ json: cardPage([record], 25) }),
    );
    await page.route(`**/api/records/${cardRecord}`, (route) =>
      route.fulfill({ json: record }),
    );
    await page.route(
      `**/api/modules/${cardModule}/assignable-users*`,
      (route) =>
        route.fulfill({
          json: cardPage([
            { id: cardTarget, username: "ana", display_name: "Ana Santos" },
          ]),
        }),
    );
    return `/openview?section=views&module=${cardModule}&view=${cardView}`;
  }
  await installBoardApi(page, () => true);
  const post = {
    id: cardPost,
    board_id: boardId,
    author_id: cardTarget,
    title: "Maintenance update",
    body: "Inspect the pump before the next shift.",
    links: [],
    status: "published",
    publish_at: stamp,
    expires_at: null,
    pinned: false,
    post_revision: null,
    board_revision: 1,
    publication_number: 2,
    published_at: stamp,
    edited: true,
    created_at: stamp,
    updated_at: stamp,
  };
  const event = {
    id: cardEvent,
    board_id: boardId,
    author_id: cardTarget,
    title: "Equipment handover",
    details: "Bring the equipment checklist.",
    location: "Workshop",
    links: [],
    all_day: true,
    start_date: "2026-09-25",
    end_date: "2026-09-25",
    start_at: null,
    end_at: null,
    timezone_name: "UTC",
    recurrence: "none",
    repeat_until: null,
    reminders: [],
    archived: false,
    revision: 1,
    board_revision: 1,
    created_at: stamp,
    updated_at: stamp,
  };
  await page.route("**/api/boards**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const prefix = `/api/boards/${boardId}`;
    if (path === "/api/boards")
      return route.fulfill({ json: cardPage([board], 25) });
    if (path === `${prefix}/post-authors`)
      return route.fulfill({
        json: cardPage(
          [{ id: cardTarget, label: "Ana Santos" }],
          Number(url.searchParams.get("limit") ?? 25),
        ),
      });
    if (path === `${prefix}/posts`)
      return route.fulfill({
        json: {
          ...cardPage(
            url.searchParams.get("view") === "published" ? [post] : [],
            Number(url.searchParams.get("limit") ?? 25),
          ),
          board_revision: 1,
        },
      });
    if (path === `${prefix}/posts/${cardPost}`)
      return route.fulfill({ json: post });
    const revisions = [2, 1].map((number) => ({
      id: `00000000-0000-4000-8000-00000000091${number}`,
      post_id: cardPost,
      author_id: cardTarget,
      publication_number: number,
      title: "Maintenance update",
      published_at: stamp,
    }));
    if (path === `${prefix}/posts/${cardPost}/revisions`)
      return route.fulfill({ json: { post_id: cardPost, items: revisions } });
    if (path.startsWith(`${prefix}/posts/${cardPost}/revisions/`))
      return route.fulfill({
        json: {
          ...revisions[0],
          body: post.body,
          links: [],
          expires_at: null,
        },
      });
    if (path === `${prefix}/events/occurrences`)
      return route.fulfill({
        json: {
          ...cardPage([
            {
              id: `${cardEvent}:2026-09-25`,
              event_id: cardEvent,
              date: "2026-09-25",
              start: "2026-09-25",
              end: "2026-09-25",
              event,
            },
            {
              id: "00000000-0000-4000-8000-000000000920:2026-09-25",
              event_id: "00000000-0000-4000-8000-000000000920",
              date: "2026-09-25",
              start: "2026-09-25",
              end: "2026-09-25",
              event: {
                ...event,
                id: "00000000-0000-4000-8000-000000000920",
                title: "Workshop briefing",
              },
            },
          ]),
          board_revision: 1,
        },
      });
    if (path === `${prefix}/events/${cardEvent}`)
      return route.fulfill({ json: event });
    if (path.endsWith("/attachments") || path.endsWith("/record-links"))
      return route.fulfill({
        json: { items: [], limit: 20, offset: 0, has_more: false },
      });
    return route.fallback();
  });
  return `/boards?board=${boardId}&section=${surface === "posts" ? "posts" : "calendar"}`;
}

export async function installPersonCardApi(
  page: Page,
  surface: CardSurface = "platform",
  role: "admin" | "member" | "guest" = "member",
  primaryUser = false,
) {
  const href = await installSurface(page, surface, primaryUser);
  await installOpenViewEventSource(page);
  const state = {
    href,
    viewer: cardViewer,
    role,
    theme: "light",
    status: 200,
    avatarStatus: 200,
    cards: new Map<string, unknown>([
      [cardTarget, { ...(role === "guest" ? publicCard : memberCard) }],
      [
        secondTarget,
        {
          ...(role === "guest" ? publicCard : memberCard),
          display_name: "Ben Cruz",
          ...(role === "guest" ? {} : { email: "ben@example.test" }),
        },
      ],
    ]),
    reads: [] as { viewer: string; target: string }[],
    avatarReads: [] as string[],
    writes: [] as string[],
    hold: null as ReturnType<typeof heldResponse> | null,
    holdAvatar: null as ReturnType<typeof heldResponse> | null,
    avatarFault: null as "mime" | "headers" | "empty" | "oversize" | null,
  };
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      path.startsWith("/api/") &&
      !["GET", "HEAD"].includes(request.method()) &&
      path !== "/api/records/query"
    )
      state.writes.push(`${request.method()} ${path}`);
  });
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user_id: state.viewer,
        setup_required: false,
      },
    }),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { id: state.viewer, role: state.role, access: [] } }),
  );
  await page.route("**/api/users/*/preferences", (route) =>
    route.fulfill({
      json: {
        ...profilePreferences(state.viewer, { motion: "reduce" }),
        theme: state.theme,
      },
    }),
  );
  await page.route("**/api/users/*/card", async (route) => {
    const target = new URL(route.request().url()).pathname.split("/")[3];
    const body = state.cards.get(target);
    const status = state.status;
    state.reads.push({ viewer: state.viewer, target });
    const hold = state.hold;
    state.hold = null;
    hold?.enter();
    if (hold) await hold.released;
    await route.fulfill({
      status,
      headers: { "Cache-Control": "private, no-store" },
      json:
        status === 200
          ? body
          : { detail: "Private source exception must not be shown" },
    });
  });
  await page.route("**/api/users/*/avatar", async (route) => {
    state.avatarReads.push(new URL(route.request().url()).pathname);
    // Every read waits while the gate is closed: a Strict Mode remount can
    // abort the first read and send a second one.
    const hold = state.holdAvatar;
    hold?.enter();
    if (hold) await hold.released;
    await route.fulfill({
      status: state.avatarStatus,
      contentType: state.avatarFault === "mime" ? "image/svg+xml" : "image/png",
      headers:
        state.avatarFault === "headers"
          ? {}
          : {
              "Cache-Control": "private, no-store",
              "X-Content-Type-Options": "nosniff",
            },
      body:
        state.avatarFault === "empty"
          ? Buffer.alloc(0)
          : state.avatarFault === "oversize"
            ? Buffer.alloc(2 * 1024 * 1024 + 1)
            : avatarPng,
    });
  });
  return state;
}
