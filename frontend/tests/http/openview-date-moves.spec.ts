import { expect, type Locator, type Page } from "@playwright/test";
import { test, isEventStream } from "./helpers/test";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";
import { pageOf } from "../helpers/pagination";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const moduleId = id(1900);
const departmentId = id(1901);
const viewId = id(1902);
const titleId = id(1903);
const startId = id(1904);
const endId = id(1905);
const noteId = id(1906);
const recordId = id(1910);
const revision = "2026-03-05T12:00:00Z";
const url = `/openview?section=views&module=${moduleId}&view=${viewId}`;
type Change = { field_id: string; value: string | boolean | null };
type Item = { record_id: string; revision: string } & (
  { changes: Change[] } | Change
);
type Batch = { module_id: string; items: Item[] };
type Row = {
  id: string;
  module_id: string;
  data: Record<string, string | boolean | null>;
  display_values: Record<string, string>;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  is_deleted: boolean;
  performed_by: string;
};
type WindowRequest = {
  mode: "calendar" | "timeline";
  scope: "window" | "undated" | "unscheduled";
  limit: number;
  offset: number;
  from_date?: string;
  to_date?: string;
  definition: { search: string | null };
};
async function installDates(
  page: Page,
  options: {
    layout?: "calendar" | "timeline";
    startType?: "date" | "datetime";
    endType?: "date" | "datetime";
    start?: string | null;
    end?: string | null;
    timezone?: string;
    undated?: number;
    level?: "read" | "write";
  } = {},
) {
  await page.clock.setFixedTime(new Date(revision));
  await installOpenViewEventSource(page);
  const startType = options.startType ?? "date";
  const endType = options.endType ?? "date";
  const zone = options.timezone ?? "America/New_York";
  let level = options.level ?? "write";
  const makeRow = (
    index: number,
    start: string | null,
    end: string | null,
  ): Row => ({
    id: id(1910 + index),
    module_id: moduleId,
    data: {
      [titleId]: `Task ${index + 1}`,
      [startId]: start,
      [endId]: end,
      [noteId]: `Keep note ${index + 1}`,
    },
    display_values: {},
    created_at: revision,
    updated_at: revision,
    deleted_at: null,
    is_deleted: false,
    performed_by: id(1),
  });
  const rows = new Map<string, Row>([
    [
      recordId,
      makeRow(
        0,
        options.start === undefined ? "2026-03-05" : options.start,
        options.end === undefined ? "2026-03-10" : options.end,
      ),
    ],
    [
      id(1911),
      makeRow(
        1,
        startType === "datetime" ? "2026-03-12T12:00:00Z" : "2026-03-12",
        endType === "datetime" ? "2026-03-15T12:00:00Z" : "2026-03-15",
      ),
    ],
    ...Array.from({ length: options.undated ?? 0 }, (_, i): [string, Row] => [
      id(1912 + i),
      makeRow(i + 2, null, null),
    ]),
  ]);
  const fields = [
    { id: titleId, name: "Name", type: "text" },
    { id: startId, name: "Start", type: startType },
    { id: endId, name: "End", type: endType },
    { id: noteId, name: "Note", type: "long_text" },
  ].map((field, position) => ({
    ...field,
    position,
    module_id: moduleId,
    config: {},
    required: false,
  }));
  const saved = {
    id: viewId,
    module_id: moduleId,
    name: "Delivery schedule",
    is_default: false,
    revision: 1,
    is_deleted: false,
    can_edit: false,
    created_at: revision,
    updated_at: revision,
    definition: {
      version: 1,
      columns: fields.map((field) => ({
        field_id: field.id,
        expected_type: field.type,
      })),
      filters: [],
      logic: "and",
      sort: [],
      deleted: "exclude",
      search: null,
      search_fields: [],
    },
    presentation: {
      version: 1,
      layout: options.layout ?? "timeline",
      column_field_ids: fields.map((field) => field.id),
      pinned_field_ids: [],
      density: "comfortable",
      wrap: false,
      card_size: "comfortable",
      primary_field_id: titleId,
      secondary_field_id: noteId,
      date_field_id: startId,
      group_by_field_id: null,
      date_range: "month",
      scale: "month",
      timeline_start_field_id: startId,
      timeline_end_field_id: endId,
      timeline_deadline_field_id: null,
      timeline_progress_field_id: null,
    },
  };
  const batches: Batch[] = [];
  const windows: WindowRequest[] = [];
  let fault: string | null = null;
  let outcome: "stale" | "invalid" | "forbidden" | null = null;
  let held: Promise<void> | null = null;
  let denied = false;
  let authReads = 0;
  let recordReads = 0;
  let writes = 0;
  let version = 0;
  const localDay = (value: string | boolean | null, type: string) => {
    if (typeof value !== "string") return null;
    if (type === "date") return value;
    const instant = new Date(
      /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value}Z`,
    );
    if (Number.isNaN(instant.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
    return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}-${parts.find((p) => p.type === "day")!.value}`;
  };
  await page.route("**/api/**", async (route) => {
    if (isEventStream(route)) return route.fallback();
    const request = route.request();
    const target = new URL(request.url());
    const path = target.pathname;
    const limit = Number(target.searchParams.get("limit") ?? 100);
    const offset = Number(target.searchParams.get("offset") ?? 0);
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        headers: { "Cache-Control": "no-store" },
        json: body,
      });
    if (
      request.method() !== "GET" &&
      path !== "/api/records/window-query" &&
      path !== "/api/records/query"
    )
      writes++;
    if (path === "/api/auth/session")
      return json({
        authenticated: true,
        user_id: id(1),
        default_organization_blocked: null,
        setup_required: false,
      });
    if (path === "/api/auth/me") {
      authReads++;
      return json({
        id: id(1),
        role: "member",
        default_organization_blocked: null,
        access: [{ department_id: departmentId, module_id: moduleId, level }],
      });
    }
    if (path === "/api/workspace")
      return json({
        id: id(102),
        display_name: "OpenSlate",
        legal_name: null,
        description: null,
        logo_file_id: null,
        mark: "OS",
        currency: "USD",
        business_hours: "09:00–18:00",
        theme: "slate",
        revision: 1,
        today: "2026-03-05",
        purge_enabled: false,
        locale: "en-US",
        timezone: zone,
        week_start: "monday",
      });
    if (path === "/api/views/data-sources")
      return json(
        pageOf(
          [
            {
              id: moduleId,
              department_id: departmentId,
              name: "Work items",
              title_field_id: titleId,
            },
          ],
          { limit },
        ),
      );
    if (path === `/api/views/data-sources/${moduleId}/fields`)
      return json(pageOf(fields, { limit }));
    if (
      path === `/api/departments/${departmentId}` ||
      path === "/api/departments"
    ) {
      const department = {
        id: departmentId,
        department_name: "Operations",
        created_at: revision,
        updated_at: revision,
        deleted_at: null,
        is_deleted: false,
        performed_by: null,
      };
      return json(
        path === "/api/departments"
          ? pageOf([department], { limit })
          : department,
      );
    }
    if (path === "/api/views") return json(pageOf([saved], { limit }));
    if (path === `/api/views/${viewId}`) return json(saved);
    if (path === "/api/records/window-query") {
      const body = request.postDataJSON() as WindowRequest;
      windows.push(body);
      if (denied) return json({ detail: "Private window canary" }, 403);
      const selected = [...rows.values()].filter((row) => {
        const start = localDay(row.data[startId], startType);
        const end = localDay(row.data[endId], endType);
        if (body.scope === "undated") return start === null;
        if (body.scope === "unscheduled") return !start || !end;
        if (!start) return false;
        return body.mode === "calendar"
          ? start >= body.from_date! && start <= body.to_date!
          : !!end && start <= body.to_date! && end >= body.from_date!;
      });
      return json({
        ...pageOf(selected.slice(body.offset, body.offset + body.limit), {
          limit: body.limit,
          offset: body.offset,
          total: selected.length,
        }),
        timezone:
          startType === "datetime" || endType === "datetime" ? zone : null,
      });
    }
    if (path === "/api/records/batch-update") {
      const batch = request.postDataJSON() as Batch;
      batches.push(batch);
      await held;
      const results = batch.items.map((item) => {
        const before = rows.get(item.record_id);
        const changes =
          "changes" in item
            ? item.changes
            : [{ field_id: item.field_id, value: item.value }];
        if (!before || level === "read")
          return { record_id: item.record_id, status: "forbidden" };
        if (item.revision !== before.updated_at)
          return { record_id: item.record_id, status: "stale" };
        if (outcome && item.record_id === id(1911)) {
          if (outcome === "forbidden") level = "read";
          return outcome === "invalid"
            ? {
                record_id: item.record_id,
                status: "invalid",
                errors: [
                  {
                    code: "invalid_date",
                    field_id: endId,
                    message: "Invalid date",
                  },
                ],
                truncated: false,
              }
            : { record_id: item.record_id, status: outcome };
        }
        if (
          changes.length < 1 ||
          changes.length > 2 ||
          new Set(changes.map((c) => c.field_id)).size !== changes.length
        )
          throw new Error("Unfaithful compound request");
        version++;
        const updated: Row = {
          ...before,
          data: {
            ...before.data,
            ...Object.fromEntries(changes.map((c) => [c.field_id, c.value])),
          },
          updated_at: `2026-03-05T12:${String(version).padStart(2, "0")}:00Z`,
        };
        rows.set(item.record_id, updated);
        return {
          record_id: item.record_id,
          status: "updated",
          record: structuredClone(updated),
        };
      });
      const failure = fault;
      fault = null;
      if (failure === "503")
        return json({ detail: "Private batch canary" }, 503);
      if (failure === "missing") return json({ results: [] });
      return json({ results });
    }
    const record = path.match(/^\/api\/records\/([^/]+)$/)?.[1];
    if (record && request.method() === "GET") {
      recordReads++;
      return json(rows.get(record), rows.has(record) ? 200 : 404);
    }
    if (path === "/api/records/query") {
      recordReads++;
      return json(
        pageOf([...rows.values()].slice(offset, offset + limit), {
          limit,
          offset,
          total: rows.size,
        }),
      );
    }
    return route.fallback();
  });
  return {
    rows,
    batches,
    windows,
    authReads: () => authReads,
    recordReads: () => recordReads,
    writes: () => writes,
    fail: (value: string) => {
      fault = value;
    },
    outcome: (value: typeof outcome) => {
      outcome = value;
    },
    deny: () => {
      denied = true;
    },
    changeAccess: (next: typeof level) => {
      level = next;
    },
    hold: () => {
      let release!: () => void;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

function card(page: Page, title = "Task 1") {
  return page
    .getByRole("article")
    .filter({
      has: page.getByRole("button", {
        name: `Open record: ${title}`,
        exact: true,
      }),
    })
    .filter({ visible: true });
}
async function moveDialog(
  page: Page,
  title = "Task 1",
  action = "Move start date…",
) {
  const trigger = card(page, title).getByRole("button", {
    name: "Move to…",
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: action, exact: true }).click();
  return page.getByRole("dialog", { name: `Move ${title}`, exact: true });
}
async function stage(
  page: Page,
  date: string,
  title = "Task 1",
  action = "Move start date…",
) {
  const dialog = await moveDialog(page, title, action);
  await dialog
    .getByLabel(
      action === "Resize end date…"
        ? "End date"
        : action === "Move date…"
          ? "Move date"
          : "Start date",
      { exact: true },
    )
    .fill(date);
  await dialog.getByRole("button", { name: "Stage move", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
async function drag(page: Page, from: Locator, to: { x: number; y: number }) {
  const box = await from.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
  // Legacy core suppresses the release click for 50ms. Advance that owned
  // sensor cleanup on the installed clock before the separate Save action.
  await page.clock.runFor(60);
}

test("Timeline stages one atomic interval through repeated moves, end resize, and a layout remount", async ({
  page,
}) => {
  const api = await installDates(page);
  await page.goto(url);
  await stage(page, "2026-03-07");
  await expect(card(page)).toContainText("Unsaved");
  await expect(card(page)).toContainText("2026-03-07");
  await expect(card(page)).toContainText("2026-03-12");
  expect(api.batches).toEqual([]);
  await stage(page, "2026-03-15", "Task 1", "Resize end date…");
  await page.getByRole("tab", { name: "Calendar", exact: true }).click();
  await page.getByRole("tab", { name: "Timeline", exact: true }).click();
  await stage(page, "2026-03-08");
  const save = page.getByRole("button", {
    name: "Save changes (1)",
    exact: true,
  });
  await expect(save).toBeVisible();
  await save.click();
  await expect(save).toHaveCount(0);
  expect(api.batches).toEqual([
    {
      module_id: moduleId,
      items: [
        {
          record_id: recordId,
          revision,
          changes: [
            { field_id: startId, value: "2026-03-08" },
            { field_id: endId, value: "2026-03-16" },
          ],
        },
      ],
    },
  ]);
  expect(api.rows.get(recordId)?.data).toEqual({
    [titleId]: "Task 1",
    [startId]: "2026-03-08",
    [endId]: "2026-03-16",
    [noteId]: "Keep note 1",
  });
});

test("Calendar preserves workspace wall time and fractional seconds across DST and reads undated pages only on intent", async ({
  page,
}) => {
  const api = await installDates(page, {
    layout: "calendar",
    startType: "datetime",
    start: "2026-03-07T14:15:30.123456Z",
    end: "2026-03-10",
    undated: 26,
  });
  await page.goto(url);
  await expect(card(page)).toBeVisible();
  expect(api.windows.filter((w) => w.scope === "undated")).toEqual([]);
  await stage(page, "2026-03-08", "Task 1", "Move date…");
  await page
    .getByRole("button", { name: "Save changes (1)", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved 1 move." }),
  ).toBeVisible();
  expect(api.batches[0]).toEqual({
    module_id: moduleId,
    items: [
      {
        record_id: recordId,
        revision,
        field_id: startId,
        value: "2026-03-08T13:15:30.123456Z",
      },
    ],
  });
  await page
    .getByRole("button", { name: "Show undated move list", exact: true })
    .click();
  const undated = page.getByRole("region", {
    name: "Undated move list",
    exact: true,
  });
  await expect(undated.getByRole("article")).toHaveCount(25);
  expect(api.windows.at(-1)).toMatchObject({
    mode: "calendar",
    scope: "undated",
    limit: 25,
    offset: 0,
  });
  await undated.getByRole("button", { name: "Go to next page" }).click();
  await expect(undated.getByRole("article")).toHaveCount(1);
  expect(api.windows.at(-1)).toMatchObject({
    scope: "undated",
    limit: 25,
    offset: 25,
  });
  const dialog = await moveDialog(page, "Task 28", "Move date…");
  await expect(dialog).toContainText("00:00");
  await dialog.getByLabel("Move date", { exact: true }).fill("2026-03-09");
  await dialog.getByRole("button", { name: "Stage move" }).click();
  await expect(undated).toContainText("Unsaved");
  await page.getByRole("button", { name: "Save changes (1)" }).click();
  await expect(undated.getByRole("article")).toHaveCount(0);
  expect(api.batches[1]).toEqual({
    module_id: moduleId,
    items: [
      {
        record_id: id(1937),
        revision,
        field_id: startId,
        value: "2026-03-09T04:00:00Z",
      },
    ],
  });
});

test("nonexistent workspace times refuse staging and overlaps require an explicit offset", async ({
  page,
}) => {
  const api = await installDates(page, {
    layout: "calendar",
    startType: "datetime",
    start: "2026-03-07T07:30:45.678Z",
  });
  await page.goto(url);
  let dialog = await moveDialog(page, "Task 1", "Move date…");
  await dialog.getByLabel("Move date", { exact: true }).fill("2026-03-08");
  await dialog.getByRole("button", { name: "Stage move" }).click();
  await expect(dialog.getByRole("alert")).toContainText("does not exist");
  expect(api.batches).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  api.rows.set(recordId, {
    ...api.rows.get(recordId)!,
    data: {
      ...api.rows.get(recordId)!.data,
      [startId]: "2026-03-07T06:30:45.678Z",
    },
  });
  await sendOpenViewEvent(page, "invalidate", { entity: "records" });
  await expect(card(page)).toContainText("1:30");
  dialog = await moveDialog(page, "Task 1", "Move date…");
  await dialog.getByLabel("Move date", { exact: true }).fill("2026-11-01");
  await dialog.getByRole("button", { name: "Stage move" }).click();
  await expect(dialog.getByRole("alert")).toContainText("occurs twice");
  await dialog
    .getByRole("combobox", { name: "Start UTC offset", exact: true })
    .selectOption("-05:00");
  await dialog.getByRole("button", { name: "Stage move" }).click();
  await page.getByRole("button", { name: "Save changes (1)" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved 1 move." }),
  ).toBeVisible();
  expect(api.batches[0].items[0]).toEqual({
    record_id: recordId,
    revision,
    field_id: startId,
    value: "2026-11-01T06:30:45.678Z",
  });
});

test("Timeline pointer shift uses unclipped dates and its end handle changes only end", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1600 });
  await page.clock.install({ time: new Date(revision) });
  const api = await installDates(page, {
    start: "2026-02-27",
    end: "2026-03-05",
  });
  await page.goto(url);
  const track = card(page).getByRole("group", {
    name: "Task 1 timeline track",
    exact: true,
  });
  const box = await track.boundingBox();
  expect(box).not.toBeNull();
  const handle = card(page).getByRole("button", {
    name: "Shift interval: Task 1",
    exact: true,
  });
  const source = await handle.boundingBox();
  await drag(page, handle, {
    x: source!.x + source!.width / 2 + (box!.width * 2) / 31,
    y: source!.y + source!.height / 2,
  });
  await expect(
    page.getByRole("button", { name: "Save changes (1)" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save changes (1)" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved 1 move." }),
  ).toBeVisible();
  expect(api.batches[0].items[0]).toEqual({
    record_id: recordId,
    revision,
    changes: [
      { field_id: startId, value: "2026-03-01" },
      { field_id: endId, value: "2026-03-07" },
    ],
  });
  const resize = card(page).getByRole("button", {
    name: "Resize end: Task 1",
    exact: true,
  });
  await expect(resize).toBeVisible();
  const resizeBox = await resize.boundingBox();
  const nextTrack = await track.boundingBox();
  await drag(page, resize, {
    x: resizeBox!.x + resizeBox!.width / 2 + nextTrack!.width / 31,
    y: resizeBox!.y + resizeBox!.height / 2,
  });
  await page.getByRole("button", { name: "Save changes (1)" }).click();
  await expect.poll(() => api.batches.length).toBe(2);
  expect(api.batches[1].items[0]).toEqual({
    record_id: recordId,
    revision: "2026-03-05T12:01:00Z",
    field_id: endId,
    value: "2026-03-08",
  });
});

test("Calendar drops an undated card on a visible day without an eager read or write", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1600 });
  await page.clock.install({ time: new Date(revision) });
  const api = await installDates(page, { layout: "calendar", undated: 1 });
  await page.goto(url);
  await expect(card(page)).toBeVisible();
  expect(api.windows.some((w) => w.scope === "undated")).toBe(false);
  await page
    .getByRole("button", { name: "Show undated move list", exact: true })
    .click();
  const source = card(page, "Task 3").getByRole("button", {
    name: "Drag date: Task 3",
    exact: true,
  });
  // The loaded move list shifts the grid. Measure only after its source exists.
  await expect(source).toBeVisible();
  const day = page.getByRole("group", {
    name: "Move to 2026-03-09",
    exact: true,
  });
  // A drop point below the viewport starts auto-scroll, which moves the grid
  // under the pointer by a timing-dependent amount; drop on a visible point.
  await day.scrollIntoViewIfNeeded();
  await expect(source).toBeInViewport();
  const target = await day.boundingBox();
  await drag(page, source, {
    x: target!.x + target!.width / 2,
    y: target!.y + target!.height / 2,
  });
  await expect(card(page, "Task 3")).toContainText("2026-03-09");
  expect(api.batches).toEqual([]);
  await page.getByRole("button", { name: "Save changes (1)" }).click();
  await expect.poll(() => api.batches.length).toBe(1);
  expect(api.batches[0].items[0]).toEqual({
    record_id: id(1912),
    revision,
    field_id: startId,
    value: "2026-03-09",
  });
});

test("phone keyboard Move to can cancel, reject a reversed end, compose, and return to the original interval", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await installDates(page);
  await page.goto(url);
  let dialog = await moveDialog(page);
  await dialog.getByLabel("Start date", { exact: true }).fill("2026-03-07");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    card(page).getByRole("button", { name: "Move to…" }),
  ).toBeFocused();
  await stage(page, "2026-03-07");
  dialog = await moveDialog(page, "Task 1", "Resize end date…");
  await dialog.getByLabel("End date", { exact: true }).fill("2026-03-06");
  await dialog.getByRole("button", { name: "Stage move" }).click();
  await expect(dialog.getByRole("alert")).toContainText("on or after");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(card(page)).toContainText("2026-03-12");
  await stage(page, "2026-03-05");
  await expect(
    page.getByRole("button", { name: "Save changes (1)" }),
  ).toHaveCount(0);
  expect(api.batches).toEqual([]);
});

for (const outcome of ["stale", "invalid", "forbidden"] as const) {
  test(`partial ${outcome} keeps the failed card and announces the successful move once`, async ({
    page,
  }) => {
    const api = await installDates(page);
    await page.goto(url);
    await stage(page, "2026-03-06");
    await stage(page, "2026-03-13", "Task 2");
    api.outcome(outcome);
    const authBefore = api.authReads();
    await page.getByRole("button", { name: "Save changes (2)" }).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Saved 1 move. 1 move needs review." }),
    ).toHaveCount(1);
    await expect(card(page, "Task 1")).not.toContainText("Unsaved");
    await expect(card(page, "Task 2")).toContainText(
      outcome === "stale"
        ? "Changed by someone else — review"
        : outcome === "invalid"
          ? "Invalid date"
          : "no longer have permission",
    );
    expect(api.rows.get(id(1911))?.data[startId]).toBe("2026-03-12");
    if (outcome === "forbidden") {
      await expect.poll(api.authReads).toBeGreaterThan(authBefore);
      await expect(
        page.getByRole("button", { name: "Move to…", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Save changes (1)" }),
      ).toBeDisabled();
    } else {
      await card(page, "Task 2")
        .getByRole("button", { name: "Review latest" })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Record details" }),
      ).toBeVisible();
      await expect.poll(api.recordReads).toBeGreaterThan(0);
      await expect(
        page
          .getByRole("dialog", { name: "Record details" })
          .getByRole("heading", { name: "Task 2", exact: true }),
      ).toBeVisible();
    }
  });
}

// The other receipt faults (half, duplicate, foreign, module, deleted) are
// owned by isolated/openview/record-move-receipts.spec.ts.
for (const fault of ["missing", "503"]) {
  test(`${fault} compound receipt refreshes reads but retains the original pending revision without retry`, async ({
    page,
  }) => {
    const api = await installDates(page);
    await page.goto(url);
    await stage(page, "2026-03-07");
    api.fail(fault);
    const before = api.windows.length;
    const save = page.getByRole("button", { name: "Save changes (1)" });
    await save.click();
    await expect(
      page.getByRole("alert").filter({ hasText: "could not be confirmed" }),
    ).toBeVisible();
    await expect.poll(() => api.windows.length).toBeGreaterThan(before);
    await expect(card(page)).toContainText("Mar 7");
    await expect(save).toBeEnabled();
    expect(api.batches).toHaveLength(1);
    await expect(page.getByRole("main")).not.toContainText(
      "Private batch canary",
    );
    await save.click();
    await expect(card(page)).toContainText("Changed by someone else — review");
    expect(api.batches[1].items[0].revision).toBe(revision);
  });
}

test("held Save blocks duplicate staging and read refusal withdraws date controls and pending metadata", async ({
  page,
}) => {
  const api = await installDates(page);
  await page.goto(url);
  await stage(page, "2026-03-07");
  const release = api.hold();
  await page.getByRole("button", { name: "Save changes (1)" }).click();
  await expect.poll(() => api.batches.length).toBe(1);
  await expect(
    card(page).getByRole("button", { name: "Move to…" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Save changes (1)", exact: true }),
  ).toBeDisabled();
  release();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved 1 move." }),
  ).toBeVisible();
  await stage(page, "2026-03-08");
  api.deny();
  await sendOpenViewEvent(page, "invalidate", { entity: "records" });
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "OpenView data is unavailable" })
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Move to…", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save changes (1)" }),
  ).toBeDisabled();
  await expect(page.getByRole("main")).not.toContainText("Task 1");
  expect(api.batches).toHaveLength(1);
});

test("incomplete intervals and read-only access never expose functioning move controls", async ({
  page,
}) => {
  const api = await installDates(page, {
    start: null,
    end: null,
    level: "read",
  });
  await page.goto(url);
  await page
    .getByRole("button", { name: "Unscheduled records", exact: true })
    .click();
  await expect(card(page)).toBeVisible();
  await expect(
    card(page).getByRole("button", { name: "Move to…" }),
  ).toHaveCount(0);
  api.changeAccess("write");
  await sendOpenViewEvent(page, "invalidate", { entity: "users" });
  await expect(card(page)).toContainText("no complete start/end interval");
  await expect(
    card(page).getByRole("button", { name: "Shift interval: Task 1" }),
  ).toHaveCount(0);
  expect(api.writes()).toBe(0);
});

test("a late held receipt cannot republish results after records-read refusal", async ({
  page,
}) => {
  const api = await installDates(page);
  await page.goto(url);
  await stage(page, "2026-03-07");
  const release = api.hold();
  await page.getByRole("button", { name: "Save changes (1)" }).click();
  await expect.poll(() => api.batches.length).toBe(1);
  api.deny();
  await sendOpenViewEvent(page, "invalidate", { entity: "records" });
  await expect(
    page.getByRole("alert").filter({ hasText: "OpenView data is unavailable" }),
  ).toBeVisible();
  release();
  await expect(
    page.getByRole("button", { name: "Discard", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved 1 move." }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save changes (1)" }),
  ).toBeDisabled();
  await expect(page.getByRole("main")).not.toContainText("Task 1");
});

test("Timeline shifts mixed date and datetime fields together across DST without losing wall precision", async ({
  page,
}) => {
  const api = await installDates(page, {
    start: "2026-03-07",
    endType: "datetime",
    end: "2026-03-07T16:20:45.123456Z",
  });
  await page.goto(url);
  await stage(page, "2026-03-08");
  await page.getByRole("button", { name: "Save changes (1)" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved 1 move." }),
  ).toBeVisible();
  expect(api.batches[0].items[0]).toEqual({
    record_id: recordId,
    revision,
    changes: [
      { field_id: startId, value: "2026-03-08" },
      { field_id: endId, value: "2026-03-08T15:20:45.123456Z" },
    ],
  });
});

test("returning a legacy timezone-free datetime to its original workspace day clears the move without a write", async ({
  page,
}) => {
  const api = await installDates(page, {
    layout: "calendar",
    startType: "datetime",
    start: "2026-03-07T01:15:30.123456",
  });
  await page.goto(url);
  await stage(page, "2026-03-08", "Task 1", "Move date…");
  await expect(
    page.getByRole("button", { name: "Save changes (1)" }),
  ).toBeVisible();
  await stage(page, "2026-03-06", "Task 1", "Move date…");
  await expect(
    page.getByRole("button", { name: "Save changes (1)" }),
  ).toHaveCount(0);
  expect(api.batches).toEqual([]);
  expect(api.rows.get(recordId)?.data[startId]).toBe(
    "2026-03-07T01:15:30.123456",
  );
});

test.describe("touch", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  test("Timeline phone handles are distinct 44px targets and touch shift stages both dates", async ({
    page,
  }) => {
    const api = await installDates(page);
    await page.goto(url);
    const shift = card(page).getByRole("button", {
      name: "Shift interval: Task 1",
      exact: true,
    });
    const resize = card(page).getByRole("button", {
      name: "Resize end: Task 1",
      exact: true,
    });
    await shift.scrollIntoViewIfNeeded();
    await expect(shift).toBeInViewport();
    const source = (await shift.boundingBox())!;
    const end = (await resize.boundingBox())!;
    expect(source.width).toBeGreaterThanOrEqual(44);
    expect(source.height).toBeGreaterThanOrEqual(44);
    expect(end.width).toBeGreaterThanOrEqual(44);
    expect(end.height).toBeGreaterThanOrEqual(44);
    expect(
      source.x + source.width <= end.x ||
        end.x + end.width <= source.x ||
        source.y + source.height <= end.y ||
        end.y + end.height <= source.y,
    ).toBe(true);
    const track = (await card(page)
      .getByRole("group", { name: "Task 1 timeline track" })
      .boundingBox())!;
    const session = await page.context().newCDPSession(page);
    const point = {
      x: source.x + source.width / 2,
      y: source.y + source.height / 2,
    };
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point],
    });
    await expect(shift).toHaveAttribute("aria-pressed", "true");
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: point.x + (track.width * 2) / 31, y: point.y }],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await session.detach();
    await expect(card(page)).toContainText("2026-03-07 – 2026-03-12");
    await expect(
      page.getByRole("button", { name: "Save changes (1)" }),
    ).toBeVisible();
    expect(api.batches).toEqual([]);
  });
});
