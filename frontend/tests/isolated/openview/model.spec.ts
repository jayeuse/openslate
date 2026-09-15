import { expect, test } from "@playwright/test";
import {
  INITIAL_CUSTOMERS,
  INITIAL_EQUIPMENT,
  INITIAL_CHART_SETTINGS,
  INITIAL_OPENVIEW_VIEW,
  OPENVIEW_MODULES,
  audienceLabel,
  decodeAudienceRef,
  decodeChartSettings,
  decodeDashboardWidgets,
  decodeDashboards,
  decodeReport,
  decodeReports,
  decodeSavedViews,
  decodeViewConfig,
  defaultViewConfig,
  defaultChartSettings,
  filterRowsByDateRange,
  filterRows,
  getOpenViewRows,
  getOpenViewOperationalDeadlineField,
  groupRows,
  isUnresolvedAudience,
  normalizeChartSettings,
  parseOpenViewUrl,
  safeOpenViewFilename,
  selectRows,
  serializeOpenViewCsv,
  serializeOpenViewUrl,
  sortRows,
  type AudienceRef,
  type FilterGroup,
  type OpenViewRow,
  type OpenViewValue,
  type SortRule,
} from "../../../src/components/sample/openview/model";
import {
  getOpenViewLanes,
  getOpenViewOperationalFacts,
  getOpenViewOperationalProfile,
  normalizeOpenViewScheduleItems,
  summarizeOpenViewOperationalRows,
  type OpenViewTimingState,
} from "../../../src/components/sample/openview/operations";
import { INITIAL_RECORDS } from "../../../src/components/sample/sample-data";

function operationalRow(
  id: string,
  overrides: Record<string, OpenViewValue> = {},
): OpenViewRow {
  return {
    id,
    moduleId: "service-requests",
    values: {
      title: id,
      customer: "Sample customer",
      status: "Open",
      assignee: "Sample owner",
      dueDate: "2026-09-30",
      priority: "Medium",
      startDate: "2026-09-14",
      endDate: "2026-09-20",
      progress: 25,
      ...overrides,
    },
  };
}

test("module adapters expose three read-only datasets with field-compatible rows", () => {
  expect(OPENVIEW_MODULES.map((module) => module.id)).toEqual([
    "service-requests",
    "equipment",
    "customers",
  ]);
  expect(getOpenViewRows("service-requests", INITIAL_RECORDS)).toHaveLength(
    INITIAL_RECORDS.length,
  );
  expect(getOpenViewRows("equipment")).toHaveLength(INITIAL_EQUIPMENT.length);
  expect(getOpenViewRows("customers")).toHaveLength(INITIAL_CUSTOMERS.length);
  expect(getOpenViewRows("equipment")[0]?.values).toEqual(
    expect.objectContaining({
      name: expect.any(String),
      status: expect.any(String),
      lastServiceDate: expect.any(String),
    }),
  );
  expect(
    OPENVIEW_MODULES.every((module) =>
      module.fields.every((field) =>
        ["text", "number", "date", "select", "boolean"].includes(field.type),
      ),
    ),
  ).toBe(true);
});

test("operational defaults expose a curated planning surface anchored to the sample snapshot", () => {
  const equipment = getOpenViewRows("equipment")[0];
  const service = getOpenViewRows("service-requests", INITIAL_RECORDS)[0];

  expect(defaultViewConfig("service-requests").layout.columns).toEqual([
    "title",
    "customer",
    "status",
    "priority",
    "assignee",
    "progress",
    "dueDate",
  ]);
  expect(defaultViewConfig("equipment").layout.columns).toEqual([
    "assetTag",
    "name",
    "status",
    "priority",
    "owner",
    "progress",
    "deadline",
  ]);
  expect(defaultViewConfig("customers").layout.columns).toEqual([
    "customerId",
    "name",
    "status",
    "priority",
    "owner",
    "progress",
    "deadline",
  ]);
  expect(equipment?.values.owner).toEqual(expect.any(String));
  expect(equipment?.values.startDate).toEqual(expect.any(String));
  expect(service?.values.priority).toEqual(expect.any(String));
  expect(
    filterRowsByDateRange(
      [
        {
          id: "snapshot-window",
          moduleId: "service-requests",
          values: { dueDate: "2026-09-14" },
        },
        {
          id: "future-window",
          moduleId: "service-requests",
          values: { dueDate: "2026-09-20" },
        },
      ],
      "dueDate",
      "week",
    ).map((row) => row.id),
  ).toEqual(["snapshot-window"]);
});

test("chart settings select operational deadlines and safely migrate legacy state", () => {
  expect(INITIAL_CHART_SETTINGS.dateField).toBe("dueDate");
  expect(
    OPENVIEW_MODULES.map((moduleEntry) =>
      getOpenViewOperationalDeadlineField(moduleEntry.id),
    ),
  ).toEqual(["dueDate", "deadline", "deadline"]);
  expect(
    OPENVIEW_MODULES.map(
      (moduleEntry) => defaultChartSettings(moduleEntry.id).dateField,
    ),
  ).toEqual(["dueDate", "deadline", "deadline"]);

  const legacy = decodeChartSettings({
    moduleId: "equipment",
    dimension: "status",
    metric: "status",
    aggregation: "average",
    from: "2026-09-01",
    to: "2026-09-30",
    limit: 99,
    filters: {
      logic: "or",
      clauses: [
        { field: "deleted-field", operator: "equals", value: "stale" },
        { field: "status", operator: "equals", value: "Inspection due" },
      ],
    },
  });
  expect(legacy).toEqual(
    expect.objectContaining({
      moduleId: "equipment",
      dateField: "deadline",
      metric: "count",
      aggregation: "count",
      from: "2026-09-01",
      to: "2026-09-30",
      limit: 8,
      filters: {
        logic: "or",
        clauses: [
          { field: "status", operator: "equals", value: "Inspection due" },
        ],
      },
    }),
  );

  const selected = normalizeChartSettings({
    ...defaultChartSettings("service-requests"),
    dateField: "startDate",
    from: "2026-09-10",
    to: "2026-09-20",
  });
  expect(selected.dateField).toBe("startDate");
  expect(
    normalizeChartSettings({
      ...selected,
      dateField: "status",
    }).dateField,
  ).toBe("dueDate");
});

test("operational profiles and fixtures expose coherent fields for every module", () => {
  for (const moduleEntry of OPENVIEW_MODULES) {
    const profile = getOpenViewOperationalProfile(moduleEntry.id);
    const fieldIds = new Set(moduleEntry.fields.map((field) => field.id));
    for (const field of [
      profile.statusField,
      profile.ownerField,
      profile.priorityField,
      profile.startField,
      profile.endField,
      profile.deadlineField,
      profile.progressField,
    ]) {
      expect(fieldIds.has(field)).toBe(true);
    }
    const rows = getOpenViewRows(moduleEntry.id, INITIAL_RECORDS);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const facts = getOpenViewOperationalFacts(row);
      expect(facts.moduleId).toBe(moduleEntry.id);
      expect(facts.owner).toEqual(expect.any(String));
      expect(facts.priority).toEqual(expect.any(String));
      expect(facts.start).toEqual(expect.any(String));
      expect(facts.end).toEqual(expect.any(String));
      expect(facts.deadline).toEqual(expect.any(String));
      expect(facts.progress).toEqual(expect.any(Number));
      expect(facts.progress).toBeGreaterThanOrEqual(0);
      expect(facts.progress).toBeLessThanOrEqual(100);
    }
  }
  expect(
    OPENVIEW_MODULES.every((moduleEntry) =>
      defaultViewConfig(moduleEntry.id).layout.columns.every((field) =>
        moduleEntry.fields.some((candidate) => candidate.id === field),
      ),
    ),
  ).toBe(true);
});

test("unknown service records keep planning values empty instead of receiving fabricated dates", () => {
  const unknown = getOpenViewRows("service-requests", [
    {
      id: "sample-sr-new",
      title: "New request",
      customer: "New customer",
      status: "Open",
      assignee: "New owner",
      dueDate: "2026-09-20",
    },
  ])[0];
  expect(unknown?.values).toEqual(
    expect.objectContaining({
      priority: "",
      startDate: "",
      endDate: "",
      progress: "",
    }),
  );
  expect(unknown).toBeDefined();
  if (!unknown) throw new Error("The unknown sample record should be present");
  const facts = getOpenViewOperationalFacts(unknown);
  expect(facts.timingState).toBe("unscheduled");
  expect(facts.diagnostics).toEqual(
    expect.arrayContaining(["Start date is missing.", "End date is missing."]),
  );
});

test("operational timing precedence and visible summary classify decision-ready states from the fixed snapshot", () => {
  const rows = [
    operationalRow("blocked", {
      status: "On hold",
      deadline: "2026-09-16",
    }),
    operationalRow("overdue", {
      dueDate: "2026-09-13",
      startDate: "2026-09-10",
      endDate: "2026-09-13",
      progress: 25,
    }),
    operationalRow("late-plan", {
      dueDate: "2026-09-18",
      endDate: "2026-09-20",
      progress: 25,
    }),
    operationalRow("due-soon", {
      dueDate: "2026-09-21",
      endDate: "2026-09-21",
      progress: 25,
    }),
    operationalRow("on-track", {
      dueDate: "2026-09-30",
      endDate: "2026-09-30",
      progress: 25,
    }),
    operationalRow("unscheduled", {
      dueDate: "",
      startDate: "",
      endDate: "",
      progress: "",
    }),
  ];
  const states = rows.map(
    (row) => getOpenViewOperationalFacts(row).timingState,
  );
  expect(states).toEqual([
    "blocked",
    "overdue",
    "late-plan",
    "due-soon",
    "on-track",
    "unscheduled",
  ] satisfies OpenViewTimingState[]);
  const summary = summarizeOpenViewOperationalRows(rows, "service-requests");
  expect(summary).toEqual(
    expect.objectContaining({
      snapshotDate: "2026-09-14",
      timezone: "Asia/Manila",
      total: 6,
      blocked: 1,
      overdue: 1,
      latePlan: 1,
      dueSoon: 1,
      onTrack: 1,
      unscheduled: 1,
      needsAttention: 5,
    }),
  );
  expect(summary.attention.map((item) => item.rowId)).toEqual([
    "blocked",
    "overdue",
    "late-plan",
    "due-soon",
    "unscheduled",
  ]);
});

test("summary scheduling counts match Gantt normalization while blocked records retain attention precedence", () => {
  const blockedWithoutDates = operationalRow("blocked-without-dates", {
    status: "On hold",
    startDate: "",
    endDate: "",
    dueDate: "",
  });
  const scheduledTask = operationalRow("scheduled-task", {
    status: "Open",
    startDate: "2026-09-14",
    endDate: "2026-09-16",
    dueDate: "2026-09-30",
  });
  const rows = [blockedWithoutDates, scheduledTask];
  const summary = summarizeOpenViewOperationalRows(rows, "service-requests");
  const scheduleItems = normalizeOpenViewScheduleItems(
    rows,
    "service-requests",
  );

  expect(getOpenViewOperationalFacts(blockedWithoutDates).timingState).toBe(
    "blocked",
  );
  expect(scheduleItems.map((item) => item.type)).toEqual([
    "unscheduled",
    "task",
  ]);
  expect(summary).toEqual(
    expect.objectContaining({
      blocked: 1,
      scheduled: 1,
      unscheduled: 1,
      needsAttention: 1,
    }),
  );
});

test("lanes follow profile order and schedule normalization distinguishes tasks, milestones, and invalid spans", () => {
  const rows = getOpenViewRows("service-requests", INITIAL_RECORDS);
  const lanes = getOpenViewLanes(rows, "service-requests");
  expect(lanes.map((lane) => lane.label)).toEqual([
    "Open",
    "Scheduled",
    "In progress",
    "Completed",
    "On hold",
  ]);
  expect(lanes.find((lane) => lane.label === "Open")?.count).toBe(3);
  expect(lanes.find((lane) => lane.label === "On hold")?.rows[0]?.id).toBe(
    "sample-sr-1008",
  );

  const scheduleRows = [
    operationalRow("task", {
      startDate: "2026-09-14",
      endDate: "2026-09-20",
      dueDate: "2026-09-20",
    }),
    operationalRow("milestone", {
      startDate: "2026-09-18",
      endDate: "2026-09-18",
      dueDate: "2026-09-18",
      progress: 0,
    }),
    operationalRow("missing", {
      startDate: "",
      endDate: "",
      dueDate: "",
    }),
    operationalRow("reversed", {
      startDate: "2026-09-21",
      endDate: "2026-09-18",
      dueDate: "2026-09-22",
    }),
    operationalRow("invalid-date", {
      endDate: "2026-09-31",
      dueDate: "2026-10-40",
    }),
  ];
  const items = normalizeOpenViewScheduleItems(
    scheduleRows,
    "service-requests",
  );
  expect(items.map((item) => item.type)).toEqual([
    "task",
    "milestone",
    "unscheduled",
    "unscheduled",
    "unscheduled",
  ]);
  expect(items[0]).toEqual(
    expect.objectContaining({
      start: "2026-09-14",
      end: "2026-09-20",
      deadline: "2026-09-20",
    }),
  );
  expect(items[3]).toEqual(
    expect.objectContaining({
      start: null,
      end: null,
      timingState: "unscheduled",
      diagnostics: expect.arrayContaining([
        "Start date must be on or before end date.",
      ]),
    }),
  );
  expect(items[4]).toEqual(
    expect.objectContaining({
      type: "unscheduled",
      start: null,
      end: null,
      diagnostics: expect.arrayContaining([
        "End date is invalid.",
        "Deadline is invalid.",
      ]),
    }),
  );
  expect(new Set(items[4]?.diagnostics).size).toBe(
    items[4]?.diagnostics.length,
  );
  expect(
    items.every(
      (item) =>
        item.start === null || item.end === null || item.start <= item.end,
    ),
  ).toBe(true);
});

test("filters compose with AND/OR logic, sort rules stay capped at three, and grouping preserves result order", () => {
  const rows = getOpenViewRows("service-requests", INITIAL_RECORDS);
  const filters: FilterGroup = {
    logic: "and",
    clauses: [
      { field: "status", operator: "equals", value: "Open" },
      { field: "title", operator: "contains", value: "pressure" },
    ],
  };
  expect(filterRows(rows, filters).map((row) => row.id)).toEqual([
    "sample-sr-1005",
  ]);
  expect(
    filterRows(rows, {
      logic: "or",
      clauses: [
        { field: "status", operator: "equals", value: "Open" },
        { field: "status", operator: "equals", value: "On hold" },
      ],
    }).map((row) => row.id),
  ).toEqual([
    "sample-sr-1005",
    "sample-sr-1008",
    "sample-sr-1009",
    "sample-sr-1011",
  ]);

  const sorts: SortRule[] = [
    { field: "status", direction: "asc" },
    { field: "dueDate", direction: "desc" },
    { field: "title", direction: "asc" },
    { field: "customer", direction: "desc" },
  ];
  const sorted = sortRows(rows, sorts);
  expect(sorted.map((row) => row.id)).toEqual([
    "sample-sr-1011",
    "sample-sr-1009",
    "sample-sr-1005",
    "sample-sr-1010",
    "sample-sr-1006",
    "sample-sr-1008",
    "sample-sr-1007",
    "sample-sr-1004",
  ]);
  expect(groupRows(sorted, "status").map((group) => group.label)).toEqual([
    "Open",
    "Scheduled",
    "On hold",
    "In progress",
  ]);
  expect(
    selectRows(rows, { ...INITIAL_OPENVIEW_VIEW, filters, sorts }),
  ).toHaveLength(1);
});

test("stored view and dashboard migrations recover legacy state without trusting display-name ownership", () => {
  const roleLookup = [{ id: "role:dispatch", name: "Dispatch" }];
  const identityLookup = [{ id: "person:eli", name: "Eli Cruz" }];
  const legacyViews = decodeSavedViews(
    [
      {
        id: "saved:dispatch",
        name: "Dispatch queue",
        audience: "Role: Dispatch",
        type: "Table",
        search: "pump",
        status: "Open",
        sort: "dueDate",
        group: "status",
      },
      { id: "bad", name: "Bad", audience: "Everyone", type: "wat", search: 4 },
    ],
    { roles: roleLookup, identities: identityLookup },
  );
  expect(legacyViews).toHaveLength(1);
  expect(legacyViews[0]?.moduleId).toBe("service-requests");
  expect(legacyViews[0]?.audience).toEqual({
    kind: "role",
    id: "role:dispatch",
  } satisfies AudienceRef);
  expect(legacyViews[0]?.config.filters).toEqual({
    logic: "and",
    clauses: [{ field: "status", operator: "equals", value: "Open" }],
  });
  const unresolvedAudience = decodeAudienceRef("Role: Missing", {
    roles: roleLookup,
  });
  expect(unresolvedAudience).toEqual({
    kind: "private",
    unresolved: { kind: "role", id: "Missing" },
  });
  expect(isUnresolvedAudience(unresolvedAudience)).toBe(true);
  expect(audienceLabel(unresolvedAudience)).toBe("Only me · unresolved role");

  const dashboards = decodeDashboards([
    {
      id: "dashboard:operations",
      name: "Operations",
      permission: "Everyone",
      refresh: "Every 5 minutes",
      widgets: [
        {
          id: "widget:summary",
          type: "Summary",
          size: "Full",
          permission: "Everyone",
          refresh: "Manual",
          pinned: false,
        },
      ],
    },
  ]);
  expect(dashboards[0]?.audience).toEqual({ kind: "everyone" });
  expect(dashboards[0]?.refresh).toBe("five-minutes");
  expect(dashboards[0]?.widgets[0]?.type).toBe("summary");
  expect(dashboards[0]?.widgets[0]?.audience).toEqual({ kind: "everyone" });
  expect(decodeViewConfig({ status: "not-a-status", type: "wat" })).toEqual(
    expect.objectContaining({
      layout: expect.objectContaining({ kind: "table" }),
      filters: { logic: "and", clauses: [] },
    }),
  );
  expect(
    decodeReport({
      name: "Weekly review",
      fields: ["title"],
      grouping: "None",
      totals: true,
      schedule: "Daily at 09:00",
      audience: "Only me",
    }),
  ).toEqual(
    expect.objectContaining({
      id: "legacy-report-weekly-review",
      moduleId: "service-requests",
      audience: { kind: "private" },
      schedule: expect.objectContaining({ cadence: "daily" }),
    }),
  );
});

test("stored OpenView decoders keep the first valid stable ID and discard unsafe duplicates", () => {
  const maximumId = `v${"x".repeat(127)}`;
  const oversizedId = `v${"x".repeat(128)}`;
  const views = decodeSavedViews([
    {
      id: "saved:dispatch",
      name: "First dispatch queue",
      audience: "Everyone",
      type: "Table",
      search: "first",
    },
    {
      id: "saved:dispatch",
      name: "Duplicate dispatch queue",
      audience: "Everyone",
      type: "Table",
      search: "duplicate",
    },
    {
      id: maximumId,
      name: "Maximum-length view",
      audience: "Everyone",
      type: "Table",
      search: "maximum",
    },
    {
      id: "",
      name: "Empty ID",
      audience: "Everyone",
      type: "Table",
      search: "empty",
    },
    {
      id: oversizedId,
      name: "Oversized ID",
      audience: "Everyone",
      type: "Table",
      search: "oversized",
    },
    {
      id: "../unsafe",
      name: "Path ID",
      audience: "Everyone",
      type: "Table",
      search: "path",
    },
  ]);
  expect(views.map((view) => [view.id, view.config.search])).toEqual([
    ["saved:dispatch", "first"],
    [maximumId, "maximum"],
  ]);

  const dashboards = decodeDashboards([
    {
      id: "dashboard:operations",
      name: "First operations",
      audience: "Everyone",
      widgets: [
        {
          id: "widget:summary",
          type: "Summary",
          size: "Full",
          permission: "Everyone",
          moduleId: "service-requests",
          fields: ["title", "deleted-field", "status"],
          metric: "status",
        },
        {
          id: "widget:summary",
          type: "Workload",
          size: "Half",
          permission: "Everyone",
        },
        {
          id: "widget:keep",
          type: "OpenView",
          size: "Half",
          permission: "Everyone",
        },
        {
          id: "",
          type: "Summary",
          size: "Half",
          permission: "Everyone",
        },
        {
          id: oversizedId,
          type: "Summary",
          size: "Half",
          permission: "Everyone",
        },
        {
          id: "widget/unsafe",
          type: "Summary",
          size: "Half",
          permission: "Everyone",
        },
      ],
    },
    {
      id: "dashboard:operations",
      name: "Duplicate operations",
      audience: "Everyone",
      widgets: [
        {
          id: "widget:duplicate-dashboard",
          type: "Summary",
          size: "Half",
          permission: "Everyone",
        },
      ],
    },
    {
      id: "dashboard:unrelated",
      name: "Unrelated dashboard",
      audience: "Everyone",
      widgets: [
        {
          id: "widget:unrelated",
          type: "Summary",
          size: "Half",
          permission: "Everyone",
        },
      ],
    },
    {
      id: "dashboard/unsafe",
      name: "Unsafe dashboard",
      audience: "Everyone",
      widgets: [],
    },
  ]);
  expect(dashboards.map((dashboard) => dashboard.id)).toEqual([
    "dashboard:operations",
    "dashboard:unrelated",
  ]);
  expect(dashboards[0]?.name).toBe("First operations");
  expect(dashboards[0]?.widgets.map((widget) => widget.id)).toEqual([
    "widget:summary",
    "widget:keep",
  ]);
  expect(dashboards[0]?.widgets[0]?.fields).toEqual(["title", "status"]);
  expect(dashboards[0]?.widgets[0]?.metric).toBe("count");
  expect(dashboards[1]?.widgets.map((widget) => widget.id)).toEqual([
    "widget:unrelated",
  ]);
});

test("stored report templates repair unsafe IDs and keep the first stable ID", () => {
  const repaired = decodeReport({
    id: "../unsafe",
    name: "Unsafe report",
    fields: ["title"],
    filters: {
      logic: "and",
      clauses: [
        { field: "deletedField", operator: "equals", value: "stale" },
        { field: "status", operator: "equals", value: "Open" },
      ],
    },
    sorts: [
      { field: "deletedField", direction: "asc" },
      { field: "title", direction: "desc" },
    ],
  });
  expect(repaired.id).toBe("legacy-report-unsafe-report");
  expect(repaired.filters.clauses).toEqual([
    { field: "status", operator: "equals", value: "Open" },
  ]);
  expect(repaired.sorts).toEqual([{ field: "title", direction: "desc" }]);

  const reports = decodeReports([
    {
      id: "report:weekly",
      name: "Weekly review",
      fields: ["title"],
    },
    {
      id: "report:weekly",
      name: "Duplicate weekly review",
      fields: ["status"],
    },
    {
      id: "../unsafe",
      name: "Unsafe report",
      fields: ["title"],
    },
    {
      id: `r${"x".repeat(128)}`,
      name: "Oversized report",
      fields: ["title"],
    },
  ]);

  expect(reports.map(({ id, name }) => ({ id, name }))).toEqual([
    { id: "report:weekly", name: "Weekly review" },
    { id: "legacy-report-unsafe-report", name: "Unsafe report" },
    { id: "legacy-report-oversized-report", name: "Oversized report" },
  ]);
});

test("dashboard widget normalization keeps the first valid widget ID", () => {
  const widgets = decodeDashboardWidgets([
    {
      id: "widget:duplicate",
      type: "Summary",
      moduleId: "service-requests",
      fields: ["title", "stale-field", "status"],
      metric: "status",
    },
    {
      id: "widget:duplicate",
      type: "Workload",
      moduleId: "service-requests",
      fields: ["customer"],
      metric: "progress",
    },
    {
      id: "widget:keep",
      type: "OpenView",
      moduleId: "service-requests",
      fields: ["assignee"],
      metric: "progress",
    },
  ]);

  expect(widgets.map((widget) => widget.id)).toEqual([
    "widget:duplicate",
    "widget:keep",
  ]);
  expect(widgets[0]?.fields).toEqual(["title", "status"]);
  expect(widgets[0]?.metric).toBe("count");
  expect(widgets[1]?.metric).toBe("progress");
});

test("view layout defaults and migrations include presentation controls", () => {
  const customers = defaultViewConfig("customers");
  expect(customers.layout).toEqual(
    expect.objectContaining({
      pinnedColumns: ["name"],
      cardSize: "comfortable",
      dateRange: "month",
    }),
  );

  const priorLayout = decodeViewConfig({
    moduleId: "customers",
    search: "",
    filters: { logic: "and", clauses: [] },
    sorts: [{ field: "name", direction: "asc" }],
    groupBy: null,
    layout: {
      kind: "grid",
      columns: ["name", "email"],
      density: "compact",
      wrap: false,
      primaryField: "name",
      secondaryField: "email",
      scale: "list",
    },
  });
  expect(priorLayout).toEqual(
    expect.objectContaining({
      moduleId: "customers",
      layout: expect.objectContaining({
        pinnedColumns: [],
        cardSize: "comfortable",
        dateRange: "month",
        scale: "list",
      }),
    }),
  );

  const sanitizedPins = decodeViewConfig({
    ...priorLayout,
    layout: {
      ...priorLayout.layout,
      pinnedColumns: ["email", "name", "not-a-customer-field"],
    },
  });
  expect(sanitizedPins.layout.pinnedColumns).toEqual(["email"]);
});

test("calendar and timeline date ranges filter dated rows while retaining unscheduled rows", () => {
  const rows: OpenViewRow[] = [
    {
      id: "before-window",
      moduleId: "service-requests",
      values: { dueDate: "2026-08-31" },
    },
    {
      id: "in-month",
      moduleId: "service-requests",
      values: { dueDate: "2026-09-25" },
    },
    {
      id: "unscheduled",
      moduleId: "service-requests",
      values: { dueDate: "" },
    },
  ];
  expect(
    filterRowsByDateRange(rows, "dueDate", "month").map((row) => row.id),
  ).toEqual(["in-month", "unscheduled"]);
  expect(
    filterRowsByDateRange(rows, "dueDate", "week").map((row) => row.id),
  ).toEqual(["unscheduled"]);
  expect(
    filterRowsByDateRange(rows, "dueDate", "year").map((row) => row.id),
  ).toEqual(["before-window", "in-month", "unscheduled"]);
});

test("URL state only serializes allowlisted identifiers and record links resolve to Views", () => {
  expect(parseOpenViewUrl("/openview?record=sample-sr-1005")).toEqual({
    section: "views",
    module: "service-requests",
    record: "sample-sr-1005",
    invalid: false,
  });
  expect(
    parseOpenViewUrl(
      serializeOpenViewUrl({
        section: "dashboards",
        module: "customers",
        dashboard: "dashboard:customers",
      }),
    ),
  ).toEqual({
    section: "dashboards",
    module: "customers",
    dashboard: "dashboard:customers",
    invalid: false,
  });
  expect(parseOpenViewUrl("?record=../secrets").invalid).toBe(true);
  expect(parseOpenViewUrl("?view=" + "x".repeat(129)).invalid).toBe(true);
  expect(serializeOpenViewUrl({ record: "../secrets" })).toBe("/openview");
});

test("CSV export quotes cells, neutralizes formula prefixes, and creates safe filenames", () => {
  const rows: OpenViewRow[] = [
    {
      id: "sample-sr-1001",
      moduleId: "service-requests",
      values: {
        title: '=HYPERLINK("https://example.invalid")',
        customer: 'A "quoted" customer\nSecond line',
        status: "Open",
      },
    },
    {
      id: "sample-sr-1002",
      moduleId: "service-requests",
      values: { title: "Normal", customer: "\t+SUM(1,2)", status: "Open" },
    },
  ];
  expect(serializeOpenViewCsv(rows, ["title", "customer", "status"])).toBe(
    [
      '"title","customer","status"',
      '"\'=HYPERLINK(""https://example.invalid"")","A ""quoted"" customer\nSecond line","Open"',
      '"Normal","\'\t+SUM(1,2)","Open"',
    ].join("\r\n"),
  );
  expect(safeOpenViewFilename("../../Quarterly: Requests 2026", "csv")).toBe(
    "quarterly-requests-2026.csv",
  );
  expect(safeOpenViewFilename("", "pdf")).toBe("openslate-openview.pdf");
});
