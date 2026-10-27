import type { Page, Route } from "@playwright/test";
import { isEventStream, signedInAs } from "./test";
import { wireBoard } from "../../helpers/wire";
import { wirePagination } from "../../helpers/pagination";

/**
 * A board calendar backend for the Calendar tab journeys (P3a): one project
 * board, its events as occurrences, record-date sources with their window
 * reads, and due cards. Today is Wed, Nov 18, 2026 unless a journey says.
 */

export const calendarBoardId = "00000000-0000-4000-8000-000000000a01";
export const viewerId = "00000000-0000-4000-8000-000000000a02";
export const otherAuthorId = "00000000-0000-4000-8000-000000000a03";
export const quotesModuleId = "00000000-0000-4000-8000-000000000a04";
export const quotesDepartmentId = "00000000-0000-4000-8000-000000000a05";
export const validUntilFieldId = "00000000-0000-4000-8000-000000000a06";
export const quoteTitleFieldId = "00000000-0000-4000-8000-000000000a07";
export const quotesSourceId = "00000000-0000-4000-8000-000000000a08";
export const stageId = "00000000-0000-4000-8000-000000000a09";
export const reviewEventId = "00000000-0000-4000-8000-000000000b01";
export const expoEventId = "00000000-0000-4000-8000-000000000b02";
export const pricingEventId = "00000000-0000-4000-8000-000000000b03";
export const quoteEventId = "00000000-0000-4000-8000-000000000b04";
export const objectiveCardId = "00000000-0000-4000-8000-000000000c01";
export const lockedCardId = "00000000-0000-4000-8000-000000000c02";

const stamp = "2026-10-01T00:00:00Z";
export const calendarName = "Calendar board announcements";

type EventShape = {
  id: string;
  title: string;
  author: string;
  allDay: boolean;
  start: string;
  end: string;
  location?: string;
  recurrence?: "none" | "weekly";
  repeatUntil?: string | null;
};

export function wireEvent(shape: EventShape) {
  return {
    id: shape.id,
    board_id: calendarBoardId,
    author_id: shape.author,
    title: shape.title,
    details: "",
    location: shape.location ?? "",
    links: [],
    all_day: shape.allDay,
    start_date: shape.allDay ? shape.start : null,
    end_date: shape.allDay ? shape.end : null,
    start_at: shape.allDay ? null : shape.start,
    end_at: shape.allDay ? null : shape.end,
    timezone_name: "UTC",
    recurrence: shape.recurrence ?? "none",
    repeat_until: shape.repeatUntil ?? null,
    reminders: [],
    archived: false,
    revision: 1,
    board_revision: 1,
    created_at: stamp,
    updated_at: stamp,
  };
}

export function wireOccurrence(
  event: ReturnType<typeof wireEvent>,
  date: string,
  start: string,
  end: string,
) {
  const keyed = event.all_day || event.recurrence !== "none";
  return {
    id: `${event.id}:${keyed ? date : start}`,
    event_id: event.id,
    date,
    start,
    end,
    event,
  };
}

const review = wireEvent({
  id: reviewEventId,
  title: "Customer account review",
  author: viewerId,
  allDay: false,
  start: "2026-11-02T09:00:00Z",
  end: "2026-11-02T10:00:00Z",
  location: "Room 2",
  recurrence: "weekly",
  repeatUntil: "2026-12-28",
});
const expo = wireEvent({
  id: expoEventId,
  title: "Logistics expo",
  author: otherAuthorId,
  allDay: true,
  start: "2026-11-18",
  end: "2026-11-20",
});
const pricing = wireEvent({
  id: pricingEventId,
  title: "Pricing review",
  author: otherAuthorId,
  allDay: false,
  start: "2026-11-18T10:00:00Z",
  end: "2026-11-18T11:30:00Z",
  location: "Room 1",
});
const quotes = wireEvent({
  id: quoteEventId,
  title: "Quote approvals",
  author: otherAuthorId,
  allDay: false,
  start: "2026-11-18T10:30:00Z",
  end: "2026-11-18T11:30:00Z",
});

/** Every occurrence of the sample events, from Nov 2 to Dec 28. */
export function sampleOccurrences() {
  const mondays = Array.from({ length: 9 }, (_, week) => {
    const date = new Date(Date.UTC(2026, 10, 2 + week * 7));
    return date.toISOString().slice(0, 10);
  });
  return [
    ...mondays.map((date) =>
      wireOccurrence(review, date, `${date}T09:00:00Z`, `${date}T10:00:00Z`),
    ),
    wireOccurrence(expo, "2026-11-18", "2026-11-18", "2026-11-20"),
    wireOccurrence(
      pricing,
      "2026-11-18",
      "2026-11-18T10:00:00Z",
      "2026-11-18T11:30:00Z",
    ),
    wireOccurrence(
      quotes,
      "2026-11-18",
      "2026-11-18T10:30:00Z",
      "2026-11-18T11:30:00Z",
    ),
  ];
}

export const quotesSourceWire = {
  id: quotesSourceId,
  module_id: quotesModuleId,
  module_name: "Quotes",
  department_id: quotesDepartmentId,
  date_field_id: validUntilFieldId,
  field_name: "Valid until",
  field_type: "date",
  position: 0,
};

function quoteRecord(id: string, date: string, title: string) {
  return {
    id,
    module_id: quotesModuleId,
    data: { [validUntilFieldId]: date, [quoteTitleFieldId]: title },
    display_values: {},
    created_at: stamp,
    updated_at: stamp,
    deleted_at: null,
    is_deleted: false,
    performed_by: null,
  };
}

function dueCard(
  id: string,
  dueOn: string,
  patch: Record<string, unknown> = {},
) {
  return {
    id,
    board_id: calendarBoardId,
    stage_id: stageId,
    kind: "objective",
    title: "Update the price list",
    rank: 1,
    assignee_id: null,
    start_on: null,
    due_on: dueOn,
    label_ids: [],
    checklist: { done: 0, total: 0 },
    archived_at: null,
    revision: 1,
    created_at: stamp,
    updated_at: stamp,
    record: null,
    ...patch,
  };
}

export type CalendarApiOptions = {
  level?: "read" | "write" | "manage";
  today?: string;
  occurrences?: (window: { start: string; end: string }) => unknown[];
  nextOccurrence?: (window: {
    start: string;
    end: string;
  }) => { date: string } | null;
  sources?: (typeof quotesSourceWire)[];
  sourceFailures?: number;
};

export async function installCalendarApi(
  page: Page,
  options: CalendarApiOptions = {},
) {
  const level = options.level ?? "manage";
  const today = options.today ?? "2026-11-18";
  const state = {
    sources: options.sources ?? [quotesSourceWire],
    sourceFailures: options.sourceFailures ?? 0,
    windowReads: [] as { start: string; end: string }[],
    recordReads: [] as unknown[],
    sourceWrites: [] as { method: string; path: string; body: unknown }[],
    myCalendarWrites: [] as unknown[],
    eventListReads: [] as string[],
    limitRefusal: false,
  };
  const board = wireBoard({
    id: calendarBoardId,
    name: "Calendar board",
    description: "Board calendar",
    level,
    created_at: stamp,
    updated_at: stamp,
  });
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
        today,
        week_start: "monday",
        locale: "en-US",
        timezone: "UTC",
      },
    }),
  );
  await page.route(`**/api/modules/${quotesModuleId}`, (route) =>
    route.fulfill({
      json: {
        id: quotesModuleId,
        department_id: quotesDepartmentId,
        module_name: "Quotes",
        title_field_id: quoteTitleFieldId,
        is_deleted: false,
      },
    }),
  );
  await page.route(`**/api/fields/${quoteTitleFieldId}`, (route) =>
    route.fulfill({
      json: {
        id: quoteTitleFieldId,
        module_id: quotesModuleId,
        name: "Quote",
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
    if (state.sourceFailures > 0) {
      state.sourceFailures -= 1;
      return route.fulfill({ status: 503, json: { detail: "Unavailable" } });
    }
    const from = String(body.from_date);
    const to = String(body.to_date);
    const records = [
      quoteRecord(
        "00000000-0000-4000-8000-000000000d01",
        "2026-11-19",
        "Q-24112 Pacific Rim",
      ),
      quoteRecord(
        "00000000-0000-4000-8000-000000000d02",
        "2026-11-26",
        "Q-24125 Visayas",
      ),
    ].filter(
      (record) =>
        record.data[validUntilFieldId] >= from &&
        record.data[validUntilFieldId] <= to,
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
  await page.route("**/api/me/calendar-sources", (route) => {
    state.myCalendarWrites.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, json: quotesSourceWire });
  });
  await page.route("**/api/boards**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const prefix = `/api/boards/${calendarBoardId}`;
    if (path === "/api/boards")
      return route.fulfill({
        json: {
          items: [board],
          pagination: wirePagination({ limit: 100, count: 1, total: 1 }),
        },
      });
    if (path === prefix) return route.fulfill({ json: board });
    if (path === `${prefix}/my-access`)
      return route.fulfill({
        json: {
          level,
          read: true,
          write: level !== "read",
          manage: level === "manage",
        },
      });
    if (path === `${prefix}/events/occurrences`) {
      const window = {
        start: url.searchParams.get("window_start") ?? "",
        end: url.searchParams.get("window_end") ?? "",
      };
      state.windowReads.push(window);
      // The server matches the search in event titles, ignoring case.
      const search = (url.searchParams.get("search") ?? "").toLowerCase();
      const items = (
        options.occurrences ??
        (() =>
          sampleOccurrences().filter(
            (item) =>
              item.date <= window.end &&
              (item.event.all_day ? item.end : item.date) >= window.start,
          ))
      )(window).filter((item) =>
        (item as { event: { title: string } }).event.title
          .toLowerCase()
          .includes(search),
      );
      return route.fulfill({
        json: {
          items,
          pagination: wirePagination({
            limit: 100,
            count: items.length,
            total: items.length,
          }),
          board_revision: 1,
          next_occurrence: options.nextOccurrence
            ? (() => {
                const next = options.nextOccurrence(window);
                return next
                  ? {
                      id: `${reviewEventId}:${next.date}`,
                      event_id: reviewEventId,
                      start: next.date,
                      end: next.date,
                      date: next.date,
                    }
                  : null;
              })()
            : null,
        },
      });
    }
    if (path === `${prefix}/events`) {
      state.eventListReads.push(url.search);
      return route.fulfill({
        json: {
          items: [],
          pagination: wirePagination({ limit: 25, count: 0, total: 0 }),
          board_revision: 1,
        },
      });
    }
    const eventMatch = /\/events\/([0-9a-f-]{36})$/.exec(path);
    if (eventMatch) {
      const event = sampleOccurrences().find(
        (item) => item.event_id === eventMatch[1],
      )?.event;
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
    if (path === `${prefix}/calendar-sources`) {
      if (request.method() === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        state.sourceWrites.push({ method: "POST", path, body });
        if (state.limitRefusal)
          return route.fulfill({
            status: 409,
            json: {
              detail: {
                code: "calendar_source_limit",
                message: "A calendar holds at most 5 sources",
              },
            },
          });
        const added = {
          ...quotesSourceWire,
          id: "00000000-0000-4000-8000-000000000a10",
          date_field_id: String(body.date_field_id),
          field_name: "Sent on",
          position: state.sources.length,
        };
        state.sources = [...state.sources, added];
        return route.fulfill({ status: 201, json: added });
      }
      return route.fulfill({ json: { items: state.sources } });
    }
    const sourceMatch = /\/calendar-sources\/([0-9a-f-]{36})$/.exec(path);
    if (sourceMatch && request.method() === "DELETE") {
      state.sourceWrites.push({ method: "DELETE", path, body: null });
      state.sources = state.sources.filter(
        (source) => source.id !== sourceMatch[1],
      );
      return route.fulfill({ status: 204, body: "" });
    }
    if (path === `${prefix}/cards`) {
      const from = url.searchParams.get("due_from") ?? "";
      const to = url.searchParams.get("due_to") ?? "";
      const cards = [
        dueCard(objectiveCardId, "2026-11-20"),
        dueCard(lockedCardId, "2026-11-20", {
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
    if (path === `${prefix}/stages`)
      return route.fulfill({
        json: {
          items: [
            {
              id: stageId,
              board_id: calendarBoardId,
              name: "Doing",
              color: null,
              wip_limit: null,
              card_sort: "manual",
              position: 0,
              revision: 1,
              archived_at: null,
              card_count: 2,
            },
          ],
          pagination: wirePagination({ limit: 100, count: 1, total: 1 }),
        },
      });
    return route.fulfill({
      status: 404,
      json: { detail: "Not in this test" },
    });
  });
  return state;
}

export function calendarHref(params = "") {
  return `/boards?board=${calendarBoardId}&section=calendar${params}`;
}
