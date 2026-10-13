import { expect, type Page } from "@playwright/test";
import { test, isEventStream } from "./helpers/test";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";
import { pageOf } from "../helpers/pagination";

const id = (value: number) =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const moduleId = id(1800);
const departmentId = id(1801);
const viewId = id(1802);
const nameFieldId = id(1803);
const laneFieldId = id(1804);
const noteFieldId = id(1805);
const todoId = id(1806);
const readyId = id(1807);
const emptyId = id(1808);
const firstRecordId = id(1810);
const secondRecordId = id(1811);
const initialRevision = "2026-10-08T12:00:00Z";
const url = `/openview?section=views&module=${moduleId}&view=${viewId}`;

type MoveItem = {
  record_id: string;
  field_id: string;
  revision: string;
  value: string | boolean | null;
};
type BatchRequest = { module_id: string; items: MoveItem[] };
type WireRecord = {
  id: string;
  module_id: string;
  data: Record<string, string | boolean | null>;
  display_values: Record<string, string>;
  created_at: string;
  updated_at: string;
  deleted_at: null;
  is_deleted: false;
  performed_by: string;
};

async function installKanbanApi(
  page: Page,
  options: {
    laneType?: "select" | "boolean" | "user" | "text";
    level?: "read" | "write" | "manage";
    required?: boolean;
    rowCount?: number;
  } = {},
) {
  await installOpenViewEventSource(page);
  const laneType = options.laneType ?? "select";
  let level = options.level ?? "write";
  const choices = [
    { id: todoId, label: laneType === "user" ? "Alex" : "To do" },
    { id: readyId, label: laneType === "user" ? "Riley" : "Ready" },
    { id: emptyId, label: "Empty lane" },
  ];
  const laneValue = laneType === "boolean" ? false : todoId;
  const rows = new Map<string, WireRecord>(
    Array.from({ length: options.rowCount ?? 2 }, (_, index) =>
      id(1810 + index),
    ).map((recordId, index) => [
      recordId,
      {
        id: recordId,
        module_id: moduleId,
        data: {
          [nameFieldId]: `Pump ${index + 1}`,
          [laneFieldId]: laneValue,
          [noteFieldId]: `Keep note ${index + 1}`,
        },
        display_values: ["select", "user"].includes(laneType)
          ? { [laneFieldId]: choices[0].label }
          : {},
        created_at: initialRevision,
        updated_at: initialRevision,
        deleted_at: null,
        is_deleted: false,
        performed_by: id(1),
      },
    ]),
  );
  if (laneType === "user")
    rows.set(id(1812), {
      ...rows.get(firstRecordId)!,
      id: id(1812),
      data: {
        [nameFieldId]: "Pump 3",
        [laneFieldId]: readyId,
        [noteFieldId]: "Keep note 3",
      },
      display_values: { [laneFieldId]: "Riley" },
    });
  const fields = [
    { id: nameFieldId, name: "Name", type: "text", config: {} },
    {
      id: laneFieldId,
      name: "Status",
      type: laneType,
      config: laneType === "select" ? { options: choices } : {},
    },
    { id: noteFieldId, name: "Note", type: "long_text", config: {} },
  ].map((field, index) => ({
    ...field,
    module_id: moduleId,
    position: index,
    required: field.id === laneFieldId && Boolean(options.required),
  }));
  const saved = {
    id: viewId,
    module_id: moduleId,
    name: "Work queue",
    is_default: false,
    revision: 1,
    is_deleted: false,
    can_edit: level === "manage",
    created_at: initialRevision,
    updated_at: initialRevision,
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
      layout: "kanban",
      column_field_ids: fields.map((field) => field.id),
      pinned_field_ids: [],
      density: "comfortable",
      wrap: false,
      card_size: "comfortable",
      primary_field_id: nameFieldId,
      secondary_field_id: noteFieldId,
      date_field_id: null,
      group_by_field_id: laneFieldId,
      date_range: "month",
      scale: null,
    },
  };
  const batches: BatchRequest[] = [];
  let authReads = 0;
  let groupedReads = 0;
  let nextBatchStatus = 200;
  let committedFailure: "malformed" | null = null;
  let holdBatch: Promise<void> | null = null;
  let revision = 0;
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
        headers: { "Cache-Control": "private, no-store" },
        json: body,
      });
    if (path === "/api/auth/session")
      return json({
        authenticated: true,
        user_id: id(1),
        setup_required: false,
      });
    if (path === "/api/auth/me") {
      authReads += 1;
      return json({
        id: id(1),
        role: "member",
        access: [{ department_id: departmentId, module_id: moduleId, level }],
      });
    }
    if (path === "/api/views/data-sources")
      return json(
        pageOf(
          [
            {
              id: moduleId,
              department_id: departmentId,
              name: "Work items",
              title_field_id: nameFieldId,
            },
          ],
          { limit },
        ),
      );
    if (path === `/api/views/data-sources/${moduleId}/fields`)
      return json(pageOf(fields, { limit }));
    if (path === `/api/departments/${departmentId}`)
      return json({
        id: departmentId,
        department_name: "Operations",
        created_at: initialRevision,
        updated_at: initialRevision,
        deleted_at: null,
        is_deleted: false,
        performed_by: null,
      });
    if (path === "/api/departments")
      return json(
        pageOf(
          [
            {
              id: departmentId,
              department_name: "Operations",
              created_at: initialRevision,
              updated_at: initialRevision,
              deleted_at: null,
              is_deleted: false,
              performed_by: null,
            },
          ],
          { limit },
        ),
      );
    if (path === "/api/views" && request.method() === "GET")
      return json(pageOf([saved], { limit }));
    if (path === `/api/views/${viewId}`) return json(saved);
    if (path === "/api/records/grouped-query") {
      groupedReads += 1;
      const body = request.postDataJSON() as {
        limit: number;
        offset: number;
        group_limit: number;
        group_offset: number;
        selected_group:
          { kind: "value"; value: string } | { kind: "unspecified" } | null;
      };
      const label = (value: string | null) =>
        value === null
          ? "Unspecified"
          : laneType === "boolean"
            ? value === "true"
              ? "Yes"
              : "No"
            : (choices.find((choice) => choice.id === value)?.label ?? value);
      const lane = (row: WireRecord) =>
        row.data[laneFieldId] === null ? null : String(row.data[laneFieldId]);
      const records = [...rows.values()];
      const groups = [...new Set(records.map(lane))].map((value) => ({
        value,
        label: label(value),
        count: records.filter((row) => lane(row) === value).length,
      }));
      const selected = body.selected_group;
      const selectedRows = selected
        ? records.filter(
            (row) =>
              lane(row) ===
              (selected.kind === "unspecified" ? null : selected.value),
          )
        : [];
      return json({
        items: selectedRows.slice(body.offset, body.offset + body.limit),
        pagination: selected
          ? pageOf(selectedRows.slice(body.offset, body.offset + body.limit), {
              limit: body.limit,
              offset: body.offset,
              total: selectedRows.length,
            }).pagination
          : null,
        groups: groups.slice(
          body.group_offset,
          body.group_offset + body.group_limit,
        ),
        group_pagination: pageOf(
          groups.slice(body.group_offset, body.group_offset + body.group_limit),
          {
            limit: body.group_limit,
            offset: body.group_offset,
            total: groups.length,
          },
        ).pagination,
        selected_group: selected,
      });
    }
    if (path === "/api/records/batch-update") {
      const batch = request.postDataJSON() as BatchRequest;
      batches.push(batch);
      await holdBatch;
      if (nextBatchStatus !== 200)
        return json({ detail: "Private failure canary" }, nextBatchStatus);
      const results = batch.items.map((item) => {
        const before = rows.get(item.record_id);
        if (!before || level === "read")
          return { record_id: item.record_id, status: "forbidden" };
        if (item.revision !== before.updated_at)
          return { record_id: item.record_id, status: "stale" };
        if (item.value === null && options.required)
          return {
            record_id: item.record_id,
            status: "invalid",
            errors: [
              {
                code: "required_field",
                field_id: laneFieldId,
                message: "Field is required",
              },
            ],
            truncated: false,
          };
        revision += 1;
        const updated: WireRecord = {
          ...before,
          data: { ...before.data, [item.field_id]: item.value },
          display_values:
            ["select", "user"].includes(laneType) && item.value !== null
              ? {
                  [laneFieldId]:
                    choices.find((choice) => choice.id === item.value)?.label ??
                    "Unavailable option",
                }
              : {},
          updated_at: new Date(
            Date.parse(initialRevision) + revision * 60_000,
          ).toISOString(),
        };
        rows.set(item.record_id, updated);
        return {
          record_id: item.record_id,
          status: "updated",
          record: updated,
        };
      });
      const failure = committedFailure;
      committedFailure = null;
      if (failure === "malformed") return json({ results: [] });
      return json({ results });
    }
    const recordId = path.match(/^\/api\/records\/([^/]+)$/)?.[1];
    if (recordId && request.method() === "GET")
      return json(rows.get(recordId), rows.has(recordId) ? 200 : 404);
    if (path === "/api/records/query")
      return json(
        pageOf([...rows.values()].slice(offset, offset + limit), {
          limit,
          offset,
          total: rows.size,
        }),
      );
    return route.fallback();
  });
  return {
    batches,
    rows,
    authReads: () => authReads,
    groupedReads: () => groupedReads,
    changeAccess: (next: typeof level) => {
      level = next;
    },
    failBatch: (status: number) => {
      nextBatchStatus = status;
    },
    commitThenFail: (failure: "malformed") => {
      committedFailure = failure;
    },
    holdBatch: () => {
      let release!: () => void;
      holdBatch = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

async function openLane(page: Page, label = "To do") {
  await page
    .getByRole("button", { name: `${label}, 2 records`, exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Open record: Pump 1", exact: true }),
  ).toBeVisible();
}

async function moveTo(page: Page, title: string, destination: string) {
  const card = page.getByRole("article").filter({
    has: page.getByRole("button", {
      name: `Open record: ${title}`,
      exact: true,
    }),
  });
  // The previous card's menu may still be closing; its items share names.
  await expect(page.getByRole("menu")).toHaveCount(0);
  await card.getByRole("button", { name: "Move to…", exact: true }).click();
  await page.getByRole("menuitem", { name: destination, exact: true }).click();
}

test("Kanban stages a menu move across a filter remount and saves only the field with its original revision", async ({
  page,
}) => {
  const api = await installKanbanApi(page);
  await page.goto(url);
  await openLane(page);
  await moveTo(page, "Pump 1", "Empty lane");
  const save = page.getByRole("button", {
    name: "Save changes (1)",
    exact: true,
  });
  await expect(save).toBeVisible();
  expect(api.batches).toEqual([]);
  expect(api.rows.get(firstRecordId)?.data[laneFieldId]).toBe(todoId);

  const beforeRemount = api.groupedReads();
  await page
    .getByRole("searchbox", { name: "Search Work items", exact: true })
    .fill("Pump");
  await expect.poll(api.groupedReads).toBeGreaterThan(beforeRemount);
  await expect(save).toBeVisible();
  await openLane(page);
  await expect(
    page.getByRole("article").filter({ hasText: "Pump 1" }),
  ).toContainText("Empty lane");
  await moveTo(page, "Pump 1", "Ready");
  await save.click();
  await expect(save).toHaveCount(0);
  expect(api.batches).toEqual([
    {
      module_id: moduleId,
      items: [
        {
          record_id: firstRecordId,
          revision: initialRevision,
          field_id: laneFieldId,
          value: readyId,
        },
      ],
    },
  ]);
  expect(api.rows.get(firstRecordId)?.data).toEqual({
    [nameFieldId]: "Pump 1",
    [laneFieldId]: readyId,
    [noteFieldId]: "Keep note 1",
  });
  await expect(
    page.getByLabel("Search Work items", { exact: true }),
  ).toHaveValue("Pump");
});

test("Kanban retains the first revision through remote refresh and keeps only a conflicting move after partial success", async ({
  page,
}) => {
  const api = await installKanbanApi(page);
  await page.goto(url);
  await openLane(page);
  await moveTo(page, "Pump 1", "Ready");
  await moveTo(page, "Pump 2", "Empty lane");
  api.rows.set(firstRecordId, {
    ...api.rows.get(firstRecordId)!,
    updated_at: "2026-10-08T12:10:00Z",
    data: {
      ...api.rows.get(firstRecordId)!.data,
      [noteFieldId]: "Remote note",
    },
  });
  const beforeRefresh = api.groupedReads();
  await sendOpenViewEvent(page, "invalidate", { entity: "records" });
  await expect.poll(api.groupedReads).toBeGreaterThan(beforeRefresh);
  await expect(
    page.getByRole("button", { name: "Open record: Pump 1", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Save changes (2)", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save changes (1)", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("article").filter({ hasText: "Pump 1" }),
  ).toContainText("Changed by someone else — review");
  expect(api.batches[0].items[0].revision).toBe(initialRevision);
  expect(api.rows.get(firstRecordId)?.data).toMatchObject({
    [laneFieldId]: todoId,
    [noteFieldId]: "Remote note",
  });
  expect(api.rows.get(secondRecordId)?.data).toMatchObject({
    [laneFieldId]: emptyId,
    [noteFieldId]: "Keep note 2",
  });
});

test("Kanban stages required Unspecified as null and preserves the failed card for correction", async ({
  page,
}) => {
  const api = await installKanbanApi(page, { required: true });
  await page.goto(url);
  await openLane(page);
  await moveTo(page, "Pump 1", "Unspecified");
  await moveTo(page, "Pump 2", "Ready");
  await page
    .getByRole("button", { name: "Save changes (2)", exact: true })
    .click();
  await expect(
    page.getByRole("article").filter({ hasText: "Pump 1" }),
  ).toContainText("Field is required");
  expect(api.batches[0].items[0].value).toBeNull();
  expect(api.rows.get(firstRecordId)?.data[laneFieldId]).toBe(todoId);
  await moveTo(page, "Pump 1", "Empty lane");
  await page
    .getByRole("button", { name: "Save changes (1)", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /^Save changes \(/ }),
  ).toHaveCount(0);
  expect(api.rows.get(firstRecordId)?.data[laneFieldId]).toBe(emptyId);
});

test("Kanban Discard and the existing navigation guard protect moves without clearing a temporary view draft", async ({
  page,
}) => {
  const api = await installKanbanApi(page);
  await page.goto(url);
  await openLane(page);
  await page.getByLabel("Search Work items", { exact: true }).fill("Pump");
  await openLane(page);
  await moveTo(page, "Pump 1", "Ready");
  const preventsUnload = () =>
    page.evaluate(
      () =>
        !window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
    );
  await expect.poll(preventsUnload).toBe(true);
  await page.getByRole("link", { name: "Charts", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText("1 unsaved move");
  await confirmation
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save changes (1)", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /^Save changes \(/ }),
  ).toHaveCount(0);
  await expect.poll(preventsUnload).toBe(false);
  await expect(
    page.getByLabel("Search Work items", { exact: true }),
  ).toHaveValue("Pump");
  expect(api.batches).toEqual([]);
  await moveTo(page, "Pump 1", "Ready");
  await page.getByLabel("Saved view", { exact: true }).selectOption("");
  await expect(confirmation).toContainText("1 unsaved move");
  await confirmation
    .getByRole("button", { name: "Discard and continue", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /^Save changes \(/ }),
  ).toHaveCount(0);
  await expect(page).not.toHaveURL(new RegExp(`view=${viewId}`));
  expect(api.batches).toEqual([]);
});

for (const laneType of ["boolean", "user"] as const)
  test(`Kanban ${laneType} moves submit stable typed values`, async ({
    page,
  }) => {
    const api = await installKanbanApi(page, { laneType });
    await page.goto(url);
    await openLane(page, laneType === "boolean" ? "No" : "Alex");
    await moveTo(page, "Pump 1", laneType === "boolean" ? "Yes" : "Riley");
    await page
      .getByRole("button", { name: "Save changes (1)", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: /^Save changes \(/ }),
    ).toHaveCount(0);
    expect(api.batches[0].items[0].value).toBe(
      laneType === "boolean" ? true : readyId,
    );
  });

for (const options of [
  { level: "read" as const },
  { laneType: "text" as const },
])
  test(`Kanban hides move controls for ${"level" in options ? "readers" : "unsupported lane types"}`, async ({
    page,
  }) => {
    const api = await installKanbanApi(page, options);
    await page.goto(url);
    await openLane(page);
    await expect(
      page.getByRole("button", { name: "Move to…", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^Drag record:/ }),
    ).toHaveCount(0);
    expect(api.batches).toEqual([]);
  });

// The receipt fault matrix is owned by
// isolated/openview/record-move-receipts.spec.ts. One committed-but-malformed
// receipt stays here for the Kanban recovery: the grouped-read poll, the lane
// count, and the record hidden until its lane opens.
for (const failure of ["malformed", "denied"] as const)
  test(`Kanban retains unsaved moves after a ${failure} batch result`, async ({
    page,
  }) => {
    const api = await installKanbanApi(page);
    await page.goto(url);
    await openLane(page);
    const originalRevision = api.rows.get(firstRecordId)!.updated_at;
    await moveTo(page, "Pump 1", "Ready");
    const authReads = api.authReads();
    const recordReads = api.groupedReads();
    if (failure === "denied") {
      api.failBatch(403);
      api.changeAccess("read");
    } else api.commitThenFail(failure);
    await page
      .getByRole("button", { name: "Save changes (1)", exact: true })
      .click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: /moves|move/i })
        .last(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Discard", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Private failure canary", { exact: false }),
    ).toHaveCount(0);
    expect(api.batches).toHaveLength(1);
    if (failure === "denied") {
      expect(api.rows.get(firstRecordId)?.data[laneFieldId]).toBe(todoId);
      await expect.poll(api.authReads).toBeGreaterThan(authReads);
      await expect(
        page.getByRole("button", { name: "Move to…", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Save changes (1)", exact: true }),
      ).toBeDisabled();
    } else {
      // The server committed; the failed response did not confirm that fact.
      // A new read must reveal it without clearing or rebasing the pending move.
      expect(api.rows.get(firstRecordId)?.data[laneFieldId]).toBe(readyId);
      expect(api.rows.get(firstRecordId)?.updated_at).not.toBe(
        originalRevision,
      );
      await expect.poll(api.groupedReads).toBeGreaterThan(recordReads);
      await expect(
        page.getByRole("button", { name: "Ready, 1 records", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Open record: Pump 1", exact: true }),
      ).toHaveCount(0);
      const save = page.getByRole("button", {
        name: "Save changes (1)",
        exact: true,
      });
      await expect(save).toBeVisible();
      expect(api.batches).toHaveLength(1);
      await page
        .getByRole("button", { name: "Ready, 1 records", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Open record: Pump 1", exact: true }),
      ).toBeVisible();
      expect(api.batches).toHaveLength(1);
      await save.click();
      await expect(
        page.getByRole("article").filter({ hasText: "Pump 1" }),
      ).toContainText("Changed by someone else — review");
      expect(api.batches).toHaveLength(2);
      expect(api.batches[1].items[0].revision).toBe(originalRevision);
      await expect(save).toBeVisible();
    }
  });

test("Kanban blocks a duplicate Save and preserves the submitted batch while it is pending", async ({
  page,
}) => {
  const api = await installKanbanApi(page);
  await page.goto(url);
  await openLane(page);
  await moveTo(page, "Pump 1", "Ready");
  const release = api.holdBatch();
  const save = page.getByRole("button", {
    name: "Save changes (1)",
    exact: true,
  });
  await save.click();
  await expect.poll(() => api.batches.length).toBe(1);
  await expect(save).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Discard", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Move to…", exact: true }).first(),
  ).toBeDisabled();
  release();
  await expect(save).toHaveCount(0);
  expect(api.batches).toHaveLength(1);
});

test("Kanban pointer drag stages a move without saving", async ({ page }) => {
  const api = await installKanbanApi(page);
  await page.goto(url);
  await openLane(page);
  const handle = page.getByRole("button", {
    name: "Drag record: Pump 1",
    exact: true,
  });
  await expect(handle).toBeVisible();
  await handle.evaluate((button) => button.scrollIntoView({ block: "end" }));
  await expect(handle).toBeInViewport();
  const source = await handle.boundingBox();
  const target = await page
    .getByRole("button", { name: /Empty lane,/, exact: false })
    .boundingBox();
  if (!source || !target)
    throw new Error("The drag controls must have visible bounds");
  await page.mouse.move(
    source.x + source.width / 2,
    source.y + source.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    target.x + target.width / 2,
    target.y + target.height / 2,
    { steps: 10 },
  );
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: "Save changes (1)", exact: true }),
  ).toBeVisible();
  expect(api.batches).toEqual([]);
});

test("Kanban keyboard drag cancels with Escape and saves the chosen lane", async ({
  page,
}) => {
  const api = await installKanbanApi(page);
  await page.goto(url);
  await openLane(page);
  const handle = page.getByRole("button", {
    name: "Drag record: Pump 1",
    exact: true,
  });
  await handle.focus();
  await page.keyboard.press("Space", { delay: 50 });
  await expect(handle).toHaveAttribute("aria-pressed", "true");
  // Core defers the keyboard listener until after activation. Let the
  // picked-up record paint before issuing another physical key.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("status").filter({ hasText: "Pump 1 is over Ready." }),
  ).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(handle).not.toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: /^Save changes \(/ }),
  ).toHaveCount(0);
  await handle.focus();
  await page.keyboard.press("Space", { delay: 50 });
  await expect(handle).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("status").filter({ hasText: "Pump 1 is over Ready." }),
  ).toHaveCount(1);
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("button", { name: "Save changes (1)", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Save changes (1)", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /^Save changes \(/ }),
  ).toHaveCount(0);
  expect(api.batches[0].items[0].value).toBe(readyId);
});

test("Kanban retains 100 pending records across pages and refuses a 101st before saving", async ({
  page,
}) => {
  // 100 staged moves is the product limit, so no smaller input proves it; each
  // menu move is two clicks (~58 ms each, flat across all 100 moves).
  test.setTimeout(120_000); // measured: 12.3-12.5 s at 1 worker (5 runs, load 4-5); 19-49 s at 3 workers (6 runs, load 16); default 30 s fails
  const api = await installKanbanApi(page, { rowCount: 101 });
  await page.goto(url);
  await page
    .getByRole("button", { name: "To do, 101 records", exact: true })
    .click();
  for (let index = 0; index < 100; index += 1) {
    if (index > 0 && index % 25 === 0)
      await page
        .getByRole("navigation", {
          name: "Kanban lane record pages",
          exact: true,
        })
        .getByRole("button", { name: "Go to next page", exact: true })
        .click();
    await moveTo(page, `Pump ${index + 1}`, "Ready");
  }
  await page
    .getByRole("navigation", { name: "Kanban lane record pages", exact: true })
    .getByRole("button", { name: "Go to next page", exact: true })
    .click();
  await moveTo(page, "Pump 101", "Ready");
  await expect(
    page.getByRole("alert").filter({ hasText: "100 records" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Save changes (100)", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /^Save changes \(/ }),
  ).toHaveCount(0);
  expect(api.batches).toHaveLength(1);
  expect(api.batches[0].items).toHaveLength(100);
  expect(new Set(api.batches[0].items.map((item) => item.record_id)).size).toBe(
    100,
  );
  expect(api.rows.get(id(1910))?.data[laneFieldId]).toBe(todoId);
});

test.describe("Kanban touch", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  test("a touch drag on a phone stages a move and the menu remains available", async ({
    page,
  }) => {
    const api = await installKanbanApi(page);
    await page.goto(url);
    await openLane(page);
    const handle = page.getByRole("button", {
      name: "Drag record: Pump 1",
      exact: true,
    });
    await expect(handle).toBeVisible();
    await handle.evaluate((button) => button.scrollIntoView({ block: "end" }));
    await expect(handle).toBeInViewport();
    const source = await handle.boundingBox();
    const target = await page
      .getByRole("button", { name: /Empty lane,/, exact: false })
      .boundingBox();
    if (!source || !target)
      throw new Error("The touch controls must have visible bounds");
    const session = await page.context().newCDPSession(page);
    const point = {
      x: source.x + source.width / 2,
      y: source.y + source.height / 2,
    };
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point],
    });
    await expect(handle).toHaveAttribute("aria-pressed", "true");
    for (let step = 1; step <= 10; step += 1)
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: point.x + ((target.x + target.width / 2 - point.x) * step) / 10,
            y: point.y + ((target.y + target.height / 2 - point.y) * step) / 10,
          },
        ],
      });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await session.detach();
    await expect(
      page.getByRole("button", { name: "Save changes (1)", exact: true }),
    ).toBeVisible();
    expect(api.batches).toEqual([]);
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await moveTo(page, "Pump 1", "Ready");
    await page
      .getByRole("button", { name: "Save changes (1)", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: /^Save changes \(/ }),
    ).toHaveCount(0);
    expect(api.batches[0].items[0].value).toBe(readyId);
  });
});
