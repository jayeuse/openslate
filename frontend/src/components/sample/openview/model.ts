import { z } from "zod";
import { serializeCsv } from "@/lib/csv";
import type { SampleRecord } from "../sample-data";
import type {
  Dashboard as LegacyDashboard,
  Report as LegacyReport,
} from "./seeds";

export const OPENVIEW_SECTIONS = [
  "views",
  "dashboards",
  "charts",
  "reports",
] as const;
export type OpenViewSection = (typeof OPENVIEW_SECTIONS)[number];

export const OPENVIEW_MODULE_IDS = [
  "service-requests",
  "equipment",
  "customers",
] as const;
export type OpenViewModuleId = (typeof OPENVIEW_MODULE_IDS)[number];
export type OpenViewValue = string | number | boolean;
export type OpenViewFieldType =
  "text" | "number" | "date" | "select" | "boolean";

export type OpenViewField = {
  id: string;
  label: string;
  type: OpenViewFieldType;
};

export type OpenViewModule = {
  id: OpenViewModuleId;
  name: string;
  description: string;
  primaryField: string;
  fields: OpenViewField[];
  defaultColumns: string[];
};

export type OpenViewRow = {
  id: string;
  moduleId: OpenViewModuleId;
  values: Record<string, OpenViewValue>;
};

export const OPENVIEW_MODULES: OpenViewModule[] = [
  {
    id: "service-requests",
    name: "Service requests",
    description: "Work orders, customers, assignments, and due dates.",
    primaryField: "title",
    defaultColumns: [
      "title",
      "customer",
      "status",
      "priority",
      "assignee",
      "progress",
      "dueDate",
    ],
    fields: [
      { id: "title", label: "Request", type: "text" },
      { id: "customer", label: "Customer", type: "text" },
      { id: "status", label: "Status", type: "select" },
      { id: "assignee", label: "Assignee", type: "select" },
      { id: "dueDate", label: "Due date", type: "date" },
      { id: "priority", label: "Priority", type: "select" },
      { id: "startDate", label: "Planned start", type: "date" },
      { id: "endDate", label: "Planned end", type: "date" },
      { id: "progress", label: "Progress", type: "number" },
    ],
  },
  {
    id: "equipment",
    name: "Equipment",
    description: "Assets, locations, condition, and service dates.",
    primaryField: "name",
    defaultColumns: [
      "assetTag",
      "name",
      "status",
      "priority",
      "owner",
      "progress",
      "deadline",
    ],
    fields: [
      { id: "assetTag", label: "Asset tag", type: "text" },
      { id: "name", label: "Equipment", type: "text" },
      { id: "status", label: "Status", type: "select" },
      { id: "location", label: "Location", type: "text" },
      { id: "lastServiceDate", label: "Last service", type: "date" },
      { id: "owner", label: "Owner", type: "select" },
      { id: "priority", label: "Priority", type: "select" },
      { id: "startDate", label: "Service start", type: "date" },
      { id: "endDate", label: "Service end", type: "date" },
      { id: "deadline", label: "Service deadline", type: "date" },
      { id: "progress", label: "Progress", type: "number" },
    ],
  },
  {
    id: "customers",
    name: "Customers",
    description: "Customer accounts, contacts, locations, and standing.",
    primaryField: "name",
    defaultColumns: [
      "customerId",
      "name",
      "status",
      "priority",
      "owner",
      "progress",
      "deadline",
    ],
    fields: [
      { id: "customerId", label: "Customer ID", type: "text" },
      { id: "name", label: "Customer", type: "text" },
      { id: "status", label: "Status", type: "select" },
      { id: "email", label: "Email", type: "text" },
      { id: "city", label: "City", type: "text" },
      { id: "owner", label: "Account owner", type: "select" },
      { id: "priority", label: "Priority", type: "select" },
      { id: "startDate", label: "Review start", type: "date" },
      { id: "endDate", label: "Review end", type: "date" },
      { id: "deadline", label: "Review deadline", type: "date" },
      { id: "progress", label: "Progress", type: "number" },
    ],
  },
];

export const INITIAL_EQUIPMENT: OpenViewRow[] = [
  {
    id: "sample-equipment-eq-204",
    moduleId: "equipment",
    values: {
      assetTag: "EQ-204",
      name: "Centrifugal pump 04",
      status: "In service",
      location: "Makati",
      lastServiceDate: "2026-08-28",
      owner: "Nina Santos",
      priority: "Medium",
      startDate: "2026-09-08",
      endDate: "2026-09-15",
      deadline: "2026-09-15",
      progress: 100,
    },
  },
  {
    id: "sample-equipment-eq-118",
    moduleId: "equipment",
    values: {
      assetTag: "EQ-118",
      name: "Air handling unit 02",
      status: "Inspection due",
      location: "Quezon City",
      lastServiceDate: "2026-07-14",
      owner: "Ramon Villanueva",
      priority: "High",
      startDate: "2026-09-15",
      endDate: "2026-09-18",
      deadline: "2026-09-18",
      progress: 0,
    },
  },
  {
    id: "sample-equipment-eq-311",
    moduleId: "equipment",
    values: {
      assetTag: "EQ-311",
      name: "Flow meter 11",
      status: "In service",
      location: "Pasig",
      lastServiceDate: "2026-09-02",
      owner: "Nina Santos",
      priority: "Low",
      startDate: "2026-09-12",
      endDate: "2026-09-16",
      deadline: "2026-09-16",
      progress: 100,
    },
  },
  {
    id: "sample-equipment-eq-087",
    moduleId: "equipment",
    values: {
      assetTag: "EQ-087",
      name: "Control panel 07",
      status: "Out for repair",
      location: "Taguig",
      lastServiceDate: "2026-06-21",
      owner: "Ramon Villanueva",
      priority: "Critical",
      startDate: "2026-09-10",
      endDate: "2026-09-20",
      deadline: "2026-09-17",
      progress: 40,
    },
  },
  {
    id: "sample-equipment-eq-226",
    moduleId: "equipment",
    values: {
      assetTag: "EQ-226",
      name: "Chiller pump 03",
      status: "In service",
      location: "Mandaluyong",
      lastServiceDate: "2026-08-05",
      owner: "Nina Santos",
      priority: "Medium",
      startDate: "2026-09-17",
      endDate: "2026-09-22",
      deadline: "2026-09-22",
      progress: 0,
    },
  },
];

export const INITIAL_CUSTOMERS: OpenViewRow[] = [
  {
    id: "sample-customer-c-1042",
    moduleId: "customers",
    values: {
      customerId: "C-1042",
      name: "Riverside Industrial",
      status: "Active",
      email: "ops@riverside.example",
      city: "Makati",
      owner: "Mara Dela Cruz",
      priority: "High",
      startDate: "2026-09-01",
      endDate: "2026-09-12",
      deadline: "2026-09-12",
      progress: 100,
    },
  },
  {
    id: "sample-customer-c-1068",
    moduleId: "customers",
    values: {
      customerId: "C-1068",
      name: "Northvale Co.",
      status: "Active",
      email: "service@northvale.example",
      city: "Pasig",
      owner: "Mara Dela Cruz",
      priority: "Medium",
      startDate: "2026-09-08",
      endDate: "2026-09-19",
      deadline: "2026-09-19",
      progress: 65,
    },
  },
  {
    id: "sample-customer-c-1091",
    moduleId: "customers",
    values: {
      customerId: "C-1091",
      name: "Cedar Ridge Facilities",
      status: "Review",
      email: "facilities@cedarridge.example",
      city: "Quezon City",
      owner: "Joel Mercado",
      priority: "High",
      startDate: "2026-09-09",
      endDate: "2026-09-16",
      deadline: "2026-09-16",
      progress: 30,
    },
  },
  {
    id: "sample-customer-c-1127",
    moduleId: "customers",
    values: {
      customerId: "C-1127",
      name: "Maple Grove Health",
      status: "Active",
      email: "admin@maplegrove.example",
      city: "Taguig",
      owner: "Joel Mercado",
      priority: "Medium",
      startDate: "2026-09-11",
      endDate: "2026-09-23",
      deadline: "2026-09-23",
      progress: 45,
    },
  },
  {
    id: "sample-customer-c-1154",
    moduleId: "customers",
    values: {
      customerId: "C-1154",
      name: "Stonebridge Manufacturing",
      status: "On hold",
      email: "plant@stonebridge.example",
      city: "Mandaluyong",
      owner: "Mara Dela Cruz",
      priority: "Critical",
      startDate: "2026-09-05",
      endDate: "2026-09-14",
      deadline: "2026-09-14",
      progress: 25,
    },
  },
];

type ServiceOperationalOverlay = {
  priority: string;
  startDate: string;
  endDate: string;
  progress: number;
};

/**
 * The sample records remain the source for request identity and due dates.
 * These planning values are intentionally owned by OpenView so the future
 * backend contract can replace them without changing SampleRecord.
 */
export const SERVICE_OPERATIONAL_OVERLAY: Record<
  string,
  ServiceOperationalOverlay
> = {
  "sample-sr-1004": {
    priority: "High",
    startDate: "2026-09-12",
    endDate: "2026-09-18",
    progress: 55,
  },
  "sample-sr-1005": {
    priority: "High",
    startDate: "2026-09-14",
    endDate: "2026-09-18",
    progress: 0,
  },
  "sample-sr-1006": {
    priority: "Medium",
    startDate: "2026-09-16",
    endDate: "2026-09-20",
    progress: 0,
  },
  "sample-sr-1007": {
    priority: "Critical",
    startDate: "2026-09-11",
    endDate: "2026-09-27",
    progress: 35,
  },
  "sample-sr-1008": {
    priority: "High",
    startDate: "2026-09-10",
    endDate: "2026-09-17",
    progress: 20,
  },
  "sample-sr-1009": {
    priority: "High",
    startDate: "2026-09-13",
    endDate: "2026-09-23",
    progress: 0,
  },
  "sample-sr-1010": {
    priority: "Low",
    startDate: "2026-09-18",
    endDate: "2026-09-24",
    progress: 0,
  },
  "sample-sr-1011": {
    priority: "Medium",
    startDate: "2026-09-15",
    endDate: "2026-09-25",
    progress: 0,
  },
};

export function getModuleDefinition(
  moduleId: OpenViewModuleId,
): OpenViewModule {
  return OPENVIEW_MODULES.find((module) => module.id === moduleId)!;
}

const OPERATIONAL_DEADLINE_FIELDS: Record<OpenViewModuleId, string> = {
  "service-requests": "dueDate",
  equipment: "deadline",
  customers: "deadline",
};

/**
 * Return the date that represents the operational deadline for a module.
 * Modules without the preferred field fall back to their first date field so
 * chart state remains usable as the sample schema evolves.
 */
export function getOpenViewOperationalDeadlineField(
  moduleId: OpenViewModuleId,
): string | undefined {
  const moduleDefinition = getModuleDefinition(moduleId);
  const preferred = OPERATIONAL_DEADLINE_FIELDS[moduleId];
  return moduleDefinition.fields.some(
    (field) => field.id === preferred && field.type === "date",
  )
    ? preferred
    : moduleDefinition.fields.find((field) => field.type === "date")?.id;
}

export function getOpenViewRows(
  moduleId: OpenViewModuleId,
  serviceRequests: SampleRecord[] = [],
): OpenViewRow[] {
  if (moduleId === "equipment") return INITIAL_EQUIPMENT;
  if (moduleId === "customers") return INITIAL_CUSTOMERS;
  return serviceRequests.map((record) => ({
    id: record.id,
    moduleId,
    // Unknown request IDs intentionally receive empty planning fields. The
    // shared record values remain intact, but OpenView never invents dates or
    // progress for a request it does not recognize.
    values: {
      title: record.title,
      customer: record.customer,
      status: record.status,
      assignee: record.assignee,
      dueDate: record.dueDate,
      priority: SERVICE_OPERATIONAL_OVERLAY[record.id]?.priority ?? "",
      startDate: SERVICE_OPERATIONAL_OVERLAY[record.id]?.startDate ?? "",
      endDate: SERVICE_OPERATIONAL_OVERLAY[record.id]?.endDate ?? "",
      progress: SERVICE_OPERATIONAL_OVERLAY[record.id]?.progress ?? "",
    },
  }));
}

export const FILTER_OPERATORS = [
  "contains",
  "equals",
  "not-equals",
  "starts-with",
  "ends-with",
  "on-or-after",
  "on-or-before",
  "is-empty",
  "is-not-empty",
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];
export type FilterClause = {
  field: string;
  operator: FilterOperator;
  value: string;
};
export type FilterGroup = { logic: "and" | "or"; clauses: FilterClause[] };
export type SortRule = { field: string; direction: "asc" | "desc" };
export type ViewLayout = {
  kind: "table" | "grid" | "kanban" | "calendar" | "timeline" | "gallery";
  columns: string[];
  pinnedColumns: string[];
  density: "comfortable" | "compact";
  wrap: boolean;
  cardSize: "comfortable" | "compact";
  primaryField?: string;
  secondaryField?: string;
  dateField?: string;
  dateRange: "week" | "month" | "quarter" | "year";
  scale?: "month" | "list";
};
export type ViewConfig = {
  moduleId: OpenViewModuleId;
  search: string;
  filters: FilterGroup;
  sorts: SortRule[];
  groupBy: string | null;
  layout: ViewLayout;
};

export type AudienceRef =
  | {
      kind: "private";
      unresolved?: { kind: "role" | "identity"; id: string };
    }
  | { kind: "everyone" }
  | { kind: "role"; id: string }
  | { kind: "identity"; id: string };
export type AudienceLookup = {
  roles?: { id: string; name: string }[];
  identities?: { id: string; name: string }[];
};

/** Project access owners into the audience lookup shared by every OpenView surface. */
export function projectAudienceLookup(
  roles: readonly { id: string; name: string }[],
  people: readonly {
    id: string;
    name: string;
    active: boolean;
    accessStatus?: string;
  }[],
): AudienceLookup {
  return {
    roles: roles.map(({ id, name }) => ({ id, name })),
    identities: activeAudienceIdentities(people),
  };
}

export function activeAudienceIdentities(
  people: readonly {
    id: string;
    name: string;
    active: boolean;
    accessStatus?: string;
  }[],
): NonNullable<AudienceLookup["identities"]> {
  return people
    .filter(
      (person) =>
        person.active && (person.accessStatus ?? "active") === "active",
    )
    .map(({ id, name }) => ({ id, name }));
}

export type SavedView = {
  id: string;
  name: string;
  moduleId: OpenViewModuleId;
  audience: AudienceRef;
  config: ViewConfig;
};
export type RefreshCadence = "manual" | "one-minute" | "five-minutes";
export type OpenViewWidget = {
  id: string;
  name: string;
  type: "summary" | "workload" | "records" | "chart";
  moduleId: OpenViewModuleId;
  size: "half" | "full";
  audience: AudienceRef;
  refresh: RefreshCadence;
  pinned: boolean;
  fields: string[];
  filters: FilterGroup;
  metric: string;
  visualization: "bar" | "line" | "pie";
};
export type Dashboard = {
  id: string;
  name: string;
  audience: AudienceRef;
  refresh: RefreshCadence;
  widgets: OpenViewWidget[];
};
export type ChartSettings = {
  moduleId: OpenViewModuleId;
  type: "bar" | "line" | "pie";
  dimension: string;
  aggregation: "count" | "sum" | "average";
  metric: string;
  dateField: string;
  filters: FilterGroup;
  from: string;
  to: string;
  limit: number;
  showLegend: boolean;
  showLabels: boolean;
};
export type ReportSchedule = {
  cadence: "manual" | "daily" | "weekly" | "monthly";
  timezone: string;
};
export type Report = {
  id: string;
  name: string;
  subtitle: string;
  moduleId: OpenViewModuleId;
  fields: string[];
  filters: FilterGroup;
  sorts: SortRule[];
  grouping: string | null;
  totals: boolean;
  schedule: ReportSchedule;
  audience: AudienceRef;
};

const moduleIdSchema = z.enum(OPENVIEW_MODULE_IDS);
const unresolvedAudienceSchema = z.object({
  kind: z.enum(["role", "identity"]),
  id: z.string().min(1).max(128),
});
const audienceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("private"),
    unresolved: unresolvedAudienceSchema.optional(),
  }),
  z.object({ kind: z.literal("everyone") }),
  z.object({ kind: z.literal("role"), id: z.string().min(1).max(128) }),
  z.object({ kind: z.literal("identity"), id: z.string().min(1).max(128) }),
]);
const clauseSchema = z.object({
  field: z.string().min(1).max(80),
  operator: z.enum(FILTER_OPERATORS),
  value: z.string().max(240),
});
const filterGroupSchema = z.object({
  logic: z.enum(["and", "or"]),
  clauses: z.array(clauseSchema).max(8),
});
const sortRuleSchema = z.object({
  field: z.string().min(1).max(80),
  direction: z.enum(["asc", "desc"]),
});
const layoutSchema = z.object({
  kind: z.enum(["table", "grid", "kanban", "calendar", "timeline", "gallery"]),
  columns: z.array(z.string().min(1).max(80)).max(20),
  pinnedColumns: z.array(z.string().min(1).max(80)).max(20).default([]),
  density: z.enum(["comfortable", "compact"]),
  wrap: z.boolean(),
  cardSize: z.enum(["comfortable", "compact"]).default("comfortable"),
  primaryField: z.string().max(80).optional(),
  secondaryField: z.string().max(80).optional(),
  dateField: z.string().max(80).optional(),
  dateRange: z.enum(["week", "month", "quarter", "year"]).default("month"),
  scale: z.enum(["month", "list"]).optional(),
});
const viewConfigSchema = z.object({
  moduleId: moduleIdSchema,
  search: z.string().max(240),
  filters: filterGroupSchema,
  sorts: z.array(sortRuleSchema).max(3),
  groupBy: z.string().max(80).nullable(),
  layout: layoutSchema,
});

export function defaultViewConfig(moduleId: OpenViewModuleId): ViewConfig {
  const moduleDefinition = getModuleDefinition(moduleId);
  const dateField = moduleDefinition.fields.find(
    (field) => field.type === "date",
  )?.id;
  return {
    moduleId,
    search: "",
    filters: { logic: "and", clauses: [] },
    sorts: [{ field: moduleDefinition.primaryField, direction: "asc" }],
    groupBy: null,
    layout: {
      kind: "table",
      columns: [...moduleDefinition.defaultColumns],
      pinnedColumns: [moduleDefinition.primaryField],
      density: "comfortable",
      wrap: true,
      cardSize: "comfortable",
      primaryField: moduleDefinition.primaryField,
      secondaryField: moduleDefinition.fields[1]?.id,
      dateField,
      dateRange: "month",
      scale: "month",
    },
  };
}

export const INITIAL_OPENVIEW_VIEW = defaultViewConfig("service-requests");

function legacyLayout(value: unknown): ViewLayout["kind"] | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  return [
    "table",
    "grid",
    "kanban",
    "calendar",
    "timeline",
    "gallery",
  ].includes(normalized)
    ? (normalized as ViewLayout["kind"])
    : null;
}

export function decodeViewConfig(raw: unknown): ViewConfig {
  const parsed = viewConfigSchema.safeParse(raw);
  if (parsed.success) return sanitizeViewConfig(parsed.data);
  if (typeof raw !== "object" || raw === null) return INITIAL_OPENVIEW_VIEW;
  const legacy = raw as Record<string, unknown>;
  const kind = legacyLayout(legacy.type);
  if (!kind) return INITIAL_OPENVIEW_VIEW;
  const next = defaultViewConfig("service-requests");
  next.layout.kind = kind;
  if (typeof legacy.search === "string")
    next.search = legacy.search.slice(0, 240);
  if (typeof legacy.status === "string" && legacy.status !== "All statuses") {
    const statuses = new Set([
      "Open",
      "In progress",
      "Scheduled",
      "On hold",
      "Completed",
    ]);
    if (statuses.has(legacy.status)) {
      next.filters = {
        logic: "and",
        clauses: [
          { field: "status", operator: "equals", value: legacy.status },
        ],
      };
    }
  }
  if (
    typeof legacy.sort === "string" &&
    getModuleDefinition(next.moduleId).fields.some(
      (field) => field.id === legacy.sort,
    )
  )
    next.sorts = [{ field: legacy.sort, direction: "asc" }];
  if (
    typeof legacy.group === "string" &&
    legacy.group !== "None" &&
    getModuleDefinition(next.moduleId).fields.some(
      (field) => field.id === legacy.group,
    )
  )
    next.groupBy = legacy.group;
  return next;
}

function sanitizeViewConfig(config: ViewConfig): ViewConfig {
  const moduleDefinition = getModuleDefinition(config.moduleId);
  const allowed = new Set(moduleDefinition.fields.map((field) => field.id));
  return {
    ...config,
    filters: {
      ...config.filters,
      clauses: config.filters.clauses.filter((clause) =>
        allowed.has(clause.field),
      ),
    },
    sorts: config.sorts.filter((sort) => allowed.has(sort.field)).slice(0, 3),
    groupBy:
      config.groupBy && allowed.has(config.groupBy) ? config.groupBy : null,
    layout: {
      ...config.layout,
      columns: config.layout.columns.filter((field) => allowed.has(field)),
      pinnedColumns: config.layout.pinnedColumns
        .filter(
          (field) =>
            allowed.has(field) && config.layout.columns.includes(field),
        )
        .slice(0, 1),
    },
  };
}

export function decodeAudienceRef(
  raw: unknown,
  lookup: AudienceLookup = {},
): AudienceRef {
  const parsed = audienceSchema.safeParse(raw);
  if (parsed.success) {
    const audience = parsed.data;
    if (
      audience.kind === "role" &&
      !lookup.roles?.some((role) => role.id === audience.id)
    )
      return {
        kind: "private",
        unresolved: { kind: "role", id: audience.id },
      };
    if (
      audience.kind === "identity" &&
      !lookup.identities?.some((identity) => identity.id === audience.id)
    )
      return {
        kind: "private",
        unresolved: { kind: "identity", id: audience.id },
      };
    return audience;
  }
  if (raw === "Everyone") return { kind: "everyone" };
  if (raw === "Only me" || raw === "Private") return { kind: "private" };
  if (typeof raw === "string" && raw.startsWith("Role: ")) {
    const unresolvedId = raw.slice(6, 134);
    const role = lookup.roles?.find(
      (candidate) => candidate.name === raw.slice(6),
    );
    return role
      ? { kind: "role", id: role.id }
      : {
          kind: "private",
          unresolved: { kind: "role", id: unresolvedId || "unknown" },
        };
  }
  if (typeof raw === "string" && raw.startsWith("User: ")) {
    const unresolvedId = raw.slice(6, 134);
    const identity = lookup.identities?.find(
      (candidate) => candidate.name === raw.slice(6),
    );
    return identity
      ? { kind: "identity", id: identity.id }
      : {
          kind: "private",
          unresolved: { kind: "identity", id: unresolvedId || "unknown" },
        };
  }
  return { kind: "private" };
}

export function isUnresolvedAudience(audience: AudienceRef): boolean {
  return audience.kind === "private" && audience.unresolved !== undefined;
}

export function audienceLabel(
  audience: AudienceRef,
  lookup: AudienceLookup = {},
): string {
  if (audience.kind === "private")
    return audience.unresolved
      ? `Only me · unresolved ${audience.unresolved.kind === "role" ? "role" : "person"}`
      : "Only me";
  if (audience.kind === "everyone") return "Everyone";
  if (audience.kind === "role")
    return `Role: ${lookup.roles?.find((role) => role.id === audience.id)?.name ?? "Unresolved"}`;
  return `User: ${lookup.identities?.find((identity) => identity.id === audience.id)?.name ?? "Unresolved"}`;
}

function legacyRefresh(refresh: RefreshCadence): string {
  if (refresh === "one-minute") return "Every minute";
  if (refresh === "five-minutes") return "Every 5 minutes";
  return "Manual";
}

function legacyWidgetType(type: OpenViewWidget["type"]): string {
  if (type === "summary") return "Summary";
  if (type === "workload") return "Workload";
  if (type === "chart") return "Chart";
  return "OpenView";
}

/** Serialize typed dashboard owners in the legacy shape accepted by Access and old tabs. */
export function toLegacyDashboard(
  dashboard: Dashboard,
  lookup: AudienceLookup,
): LegacyDashboard {
  return {
    id: dashboard.id,
    name: dashboard.name,
    permission: audienceLabel(dashboard.audience, lookup),
    audience: structuredClone(dashboard.audience),
    refresh: legacyRefresh(dashboard.refresh),
    widgets: dashboard.widgets.map((widget) => ({
      id: widget.id,
      name: widget.name,
      type: legacyWidgetType(widget.type),
      size: widget.size === "full" ? "Full" : "Half",
      permission: audienceLabel(widget.audience, lookup),
      refresh: legacyRefresh(widget.refresh),
      pinned: widget.pinned,
      moduleId: widget.moduleId,
      audience: structuredClone(widget.audience),
      fields: [...widget.fields],
      filters: structuredClone(widget.filters),
      metric: widget.metric,
      visualization: widget.visualization,
    })),
  };
}

function legacySchedule(schedule: Report["schedule"]): string {
  if (schedule.cadence === "daily") return "Daily at 09:00";
  if (schedule.cadence === "weekly") return "Weekly on Monday at 09:00";
  if (schedule.cadence === "monthly") return "Monthly on the 1st at 09:00";
  return "Manual";
}

/** Serialize typed report owners in the legacy shape accepted by Access and old tabs. */
export function toLegacyReport(
  report: Report,
  lookup: AudienceLookup = {},
): LegacyReport {
  return {
    id: report.id,
    name: report.name,
    subtitle: report.subtitle,
    moduleId: report.moduleId,
    fields: [...report.fields],
    grouping: report.grouping ?? "None",
    totals: report.totals,
    schedule: legacySchedule(report.schedule),
    audience: structuredClone(report.audience),
    audienceLabel: audienceLabel(report.audience, lookup),
    permission: audienceLabel(report.audience, lookup),
    filters: structuredClone(report.filters),
    sorts: structuredClone(report.sorts),
  };
}

export function decodeSavedViews(
  raw: unknown,
  lookup: AudienceLookup = {},
): SavedView[] {
  if (!Array.isArray(raw)) return [];
  const decoded = raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const value = entry as Record<string, unknown>;
    if (!isSafeStoredIdentifier(value.id) || typeof value.name !== "string")
      return [];
    if ("config" in value) {
      const config = decodeViewConfig(value.config);
      return [
        {
          id: value.id,
          name: value.name.slice(0, 80),
          moduleId: config.moduleId,
          audience: decodeAudienceRef(value.audience, lookup),
          config,
        },
      ];
    }
    if (
      typeof value.type !== "string" ||
      typeof value.search !== "string" ||
      !legacyLayout(value.type)
    )
      return [];
    const config = decodeViewConfig(value);
    return [
      {
        id: value.id,
        name: value.name.slice(0, 80),
        moduleId: config.moduleId,
        audience: decodeAudienceRef(value.audience, lookup),
        config,
      },
    ];
  });
  return firstStableIdWins(decoded);
}

function decodeRefresh(raw: unknown): RefreshCadence {
  if (raw === "one-minute" || raw === "Every minute") return "one-minute";
  if (raw === "five-minutes" || raw === "Every 5 minutes")
    return "five-minutes";
  return "manual";
}

function decodeWidget(
  raw: unknown,
  lookup: AudienceLookup = {},
): OpenViewWidget | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (!isSafeStoredIdentifier(value.id)) return null;
  const legacyTypes: Record<string, OpenViewWidget["type"]> = {
    Summary: "summary",
    Workload: "workload",
    OpenView: "records",
  };
  const type =
    typeof value.type === "string" &&
    ["summary", "workload", "records", "chart"].includes(value.type)
      ? (value.type as OpenViewWidget["type"])
      : legacyTypes[String(value.type)];
  if (!type) return null;
  const moduleId = moduleIdSchema.safeParse(value.moduleId).success
    ? (value.moduleId as OpenViewModuleId)
    : "service-requests";
  const moduleDefinition = getModuleDefinition(moduleId);
  const allowedFields = new Set(
    moduleDefinition.fields.map((field) => field.id),
  );
  const decodedFields = Array.isArray(value.fields)
    ? firstStableIdWins(
        value.fields.flatMap((field) =>
          typeof field === "string" && allowedFields.has(field)
            ? [{ id: field }]
            : [],
        ),
      )
        .map((field) => field.id)
        .slice(0, 24)
    : [];
  const fields =
    decodedFields.length > 0
      ? decodedFields
      : moduleDefinition.fields.slice(0, 3).map((field) => field.id);
  const metric =
    typeof value.metric === "string" &&
    (value.metric === "count" ||
      moduleDefinition.fields.some(
        (field) => field.id === value.metric && field.type === "number",
      ))
      ? value.metric
      : "count";
  const parsedFilters = filterGroupSchema.safeParse(value.filters);
  return {
    id: value.id,
    name:
      typeof value.name === "string"
        ? value.name.slice(0, 80)
        : type === "records"
          ? "OpenView records"
          : `${type[0].toUpperCase()}${type.slice(1)}`,
    type,
    moduleId,
    size: value.size === "full" || value.size === "Full" ? "full" : "half",
    audience: decodeAudienceRef(value.audience ?? value.permission, lookup),
    refresh: decodeRefresh(value.refresh),
    pinned: value.pinned === true,
    fields,
    filters: parsedFilters.success
      ? {
          ...parsedFilters.data,
          clauses: parsedFilters.data.clauses.filter((clause) =>
            allowedFields.has(clause.field),
          ),
        }
      : { logic: "and", clauses: [] },
    metric,
    visualization:
      value.visualization === "line" || value.visualization === "pie"
        ? value.visualization
        : "bar",
  };
}

export function decodeDashboardWidgets(
  raw: unknown,
  lookup: AudienceLookup = {},
): OpenViewWidget[] {
  if (!Array.isArray(raw)) return [];
  return firstStableIdWins(
    raw.flatMap((widget) => {
      const decoded = decodeWidget(widget, lookup);
      return decoded ? [decoded] : [];
    }),
  ).slice(0, 12);
}

export function decodeDashboards(
  raw: unknown,
  lookup: AudienceLookup = {},
): Dashboard[] {
  if (!Array.isArray(raw)) return [];
  const decoded = raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const value = entry as Record<string, unknown>;
    if (!isSafeStoredIdentifier(value.id) || typeof value.name !== "string")
      return [];
    return [
      {
        id: value.id,
        name: value.name.slice(0, 80),
        audience: decodeAudienceRef(value.audience ?? value.permission, lookup),
        refresh: decodeRefresh(value.refresh),
        widgets: decodeDashboardWidgets(value.widgets, lookup),
      },
    ];
  });
  return firstStableIdWins(decoded);
}

export function decodeReport(
  raw: unknown,
  lookup: AudienceLookup = {},
): Report {
  if (typeof raw !== "object" || raw === null)
    return initialReport("service-requests");
  const value = raw as Record<string, unknown>;
  const moduleId = moduleIdSchema.safeParse(value.moduleId).success
    ? (value.moduleId as OpenViewModuleId)
    : "service-requests";
  const moduleDefinition = getModuleDefinition(moduleId);
  const name =
    typeof value.name === "string"
      ? value.name.slice(0, 80)
      : "Untitled report";
  const schedule =
    typeof value.schedule === "object" && value.schedule !== null
      ? (value.schedule as Record<string, unknown>)
      : null;
  let cadence: ReportSchedule["cadence"] = "manual";
  if (
    schedule &&
    ["manual", "daily", "weekly", "monthly"].includes(String(schedule.cadence))
  )
    cadence = schedule.cadence as ReportSchedule["cadence"];
  else if (typeof value.schedule === "string") {
    if (value.schedule.startsWith("Daily")) cadence = "daily";
    else if (value.schedule.startsWith("Weekly")) cadence = "weekly";
    else if (value.schedule.startsWith("Monthly")) cadence = "monthly";
  }
  const allowedFields = new Set(
    moduleDefinition.fields.map((field) => field.id),
  );
  const parsedFilters = filterGroupSchema.safeParse(value.filters);
  return {
    id: isSafeStoredIdentifier(value.id) ? value.id : legacyReportId(name),
    name,
    subtitle:
      typeof value.subtitle === "string" ? value.subtitle.slice(0, 160) : "",
    moduleId,
    fields: Array.isArray(value.fields)
      ? value.fields.filter(
          (field): field is string =>
            typeof field === "string" &&
            moduleDefinition.fields.some((candidate) => candidate.id === field),
        )
      : moduleDefinition.fields.slice(0, 3).map((field) => field.id),
    filters: parsedFilters.success
      ? {
          ...parsedFilters.data,
          clauses: parsedFilters.data.clauses.filter((clause) =>
            allowedFields.has(clause.field),
          ),
        }
      : { logic: "and", clauses: [] },
    sorts: Array.isArray(value.sorts)
      ? value.sorts
          .map((sort) => sortRuleSchema.safeParse(sort))
          .filter((result) => result.success)
          .map((result) => result.data)
          .filter((sort) => allowedFields.has(sort.field))
          .slice(0, 3)
      : [],
    grouping:
      typeof value.grouping === "string" &&
      value.grouping !== "None" &&
      moduleDefinition.fields.some((field) => field.id === value.grouping)
        ? value.grouping
        : null,
    totals: value.totals === true,
    schedule: {
      cadence,
      timezone:
        schedule && typeof schedule.timezone === "string"
          ? schedule.timezone
          : "Asia/Manila",
    },
    audience: decodeAudienceRef(value.audience, lookup),
  };
}

export function decodeReports(
  raw: unknown,
  lookup: AudienceLookup = {},
): Report[] {
  if (!Array.isArray(raw)) return [];
  const usedIds = new Set<string>();
  return raw.flatMap((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("name" in entry) ||
      typeof entry.name !== "string"
    )
      return [];
    const decoded = decodeReport(entry, lookup);
    const entryId = (entry as Record<string, unknown>).id;
    if (isSafeStoredIdentifier(entryId)) {
      if (usedIds.has(decoded.id)) return [];
      usedIds.add(decoded.id);
      return [decoded];
    }

    let uniqueId = decoded.id;
    let suffix = 2;
    while (usedIds.has(uniqueId)) {
      const suffixText = `-${suffix}`;
      uniqueId = `${decoded.id.slice(0, 128 - suffixText.length)}${suffixText}`;
      suffix += 1;
    }
    usedIds.add(uniqueId);
    return [{ ...decoded, id: uniqueId }];
  });
}

export function initialReport(moduleId: OpenViewModuleId): Report {
  const moduleDefinition = getModuleDefinition(moduleId);
  return {
    id: "sample-report-weekly-review",
    name: "Weekly operations review",
    subtitle: "A concise review of the selected sample module.",
    moduleId,
    fields: moduleDefinition.fields.slice(0, 3).map((field) => field.id),
    filters: { logic: "and", clauses: [] },
    sorts: [{ field: moduleDefinition.primaryField, direction: "asc" }],
    grouping:
      moduleDefinition.fields.find((field) => field.id === "status")?.id ??
      null,
    totals: true,
    schedule: { cadence: "manual", timezone: "Asia/Manila" },
    audience: { kind: "private" },
  };
}

export const INITIAL_DASHBOARDS: Dashboard[] = [
  {
    id: "sample-dashboard-operations",
    name: "Operations pulse",
    audience: { kind: "everyone" },
    refresh: "manual",
    widgets: [
      {
        id: "sample-widget-summary",
        name: "Request summary",
        type: "summary",
        moduleId: "service-requests",
        size: "full",
        audience: { kind: "everyone" },
        refresh: "manual",
        pinned: false,
        fields: ["title", "status"],
        filters: { logic: "and", clauses: [] },
        metric: "count",
        visualization: "bar",
      },
      {
        id: "sample-widget-workload",
        name: "Team workload",
        type: "workload",
        moduleId: "service-requests",
        size: "half",
        audience: { kind: "everyone" },
        refresh: "manual",
        pinned: false,
        fields: ["assignee", "status"],
        filters: { logic: "and", clauses: [] },
        metric: "count",
        visualization: "bar",
      },
    ],
  },
];

export const INITIAL_CHART_SETTINGS: ChartSettings = {
  moduleId: "service-requests",
  type: "bar",
  dimension: "status",
  aggregation: "count",
  metric: "count",
  dateField: getOpenViewOperationalDeadlineField("service-requests") ?? "",
  filters: { logic: "and", clauses: [] },
  from: "",
  to: "",
  limit: 8,
  showLegend: true,
  showLabels: true,
};

function validIsoDate(value: unknown): value is string {
  if (value === "") return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
  );
}

function validChartLimit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 20
  );
}

function defaultChartDimension(moduleId: OpenViewModuleId): string {
  const moduleDefinition = getModuleDefinition(moduleId);
  return (
    moduleDefinition.fields.find((field) => field.type === "select")?.id ??
    moduleDefinition.primaryField
  );
}

function numericChartMetric(
  moduleId: OpenViewModuleId,
  metric: string,
): boolean {
  return getModuleDefinition(moduleId).fields.some(
    (field) => field.id === metric && field.type === "number",
  );
}

function chartFilters(raw: unknown, moduleId: OpenViewModuleId): FilterGroup {
  if (typeof raw !== "object" || raw === null) {
    return { logic: "and", clauses: [] };
  }
  const source = raw as Record<string, unknown>;
  const allowed = new Set(
    getModuleDefinition(moduleId).fields.map((field) => field.id),
  );
  const logic: FilterGroup["logic"] = source.logic === "or" ? "or" : "and";
  const clauses = Array.isArray(source.clauses)
    ? source.clauses.slice(0, 8).flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const clause = entry as Record<string, unknown>;
        if (
          typeof clause.field !== "string" ||
          !allowed.has(clause.field) ||
          !FILTER_OPERATORS.includes(clause.operator as FilterOperator) ||
          typeof clause.value !== "string" ||
          clause.value.length > 240
        )
          return [];
        return [
          {
            field: clause.field,
            operator: clause.operator as FilterOperator,
            value: clause.value,
          },
        ];
      })
    : [];
  return { logic, clauses };
}

export function normalizeChartSettings(settings: ChartSettings): ChartSettings {
  const moduleDefinition = getModuleDefinition(settings.moduleId);
  const dimension = moduleDefinition.fields.some(
    (field) => field.id === settings.dimension,
  )
    ? settings.dimension
    : defaultChartDimension(settings.moduleId);
  const dateField = moduleDefinition.fields.some(
    (field) => field.id === settings.dateField && field.type === "date",
  )
    ? settings.dateField
    : (getOpenViewOperationalDeadlineField(settings.moduleId) ?? "");
  const metric =
    settings.metric === "count" ||
    numericChartMetric(settings.moduleId, settings.metric)
      ? settings.metric
      : "count";
  const aggregation =
    metric === "count"
      ? "count"
      : settings.aggregation === "average" || settings.aggregation === "sum"
        ? settings.aggregation
        : "sum";
  return {
    ...settings,
    dimension,
    dateField,
    metric,
    aggregation,
    limit: validChartLimit(settings.limit) ? settings.limit : 8,
    from: validIsoDate(settings.from) ? settings.from : "",
    to: validIsoDate(settings.to) ? settings.to : "",
  };
}

export function defaultChartSettings(
  moduleId: OpenViewModuleId,
): ChartSettings {
  return normalizeChartSettings({
    ...INITIAL_CHART_SETTINGS,
    moduleId,
    dimension: defaultChartDimension(moduleId),
    metric: "count",
    aggregation: "count",
    dateField: getOpenViewOperationalDeadlineField(moduleId) ?? "",
    filters: { logic: "and", clauses: [] },
    from: "",
    to: "",
  });
}

/**
 * Decode persisted chart state, including the pre-date-field shape. Invalid
 * module fields and metrics fail closed to a readable module-local default.
 */
export function decodeChartSettings(raw: unknown): ChartSettings {
  if (typeof raw !== "object" || raw === null)
    return defaultChartSettings("service-requests");
  const source = raw as Record<string, unknown>;
  const moduleId = moduleIdSchema.safeParse(source.moduleId).success
    ? (source.moduleId as OpenViewModuleId)
    : "service-requests";
  const moduleDefinition = getModuleDefinition(moduleId);
  const typeValue =
    typeof source.type === "string" ? source.type.toLowerCase() : "bar";
  const type: ChartSettings["type"] =
    typeValue === "line" || typeValue === "pie" ? typeValue : "bar";
  const dimension =
    typeof source.dimension === "string" &&
    moduleDefinition.fields.some((field) => field.id === source.dimension)
      ? source.dimension
      : defaultChartDimension(moduleId);
  const aggregationValue =
    typeof source.aggregation === "string"
      ? source.aggregation.toLowerCase()
      : "count";
  const aggregation: ChartSettings["aggregation"] =
    aggregationValue === "sum" || aggregationValue === "average"
      ? aggregationValue
      : "count";
  const metric =
    typeof source.metric === "string" &&
    (source.metric === "count" || numericChartMetric(moduleId, source.metric))
      ? source.metric
      : "count";
  const dateField =
    typeof source.dateField === "string" &&
    moduleDefinition.fields.some(
      (field) => field.id === source.dateField && field.type === "date",
    )
      ? source.dateField
      : (getOpenViewOperationalDeadlineField(moduleId) ?? "");
  const limit = validChartLimit(source.limit) ? source.limit : 8;
  return normalizeChartSettings({
    moduleId,
    type,
    dimension,
    aggregation,
    metric,
    dateField,
    filters: chartFilters(source.filters, moduleId),
    from: validIsoDate(source.from) ? source.from : "",
    to: validIsoDate(source.to) ? source.to : "",
    limit,
    showLegend:
      typeof source.showLegend === "boolean" ? source.showLegend : true,
    showLabels:
      typeof source.showLabels === "boolean" ? source.showLabels : true,
  });
}

function compareValue(
  left: OpenViewValue | undefined,
  operator: FilterOperator,
  right: string,
): boolean {
  const source = String(left ?? "");
  const a = source.toLocaleLowerCase();
  const b = right.toLocaleLowerCase();
  if (operator === "contains") return a.includes(b);
  if (operator === "equals") return a === b;
  if (operator === "not-equals") return a !== b;
  if (operator === "starts-with") return a.startsWith(b);
  if (operator === "ends-with") return a.endsWith(b);
  if (operator === "on-or-after") return source >= right;
  if (operator === "on-or-before") return source <= right;
  if (operator === "is-empty") return source.trim() === "";
  return source.trim() !== "";
}

export function filterRows(
  rows: OpenViewRow[],
  filters: FilterGroup,
): OpenViewRow[] {
  const clauses = filters.clauses.slice(0, 8);
  if (!clauses.length) return rows;
  return rows.filter((row) =>
    filters.logic === "and"
      ? clauses.every((clause) =>
          compareValue(row.values[clause.field], clause.operator, clause.value),
        )
      : clauses.some((clause) =>
          compareValue(row.values[clause.field], clause.operator, clause.value),
        ),
  );
}

export function sortRows(
  rows: OpenViewRow[],
  sorts: SortRule[],
): OpenViewRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      for (const sort of sorts.slice(0, 3)) {
        const leftValue = String(left.row.values[sort.field] ?? "");
        const rightValue = String(right.row.values[sort.field] ?? "");
        const statusOrder = [
          "Open",
          "Scheduled",
          "On hold",
          "In progress",
          "Completed",
        ];
        const result =
          sort.field === "status" &&
          statusOrder.includes(leftValue) &&
          statusOrder.includes(rightValue)
            ? statusOrder.indexOf(leftValue) - statusOrder.indexOf(rightValue)
            : leftValue.localeCompare(rightValue, undefined, { numeric: true });
        if (result) return sort.direction === "asc" ? result : -result;
      }
      return left.index - right.index;
    })
    .map(({ row }) => row);
}

export function groupRows(
  rows: OpenViewRow[],
  field: string | null,
): { label: string; rows: OpenViewRow[] }[] {
  if (!field) return [{ label: "All records", rows }];
  const groups = new Map<string, OpenViewRow[]>();
  for (const row of rows) {
    const label = String(row.values[field] ?? "Unspecified");
    const groupedRows = groups.get(label);
    if (groupedRows) groupedRows.push(row);
    else groups.set(label, [row]);
  }
  return [...groups].map(([label, groupedRows]) => ({
    label,
    rows: groupedRows,
  }));
}

export function selectRows(
  rows: OpenViewRow[],
  config: ViewConfig,
): OpenViewRow[] {
  const searched = config.search.trim()
    ? rows.filter((row) =>
        Object.values(row.values).some((value) =>
          String(value)
            .toLocaleLowerCase()
            .includes(config.search.trim().toLocaleLowerCase()),
        ),
      )
    : rows;
  return sortRows(filterRows(searched, config.filters), config.sorts);
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_IN_MS = 24 * 60 * 60 * 1000;
export const OPENVIEW_SAMPLE_SNAPSHOT_DATE = "2026-09-14";
export const OPENVIEW_SAMPLE_TIMEZONE = "Asia/Manila";

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === value ? date : null;
}

export function isOpenViewIsoDate(value: unknown): value is string {
  return parseIsoDate(value) !== null;
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Applies the selected calendar/timeline window to dated rows. The sample
 * workspace uses a fixed snapshot date so visual urgency does not move with
 * the local clock. Rows without a valid date remain visible as unscheduled.
 */
export function filterRowsByDateRange(
  rows: OpenViewRow[],
  dateField: string | undefined,
  dateRange: ViewLayout["dateRange"],
  anchor: string | OpenViewRow[] = OPENVIEW_SAMPLE_SNAPSHOT_DATE,
): OpenViewRow[] {
  if (!dateField) return rows;
  // Keep accepting the old fourth argument shape while ignoring its row
  // contents. The row collection was previously used as a moving anchor;
  // deterministic OpenView windows must never shift with filtered data.
  const anchorDate =
    parseIsoDate(typeof anchor === "string" ? anchor : "") ??
    parseIsoDate(OPENVIEW_SAMPLE_SNAPSHOT_DATE);
  if (!anchorDate) return rows;

  const year = anchorDate.getUTCFullYear();
  const month = anchorDate.getUTCMonth();
  let start: Date;
  let end: Date;
  if (dateRange === "week") {
    start = new Date(anchorDate.getTime() - 6 * DAY_IN_MS);
    end = anchorDate;
  } else if (dateRange === "quarter") {
    const quarterStartMonth = Math.floor(month / 3) * 3;
    start = new Date(Date.UTC(year, quarterStartMonth, 1));
    end = new Date(Date.UTC(year, quarterStartMonth + 3, 0));
  } else if (dateRange === "year") {
    start = new Date(Date.UTC(year, 0, 1));
    end = new Date(Date.UTC(year, 12, 0));
  } else {
    start = new Date(Date.UTC(year, month, 1));
    end = new Date(Date.UTC(year, month + 1, 0));
  }
  const startValue = formatIsoDate(start);
  const endValue = formatIsoDate(end);
  return rows.filter((row) => {
    const value = parseIsoDate(row.values[dateField]);
    if (!value) return true;
    const dateValue = formatIsoDate(value);
    return dateValue >= startValue && dateValue <= endValue;
  });
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function isSafeStoredIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifierPattern.test(value);
}

function firstStableIdWins<T extends { id: string }>(entries: T[]): T[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

function safeIdentifier(value: string | null): string | undefined {
  return isSafeStoredIdentifier(value) ? value : undefined;
}
export type OpenViewUrlState = {
  section?: OpenViewSection;
  module?: OpenViewModuleId;
  view?: string;
  dashboard?: string;
  record?: string;
  invalid?: boolean;
};

export function parseOpenViewUrl(
  raw: string,
): Required<Pick<OpenViewUrlState, "section" | "module">> &
  Omit<OpenViewUrlState, "section" | "module"> {
  const url = new URL(raw, "https://openslate.local/openview");
  const sectionValue = url.searchParams.get("section");
  const moduleValue = url.searchParams.get("module");
  const recordValue = url.searchParams.get("record");
  const viewValue = url.searchParams.get("view");
  const dashboardValue = url.searchParams.get("dashboard");
  let invalid = false;
  if (
    sectionValue &&
    !OPENVIEW_SECTIONS.includes(sectionValue as OpenViewSection)
  )
    invalid = true;
  if (
    moduleValue &&
    !OPENVIEW_MODULE_IDS.includes(moduleValue as OpenViewModuleId)
  )
    invalid = true;
  for (const value of [recordValue, viewValue, dashboardValue])
    if (value && !safeIdentifier(value)) invalid = true;
  const record = safeIdentifier(recordValue);
  const result: ReturnType<typeof parseOpenViewUrl> = {
    section: record
      ? "views"
      : OPENVIEW_SECTIONS.includes(sectionValue as OpenViewSection)
        ? (sectionValue as OpenViewSection)
        : "views",
    module:
      record && !moduleValue
        ? "service-requests"
        : OPENVIEW_MODULE_IDS.includes(moduleValue as OpenViewModuleId)
          ? (moduleValue as OpenViewModuleId)
          : "service-requests",
    invalid,
  };
  const view = safeIdentifier(viewValue);
  const dashboard = safeIdentifier(dashboardValue);
  if (record) result.record = record;
  if (view) result.view = view;
  if (dashboard) result.dashboard = dashboard;
  return result;
}

export function serializeOpenViewUrl(state: OpenViewUrlState): string {
  const parameters = new URLSearchParams();
  if (state.record && !safeIdentifier(state.record)) return "/openview";
  if (state.view && !safeIdentifier(state.view)) return "/openview";
  if (state.dashboard && !safeIdentifier(state.dashboard)) return "/openview";
  if (state.section && OPENVIEW_SECTIONS.includes(state.section))
    parameters.set("section", state.section);
  if (state.module && OPENVIEW_MODULE_IDS.includes(state.module))
    parameters.set("module", state.module);
  if (state.view) parameters.set("view", state.view);
  if (state.dashboard) parameters.set("dashboard", state.dashboard);
  if (state.record) parameters.set("record", state.record);
  const query = parameters.toString();
  return query ? `/openview?${query}` : "/openview";
}

export function serializeOpenViewCsv(
  rows: OpenViewRow[],
  fields: string[],
): string {
  return serializeCsv([
    fields,
    ...rows.map((row) => fields.map((field) => row.values[field])),
  ]);
}

function slug(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function stableTextHash(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return (hash >>> 0).toString(36);
}

function legacyReportId(name: string): string {
  const hash = stableTextHash(name);
  const readable = slug(name) || "untitled";
  return `legacy-report-${readable.slice(0, 128 - hash.length - 15)}-${hash}`;
}

export function safeOpenViewFilename(
  name: string,
  extension: "csv" | "pdf",
): string {
  const leaf =
    name
      .split(/[\\/]/)
      .filter((part) => part && part !== "..")
      .at(-1) ?? "";
  return `${slug(leaf) || "openslate-openview"}.${extension}`;
}
