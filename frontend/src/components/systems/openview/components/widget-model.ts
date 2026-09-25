import type { SampleRecord } from "../../shared/data/sample-data";
import { normalizeFilterGroup } from "../helpers/filter-helpers";
import {
  OPENVIEW_MODULE_IDS,
  getModuleDefinition,
  getOpenViewRows,
  type AudienceLookup,
  type AudienceRef,
  type FilterGroup,
  type OpenViewModuleId,
  type OpenViewRow,
  type OpenViewWidget,
} from "../domain/model";

/**
 * Boards predates the typed OpenView model and stores these six fields in its
 * local sample snapshot. Keep that shape exported while this surface works
 * with OpenViewWidget values internally. New widgets include both
 * representations, so a Board and a dashboard can share one widget without
 * breaking Access' legacy federation projection.
 */
export type SampleWidget = {
  id: string;
  type: string;
  size: string;
  permission: string;
  refresh: string;
  pinned: boolean;
  name?: string;
  moduleId?: OpenViewModuleId;
  audience?: AudienceRef;
  fields?: string[];
  filters?: FilterGroup;
  metric?: string;
  visualization?: OpenViewWidget["visualization"];
};

export type WidgetInput = SampleWidget | OpenViewWidget;
export type RowsByModule = Partial<Record<OpenViewModuleId, OpenViewRow[]>>;

export function normalizeWidgetType(value: string): OpenViewWidget["type"] {
  const normalized = value.toLocaleLowerCase();
  if (normalized === "workload") return "workload";
  if (normalized === "openview" || normalized === "records") return "records";
  if (normalized === "chart") return "chart";
  return "summary";
}

export function defaultWidgetName(type: OpenViewWidget["type"]): string {
  if (type === "workload") return "Team workload";
  if (type === "records") return "OpenView records";
  if (type === "chart") return "Operations chart";
  return "Request summary";
}

export function widgetTypeLabel(type: OpenViewWidget["type"]): string {
  if (type === "records") return "Records";
  return type[0].toLocaleUpperCase() + type.slice(1);
}

export function refreshLabel(refresh: OpenViewWidget["refresh"]): string {
  if (refresh === "one-minute") return "Every minute";
  if (refresh === "five-minutes") return "Every 5 minutes";
  return "Manual";
}

export function normalizeRefresh(value: unknown): OpenViewWidget["refresh"] {
  if (value === "one-minute" || value === "Every minute") return "one-minute";
  if (value === "five-minutes" || value === "Every 5 minutes") {
    return "five-minutes";
  }
  return "manual";
}

export function isCanonicalWidget(
  widget: WidgetInput,
): widget is OpenViewWidget {
  return (
    !("permission" in widget) &&
    "moduleId" in widget &&
    typeof widget.moduleId === "string" &&
    "audience" in widget &&
    widget.audience !== undefined
  );
}

export function normalizeWidget(
  source: WidgetInput,
  fallbackModule: OpenViewModuleId | undefined,
  lookup: AudienceLookup,
): OpenViewWidget {
  const moduleId = isModuleId(source.moduleId)
    ? source.moduleId
    : (fallbackModule ?? "service-requests");
  const moduleDefinition = getModuleDefinition(moduleId);
  const allowed = new Set(moduleDefinition.fields.map((field) => field.id));
  const fields = Array.isArray(source.fields)
    ? source.fields.filter((field) => allowed.has(field))
    : [];
  const filters = normalizeFilterGroup(source.filters, moduleDefinition);
  const legacyPermission =
    "permission" in source && typeof source.permission === "string"
      ? source.permission
      : undefined;
  const audience =
    source.audience ??
    audienceFromLegacy(
      legacyPermission,
      lookup.roles ?? [],
      lookup.identities ?? [],
    );
  return {
    id: source.id,
    name:
      typeof source.name === "string" && source.name.trim()
        ? source.name.slice(0, 80)
        : defaultWidgetName(normalizeWidgetType(source.type)),
    type: normalizeWidgetType(source.type),
    moduleId,
    size: source.size === "full" || source.size === "Full" ? "full" : "half",
    audience,
    refresh: normalizeRefresh(source.refresh),
    pinned: source.pinned === true,
    fields: fields.length
      ? fields
      : moduleDefinition.fields.slice(0, 3).map((field) => field.id),
    filters,
    metric:
      typeof source.metric === "string" &&
      (source.metric === "count" || allowed.has(source.metric))
        ? source.metric
        : "count",
    visualization:
      source.visualization === "line" || source.visualization === "pie"
        ? source.visualization
        : "bar",
  };
}

export function prepareModuleChange(
  widget: OpenViewWidget,
  moduleId: OpenViewModuleId,
): OpenViewWidget {
  if (widget.moduleId === moduleId) return widget;
  const moduleDefinition = getModuleDefinition(moduleId);
  return {
    ...widget,
    moduleId,
    fields: moduleDefinition.fields.slice(0, 3).map((field) => field.id),
    filters: { logic: widget.filters.logic, clauses: [] },
    metric: "count",
  };
}

export function writeWidget(
  source: WidgetInput,
  widget: OpenViewWidget,
  lookup: AudienceLookup,
): WidgetInput {
  if (isCanonicalWidget(source)) {
    const permission =
      "permission" in source && typeof source.permission === "string"
        ? audienceToLegacy(widget.audience, lookup)
        : undefined;
    return permission
      ? ({ ...widget, permission } as OpenViewWidget & SampleWidget)
      : widget;
  }
  return {
    ...source,
    id: widget.id,
    name: widget.name,
    moduleId: widget.moduleId,
    audience: widget.audience,
    fields: [...widget.fields],
    filters: {
      logic: widget.filters.logic,
      clauses: widget.filters.clauses.map((clause) => ({ ...clause })),
    },
    metric: widget.metric,
    visualization: widget.visualization,
    size: widget.size === "full" ? "Full" : "Half",
    permission: audienceToLegacy(widget.audience, lookup),
    refresh: refreshLabel(widget.refresh),
    pinned: widget.pinned,
  };
}

export function isModuleId(value: unknown): value is OpenViewModuleId {
  return (
    typeof value === "string" &&
    OPENVIEW_MODULE_IDS.includes(value as OpenViewModuleId)
  );
}

export function audienceKey(audience: AudienceRef): string {
  if (audience.kind === "private" || audience.kind === "everyone") {
    return audience.kind;
  }
  return `${audience.kind}:${audience.id}`;
}

export function audienceFromKey(
  value: string,
  roles: { id: string; name: string }[],
  people: { id: string; name: string }[],
): AudienceRef {
  if (value === "everyone") return { kind: "everyone" };
  if (
    value.startsWith("role:") &&
    roles.some((role) => role.id === value.slice(5))
  ) {
    return { kind: "role", id: value.slice(5) };
  }
  if (
    value.startsWith("identity:") &&
    people.some((person) => person.id === value.slice(9))
  ) {
    return { kind: "identity", id: value.slice(9) };
  }
  return { kind: "private" };
}

export function audienceFromLegacy(
  value: string | undefined,
  roles: { id: string; name: string }[],
  people: { id: string; name: string }[],
): AudienceRef {
  if (value === "Everyone") return { kind: "everyone" };
  if (!value || value === "Only me" || value === "Private") {
    return { kind: "private" };
  }
  const roleName = value.startsWith("Role: ") ? value.slice(6) : value;
  const role = roles.find((candidate) => candidate.name === roleName);
  if (role) return { kind: "role", id: role.id };
  const personName = value.startsWith("User: ") ? value.slice(6) : value;
  const person = people.find((candidate) => candidate.name === personName);
  return person ? { kind: "identity", id: person.id } : { kind: "private" };
}

export function audienceToLegacy(
  audience: AudienceRef,
  lookup: AudienceLookup,
): string {
  if (audience.kind === "everyone") return "Everyone";
  if (audience.kind === "role") {
    return `Role: ${lookup.roles?.find((role) => role.id === audience.id)?.name ?? "Unresolved"}`;
  }
  if (audience.kind === "identity") {
    return `User: ${lookup.identities?.find((person) => person.id === audience.id)?.name ?? "Unresolved"}`;
  }
  return "Only me";
}

export function formatValue(
  value: OpenViewRow["values"][string] | undefined,
): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return value === undefined || value === null ? "" : String(value);
}

export function formatOperationalDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function operationalTimingLabel(state: string): string {
  if (state === "blocked") return "Blocked";
  if (state === "overdue") return "Overdue";
  if (state === "late-plan") return "Planned after deadline";
  if (state === "due-soon") return "Due soon";
  if (state === "unscheduled") return "Missing dates";
  return "On track";
}

export function operationalTimingVariant(state: string) {
  if (state === "overdue") return "destructive" as const;
  if (state === "blocked" || state === "late-plan" || state === "due-soon") {
    return "warning" as const;
  }
  if (state === "on-track") return "success" as const;
  return "outline" as const;
}

export function numberValue(
  value: OpenViewRow["values"][string] | undefined,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown time" : date.toLocaleString();
}
export function chooseDimension(widget: OpenViewWidget) {
  const moduleDefinition = getModuleDefinition(widget.moduleId);
  const candidate = widget.fields.find((field) =>
    moduleDefinition.fields.some((definition) => definition.id === field),
  );
  const fieldId = candidate ?? moduleDefinition.primaryField;
  return (
    moduleDefinition.fields.find((field) => field.id === fieldId) ??
    moduleDefinition.fields[0]!
  );
}

export function chooseWorkloadDimension(
  widget: OpenViewWidget,
  rows: OpenViewRow[],
) {
  const moduleDefinition = getModuleDefinition(widget.moduleId);
  const preferred = ["assignee", "status", "location", "city"];
  const fieldId =
    preferred.find(
      (candidate) =>
        moduleDefinition.fields.some((field) => field.id === candidate) &&
        rows.some((row) => row.values[candidate] !== undefined),
    ) ?? chooseDimension(widget).id;
  return (
    moduleDefinition.fields.find((field) => field.id === fieldId) ??
    moduleDefinition.fields[0]!
  );
}

export function summarizeRows(
  rows: OpenViewRow[],
  dimension: { id: string },
  metric: string,
) {
  const groups = new Map<string, number>();
  for (const row of rows) {
    const label = formatValue(row.values[dimension.id]) || "Unspecified";
    const value = metric === "count" ? 1 : numberValue(row.values[metric]);
    groups.set(label, (groups.get(label) ?? 0) + value);
  }
  return [...groups.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort(
      (left, right) =>
        right.value - left.value || left.label.localeCompare(right.label),
    );
}

export function resolveRows(
  moduleId: OpenViewModuleId,
  props: {
    records: SampleRecord[];
    rows?: OpenViewRow[];
    rowsByModule?: RowsByModule;
  },
) {
  const fromMap = props.rowsByModule?.[moduleId];
  if (fromMap) return fromMap;
  if (
    props.rows &&
    (props.rows.length === 0 ||
      props.rows.some((row) => row.moduleId === moduleId))
  ) {
    return props.rows.filter((row) => row.moduleId === moduleId);
  }
  return getOpenViewRows(moduleId, props.records);
}
