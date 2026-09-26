import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";

const userId = "00000000-0000-4000-8000-000000000001";
const moduleId = "00000000-0000-4000-8000-000000000010";
const departmentId = "00000000-0000-4000-8000-000000000011";
const nameFieldId = "00000000-0000-4000-8000-000000000012";
const statusFieldId = "00000000-0000-4000-8000-000000000013";
const serialFieldId = "00000000-0000-4000-8000-000000000020";
const unselectedQueryFieldId = "00000000-0000-4000-8000-000000000021";
const timelineStartFieldId = "00000000-0000-4000-8000-000000000022";
const timelineEndFieldId = "00000000-0000-4000-8000-000000000023";
const calendarDateFieldId = "00000000-0000-4000-8000-000000000024";
const timelineDeadlineFieldId = "00000000-0000-4000-8000-000000000025";
const timelineProgressFieldId = "00000000-0000-4000-8000-000000000026";
const timelineTimestampDeadlineFieldId = "00000000-0000-4000-8000-000000000027";
const numberFieldId = "00000000-0000-4000-8000-000000000028";
const integerFieldId = "00000000-0000-4000-8000-000000000029";
const viewId = "00000000-0000-4000-8000-000000000014";
const secondViewId = "00000000-0000-4000-8000-000000000019";
const duplicateViewId = "00000000-0000-4000-8000-000000000030";
const recordOneId = "00000000-0000-4000-8000-000000000015";
const recordTwoId = "00000000-0000-4000-8000-000000000016";

type QueryDefinition = {
  version: 1;
  logic: "and" | "or";
  columns: { field_id: string; expected_type: string }[];
  filters: {
    field_id: string;
    expected_type: string;
    operator: string;
    value?: string | number | boolean | string[] | null;
  }[];
  sort: {
    field_id: string;
    expected_type: string;
    direction: "asc" | "desc";
  }[];
  deleted: "exclude" | "include" | "only";
  search: string | null;
  search_fields: { field_id: string; expected_type: string }[];
};

type SavedView = {
  id: string;
  module_id: string;
  owner_id: string;
  name: string;
  visibility: "private" | "workspace";
  audience: {
    kind: "private" | "everyone" | "role" | "user";
    role_id: string | null;
    user_id: string | null;
  };
  definition: QueryDefinition;
  presentation: {
    version: 1;
    layout: "table" | "grid" | "kanban" | "calendar" | "timeline" | "gallery";
    column_field_ids: string[];
    pinned_field_ids: string[];
    density: "comfortable" | "compact";
    wrap: boolean;
    card_size: "comfortable" | "compact";
    primary_field_id: string | null;
    secondary_field_id: string | null;
    date_field_id: string | null;
    timeline_start_field_id?: string | null;
    timeline_end_field_id?: string | null;
    timeline_deadline_field_id?: string | null;
    timeline_progress_field_id?: string | null;
    group_by_field_id: string | null;
    date_range: "week" | "month" | "quarter" | "year";
    scale: "month" | "list" | null;
  };
  revision: number;
  is_deleted: boolean;
  can_edit: boolean;
  created_at: string;
  updated_at: string;
};

type SavedViewLayout = SavedView["presentation"]["layout"];

function baseView(): SavedView {
  return {
    id: viewId,
    module_id: moduleId,
    owner_id: userId,
    name: "Equipment register",
    visibility: "private",
    audience: { kind: "private", role_id: null, user_id: null },
    definition: {
      version: 1,
      logic: "and",
      columns: [
        { field_id: nameFieldId, expected_type: "text" },
        { field_id: statusFieldId, expected_type: "select" },
      ],
      filters: [],
      sort: [],
      deleted: "exclude",
      search: "pump",
      search_fields: [{ field_id: nameFieldId, expected_type: "text" }],
    },
    presentation: {
      version: 1,
      layout: "table",
      column_field_ids: [nameFieldId, statusFieldId],
      pinned_field_ids: [],
      density: "comfortable",
      wrap: false,
      card_size: "comfortable",
      primary_field_id: nameFieldId,
      secondary_field_id: null,
      date_field_id: null,
      group_by_field_id: null,
      date_range: "month",
      scale: null,
    },
    revision: 1,
    is_deleted: false,
    can_edit: true,
    created_at: "2026-09-23T00:00:00Z",
    updated_at: "2026-09-23T00:00:00Z",
  };
}

function pageResponse<T>(
  items: T[],
  limit = 100,
  offset = 0,
  total = items.length,
  hasMore = false,
) {
  return {
    items,
    pagination: {
      limit,
      offset,
      count: items.length,
      total,
      has_more: hasMore,
    },
  };
}

function record(id: string, name: string, status: string) {
  return {
    id,
    module_id: moduleId,
    data: {
      [nameFieldId]: name,
      [statusFieldId]: status,
      [serialFieldId]: id === recordOneId ? "S" : `SN-${id.slice(-2)}`,
      [unselectedQueryFieldId]: "Do not surface this query-only field",
      [timelineStartFieldId]: "2026-09-01",
      [timelineEndFieldId]: "2026-09-02",
      [calendarDateFieldId]: "2026-09-01T18:30:00.000Z",
      [timelineDeadlineFieldId]: "2026-09-06",
      [timelineProgressFieldId]: "50.00",
      [timelineTimestampDeadlineFieldId]: "2026-09-06T18:30:00.000Z",
    },
    created_at: "2026-09-23T00:00:00Z",
    updated_at: "2026-09-23T00:00:00Z",
    deleted_at: null,
    is_deleted: false,
    performed_by: userId,
  };
}

async function installViewsApi(
  page: Page,
  options: {
    initialDefault?: boolean;
    initialName?: string;
    initialLayout?: SavedView["presentation"]["layout"];
    initialGroupByFieldId?: string;
    initialPresentation?: Partial<SavedView["presentation"]>;
    disableInitialSearch?: boolean;
    recordName?: string;
    cardFieldsNotInColumns?: boolean;
    additionalViews?: SavedView[];
    deepViewBeyondBound?: boolean;
    calendarDateTimeValue?: string;
  } = {},
) {
  await installOpenViewEventSource(page);
  let saved = baseView();
  if (options.initialName) saved = { ...saved, name: options.initialName };
  if (options.disableInitialSearch)
    saved = {
      ...saved,
      definition: { ...saved.definition, search: null },
    };
  if (options.cardFieldsNotInColumns) {
    saved = {
      ...saved,
      definition: {
        ...saved.definition,
        columns: [
          ...saved.definition.columns,
          { field_id: serialFieldId, expected_type: "text" },
          { field_id: unselectedQueryFieldId, expected_type: "text" },
        ],
      },
      presentation: {
        ...saved.presentation,
        column_field_ids: [nameFieldId],
        primary_field_id: serialFieldId,
        secondary_field_id: statusFieldId,
      },
    };
  }
  if (options.initialGroupByFieldId) {
    saved = {
      ...saved,
      presentation: {
        ...saved.presentation,
        group_by_field_id: options.initialGroupByFieldId,
      },
    };
  }
  if (options.initialLayout) {
    saved = {
      ...saved,
      definition: {
        ...saved.definition,
        columns:
          options.initialLayout === "timeline"
            ? [
                ...saved.definition.columns,
                { field_id: timelineStartFieldId, expected_type: "date" },
                { field_id: timelineEndFieldId, expected_type: "date" },
                { field_id: timelineDeadlineFieldId, expected_type: "date" },
                {
                  field_id: timelineTimestampDeadlineFieldId,
                  expected_type: "datetime",
                },
                { field_id: timelineProgressFieldId, expected_type: "decimal" },
              ]
            : options.initialLayout === "calendar"
              ? [
                  ...saved.definition.columns,
                  {
                    field_id: calendarDateFieldId,
                    expected_type: "datetime",
                  },
                ]
              : saved.definition.columns,
        ...(options.initialLayout === "kanban" ? { search: null } : {}),
      },
      presentation: {
        ...saved.presentation,
        layout: options.initialLayout,
        ...(options.initialLayout === "timeline"
          ? {
              timeline_start_field_id: timelineStartFieldId,
              timeline_end_field_id: timelineEndFieldId,
              timeline_deadline_field_id: timelineDeadlineFieldId,
              timeline_progress_field_id: timelineProgressFieldId,
            }
          : options.initialLayout === "calendar"
            ? { date_field_id: calendarDateFieldId }
            : {}),
      },
    };
  }
  if (options.initialPresentation) {
    saved = {
      ...saved,
      presentation: {
        ...saved.presentation,
        ...options.initialPresentation,
      },
    };
  }
  let personalDefault: string | null = options.initialDefault ? viewId : null;
  const createdViews: SavedView[] = [];
  let nextPatchIsStale = false;
  let failNextGroupedQuery = false;
  let nextMutationFailure: "archive" | "restore" | "default-clear" | null =
    null;
  let nextPatchBarrier: {
    wait: Promise<void>;
    signalStarted: () => void;
  } | null = null;
  const apiRequests: string[] = [];
  const recordQueryRequests: {
    definition: QueryDefinition;
    limit?: number;
    offset?: number;
  }[] = [];
  const groupedQueryRequests: {
    definition: QueryDefinition;
    group_by: { field_id: string; expected_type: string };
    limit: number;
    offset: number;
    group_limit: number;
    group_offset: number;
    selected_group?:
      { kind: "value"; value: string } | { kind: "unspecified" } | null;
  }[] = [];
  const windowQueryRequests: Record<string, unknown>[] = [];
  let failNextWindowQuery = false;
  let denyRecordQueries = false;
  let deniedRecordId: string | null = null;
  let nextRecordLookupBarrier: {
    wait: Promise<void>;
    signalStarted: () => void;
  } | null = null;
  const kanbanRows = Array.from({ length: 38 }, (_, index) =>
    record(
      `00000000-0000-4000-8000-${(index + 100).toString().padStart(12, "0")}`,
      index < 26
        ? "In service"
        : `Category ${String(index - 25).padStart(2, "0")}`,
      "In service",
    ),
  );
  const windowRows = Array.from({ length: 26 }, (_, index) => {
    const item = record(
      `00000000-0000-4000-8000-${(index + 200).toString().padStart(12, "0")}`,
      `Window equipment ${String(index + 1).padStart(2, "0")}`,
      "In service",
    );
    return {
      ...item,
      data: {
        ...item.data,
        [timelineStartFieldId]: index === 0 ? "2026-08-29" : "2026-09-01",
        [timelineEndFieldId]: index === 0 ? "2026-09-04" : "2026-09-10",
        [calendarDateFieldId]:
          options.calendarDateTimeValue ?? "2026-09-01T18:30:00.000Z",
        [timelineDeadlineFieldId]: "2026-09-06",
        [timelineProgressFieldId]: index === 0 ? "40.50" : "50.00",
        [timelineTimestampDeadlineFieldId]: "2026-09-06T18:30:00.000Z",
      },
    };
  });
  await page.route("**/api/auth/session", async (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user_id: userId,
        setup_required: false,
      }),
    }),
  );
  await page.route("**/api/views**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    apiRequests.push(`${request.method()} ${url.pathname}${url.search}`);
    if (url.pathname === "/api/views/data-sources") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          pageResponse([
            { id: moduleId, name: "Equipment", department_id: departmentId },
          ]),
        ),
      });
    }
    if (url.pathname === `/api/views/data-sources/${moduleId}/fields`) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          pageResponse([
            {
              id: nameFieldId,
              module_id: moduleId,
              name: "Equipment name",
              type: "text",
              required: true,
              position: 0,
              config: {},
            },
            {
              id: statusFieldId,
              module_id: moduleId,
              name: "Status",
              type: "select",
              required: false,
              position: 1,
              config: { choices: ["In service", "Inspection due"] },
            },
            {
              id: serialFieldId,
              module_id: moduleId,
              name: "Serial number",
              type: "text",
              required: false,
              position: 2,
              config: {},
            },
            {
              id: unselectedQueryFieldId,
              module_id: moduleId,
              name: "Unselected query field",
              type: "text",
              required: false,
              position: 3,
              config: {},
            },
            {
              id: timelineStartFieldId,
              module_id: moduleId,
              name: "Start date",
              type: "date",
              required: false,
              position: 4,
              config: {},
            },
            {
              id: timelineEndFieldId,
              module_id: moduleId,
              name: "End date",
              type: "date",
              required: false,
              position: 5,
              config: {},
            },
            {
              id: calendarDateFieldId,
              module_id: moduleId,
              name: "Scheduled at",
              type: "datetime",
              required: false,
              position: 6,
              config: {},
            },
            {
              id: timelineDeadlineFieldId,
              module_id: moduleId,
              name: "Deadline",
              type: "date",
              required: false,
              position: 7,
              config: {},
            },
            {
              id: timelineProgressFieldId,
              module_id: moduleId,
              name: "Progress",
              type: "decimal",
              required: false,
              position: 8,
              config: {},
            },
            {
              id: timelineTimestampDeadlineFieldId,
              module_id: moduleId,
              name: "Timestamp deadline",
              type: "datetime",
              required: false,
              position: 9,
              config: {},
            },
            {
              id: numberFieldId,
              module_id: moduleId,
              name: "Measurement",
              type: "number",
              required: false,
              position: 10,
              config: {},
            },
            {
              id: integerFieldId,
              module_id: moduleId,
              name: "Item count",
              type: "int",
              required: false,
              position: 11,
              config: {},
            },
          ]),
        ),
      });
    }
    if (url.pathname === "/api/views/audience-options") {
      const option =
        url.searchParams.get("kind") === "role"
          ? {
              kind: "role",
              id: "00000000-0000-4000-8000-000000000017",
              label: "Operations",
            }
          : {
              kind: "user",
              id: "00000000-0000-4000-8000-000000000018",
              label: "Nina Santos",
            };
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(pageResponse([option])),
      });
    }
    if (url.pathname === "/api/views/defaults") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          pageResponse(
            personalDefault
              ? [{ module_id: moduleId, view_id: personalDefault, revision: 1 }]
              : [],
          ),
        ),
      });
    }
    if (url.pathname === "/api/views" && request.method() === "POST") {
      const body = request.postDataJSON() as {
        module_id: string;
        name: string;
        audience: SavedView["audience"];
        definition: QueryDefinition;
        presentation: SavedView["presentation"];
      };
      const created: SavedView = {
        ...saved,
        id: duplicateViewId,
        module_id: body.module_id,
        owner_id: userId,
        name: body.name,
        visibility: body.audience.kind === "private" ? "private" : "workspace",
        audience: body.audience,
        definition: body.definition,
        presentation: body.presentation,
        revision: 1,
        is_deleted: false,
        can_edit: true,
        created_at: "2026-09-23T00:00:00Z",
        updated_at: "2026-09-23T00:00:00Z",
      };
      createdViews.push(created);
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(created),
      });
    }
    if (url.pathname === "/api/views" && request.method() === "GET") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      if (options.deepViewBeyondBound) {
        const total = 1001;
        const items = Array.from(
          { length: Math.min(limit, Math.max(0, total - offset)) },
          (_, index) => {
            const absoluteIndex = offset + index;
            const sequence = (offset + index + 1)
              .toString(16)
              .padStart(12, "0");
            if (absoluteIndex === total - 1) return saved;
            return {
              ...saved,
              id: `10000000-0000-4000-8000-${sequence}`,
              name: `Older view ${offset + index + 1}`,
            };
          },
        );
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(
            pageResponse(
              items,
              limit,
              offset,
              total,
              offset + items.length < total,
            ),
          ),
        });
      }
      const includeDeleted = url.searchParams.get("deleted") === "include";
      const allViews = [
        saved,
        ...(options.additionalViews ?? []),
        ...createdViews,
      ];
      const views = allViews.filter(
        (view) =>
          view.module_id === url.searchParams.get("module_id") &&
          (includeDeleted || !view.is_deleted),
      );
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(pageResponse(views, limit, offset, views.length)),
      });
    }
    if (url.pathname === `/api/views/${viewId}` && request.method() === "GET") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(saved),
      });
    }
    if (
      url.pathname === `/api/views/${viewId}` &&
      request.method() === "PATCH"
    ) {
      const barrier = nextPatchBarrier;
      if (barrier) {
        nextPatchBarrier = null;
        barrier.signalStarted();
        await barrier.wait;
      }
      if (nextPatchIsStale) {
        nextPatchIsStale = false;
        saved = {
          ...saved,
          revision: saved.revision + 1,
          definition: { ...saved.definition, search: "external edit" },
        };
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            detail: {
              code: "stale_revision",
              message: "View changed; reload before saving",
              current_revision: saved.revision,
            },
          }),
        });
      }
      const body = request.postDataJSON() as {
        revision: number;
        name?: string;
        audience?: SavedView["audience"];
        definition?: QueryDefinition;
        presentation?: SavedView["presentation"];
      };
      if (body.revision !== saved.revision) {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ detail: { code: "stale_revision" } }),
        });
      }
      saved = {
        ...saved,
        revision: saved.revision + 1,
        name: body.name ?? saved.name,
        audience: body.audience ?? saved.audience,
        visibility:
          body.audience && body.audience.kind !== "private"
            ? "workspace"
            : saved.visibility,
        definition: body.definition ?? saved.definition,
        presentation: body.presentation ?? saved.presentation,
        updated_at: new Date().toISOString(),
      };
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(saved),
      });
    }
    if (
      url.pathname === `/api/views/${viewId}` &&
      request.method() === "DELETE"
    ) {
      if (nextMutationFailure === "archive") {
        nextMutationFailure = null;
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Archive temporarily failed." }),
        });
      }
      saved = { ...saved, revision: saved.revision + 1, is_deleted: true };
      return route.fulfill({ status: 204, body: "" });
    }
    if (
      url.pathname === `/api/views/${viewId}/restore` &&
      request.method() === "POST"
    ) {
      if (nextMutationFailure === "restore") {
        nextMutationFailure = null;
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Restore temporarily failed." }),
        });
      }
      saved = { ...saved, revision: saved.revision + 1, is_deleted: false };
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(saved),
      });
    }
    if (
      url.pathname === `/api/views/defaults/${moduleId}` &&
      request.method() === "PUT"
    ) {
      const body = request.postDataJSON() as { view_id: string };
      personalDefault = body.view_id;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          module_id: moduleId,
          view_id: personalDefault,
          revision: 1,
        }),
      });
    }
    if (
      url.pathname === `/api/views/defaults/${moduleId}` &&
      request.method() === "DELETE"
    ) {
      if (nextMutationFailure === "default-clear") {
        nextMutationFailure = null;
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Default could not be cleared." }),
        });
      }
      personalDefault = null;
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: "{}",
    });
  });
  await page.route("**/api/records/query", async (route: Route) => {
    const body = route.request().postDataJSON() as {
      definition: QueryDefinition;
      limit?: number;
      offset?: number;
    };
    recordQueryRequests.push(body);
    if (denyRecordQueries) {
      return route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Forbidden" }),
      });
    }
    const search = body.definition.search?.toLowerCase() ?? "";
    if (nextRecordLookupBarrier && search.includes("-")) {
      const barrier = nextRecordLookupBarrier;
      nextRecordLookupBarrier = null;
      barrier.signalStarted();
      await barrier.wait;
    }
    const regularRows = [
      record(
        recordOneId,
        options.recordName ?? "Centrifugal pump 04",
        "In service",
      ),
      record(recordTwoId, "Cooling panel 02", "Inspection due"),
      ...Array.from({ length: 28 }, (_, index) =>
        record(
          `00000000-0000-4000-8000-${(index + 32).toString().padStart(12, "0")}`,
          index === 0 ? "Compressor 01" : `Equipment ${index + 3}`,
          "In service",
        ),
      ),
    ];
    const allRows = [
      ...regularRows,
      ...(kanbanRows.some((row) => row.id.toLowerCase() === search)
        ? kanbanRows
        : []),
      ...(windowRows.some((row) => row.id.toLowerCase() === search)
        ? windowRows
        : []),
    ].filter(
      (row) =>
        row.id !== deniedRecordId &&
        (!search ||
          row.id.toLowerCase().includes(search) ||
          String(row.data[nameFieldId]).toLowerCase().includes(search)),
    );
    const limit = body.limit ?? 25;
    const offset = body.offset ?? 0;
    const requestedFieldIds = new Set(
      body.definition.columns.map(({ field_id }) => field_id),
    );
    const rows = allRows.slice(offset, offset + limit).map((row) => ({
      ...row,
      data: Object.fromEntries(
        Object.entries(row.data).filter(([fieldId]) =>
          requestedFieldIds.has(fieldId),
        ),
      ),
    }));
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        pageResponse(
          rows,
          limit,
          offset,
          allRows.length,
          offset + rows.length < allRows.length,
        ),
      ),
    });
  });
  await page.route("**/api/records/grouped-query", async (route: Route) => {
    const body = route
      .request()
      .postDataJSON() as (typeof groupedQueryRequests)[number];
    groupedQueryRequests.push(body);
    if (failNextGroupedQuery) {
      failNextGroupedQuery = false;
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Grouped query temporarily failed." }),
      });
    }
    const rows = kanbanRows;
    const fieldId = body.group_by.field_id;
    const groupValue = (row: ReturnType<typeof record>) =>
      (row.data as Record<string, unknown>)[fieldId];
    const groups = Array.from(
      new Set(rows.map((row) => String(groupValue(row) ?? ""))),
    )
      .sort((left, right) => left.localeCompare(right))
      .map((value) => ({
        value,
        label: value,
        count: rows.filter((row) => String(groupValue(row) ?? "") === value)
          .length,
      }));
    const groupOffset = body.group_offset ?? 0;
    const groupLimit = body.group_limit ?? 12;
    const selectedGroup = body.selected_group ?? null;
    const selectedRows =
      selectedGroup?.kind === "value"
        ? rows.filter((row) => groupValue(row) === selectedGroup.value)
        : [];
    const offset = body.offset ?? 0;
    const limit = body.limit ?? 25;
    const selectedFieldIds = new Set(
      saved.definition.columns.map(({ field_id }) => field_id),
    );
    const items = selectedRows.slice(offset, offset + limit).map((row) => ({
      ...row,
      data: Object.fromEntries(
        Object.entries(row.data).filter(([id]) => selectedFieldIds.has(id)),
      ),
    }));
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items,
        pagination:
          selectedGroup === null
            ? null
            : {
                limit,
                offset,
                count: items.length,
                total: selectedRows.length,
                has_more: offset + items.length < selectedRows.length,
              },
        groups: groups.slice(groupOffset, groupOffset + groupLimit),
        group_pagination: {
          limit: groupLimit,
          offset: groupOffset,
          count: Math.min(groupLimit, Math.max(0, groups.length - groupOffset)),
          total: groups.length,
          has_more: groupOffset + groupLimit < groups.length,
        },
        selected_group: selectedGroup,
      }),
    });
  });
  await page.route("**/api/records/window-query", async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    windowQueryRequests.push(body);
    if (failNextWindowQuery) {
      failNextWindowQuery = false;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Window query temporarily failed." }),
      });
    }
    const definition = body.definition as QueryDefinition;
    const selectedFieldIds = new Set(
      definition.columns.map(({ field_id }) => field_id),
    );
    const undated = record(
      recordTwoId,
      "Unscheduled equipment",
      "Inspection due",
    );
    const allRows =
      body.scope === "undated" || body.scope === "unscheduled"
        ? [
            {
              ...undated,
              data: {
                ...undated.data,
                [calendarDateFieldId]: null,
                [timelineStartFieldId]: null,
                [timelineEndFieldId]: null,
              },
            },
          ]
        : windowRows;
    const limit = Number(body.limit ?? 25);
    const offset = Number(body.offset ?? 0);
    const items = allRows.slice(offset, offset + limit).map((item) => ({
      ...item,
      data: Object.fromEntries(
        Object.entries(item.data).filter(([id]) => selectedFieldIds.has(id)),
      ),
    }));
    const includesDatetime = definition.columns.some(
      ({ expected_type }) => expected_type === "datetime",
    );
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...pageResponse(
          items,
          limit,
          offset,
          allRows.length,
          offset + items.length < allRows.length,
        ),
        timezone: includesDatetime ? "Asia/Manila" : null,
      }),
    });
  });
  return {
    requests: apiRequests,
    triggerInvalidation: (entity: string) =>
      sendOpenViewEvent(page, "invalidate", { entity }),
    makeNextPatchStale: () => {
      nextPatchIsStale = true;
    },
    rejectNextMutation: (mutation: "archive" | "restore" | "default-clear") => {
      nextMutationFailure = mutation;
    },
    pauseNextPatch: () => {
      let signalStarted: () => void = () => undefined;
      let releasePatch: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        releasePatch = resolve;
      });
      nextPatchBarrier = { wait, signalStarted };
      return { started, release: releasePatch };
    },
    saved: () => saved,
    changeSavedViewElsewhere: (search: string) => {
      saved = {
        ...saved,
        revision: saved.revision + 1,
        definition: { ...saved.definition, search },
        updated_at: new Date().toISOString(),
      };
    },
    createdViews: () => createdViews,
    personalDefault: () => personalDefault,
    changePersonalDefaultElsewhere: (viewId: string) => {
      personalDefault = viewId;
    },
    recordQueryRequests,
    denyRecordQueries() {
      denyRecordQueries = true;
    },
    denyRecordId: (id: string) => {
      deniedRecordId = id;
    },
    pauseNextRecordLookup: () => {
      let signalStarted: () => void = () => undefined;
      let release: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      nextRecordLookupBarrier = { wait, signalStarted };
      return { started, release };
    },
    groupedQueryRequests,
    failNextGroupedQuery: () => {
      failNextGroupedQuery = true;
    },
    windowQueryRequests,
    failNextWindowQuery: () => {
      failNextWindowQuery = true;
    },
  };
}

async function openFilters(page: Page) {
  const dialog = page.getByRole("dialog", { name: "More filters" });
  if (!(await dialog.isVisible()))
    await page.getByRole("button", { name: /More filters/ }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openLayoutSettings(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Layout settings" });
  if (!(await dialog.isVisible()))
    await page.getByRole("button", { name: "Layout settings" }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openColumns(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Columns" });
  if (!(await dialog.isVisible()))
    await page.getByRole("button", { name: "Columns", exact: true }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}

async function closeDialog(dialog: Locator) {
  await dialog.getByRole("button", { name: "Close" }).click();
}

async function setLayoutFromSettings(page: Page, layout: SavedViewLayout) {
  const dialog = await openLayoutSettings(page);
  await dialog.getByLabel("Presentation layout").selectOption(layout);
  await closeDialog(dialog);
}

async function expectLayoutFromSettings(page: Page, layout: SavedViewLayout) {
  const dialog = await openLayoutSettings(page);
  await expect(dialog.getByLabel("Presentation layout")).toHaveValue(layout);
  await closeDialog(dialog);
}

async function openViewAction(page: Page, action: string) {
  await page.getByRole("button", { name: "View actions" }).click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}

async function addFilterForField(page: Page, fieldId: string) {
  const dialog = await openFilters(page);
  await dialog.getByRole("button", { name: "Add filter" }).click();
  await dialog
    .getByRole("combobox", { name: "Field", exact: true })
    .selectOption(fieldId);
  await closeDialog(dialog);
}

async function enterFilterAndWaitForQuery(
  page: Page,
  fieldId: string,
  value: string,
) {
  const dialog = await openFilters(page);
  const requestPromise = page.waitForRequest((request) => {
    const url = new URL(request.url());
    if (url.pathname !== "/api/records/query" || request.method() !== "POST")
      return false;
    const body = request.postDataJSON() as { definition: QueryDefinition };
    return body.definition.filters.some(
      (filter) =>
        filter.field_id === fieldId &&
        (filter.value === value || filter.value === Number(value)),
    );
  });
  await dialog.getByLabel("Value").fill(value);
  await closeDialog(dialog);
  return requestPromise;
}

test("decimal View filters retain ordinary and high-precision strings", async ({
  page,
}) => {
  await installViewsApi(page);
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await addFilterForField(page, timelineProgressFieldId);

  for (const value of ["1.25", "9007199254740993"]) {
    const request = await enterFilterAndWaitForQuery(
      page,
      timelineProgressFieldId,
      value,
    );
    const body = request.postDataJSON() as { definition: QueryDefinition };
    const filter = body.definition.filters.find(
      (item) => item.field_id === timelineProgressFieldId,
    );

    expect(filter).toEqual({
      field_id: timelineProgressFieldId,
      expected_type: "decimal",
      operator: "eq",
      value,
    });
  }
});

test("number View filters continue sending numeric values", async ({
  page,
}) => {
  await installViewsApi(page);
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await addFilterForField(page, numberFieldId);

  const request = await enterFilterAndWaitForQuery(page, numberFieldId, "12.5");
  const body = request.postDataJSON() as { definition: QueryDefinition };
  const filter = body.definition.filters.find(
    (item) => item.field_id === numberFieldId,
  );

  expect(filter).toEqual({
    field_id: numberFieldId,
    expected_type: "number",
    operator: "eq",
    value: 12.5,
  });
});

test("membership View filters accept comma-separated typing and submit lists", async ({
  page,
}) => {
  const api = await installViewsApi(page);
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await addFilterForField(page, statusFieldId);

  const filterDialog = await openFilters(page);
  const operator = filterDialog.getByRole("combobox", { name: "Condition" });
  await operator.selectOption("in");

  const value = filterDialog.getByLabel("Value");
  await value.pressSequentially("In service, Inspection due");
  await expect(value).toHaveValue("In service, Inspection due");
  const expectedMembershipFilter = {
    field_id: statusFieldId,
    expected_type: "select",
    operator: "in",
    value: ["In service", "Inspection due"],
  };
  await expect
    .poll(() =>
      api.recordQueryRequests.some(({ definition }) =>
        definition.filters.some(
          (filter) =>
            filter.field_id === statusFieldId &&
            JSON.stringify(filter.value) ===
              JSON.stringify(expectedMembershipFilter.value),
        ),
      ),
    )
    .toBe(true);
  const submittedQueryFilter = api.recordQueryRequests
    .find(({ definition }) =>
      definition.filters.some(
        (filter) =>
          filter.field_id === statusFieldId &&
          JSON.stringify(filter.value) ===
            JSON.stringify(expectedMembershipFilter.value),
      ),
    )
    ?.definition.filters.find((filter) => filter.field_id === statusFieldId);
  expect(submittedQueryFilter).toEqual(expectedMembershipFilter);
  await closeDialog(filterDialog);

  const saveRequestPromise = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return (
      url.pathname === `/api/views/${viewId}` && request.method() === "PATCH"
    );
  });
  await page.getByRole("button", { name: "Save changes" }).click();
  await saveRequestPromise;
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Equipment register” was saved." }),
  ).toHaveText("“Equipment register” was saved.");
  expect(api.saved().definition.filters).toEqual([
    {
      field_id: statusFieldId,
      expected_type: "select",
      operator: "in",
      value: ["In service", "Inspection due"],
    },
  ]);
});

for (const layout of ["kanban", "calendar", "timeline"] as const) {
  test(`${layout} does not query incomplete filters and sends typed membership values`, async ({
    page,
  }) => {
    const api = await installViewsApi(page, { initialLayout: layout });
    await page.goto(
      `/openview?section=views&module=${moduleId}&view=${viewId}`,
    );
    const layoutDialog = await openLayoutSettings(page);
    await expect(layoutDialog.getByLabel("Presentation layout")).toHaveValue(
      layout,
    );
    if (layout === "kanban") {
      await layoutDialog
        .getByRole("combobox", { name: "Group lanes by" })
        .selectOption(nameFieldId);
      await expect
        .poll(() => api.groupedQueryRequests.length)
        .toBeGreaterThan(0);
    } else {
      await expect
        .poll(() => api.windowQueryRequests.length)
        .toBeGreaterThan(0);
    }
    await closeDialog(layoutDialog);
    const requests =
      layout === "kanban" ? api.groupedQueryRequests : api.windowQueryRequests;
    const initialRequestCount = requests.length;

    await addFilterForField(page, statusFieldId);
    const filterDialog = await openFilters(page);
    await expect(
      filterDialog.getByText(
        "Complete this condition or remove it before saving.",
      ),
    ).toBeVisible();
    expect(
      requests
        .slice(initialRequestCount)
        .some((request) =>
          (request.definition as QueryDefinition).filters.some(
            (filter) => filter.value === "",
          ),
        ),
    ).toBe(false);

    await filterDialog
      .getByRole("combobox", { name: "Condition" })
      .selectOption("in");
    expect(
      requests
        .slice(initialRequestCount)
        .some((request) =>
          (request.definition as QueryDefinition).filters.some(
            (filter) => filter.operator === "in" && filter.value === "",
          ),
        ),
    ).toBe(false);
    const value = filterDialog.getByLabel("Value");
    await value.pressSequentially("In service, Inspection due");
    await expect(value).toHaveValue("In service, Inspection due");
    await expect
      .poll(() =>
        requests.some((request) => {
          const definition = request.definition as QueryDefinition;
          return definition.filters.some(
            (filter) =>
              filter.field_id === statusFieldId &&
              filter.operator === "in" &&
              JSON.stringify(filter.value) ===
                JSON.stringify(["In service", "Inspection due"]),
          );
        }),
      )
      .toBe(true);
    await closeDialog(filterDialog);
  });
}

test("switching scalar and membership View filters clears incompatible values", async ({
  page,
}) => {
  await installViewsApi(page);
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await addFilterForField(page, statusFieldId);

  const filterDialog = await openFilters(page);
  const operator = filterDialog.getByRole("combobox", { name: "Condition" });
  const value = filterDialog.getByLabel("Value");

  await value.fill("In service");
  await operator.selectOption("in");
  await expect(value).toHaveValue("");
  await expect(
    page.getByText("Complete this condition or remove it before saving."),
  ).toBeVisible();
  await value.fill("In service, Inspection due");
  await operator.selectOption("eq");
  await expect(value).toHaveValue("");
  await closeDialog(filterDialog);
  await expect(
    page.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save view" })).toBeDisabled();
});

test("changing a Views filter field with the keyboard retains focus", async ({
  page,
}) => {
  await installViewsApi(page);
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  const filterDialog = await openFilters(page);
  await filterDialog.getByRole("button", { name: "Add filter" }).click();

  const field = filterDialog.getByRole("combobox", { name: "Field" });
  await expect(field).toHaveValue(nameFieldId);
  await field.focus();
  await page.keyboard.press("s");

  await expect(field).toHaveValue(statusFieldId);
  await expect(field).toBeFocused();
});

test("clearing a number View filter stays blank instead of querying zero", async ({
  page,
}) => {
  const api = await installViewsApi(page);
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await addFilterForField(page, numberFieldId);
  const filterDialog = await openFilters(page);

  const value = filterDialog.getByLabel("Value");
  await value.fill("12.5");
  await expect
    .poll(() =>
      api.recordQueryRequests.some(({ definition }) =>
        definition.filters.some(
          (filter) =>
            filter.field_id === numberFieldId && filter.value === 12.5,
        ),
      ),
    )
    .toBe(true);
  const requestCountBeforeClear = api.recordQueryRequests.length;

  await value.fill("");
  await expect(value).toHaveValue("");
  await expect(
    filterDialog.getByText(
      "Complete this condition or remove it before saving.",
    ),
  ).toBeVisible();
  await closeDialog(filterDialog);
  await expect(
    page.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save view" })).toBeDisabled();
  expect(
    api.recordQueryRequests
      .slice(requestCountBeforeClear)
      .some(({ definition }) =>
        definition.filters.some(
          (filter) => filter.field_id === numberFieldId && filter.value === 0,
        ),
      ),
  ).toBe(false);
});

test("unsafe integer View filters fail locally without sending a rounded value", async ({
  page,
}) => {
  const api = await installViewsApi(page);
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await addFilterForField(page, integerFieldId);
  const filterDialog = await openFilters(page);

  const valueInput = filterDialog.getByLabel("Value");
  for (const value of ["9007199254740993", "1.0000000000000001"]) {
    await valueInput.fill(value);

    await expect(valueInput).toHaveValue(value);
    await expect(valueInput).toHaveAttribute("aria-invalid", "true");
    await expect(valueInput).toHaveAttribute(
      "aria-describedby",
      "openview-filter-value-error-0",
    );
    await expect(
      page.getByText(
        "Enter a whole number from -9007199254740991 to 9007199254740991.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(
      api.recordQueryRequests.some(({ definition }) =>
        definition.filters.some(
          (filter) =>
            filter.field_id === integerFieldId &&
            filter.value !== "" &&
            filter.value !== null &&
            filter.value !== undefined,
        ),
      ),
    ).toBe(false);
  }
  await closeDialog(filterDialog);
  await expect(
    page.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
});

test("server-backed Views preserve edits through save, conflict, archive, restore, and default changes", async ({
  page,
}) => {
  const api = await installViewsApi(page);

  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await expect(page.getByRole("heading", { name: "Views" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Saved view" })).toHaveValue(
    viewId,
  );
  await expect(page.getByText("Centrifugal pump 04")).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`module=${moduleId}.*view=${viewId}`),
  );

  const search = page.getByRole("textbox", { name: "Search Equipment" });
  await search.fill("panel");
  await expect(page.getByText("Cooling panel 02")).toBeVisible();
  await expect(page.getByText("Centrifugal pump 04")).toHaveCount(0);
  await page.getByRole("link", { name: "Dashboards" }).click();
  const discardDialog = page.getByRole("alertdialog", {
    name: "Discard unsaved view changes?",
  });
  await expect(discardDialog).toBeVisible();
  await discardDialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(
    new RegExp(`module=${moduleId}.*view=${viewId}`),
  );
  const firstSave = api.pauseNextPatch();
  await page.getByRole("button", { name: "Save changes" }).click();
  await firstSave.started;
  await search.fill("panel 02");
  firstSave.release();
  await expect(
    page.getByRole("status").filter({ hasText: "newer edits remain" }),
  ).toHaveText(
    "“Equipment register” was saved. Your newer edits remain open as an unsaved draft.",
  );
  await expect(search).toHaveValue("panel 02");
  expect(api.saved().definition.search).toBe("panel");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "“Equipment register” was saved." }),
  ).toHaveText("“Equipment register” was saved.");
  expect(api.saved().definition.search).toBe("panel 02");

  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Search Equipment" }),
  ).toHaveValue("panel 02");
  await expect(page.getByText("Cooling panel 02")).toBeVisible();

  api.makeNextPatchStale();
  await page
    .getByRole("textbox", { name: "Search Equipment" })
    .fill("compressor");
  await page.getByRole("button", { name: "Save changes" }).click();
  const conflictDialog = page.getByRole("dialog", {
    name: "Update saved view",
  });
  await expect(conflictDialog).toBeVisible();
  await expect(
    conflictDialog.getByText(/Query, filters, or sort/),
  ).toBeVisible();
  await expect(
    conflictDialog.getByText(/local search “compressor”/),
  ).toBeVisible();
  await expect(
    conflictDialog.getByRole("button", { name: "Update view" }),
  ).toHaveCount(0);
  expect(api.saved().definition.search).toBe("external edit");

  api.makeNextPatchStale();
  await conflictDialog
    .getByRole("button", { name: "Save my version over latest" })
    .click();
  await expect(conflictDialog).toBeVisible();
  expect(api.saved().definition.search).toBe("external edit");
  await conflictDialog
    .getByRole("button", { name: "Save my version over latest" })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "“Equipment register” was saved." }),
  ).toHaveText("“Equipment register” was saved.");
  expect(api.saved().definition.search).toBe("compressor");

  await page
    .getByRole("textbox", { name: "Search Equipment" })
    .fill("draft before archive");
  await openViewAction(page, "Archive view");
  const archiveDialog = page.getByRole("alertdialog", {
    name: "Archive saved view?",
  });
  await archiveDialog.getByRole("button", { name: "Archive view" }).click();
  await expect(discardDialog).toBeVisible();
  expect(api.saved().is_deleted).toBe(false);
  await discardDialog.getByRole("button", { name: "Keep editing" }).click();
  await archiveDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(
    page.getByRole("textbox", { name: "Search Equipment" }),
  ).toHaveValue("draft before archive");
  expect(api.saved().is_deleted).toBe(false);
  await openViewAction(page, "Archive view");
  api.rejectNextMutation("archive");
  await archiveDialog.getByRole("button", { name: "Archive view" }).click();
  await discardDialog
    .getByRole("button", { name: "Discard and continue" })
    .click();
  await expect(
    archiveDialog.getByRole("alert").filter({ hasText: "Archive" }),
  ).toBeVisible();
  expect(api.saved().is_deleted).toBe(false);
  await expect(page.locator("#openview-search")).toHaveValue(
    "draft before archive",
  );
  await archiveDialog.getByRole("button", { name: "Cancel" }).click();

  await openViewAction(page, "Archive view");
  await archiveDialog.getByRole("button", { name: "Archive view" }).click();
  await discardDialog
    .getByRole("button", { name: "Discard and continue" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "archived" }),
  ).toBeVisible();
  await expect(page).toHaveURL(`/openview?section=views&module=${moduleId}`);

  await page
    .getByRole("textbox", { name: "Search Equipment" })
    .fill("draft before restore");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await expect(page).toHaveURL(`/openview?section=views&module=${moduleId}`);
  await page.getByRole("button", { name: "Archived views" }).click();
  const archivedDialog = page.getByRole("dialog", { name: "Archived views" });
  await expect(
    archivedDialog.getByText("Equipment register", { exact: true }),
  ).toBeVisible();
  await archivedDialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await page.getByRole("button", { name: "Archived views" }).click();
  await archivedDialog
    .getByRole("button", { name: "Restore Equipment register" })
    .click();
  await expect(discardDialog).toBeVisible();
  expect(api.saved().is_deleted).toBe(true);
  await discardDialog.getByRole("button", { name: "Keep editing" }).click();
  await archivedDialog.getByRole("button", { name: "Close" }).click();
  await expect(
    page.getByRole("textbox", { name: "Search Equipment" }),
  ).toHaveValue("draft before restore");
  expect(api.saved().is_deleted).toBe(true);
  await page.getByRole("button", { name: "Archived views" }).click();
  await archivedDialog
    .getByRole("button", { name: "Restore Equipment register" })
    .click();
  api.rejectNextMutation("restore");
  await discardDialog
    .getByRole("button", { name: "Discard and continue" })
    .click();
  await expect(
    archivedDialog.getByRole("alert").filter({ hasText: "Restore" }),
  ).toBeVisible();
  expect(api.saved().is_deleted).toBe(true);
  await expect(page.locator("#openview-search")).toHaveValue(
    "draft before restore",
  );
  await archivedDialog
    .getByRole("button", { name: "Restore Equipment register" })
    .click();
  await discardDialog
    .getByRole("button", { name: "Discard and continue" })
    .click();
  await expect(
    archivedDialog.getByRole("status").filter({ hasText: "restored" }),
  ).toBeVisible();
  await archivedDialog.getByRole("button", { name: "Close" }).click();

  await openViewAction(page, "Set as my default");
  await expect(
    page.getByRole("status").filter({ hasText: "default" }),
  ).toBeVisible();
  expect(api.personalDefault()).toBe(viewId);
  expect(
    api.requests.some((request) => request.includes("deleted=include")),
  ).toBe(true);
});

test("clearing an implicit default asks before discarding its local draft", async ({
  page,
}) => {
  const api = await installViewsApi(page, { initialDefault: true });

  await page.goto(`/openview?section=views&module=${moduleId}`);
  await expect(page.getByRole("combobox", { name: "Saved view" })).toHaveValue(
    viewId,
  );
  const search = page.getByRole("textbox", { name: "Search Equipment" });
  await search.fill("unpublished default draft");
  await openViewAction(page, "Clear my default");

  const discardDialog = page.getByRole("alertdialog", {
    name: "Discard unsaved view changes?",
  });
  await expect(discardDialog).toBeVisible();
  expect(api.personalDefault()).toBe(viewId);
  await discardDialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(search).toHaveValue("unpublished default draft");
  expect(api.personalDefault()).toBe(viewId);

  await openViewAction(page, "Clear my default");
  api.rejectNextMutation("default-clear");
  await discardDialog
    .getByRole("button", { name: "Discard and continue" })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Default" }),
  ).toBeVisible();
  expect(api.personalDefault()).toBe(viewId);
  await expect(search).toHaveValue("unpublished default draft");

  await openViewAction(page, "Clear my default");
  await discardDialog
    .getByRole("button", { name: "Discard and continue" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "default was cleared" }),
  ).toBeVisible();
  expect(api.personalDefault()).toBe(null);
  await expect(search).toHaveValue("");
  await expect(page).toHaveURL(`/openview?section=views&module=${moduleId}`);
});

test("selecting Unsaved view overrides a personal default after discard confirmation", async ({
  page,
}) => {
  await installViewsApi(page, { initialDefault: true });

  await page.goto(`/openview?section=views&module=${moduleId}`);
  const savedView = page.getByRole("combobox", { name: "Saved view" });
  await expect(savedView).toHaveValue(viewId);
  const search = page.getByRole("textbox", { name: "Search Equipment" });
  await search.fill("keep until confirmed");
  await savedView.selectOption("");

  const discardDialog = page.getByRole("alertdialog", {
    name: "Discard unsaved view changes?",
  });
  await expect(discardDialog).toBeVisible();
  await discardDialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(savedView).toHaveValue(viewId);
  await expect(search).toHaveValue("keep until confirmed");

  await savedView.selectOption("");
  await discardDialog
    .getByRole("button", { name: "Discard and continue" })
    .click();

  await expect(savedView).toHaveValue("");
  await expect(search).toHaveValue("");
  await expect(page).toHaveURL(`/openview?section=views&module=${moduleId}`);
  await page.reload();
  await expect(savedView).toHaveValue(viewId);
});

test("duplicating a saved view saves the current draft as a private selected copy", async ({
  page,
}) => {
  const existingCopy = {
    ...baseView(),
    id: secondViewId,
    name: "Equipment register (copy)",
  };
  const api = await installViewsApi(page, {
    additionalViews: [existingCopy],
  });

  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await page
    .getByRole("textbox", { name: "Search Equipment" })
    .fill("draft query");
  await setLayoutFromSettings(page, "grid");
  await openViewAction(page, "Duplicate view");

  await expect(
    page.getByRole("status").filter({ hasText: "was duplicated" }),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Saved view" })).toHaveValue(
    duplicateViewId,
  );
  await expect(page).toHaveURL(
    `/openview?section=views&module=${moduleId}&view=${duplicateViewId}`,
  );
  await expect(
    page.getByRole("textbox", { name: "Search Equipment" }),
  ).toHaveValue("draft query");

  expect(api.createdViews()).toHaveLength(1);
  expect(api.createdViews()[0]).toMatchObject({
    name: "Equipment register (copy 2)",
    audience: { kind: "private" },
    definition: { search: "draft query" },
    presentation: { layout: "grid" },
    owner_id: userId,
    can_edit: true,
  });
  expect(api.saved()).toMatchObject({
    name: "Equipment register",
    definition: { search: "pump" },
  });
});

test("duplicating a long Unicode view keeps the copy name within the API limit", async ({
  page,
}) => {
  const api = await installViewsApi(page, { initialName: "🚜".repeat(100) });

  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await openViewAction(page, "Duplicate view");

  await expect(
    page.getByRole("status").filter({ hasText: "was duplicated" }),
  ).toBeVisible();
  expect(api.createdViews()).toHaveLength(1);
  expect(api.createdViews()[0].name.length).toBeLessThanOrEqual(200);
  expect(api.createdViews()[0].name.endsWith(" (copy)")).toBe(true);
});

test("resetting changes restores the saved base or clears an unsaved draft", async ({
  page,
}) => {
  const api = await installViewsApi(page);

  await page.goto(`/openview?section=views&module=${moduleId}`);
  const search = page.getByRole("textbox", { name: "Search Equipment" });
  await expectLayoutFromSettings(page, "table");
  await search.fill("unsaved draft");
  await setLayoutFromSettings(page, "grid");
  await page.getByRole("button", { name: "Reset changes" }).click();
  await expect(search).toHaveValue("");
  await expectLayoutFromSettings(page, "table");
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);
  await expect(page).toHaveURL(`/openview?section=views&module=${moduleId}`);

  await page.getByRole("combobox", { name: "Saved view" }).selectOption(viewId);
  await expect(search).toHaveValue("pump");
  await search.fill("saved draft");
  await setLayoutFromSettings(page, "grid");
  await page.getByRole("button", { name: "Reset changes" }).click();

  await expect(search).toHaveValue("pump");
  await expectLayoutFromSettings(page, "table");
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Saved view" })).toHaveValue(
    viewId,
  );
  await expect(page).toHaveURL(
    `/openview?section=views&module=${moduleId}&view=${viewId}`,
  );
  expect(api.saved()).toMatchObject({
    definition: { search: "pump" },
    presentation: { layout: "table" },
  });
});

test("saved Views send, save, and reload up to three ordered sort rules", async ({
  page,
}) => {
  const api = await installViewsApi(page, { disableInitialSearch: true });

  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  const settings = await openLayoutSettings(page);
  const addSort = page.getByRole("button", { name: "Add sort rule" });
  await addSort.click();
  await page.getByLabel("Sort field 1").selectOption(statusFieldId);
  await page.getByLabel("Sort direction 1").selectOption("desc");
  await addSort.click();
  await page.getByLabel("Sort field 2").selectOption(nameFieldId);
  await page.getByLabel("Sort direction 2").selectOption("asc");
  await addSort.click();
  await page.getByLabel("Sort field 3").selectOption(serialFieldId);
  await page.getByLabel("Sort direction 3").selectOption("desc");
  await expect(addSort).toBeDisabled();

  const expectedSort = [
    { field_id: statusFieldId, expected_type: "select", direction: "desc" },
    { field_id: nameFieldId, expected_type: "text", direction: "asc" },
    { field_id: serialFieldId, expected_type: "text", direction: "desc" },
  ];
  await expect
    .poll(() => api.recordQueryRequests.at(-1)?.definition.sort)
    .toEqual(expectedSort);
  await closeDialog(settings);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "was saved" }),
  ).toBeVisible();
  expect(api.saved().definition.sort).toEqual(expectedSort);

  await page.reload();
  const reloadedSettings = await openLayoutSettings(page);
  await expect(reloadedSettings.getByLabel("Sort field 1")).toHaveValue(
    statusFieldId,
  );
  await expect(reloadedSettings.getByLabel("Sort direction 1")).toHaveValue(
    "desc",
  );
  await expect(reloadedSettings.getByLabel("Sort field 2")).toHaveValue(
    nameFieldId,
  );
  await expect(reloadedSettings.getByLabel("Sort direction 2")).toHaveValue(
    "asc",
  );
  await expect(reloadedSettings.getByLabel("Sort field 3")).toHaveValue(
    serialFieldId,
  );
  await expect(reloadedSettings.getByLabel("Sort direction 3")).toHaveValue(
    "desc",
  );
  await expect(
    reloadedSettings.getByRole("button", { name: "Add sort rule" }),
  ).toBeDisabled();
  await closeDialog(reloadedSettings);

  await page.getByRole("combobox", { name: "Sort" }).selectOption("");
  await expect
    .poll(() => api.recordQueryRequests.at(-1)?.definition.sort)
    .toEqual([]);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => api.saved().definition.sort).toEqual([]);
});

for (const layout of ["table", "grid", "gallery"] as const) {
  test(`${layout} grouping uses server counts and separately paginates selected records`, async ({
    page,
  }) => {
    const api = await installViewsApi(page, { disableInitialSearch: true });

    await page.goto(
      `/openview?section=views&module=${moduleId}&view=${viewId}`,
    );
    const settings = await openLayoutSettings(page);
    await settings.getByLabel("Presentation layout").selectOption(layout);
    await settings.getByLabel("Group records by").selectOption(statusFieldId);
    await closeDialog(settings);

    const group = page.getByRole("button", {
      name: "In service, 38 records",
    });
    await expect(group).toBeVisible();
    await expect(group).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByText("Groups 1–1 of 1").first()).toBeVisible();
    const ordinaryRequestCount = api.recordQueryRequests.length;
    expect(api.groupedQueryRequests.at(-1)).toMatchObject({
      group_by: { field_id: statusFieldId, expected_type: "select" },
      limit: 25,
      offset: 0,
      group_limit: 12,
      group_offset: 0,
      selected_group: null,
    });
    await group.click();
    await expect(group).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Showing 1–25 of 38 records")).toBeVisible();
    if (layout === "table") {
      await expect(page.getByRole("table").getByRole("row")).toHaveCount(26);
    } else {
      await expect(
        page
          .getByRole("list", {
            name: layout === "grid" ? "Grid records" : "Gallery records",
          })
          .getByRole("listitem"),
      ).toHaveCount(25);
    }
    expect(api.groupedQueryRequests.at(-1)).toMatchObject({
      limit: 25,
      offset: 0,
      group_offset: 0,
      selected_group: { kind: "value", value: "In service" },
    });
    expect(api.recordQueryRequests).toHaveLength(ordinaryRequestCount);

    await page
      .getByRole("navigation", { name: "Record result pages" })
      .getByRole("button", { name: "Go to next page" })
      .click();
    await expect(page.getByText("Showing 26–38 of 38 records")).toBeVisible();
    if (layout === "table") {
      await expect(page.getByRole("table").getByRole("row")).toHaveCount(14);
    } else {
      await expect(
        page
          .getByRole("list", {
            name: layout === "grid" ? "Grid records" : "Gallery records",
          })
          .getByRole("listitem"),
      ).toHaveCount(13);
    }
    expect(api.groupedQueryRequests.at(-1)).toMatchObject({
      limit: 25,
      offset: 25,
      group_offset: 0,
      selected_group: { kind: "value", value: "In service" },
    });
    expect(api.recordQueryRequests).toHaveLength(ordinaryRequestCount);
    if (layout === "table") {
      await page
        .getByRole("table")
        .getByRole("row")
        .nth(1)
        .getByRole("button", { name: "In service" })
        .click();
      const inspector = page.getByRole("dialog", { name: "Record details" });
      await expect(
        inspector.getByRole("heading", { name: "In service" }),
      ).toBeVisible();
      await inspector.getByRole("button", { name: "Previous record" }).click();
      await expect(page).toHaveURL(
        /record=00000000-0000-4000-8000-000000000124/,
      );
      await inspector.getByRole("button", { name: "Next record" }).click();
      await expect(page).toHaveURL(
        /record=00000000-0000-4000-8000-000000000125/,
      );
      expect(api.groupedQueryRequests.slice(-2)).toMatchObject([
        { offset: 0, selected_group: { kind: "value", value: "In service" } },
        { offset: 25, selected_group: { kind: "value", value: "In service" } },
      ]);
    }
  });
}

for (const layout of ["calendar", "timeline"] as const) {
  test(`${layout} preserves saved general grouping as inactive while querying its window`, async ({
    page,
  }) => {
    const api = await installViewsApi(page, {
      initialLayout: layout,
      initialGroupByFieldId: statusFieldId,
    });

    await page.goto(
      `/openview?section=views&module=${moduleId}&view=${viewId}`,
    );
    const settings = await openLayoutSettings(page);
    const layoutLabel = layout === "calendar" ? "Calendar" : "Timeline";
    await expect(
      settings.getByText(
        `General grouping is inactive in ${layoutLabel}; the saved group field is preserved.`,
      ),
    ).toBeVisible();
    await expect(settings.getByLabel("Group records by")).toHaveCount(0);
    await closeDialog(settings);

    await page.getByLabel("Window starts").fill("2026-09-01");
    await page.getByLabel("Window ends").fill("2026-09-30");
    await expect.poll(() => api.windowQueryRequests.at(-1)?.mode).toBe(layout);
    expect(api.windowQueryRequests.at(-1)).toMatchObject({
      mode: layout,
      scope: "window",
      from_date: "2026-09-01",
      to_date: "2026-09-30",
    });
    expect(api.groupedQueryRequests).toHaveLength(0);
    expect(api.saved().presentation.group_by_field_id).toBe(statusFieldId);
  });
}

test("saved table presentation controls persist and drive the rendered table", async ({
  page,
}) => {
  const longName =
    "Centrifugal pump assembly with a deliberately long equipment description";
  const api = await installViewsApi(page, {
    cardFieldsNotInColumns: true,
    disableInitialSearch: true,
    recordName: longName,
    initialPresentation: {
      column_field_ids: [nameFieldId, statusFieldId, serialFieldId],
      pinned_field_ids: [],
      density: "comfortable",
      wrap: false,
    },
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  const table = page.getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveText([
    "Equipment name",
    "Status",
    "Serial number",
    "Updated",
  ]);

  const columnsDialog = await openColumns(page);
  await columnsDialog.getByRole("button", { name: "Move Status up" }).click();
  await columnsDialog.getByRole("checkbox", { name: "Pin Status" }).click();
  await columnsDialog
    .getByRole("checkbox", { name: "Show Serial number" })
    .click();
  await columnsDialog.getByLabel("Row density").selectOption("compact");
  await columnsDialog.getByRole("checkbox", { name: "Wrap long text" }).click();
  await closeDialog(columnsDialog);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("status").filter({
      hasText: "“Equipment register” was saved.",
    }),
  ).toBeVisible();
  expect(api.saved().presentation).toMatchObject({
    column_field_ids: [statusFieldId, nameFieldId],
    pinned_field_ids: [statusFieldId],
    density: "compact",
    wrap: true,
  });

  await page.reload();
  await expect(table.getByRole("columnheader")).toHaveText([
    "Status",
    "Equipment name",
    "Updated",
  ]);
  const reloadedColumns = await openColumns(page);
  await expect(
    reloadedColumns.getByRole("checkbox", { name: "Show Serial number" }),
  ).toHaveAttribute("aria-checked", "false");
  await expect(
    reloadedColumns.getByRole("checkbox", { name: "Pin Status" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(reloadedColumns.getByLabel("Row density")).toHaveValue(
    "compact",
  );
  await expect(
    reloadedColumns.getByRole("checkbox", { name: "Wrap long text" }),
  ).toHaveAttribute("aria-checked", "true");
  await closeDialog(reloadedColumns);

  const pinnedHeader = table.getByRole("columnheader", { name: "Status" });
  const pinnedCell = table
    .getByRole("rowgroup")
    .nth(1)
    .getByRole("row")
    .first()
    .getByRole("cell")
    .first();
  await expect(pinnedHeader).toHaveCSS("position", "sticky");
  await expect(pinnedHeader).toHaveCSS("left", "0px");
  await expect(pinnedCell).toHaveCSS("position", "sticky");
  await expect(pinnedCell).toHaveCSS("left", "0px");
  const initialPinnedLeft = await pinnedHeader.evaluate(
    (element) => element.getBoundingClientRect().left,
  );
  const scrolled = await table.evaluate((element) => {
    const container = element.parentElement;
    if (!container) return false;
    container.scrollLeft = container.scrollWidth;
    return container.scrollLeft > 0;
  });
  expect(scrolled).toBe(true);
  await expect
    .poll(() =>
      pinnedHeader.evaluate((element) => element.getBoundingClientRect().left),
    )
    .toBe(initialPinnedLeft);

  const firstDataRow = table
    .getByRole("rowgroup")
    .nth(1)
    .getByRole("row")
    .first();
  await expect(firstDataRow.getByRole("cell").first()).toHaveCSS(
    "padding-top",
    "6px",
  );
  await expect(firstDataRow.getByRole("cell").nth(1)).toHaveCSS(
    "white-space",
    "normal",
  );
  await expect(firstDataRow.getByText(longName)).toBeVisible();
});

for (const layout of ["grid", "gallery"] as const) {
  test(`${layout} consumes saved card fields, wrapping, and size after reload`, async ({
    page,
  }) => {
    const longName =
      "Centrifugal pump assembly with a deliberately long equipment description";
    const api = await installViewsApi(page, {
      cardFieldsNotInColumns: true,
      disableInitialSearch: true,
      recordName: longName,
      initialPresentation: {
        layout,
        column_field_ids: [
          nameFieldId,
          statusFieldId,
          unselectedQueryFieldId,
          serialFieldId,
        ],
        pinned_field_ids: [],
        primary_field_id: nameFieldId,
        secondary_field_id: null,
        card_size: "comfortable",
        wrap: false,
      },
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      `/openview?section=views&module=${moduleId}&view=${viewId}`,
    );
    const records = page.getByRole("list", {
      name: layout === "grid" ? "Grid records" : "Gallery records",
    });
    const firstCard = records
      .getByRole("listitem")
      .first()
      .getByRole("article");
    await expect(
      firstCard.getByRole("button", {
        name: `Open record: ${longName}`,
        exact: true,
      }),
    ).toBeVisible();
    expect(
      (await firstCard.locator("dt").allTextContents()).map((text) =>
        text.trim(),
      ),
    ).toEqual(["Status", "Unselected query field", "Serial number"]);

    const columnsDialog = await openColumns(page);
    await columnsDialog
      .getByRole("button", { name: "Move Serial number up" })
      .click();
    const hiddenDetail = columnsDialog.getByRole("checkbox", {
      name: "Show Unselected query field",
    });
    await hiddenDetail.click();
    await expect(hiddenDetail).toHaveAttribute("aria-checked", "false");
    await columnsDialog.getByLabel("Card size").selectOption("compact");
    await columnsDialog
      .getByRole("checkbox", { name: "Wrap long text" })
      .click();
    await closeDialog(columnsDialog);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(
      page.getByRole("status").filter({
        hasText: "“Equipment register” was saved.",
      }),
    ).toBeVisible();
    expect(api.saved().presentation).toMatchObject({
      column_field_ids: [nameFieldId, statusFieldId, serialFieldId],
      card_size: "compact",
      wrap: true,
    });

    await page.reload();
    const reloadedColumns = await openColumns(page);
    await expect(reloadedColumns.getByLabel("Card size")).toHaveValue(
      "compact",
    );
    await expect(
      reloadedColumns.getByRole("checkbox", { name: "Wrap long text" }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(
      reloadedColumns.getByRole("checkbox", {
        name: "Show Unselected query field",
      }),
    ).toHaveAttribute("aria-checked", "false");
    await closeDialog(reloadedColumns);

    const firstVisibleCard = records.getByRole("listitem").first();
    const article = firstVisibleCard.getByRole("article");
    await expect(article).toHaveCSS("padding-top", "12px");
    const title = firstVisibleCard.getByRole("button", {
      name: `Open record: ${longName}`,
      exact: true,
    });
    await expect(title.locator("span")).toHaveCSS("white-space", "normal");
    expect(
      (await firstVisibleCard.locator("dt").allTextContents()).map((text) =>
        text.trim(),
      ),
    ).toEqual(["Status", "Serial number"]);
    await expect(
      firstVisibleCard.getByText("Unselected query field"),
    ).toHaveCount(0);
  });
}

test("Grid and Gallery use the current server page and save only the selected layout", async ({
  page,
}) => {
  const api = await installViewsApi(page, { cardFieldsNotInColumns: true });
  const initialPresentation = structuredClone(api.saved().presentation);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await expect(
    page.getByRole("heading", { name: "Equipment register" }),
  ).toBeVisible();

  const layout = page.getByRole("combobox", { name: "Layout" });
  await expect(layout).toHaveValue("table");
  await page.getByRole("textbox", { name: "Search Equipment" }).fill("");
  await expect(
    page.getByText("30 matching records · live workspace data"),
  ).toBeVisible();
  await layout.selectOption("grid");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "“Equipment register” was saved." }),
  ).toBeVisible();

  expect(api.saved().presentation).toMatchObject({
    ...initialPresentation,
    layout: "grid",
  });
  const grid = page.getByRole("list", { name: "Grid records" });
  await expect(grid.getByRole("listitem")).toHaveCount(25);
  const firstGridRecord = grid.getByRole("listitem").first();
  await expect(
    firstGridRecord.getByRole("button", {
      name: "Open record: S",
      exact: true,
    }),
  ).toBeVisible();
  await expect(firstGridRecord.getByText("Status: In service")).toBeVisible();
  await expect(
    grid.getByText("Do not surface this query-only field", { exact: true }),
  ).toHaveCount(0);
  const shortTitle = firstGridRecord.getByRole("button", {
    name: "Open record: S",
    exact: true,
  });
  const shortTitleBounds = await shortTitle.boundingBox();
  expect(shortTitleBounds?.width).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(
    page.getByText("Showing 1–25 of 30 matching records"),
  ).toBeVisible();

  await layout.selectOption("gallery");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "“Equipment register” was saved." }),
  ).toBeVisible();
  expect(api.saved().presentation).toMatchObject({
    ...initialPresentation,
    layout: "gallery",
  });
  const gallery = page.getByRole("list", { name: "Gallery records" });
  await expect(gallery.getByRole("listitem")).toHaveCount(25);
  await expect(
    gallery.getByRole("listitem").first().getByText("Status: In service"),
  ).toBeVisible();
  await expect(
    gallery.getByText("Do not surface this query-only field", { exact: true }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Go to next page" }).click();
  await expect(
    page.getByText("Showing 26–30 of 30 matching records"),
  ).toBeVisible();
  await expect(gallery.getByRole("listitem")).toHaveCount(5);
  await gallery.getByRole("button", { name: "Open record: SN-55" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    new RegExp(`record=00000000-0000-4000-8000-000000000055`),
  );
});

test("Views exposes its filter, column, and layout editors on demand", async ({
  page,
}) => {
  const api = await installViewsApi(page, {
    disableInitialSearch: true,
    cardFieldsNotInColumns: true,
  });
  await page.goto(
    "/openview?section=views&module=" + moduleId + "&view=" + viewId,
  );

  const initialRevision = api.saved().revision;
  for (const layout of [
    "Table",
    "Grid",
    "Gallery",
    "Kanban",
    "Calendar",
    "Timeline",
  ]) {
    await expect(
      page.getByRole("tab", { name: layout, exact: true }),
    ).toBeVisible();
  }
  const sort = page.getByRole("combobox", { name: "Sort" });
  await sort.selectOption(statusFieldId + ":desc");
  await expect
    .poll(() =>
      api.recordQueryRequests.some(
        ({ definition }) =>
          definition.sort[0]?.field_id === statusFieldId &&
          definition.sort[0]?.direction === "desc",
      ),
    )
    .toBe(true);

  const columnsDialog = page.getByRole("dialog", { name: "Columns" });
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  await expect(columnsDialog).toBeVisible();
  await columnsDialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    1,
  );
  expect(api.saved().revision).toBe(initialRevision);

  const filterDialog = page.getByRole("dialog", { name: "More filters" });
  await page.getByRole("button", { name: /More filters/ }).click();
  await expect(filterDialog).toBeVisible();

  await filterDialog.getByRole("button", { name: "Add filter" }).click();
  await filterDialog
    .getByRole("combobox", { name: "Field", exact: true })
    .selectOption(statusFieldId);
  await filterDialog
    .getByRole("combobox", { name: "Condition" })
    .selectOption("eq");
  await filterDialog.getByLabel("Value").fill("Inspection due");
  await expect
    .poll(() =>
      api.recordQueryRequests.some(({ definition }) =>
        definition.filters.some(
          (filter) =>
            filter.field_id === statusFieldId &&
            filter.operator === "eq" &&
            filter.value === "Inspection due",
        ),
      ),
    )
    .toBe(true);
  await filterDialog.getByRole("button", { name: "Close" }).click();
  await expect(
    page.getByText("Status is Inspection due", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /More filters.*1 active/ }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Columns", exact: true }).click();
  await expect(columnsDialog).toBeVisible();
  await columnsDialog
    .getByRole("checkbox", { name: "Show Serial number" })
    .click();
  await columnsDialog.getByRole("button", { name: "Close" }).click();

  const layoutDialog = page.getByRole("dialog", { name: "Layout settings" });
  await page
    .getByRole("button", { name: "Layout settings", exact: true })
    .click();
  await expect(layoutDialog).toBeVisible();
  await layoutDialog.getByRole("button", { name: "Add sort rule" }).click();
  await layoutDialog.getByLabel("Sort field 2").selectOption(serialFieldId);
  await layoutDialog.getByLabel("Sort direction 2").selectOption("asc");
  await layoutDialog.getByRole("button", { name: "Close" }).click();

  expect(api.saved().revision).toBe(1);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => api.saved().revision).toBe(2);
  expect(api.saved().definition.filters).toEqual([
    {
      field_id: statusFieldId,
      expected_type: "select",
      operator: "eq",
      value: "Inspection due",
    },
  ]);
  expect(api.saved().definition.sort).toEqual([
    { field_id: statusFieldId, expected_type: "select", direction: "desc" },
    { field_id: serialFieldId, expected_type: "text", direction: "asc" },
  ]);
  expect(api.saved().presentation.column_field_ids).toEqual([
    nameFieldId,
    serialFieldId,
  ]);
});

for (const layout of ["calendar", "timeline"] as const) {
  test(`${layout} record details navigate across the server page and close back to it`, async ({
    page,
  }) => {
    const api = await installViewsApi(page, { initialLayout: layout });
    await page.goto(
      "/openview?section=views&module=" + moduleId + "&view=" + viewId,
    );
    await page.getByLabel("Window starts").fill("2026-09-01");
    await page.getByLabel("Window ends").fill("2026-09-30");
    await expect(
      page.getByRole("button", { name: "Open record: Window equipment 25" }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: "Open record: Window equipment 25" })
      .click();
    const details = page.getByRole("dialog", { name: "Record details" });
    await expect(
      details.getByRole("heading", { name: "Window equipment 25" }),
    ).toBeVisible();
    await expect(
      details.getByRole("button", { name: "Next record" }),
    ).toBeEnabled();
    await details.getByRole("button", { name: "Next record" }).click();
    await expect(
      details.getByRole("heading", { name: "Window equipment 26" }),
    ).toBeVisible();
    await expect.poll(() => api.windowQueryRequests.at(-1)?.offset).toBe(25);

    await details.getByRole("button", { name: "Close" }).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("record"))
      .toBeNull();
    await expect(
      page.getByRole("button", { name: "Open record: Window equipment 26" }),
    ).toBeVisible();
    await expect(
      page.getByText("Showing 26–26 of 26 matching records"),
    ).toBeVisible();
  });
}

test("Views inspector follows the filtered page in both directions and reopens safe links through record authorization", async ({
  page,
}) => {
  const api = await installViewsApi(page, { disableInitialSearch: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await expect(
    page.getByText("Showing 1–25 of 30 matching records"),
  ).toBeVisible();

  await page.getByRole("button", { name: "Equipment 25", exact: true }).click();
  const inspector = page.getByRole("dialog", { name: "Record details" });
  await expect(
    inspector.getByRole("heading", { name: "Equipment 25" }),
  ).toBeVisible();
  await inspector.getByRole("button", { name: "Next record" }).click();
  await expect(
    inspector.getByRole("heading", { name: "Equipment 26" }),
  ).toBeVisible();
  await inspector.getByRole("button", { name: "Close" }).click();
  await expect(
    page.getByText("Showing 26–30 of 30 matching records"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Equipment 26", exact: true }).click();
  await inspector.getByRole("button", { name: "Previous record" }).click();
  await expect(
    inspector.getByRole("heading", { name: "Equipment 25" }),
  ).toBeVisible();
  const resultOffsets = api.recordQueryRequests
    .filter(({ definition }) => definition.search === null)
    .map(({ offset }) => offset);
  expect(resultOffsets).toContain(25);
  expect(resultOffsets.at(-1)).toBe(0);
  expect(api.saved().definition.search).toBeNull();

  await page.evaluate(() => {
    const copiedWindow = window as Window & { copiedSafeLink?: string };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          copiedWindow.copiedSafeLink = value;
        },
      },
    });
  });
  await inspector.getByRole("button", { name: "Copy safe link" }).click();
  const copiedLink = await page.evaluate(
    () => (window as Window & { copiedSafeLink?: string }).copiedSafeLink,
  );
  expect(copiedLink).toBe(page.url());
  if (!copiedLink) throw new Error("The safe link was not copied");
  const copiedUrl = new URL(copiedLink);
  expect([...copiedUrl.searchParams.keys()]).toEqual([
    "section",
    "module",
    "view",
    "record",
  ]);

  await page.goto(copiedLink);
  await expect(
    inspector.getByRole("heading", { name: "Equipment 25" }),
  ).toBeVisible();
  await expect(
    inspector.getByRole("button", { name: "Next record" }),
  ).toHaveCount(0);
  api.denyRecordId("00000000-0000-4000-8000-000000000054");
  await page.reload();
  await expect(inspector.getByText("This record is unavailable")).toBeVisible();
  await expect(
    inspector.getByRole("heading", { name: "Equipment 25" }),
  ).toHaveCount(0);
});

test("Views inspector does not reveal a stale list row before record authorization finishes", async ({
  page,
}) => {
  const api = await installViewsApi(page, { disableInitialSearch: true });
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await expect(
    page.getByRole("button", { name: "Centrifugal pump 04" }),
  ).toBeVisible();

  api.denyRecordId(recordOneId);
  const lookup = api.pauseNextRecordLookup();
  await page.getByRole("button", { name: "Centrifugal pump 04" }).click();
  await lookup.started;
  const inspector = page.getByRole("dialog", { name: "Record details" });
  await expect(inspector.getByText("Loading linked record…")).toBeVisible();
  await expect(
    inspector.getByRole("heading", { name: "Centrifugal pump 04" }),
  ).toHaveCount(0);
  lookup.release();
  await expect(inspector.getByText("This record is unavailable")).toBeVisible();
});

test("closing record details returns to the page reached through inspector navigation", async ({
  page,
}) => {
  await installViewsApi(page, { disableInitialSearch: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await expect(
    page.getByText("Showing 1–25 of 30 matching records"),
  ).toBeVisible();

  await page.getByRole("button", { name: "Equipment 25", exact: true }).click();
  const inspector = page.getByRole("dialog", { name: "Record details" });
  await inspector.getByRole("button", { name: "Next record" }).click();
  await expect(
    inspector.getByRole("heading", { name: "Equipment 26" }),
  ).toBeVisible();
  await expect(
    inspector.getByText(
      "Showing this linked record. The saved view query remains unchanged.",
    ),
  ).toBeVisible();
  await inspector.getByRole("button", { name: "Close" }).click();

  await expect(
    page.getByText("Showing 26–30 of 30 matching records"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Equipment 26", exact: true }),
  ).toBeVisible();
});

test("Kanban uses paginated server lane counts and only pages the selected lane", async ({
  page,
}) => {
  const api = await installViewsApi(page, { initialLayout: "kanban" });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  const settings = await openLayoutSettings(page);
  const groupField = settings.getByRole("combobox", { name: "Group lanes by" });
  await expect(groupField).toBeVisible();
  await expect(
    groupField.getByRole("option", { name: "Serial number" }),
  ).toHaveCount(0);
  await groupField.selectOption(nameFieldId);
  await closeDialog(settings);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "“Equipment register” was saved." }),
  ).toBeVisible();
  expect(api.saved().presentation).toMatchObject({
    layout: "kanban",
    group_by_field_id: nameFieldId,
  });

  await expect(page.getByText("Lanes 1–12 of 13").first()).toBeVisible();
  expect(api.groupedQueryRequests[0]).toMatchObject({
    group_by: { field_id: nameFieldId, expected_type: "text" },
    limit: 25,
    offset: 0,
    group_limit: 12,
    group_offset: 0,
    selected_group: null,
  });
  await page
    .getByRole("navigation", { name: "Kanban lane pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  await expect(page.getByText("Lanes 13–13 of 13").first()).toBeVisible();
  expect(api.groupedQueryRequests.at(-1)).toMatchObject({
    group_offset: 12,
    selected_group: null,
  });
  const lane = page.getByRole("button", {
    name: "In service, 26 records",
  });
  await expect(lane).toBeVisible();
  expect((await lane.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await lane.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("Showing 1–25 of 26 records").first(),
  ).toBeVisible();
  const laneRecords = page.getByRole("list", { name: "Kanban lane records" });
  await expect(laneRecords.getByRole("listitem")).toHaveCount(25);
  await expect(
    laneRecords.getByText("Do not surface this query-only field", {
      exact: true,
    }),
  ).toHaveCount(0);
  expect(api.groupedQueryRequests.at(-1)).toMatchObject({
    limit: 25,
    offset: 0,
    group_limit: 12,
    group_offset: 12,
    selected_group: { kind: "value", value: "In service" },
  });
  api.failNextGroupedQuery();
  await page
    .getByRole("navigation", { name: "Kanban lane record pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  await expect(
    page.getByRole("alert").filter({
      hasText: "Grouped query temporarily failed.",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Showing 1–25 of 26 records").first(),
  ).toBeVisible();
  await expect(laneRecords.getByRole("listitem")).toHaveCount(25);
  await page.getByRole("button", { name: "Retry lane records" }).click();
  await expect(
    page.getByText("Showing 26–26 of 26 records").first(),
  ).toBeVisible();
  await expect(laneRecords.getByRole("listitem")).toHaveCount(1);
  expect(api.groupedQueryRequests.at(-1)).toMatchObject({
    offset: 25,
    group_offset: 12,
    selected_group: { kind: "value", value: "In service" },
  });
  expect(api.recordQueryRequests).toHaveLength(0);

  const groupedRequestsBeforeInvalidation = api.groupedQueryRequests.length;
  await api.triggerInvalidation("records");
  await expect
    .poll(() => api.groupedQueryRequests.length)
    .toBe(groupedRequestsBeforeInvalidation + 1);
  expect(api.groupedQueryRequests.at(-1)).toMatchObject({
    offset: 25,
    group_offset: 12,
    selected_group: { kind: "value", value: "In service" },
  });

  const linkedRecordId = "00000000-0000-4000-8000-000000000125";
  const groupedRequestCount = api.groupedQueryRequests.length;
  await laneRecords
    .getByRole("button", { name: "Open record: In service" })
    .click();
  await expect(page).toHaveURL(new RegExp(`record=${linkedRecordId}`));
  const linkedRecord = page.getByRole("dialog", { name: "Record details" });
  await expect(linkedRecord).toBeVisible();
  await expect(
    linkedRecord.getByRole("heading", { name: "In service" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Kanban lanes and counts continue to use the saved view query.",
    ),
  ).toBeVisible();
  expect(api.recordQueryRequests).toHaveLength(1);
  expect(api.groupedQueryRequests).toHaveLength(groupedRequestCount);
  expect(api.groupedQueryRequests.at(-1)).toMatchObject({
    selected_group: { kind: "value", value: "In service" },
  });
  await linkedRecord.getByRole("button", { name: "Close" }).click();
  await expect(laneRecords.getByRole("listitem")).toHaveCount(1);
});

test("Calendar displays workspace-local window matches, pages results, and retries failures", async ({
  page,
}) => {
  const api = await installViewsApi(page, { initialLayout: "calendar" });

  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await expect(page.getByRole("combobox", { name: "Saved view" })).toHaveValue(
    viewId,
  );
  await expectLayoutFromSettings(page, "calendar");
  await page.getByLabel("Window starts").fill("2026-09-01");
  await page.getByLabel("Window ends").fill("2026-09-30");
  await expect(
    page.getByRole("heading", { name: "Sep 2, 2026" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open record: Window equipment 01" }),
  ).toBeVisible();
  await expect(page.getByText("Workspace timezone: Asia/Manila")).toBeVisible();
  expect(api.windowQueryRequests.at(-1)).toMatchObject({
    mode: "calendar",
    scope: "window",
    module_id: moduleId,
    date_field: {
      field_id: calendarDateFieldId,
      expected_type: "datetime",
    },
    from_date: "2026-09-01",
    to_date: "2026-09-30",
  });

  api.failNextWindowQuery();
  await page
    .getByRole("navigation", { name: "Date window record pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  await expect(
    page.getByRole("alert").filter({
      hasText: "Window records could not be loaded.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open record: Window equipment 01" }),
  ).toBeVisible();
  await expect(page.getByText(/showing previous page 1–25/i)).toBeVisible();
  await page.getByRole("button", { name: "Retry window records" }).click();
  await expect(
    page.getByRole("button", { name: "Open record: Window equipment 26" }),
  ).toBeVisible();
  expect(api.windowQueryRequests.at(-1)).toMatchObject({ offset: 25 });

  api.failNextWindowQuery();
  await page.getByRole("button", { name: "Undated records" }).click();
  await expect(
    page.getByRole("alert").filter({
      hasText: "Window records could not be loaded.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Open record: Window equipment/ }),
  ).toHaveCount(0);
  expect(api.windowQueryRequests.at(-1)).toMatchObject({ scope: "undated" });
  await page.getByRole("button", { name: "Retry window records" }).click();
  await expect(
    page.getByRole("button", { name: "Open record: Unscheduled equipment" }),
  ).toBeVisible();
  expect(api.windowQueryRequests.at(-1)).toMatchObject({
    mode: "calendar",
    scope: "undated",
    date_field: { field_id: calendarDateFieldId, expected_type: "datetime" },
  });
});

test("saved Calendar range and Month/List scale drive and persist the live layouts", async ({
  page,
}) => {
  const api = await installViewsApi(page, {
    initialLayout: "calendar",
    initialPresentation: { date_range: "quarter", scale: null },
  });

  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  const settings = await openLayoutSettings(page);
  await expect(settings.getByLabel("Calendar date range")).toHaveValue(
    "quarter",
  );
  await expect(settings.getByLabel("Calendar scale")).toHaveValue("month");
  await closeDialog(settings);
  await expect(
    page.getByRole("region", { name: "Calendar", exact: true }),
  ).toBeVisible();

  const editSettings = await openLayoutSettings(page);
  await editSettings.getByLabel("Calendar date range").selectOption("year");
  await editSettings.getByLabel("Calendar scale").selectOption("list");
  await closeDialog(editSettings);
  await expect(
    page.getByRole("region", { name: "Calendar list view" }),
  ).toBeVisible();
  await expect
    .poll(() => api.windowQueryRequests.at(-1)?.from_date)
    .toMatch(/^\d{4}-01-01$/);
  await expect
    .poll(() => api.windowQueryRequests.at(-1)?.to_date)
    .toMatch(/^\d{4}-12-31$/);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => api.saved().presentation.date_range).toBe("year");
  await expect.poll(() => api.saved().presentation.scale).toBe("list");

  await page.reload();
  const reloadedSettings = await openLayoutSettings(page);
  await expect(reloadedSettings.getByLabel("Calendar date range")).toHaveValue(
    "year",
  );
  await expect(reloadedSettings.getByLabel("Calendar scale")).toHaveValue(
    "list",
  );
  await closeDialog(reloadedSettings);
  await expect(
    page.getByRole("region", { name: "Calendar list view" }),
  ).toBeVisible();

  const scaleSettings = await openLayoutSettings(page);
  await scaleSettings.getByLabel("Calendar scale").selectOption("month");
  await closeDialog(scaleSettings);
  await expect(
    page.getByRole("region", { name: "Calendar", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => api.saved().presentation.scale).toBe("month");
  await page.reload();
  const savedScaleSettings = await openLayoutSettings(page);
  await expect(savedScaleSettings.getByLabel("Calendar scale")).toHaveValue(
    "month",
  );
  await closeDialog(savedScaleSettings);
  await expect(
    page.getByRole("region", { name: "Calendar", exact: true }),
  ).toBeVisible();
});

test("OpenView invalidations refresh Views while preserving dirty edits and clear denied records", async ({
  page,
}) => {
  const api = await installViewsApi(page, { initialLayout: "table" });
  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);

  const search = page.getByLabel("Search Equipment");
  await search.fill("compressor");
  await expect(page.getByText("Compressor 01")).toBeVisible();
  await expect
    .poll(() => api.recordQueryRequests.at(-1)?.definition.search)
    .toBe("compressor");
  const viewReadsBefore = api.requests.filter((request) =>
    request.startsWith("GET /api/views?"),
  ).length;

  api.saved().name = "Changed in another session";
  await api.triggerInvalidation("saved_views");
  await expect
    .poll(
      () =>
        api.requests.filter((request) => request.startsWith("GET /api/views?"))
          .length,
    )
    .toBeGreaterThan(viewReadsBefore);
  await expect(search).toHaveValue("compressor");

  const recordQueriesBefore = api.recordQueryRequests.length;
  await api.triggerInvalidation("records");
  await expect
    .poll(() => api.recordQueryRequests.length)
    .toBeGreaterThan(recordQueriesBefore);
  await expect(search).toHaveValue("compressor");

  const deniedQueriesBefore = api.recordQueryRequests.length;
  api.denyRecordQueries();
  await api.triggerInvalidation("records");
  await expect
    .poll(() => api.recordQueryRequests.length)
    .toBeGreaterThan(deniedQueriesBefore);
  await expect(page.getByText("Compressor 01")).toHaveCount(0);
  await expect(search).toHaveValue("compressor");
  await expect(
    page.getByRole("alert").filter({ hasText: /no longer have access/i }),
  ).toBeVisible();
});

test("default invalidation keeps an implicit selected view and its dirty draft anchored", async ({
  page,
}) => {
  const otherView = {
    ...baseView(),
    id: secondViewId,
    name: "Other register",
    definition: { ...baseView().definition, search: "panel" },
  };
  const api = await installViewsApi(page, {
    initialDefault: true,
    additionalViews: [otherView],
  });
  await page.goto(`/openview?section=views&module=${moduleId}`);
  const selected = page.getByRole("combobox", { name: "Saved view" });
  await expect(selected).toHaveValue(viewId);
  const search = page.getByRole("textbox", { name: "Search Equipment" });
  await search.fill("compressor");
  await expect(search).toHaveValue("compressor");

  api.changePersonalDefaultElsewhere(secondViewId);
  const defaultsReadCount = api.requests.filter((request) =>
    request.startsWith("GET /api/views/defaults"),
  ).length;
  await api.triggerInvalidation("saved_view_defaults");
  await expect
    .poll(
      () =>
        api.requests.filter((request) =>
          request.startsWith("GET /api/views/defaults"),
        ).length,
    )
    .toBeGreaterThan(defaultsReadCount);
  await expect(
    selected.locator(`option[value="${secondViewId}"]`),
  ).toContainText("default");
  await expect(selected).toHaveValue(viewId);
  await expect(search).toHaveValue("compressor");
  await expect(
    page.getByRole("button", { name: "Save changes" }),
  ).toBeEnabled();
  await expect(page).not.toHaveURL(new RegExp(`[?&]view=${secondViewId}`));
});

test("default invalidation follows the new default after an implicit draft is reverted", async ({
  page,
}) => {
  const otherView = {
    ...baseView(),
    id: secondViewId,
    name: "Other register",
    definition: { ...baseView().definition, search: "panel" },
  };
  const api = await installViewsApi(page, {
    initialDefault: true,
    additionalViews: [otherView],
  });
  await page.goto(`/openview?section=views&module=${moduleId}`);
  const selected = page.getByRole("combobox", { name: "Saved view" });
  const search = page.getByRole("textbox", { name: "Search Equipment" });
  await expect(selected).toHaveValue(viewId);
  await search.fill("compressor");
  await search.fill("pump");
  await expect(search).toHaveValue("pump");

  api.changePersonalDefaultElsewhere(secondViewId);
  await api.triggerInvalidation("saved_view_defaults");
  await expect(
    selected.locator(`option[value="${secondViewId}"]`),
  ).toContainText("default");
  await expect(selected).toHaveValue(secondViewId);
  await expect(search).toHaveValue("panel");
});

for (const localAction of ["revert", "save"] as const) {
  test(`same-view invalidation refreshes a clean implicit editor after local ${localAction}`, async ({
    page,
  }) => {
    const api = await installViewsApi(page, { initialDefault: true });
    await page.goto(`/openview?section=views&module=${moduleId}`);
    const selected = page.getByRole("combobox", { name: "Saved view" });
    const search = page.getByRole("textbox", { name: "Search Equipment" });
    await expect(selected).toHaveValue(viewId);
    await search.fill("compressor");
    if (localAction === "revert") {
      await search.fill("pump");
    } else {
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect.poll(() => api.saved().definition.search).toBe("compressor");
    }
    await expect(
      page.getByRole("button", { name: "Save changes" }),
    ).toHaveCount(0);

    api.changeSavedViewElsewhere("panel");
    await api.triggerInvalidation("saved_views");
    await expect(selected).toHaveValue(viewId);
    await expect(search).toHaveValue("panel");
    await expect(page.getByText("Cooling panel 02")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save changes" }),
    ).toHaveCount(0);
    await expect(page.getByText("Unsaved changes")).toHaveCount(0);
    await expect(
      page.getByText(`Revision ${api.saved().revision}`),
    ).toBeVisible();
  });
}

test.describe("Calendar DATETIME rendering in a non-UTC browser timezone", () => {
  test.use({ timezoneId: "America/Los_Angeles" });

  test("interprets timezone-free DATETIME values as UTC before workspace conversion", async ({
    page,
  }) => {
    const api = await installViewsApi(page, {
      initialLayout: "calendar",
      calendarDateTimeValue: "2026-09-01T10:00:00",
    });

    await page.goto(
      `/openview?section=views&module=${moduleId}&view=${viewId}`,
    );
    await page.getByLabel("Window starts").fill("2026-09-01");
    await page.getByLabel("Window ends").fill("2026-09-30");
    await expect(
      page.getByRole("heading", { name: "Sep 1, 2026" }).first(),
    ).toBeVisible();
    await expect(
      page.getByText(/Sep 1, 2026(?:,| at) 6:00 PM/).first(),
    ).toBeVisible();
    expect(api.windowQueryRequests.at(-1)).toMatchObject({
      mode: "calendar",
      scope: "window",
      from_date: "2026-09-01",
      to_date: "2026-09-30",
    });
  });
});

test("Timeline renders complete intervals and keeps unscheduled records separate", async ({
  page,
}) => {
  const api = await installViewsApi(page, { initialLayout: "timeline" });

  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await expect(page.getByRole("combobox", { name: "Saved view" })).toHaveValue(
    viewId,
  );
  await page.getByLabel("Window starts").fill("2026-09-01");
  await page.getByLabel("Window ends").fill("2026-09-30");
  await expect(
    page.getByRole("list", { name: "Timeline intervals" }),
  ).toBeVisible();
  const firstInterval = page
    .getByRole("list", { name: "Timeline intervals" })
    .getByRole("listitem")
    .first();
  await expect(firstInterval).toContainText("Aug 29, 2026 – Sep 4, 2026");
  await expect(firstInterval).toContainText("Deadline: Sep 6, 2026");
  await expect(firstInterval).toContainText("Progress: 40.50%");
  await expect(
    firstInterval.getByRole("progressbar", {
      name: "Window equipment 01 progress",
    }),
  ).toHaveAttribute("aria-valuenow", "40.5");
  expect(api.windowQueryRequests.at(-1)).toMatchObject({
    mode: "timeline",
    scope: "window",
    from_date: "2026-09-01",
    to_date: "2026-09-30",
    start_field: { field_id: timelineStartFieldId, expected_type: "date" },
    end_field: { field_id: timelineEndFieldId, expected_type: "date" },
  });
  expect(
    (api.windowQueryRequests.at(-1)?.definition as QueryDefinition).columns.map(
      ({ field_id }) => field_id,
    ),
  ).toEqual(
    expect.arrayContaining([
      timelineDeadlineFieldId,
      timelineTimestampDeadlineFieldId,
      timelineProgressFieldId,
    ]),
  );

  await page
    .getByRole("navigation", { name: "Date window record pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  await expect(
    page.getByRole("button", { name: "Open record: Window equipment 26" }),
  ).toBeVisible();
  expect(api.windowQueryRequests.at(-1)).toMatchObject({ offset: 25 });
  await page
    .getByRole("navigation", { name: "Date window record pages" })
    .getByRole("button", { name: "Go to previous page" })
    .click();
  await expect(
    page.getByRole("button", { name: "Open record: Window equipment 01" }),
  ).toBeVisible();
  expect(api.windowQueryRequests.at(-1)).toMatchObject({ offset: 0 });

  const unscheduledResponse = page.waitForResponse((response) => {
    const request = response.request();
    return (
      new URL(response.url()).pathname === "/api/records/window-query" &&
      request.method() === "POST" &&
      (request.postDataJSON() as { scope?: string }).scope === "unscheduled"
    );
  });
  await page.getByRole("button", { name: "Unscheduled records" }).click();
  expect((await unscheduledResponse).status()).toBe(200);
  const openRecord = page.getByRole("button", {
    name: "Open record: Unscheduled equipment",
  });
  await expect(openRecord).toBeVisible();
  expect(api.windowQueryRequests.at(-1)).toMatchObject({
    mode: "timeline",
    scope: "unscheduled",
  });
  const timelineRequestsBeforeInvalidation = api.windowQueryRequests.length;
  await api.triggerInvalidation("records");
  await expect
    .poll(() => api.windowQueryRequests.length)
    .toBe(timelineRequestsBeforeInvalidation + 1);
  expect(api.windowQueryRequests.at(-1)).toMatchObject({
    mode: "timeline",
    scope: "unscheduled",
  });
  await expect(openRecord).toBeVisible();
  await openRecord.click();
  await expect(page).toHaveURL(new RegExp(`record=${recordTwoId}`));
  await expect(
    page
      .getByRole("dialog", { name: "Record details" })
      .getByText("Showing this linked record."),
  ).toBeVisible();
});

test("Timeline accepts a DATETIME deadline alongside DATE interval fields", async ({
  page,
}) => {
  const api = await installViewsApi(page, { initialLayout: "timeline" });

  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  const settings = await openLayoutSettings(page);
  const deadlineField = settings.getByRole("combobox", {
    name: "Deadline field (optional)",
  });
  await deadlineField.selectOption(timelineTimestampDeadlineFieldId);
  const save = page.getByRole("button", { name: "Save changes" });
  await closeDialog(settings);
  await expect(save).toBeEnabled();
  await save.click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "“Equipment register” was saved." }),
  ).toBeVisible();
  await expect(
    page.getByText(/Deadline: Sep 7, 2026(?:,| at) 2:30 AM/).first(),
  ).toBeVisible();
  expect(api.saved().presentation).toMatchObject({
    timeline_start_field_id: timelineStartFieldId,
    timeline_end_field_id: timelineEndFieldId,
    timeline_deadline_field_id: timelineTimestampDeadlineFieldId,
  });
});

test("stale conflict can reload the authoritative saved version without losing it implicitly", async ({
  page,
}) => {
  const api = await installViewsApi(page);

  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await expect(
    page.getByRole("heading", { name: "Equipment register" }),
  ).toBeVisible();
  const search = page.getByRole("textbox", { name: "Search Equipment" });
  await search.fill("my local edit");
  api.makeNextPatchStale();
  await page.getByRole("button", { name: "Save changes" }).click();

  const conflictDialog = page.getByRole("dialog", {
    name: "Update saved view",
  });
  await expect(
    conflictDialog.getByText(/Query, filters, or sort/),
  ).toBeVisible();
  await expect(
    conflictDialog.getByText(/local search “my local edit”/),
  ).toBeVisible();
  expect(api.saved().definition.search).toBe("external edit");
  await conflictDialog.getByRole("button", { name: "Reload latest" }).click();

  await expect(conflictDialog).toBeHidden();
  await expect(search).toHaveValue("external edit");
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(
    0,
  );
  expect(api.saved().definition.search).toBe("external edit");
});

test("a saved view beyond the bounded list loads through its UUID deep link", async ({
  page,
}) => {
  const api = await installViewsApi(page, { deepViewBeyondBound: true });

  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await expect(
    page.getByRole("heading", { name: "Equipment register" }),
  ).toBeVisible();
  await expect(page.getByLabel("Saved view")).toHaveValue(viewId);
  await expect(
    page.getByRole("button", { name: "Load more metadata" }),
  ).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "unavailable" }),
  ).toHaveCount(0);
  expect(api.requests).toContain(`GET /api/views/${viewId}`);
  await page.getByRole("button", { name: "Load more metadata" }).click();
  await expect(
    page.getByRole("button", { name: "Load more metadata" }),
  ).toHaveCount(0);
  await expect(
    page.locator(`#openview-saved-view option[value="${viewId}"]`),
  ).toHaveCount(1);

  await openViewAction(page, "Archive view");
  await page
    .getByRole("alertdialog", { name: "Archive saved view?" })
    .getByRole("button", { name: "Archive view" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "archived" }),
  ).toBeVisible();
  expect(api.saved().is_deleted).toBe(true);

  await page.getByRole("button", { name: "Archived views" }).click();
  const archivedDialog = page.getByRole("dialog", { name: "Archived views" });
  await expect(
    archivedDialog.getByText("Equipment register", { exact: true }),
  ).toBeVisible();
  await expect(
    archivedDialog.getByRole("button", {
      name: "Restore Equipment register",
    }),
  ).toHaveCount(1);
  await archivedDialog
    .getByRole("button", { name: "Restore Equipment register" })
    .click();
  await expect(
    archivedDialog.getByRole("status").filter({ hasText: "restored" }),
  ).toBeVisible();
  expect(api.saved().is_deleted).toBe(false);
  await archivedDialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByLabel("Saved view")).toHaveValue(viewId);
});

test("changing saved views resets record pagination", async ({ page }) => {
  const secondView = {
    ...baseView(),
    id: secondViewId,
    name: "Compressor queue",
    definition: {
      ...baseView().definition,
      search: "compressor",
    },
  };
  await installViewsApi(page, { additionalViews: [secondView] });

  await page.goto(`/openview?section=views&module=${moduleId}&view=${viewId}`);
  await expect(page.getByText("Centrifugal pump 04")).toBeVisible();
  await page.getByRole("textbox", { name: "Search Equipment" }).fill("");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Equipment register” was saved" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Go to next page" }).click();
  await expect(page.getByText("Showing 26–30 of 30")).toBeVisible();

  await page.getByLabel("Saved view").selectOption(secondViewId);
  await expect(page.getByText("Compressor 01")).toBeVisible();
  await expect(page.getByText("Showing 1–1 of 1")).toBeVisible();
});

test("invalid UUID view links recover to the first active catalog source", async ({
  page,
}) => {
  await installViewsApi(page);

  await page.goto("/openview?section=views&module=bad-module&view=bad-view");
  await expect(page.getByRole("heading", { name: "Views" })).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "unavailable" }),
  ).toBeVisible();
  await expect(page.getByLabel("Data source")).toHaveValue(moduleId);
  await page.getByRole("button", { name: "Return to workspace" }).click();
  await expect(page).toHaveURL(`/openview?section=views&module=${moduleId}`);
  await expect(
    page.getByRole("alert").filter({ hasText: "unavailable" }),
  ).toHaveCount(0);
});

test("a legacy sample Board URL cannot create a local OpenView record link", async ({
  page,
}) => {
  const api = await installViewsApi(page);
  await page.route("**/api/boards**", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Board unavailable" }),
    }),
  );

  await page.goto("/boards?board=sample-board-organization&section=overview");
  await expect(
    page.getByText(
      /This Board may have been removed or your account may not have access/,
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Organization board" }),
  ).toHaveCount(0);
  await expect(
    page.locator('a[href^="/openview?module=service-requests&record="]'),
  ).toHaveCount(0);
  await expect(page).toHaveURL(
    "/boards?board=sample-board-organization&section=overview",
  );
  expect(api.requests).toHaveLength(0);
});

test("Dashboard section loads the live Dashboard API without fetching saved Views", async ({
  page,
}) => {
  let savedViewRequests = 0;
  let dashboardListRequests = 0;
  await page.route("**/api/auth/session", async (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user_id: userId,
        setup_required: false,
      }),
    }),
  );
  await page.route("**/api/views**", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/views/data-sources") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items: [],
          pagination: {
            limit: 100,
            offset: 0,
            count: 0,
            total: 0,
            has_more: false,
          },
        }),
      });
    }
    savedViewRequests += 1;
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: "{}",
    });
  });
  await page.route("**/api/dashboards**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/dashboards/default") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ dashboard_id: null }),
      });
    }
    if (path === "/api/dashboards") {
      dashboardListRequests += 1;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items: [],
          pagination: {
            limit: 25,
            offset: 0,
            count: 0,
            total: 0,
            has_more: false,
          },
        }),
      });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto("/openview?section=dashboards");
  await expect(
    page.getByRole("heading", { name: "Private dashboards" }),
  ).toBeVisible();
  await expect(
    page.getByText("No Dashboards yet.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New Dashboard" }).click();
  await expect(
    page.getByRole("textbox", { name: "Dashboard name" }),
  ).toHaveValue("");
  expect(dashboardListRequests).toBeGreaterThan(0);
  expect(savedViewRequests).toBe(0);
});
