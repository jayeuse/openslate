import { z } from "zod";
import type { Report } from "../domain/seeds";
import {
  OPENVIEW_MODULE_IDS,
  audienceLabel,
  decodeAudienceRef,
  decodeDashboardWidgets,
  decodeDashboards,
  decodeReport,
  filterRows,
  getModuleDefinition,
  isOpenViewIsoDate,
  normalizeChartSettings,
  type AudienceLookup,
  type AudienceRef,
  type ChartSettings,
  type FilterGroup,
  type FilterOperator,
  type OpenViewModuleId,
  type OpenViewRow,
  type OpenViewWidget,
  type RefreshCadence,
  type Report as OpenViewReport,
  type Dashboard as OpenViewDashboard,
} from "../domain/model";
import { OPENVIEW_SAMPLE_SNAPSHOT_DATE } from "../helpers/operations";

const legacyReportSchema = z.object({
  id: z.string().optional(),
  name: z.string().max(160),
  subtitle: z.string().max(240).optional(),
  moduleId: z.enum(OPENVIEW_MODULE_IDS).optional(),
  fields: z.array(z.string()).max(24),
  grouping: z.string().max(80),
  totals: z.boolean(),
  schedule: z.string().max(160),
  audience: z.string().max(160),
  filters: z.unknown().optional(),
  sorts: z.unknown().optional(),
});

function isAudienceRef(value: unknown): value is AudienceRef {
  if (typeof value !== "object" || value === null || !("kind" in value))
    return false;
  if (value.kind === "private" || value.kind === "everyone") return true;
  return (
    (value.kind === "role" || value.kind === "identity") &&
    "id" in value &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 128
  );
}

export function normalizeReports(raw: unknown): Report[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    const parsed = legacyReportSchema.safeParse(value);
    if (parsed.success) return [parsed.data];
    if (
      typeof value !== "object" ||
      value === null ||
      !("name" in value) ||
      typeof value.name !== "string"
    )
      return [];
    const report = decodeReport(value);
    const audience = isAudienceRef(value.audience)
      ? value.audience
      : report.audience;
    return [toLegacyReport({ ...report, audience })];
  });
}

const cadenceLabels: Record<RefreshCadence, string> = {
  manual: "Manual",
  "one-minute": "Every minute",
  "five-minutes": "Every 5 minutes",
};
export const scheduleLabels: Record<
  OpenViewReport["schedule"]["cadence"],
  string
> = {
  manual: "Manual",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

const analyticsFilterOperatorLabels: Record<FilterOperator, string> = {
  contains: "contains",
  equals: "equals",
  "not-equals": "does not equal",
  "starts-with": "starts with",
  "ends-with": "ends with",
  "on-or-after": "on or after",
  "on-or-before": "on or before",
  "is-empty": "is empty",
  "is-not-empty": "is not empty",
};

export function analyticsFilterOperatorLabel(operator: FilterOperator): string {
  return analyticsFilterOperatorLabels[operator];
}
export function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function audienceValue(audience: AudienceRef): string {
  if (audience.kind === "private") return "private";
  if (audience.kind === "everyone") return "everyone";
  return `${audience.kind}:${audience.id}`;
}

export function parseAudienceValue(value: string): AudienceRef {
  if (value === "everyone") return { kind: "everyone" };
  if (value === "private") return { kind: "private" };
  if (value.startsWith("role:")) return { kind: "role", id: value.slice(5) };
  if (value.startsWith("identity:"))
    return { kind: "identity", id: value.slice(9) };
  return { kind: "private" };
}

export function refreshValue(refresh: RefreshCadence): string {
  return refresh;
}

export function refreshFromValue(value: string): RefreshCadence {
  return value === "one-minute" || value === "five-minutes" ? value : "manual";
}

export function refreshLabel(refresh: RefreshCadence): string {
  return cadenceLabels[refresh];
}

export function scheduleLabel(schedule: OpenViewReport["schedule"]): string {
  if (schedule.cadence === "manual") return "Manual";
  if (schedule.cadence === "daily") return "Daily at 09:00";
  if (schedule.cadence === "weekly") return "Weekly on Monday at 09:00";
  return "Monthly on the 1st at 09:00";
}

export function scheduleFromValue(value: unknown): OpenViewReport["schedule"] {
  if (typeof value === "object" && value !== null && "cadence" in value) {
    const candidate = value as { cadence?: unknown; timezone?: unknown };
    const cadence =
      candidate.cadence === "daily" ||
      candidate.cadence === "weekly" ||
      candidate.cadence === "monthly"
        ? candidate.cadence
        : "manual";
    return {
      cadence,
      timezone:
        typeof candidate.timezone === "string"
          ? candidate.timezone
          : "Asia/Manila",
    };
  }
  if (value === "Daily at 09:00")
    return { cadence: "daily", timezone: "Asia/Manila" };
  if (value === "Weekly on Monday at 09:00")
    return { cadence: "weekly", timezone: "Asia/Manila" };
  if (value === "Monthly on the 1st at 09:00")
    return { cadence: "monthly", timezone: "Asia/Manila" };
  return { cadence: "manual", timezone: "Asia/Manila" };
}

export function fieldLabel(
  moduleId: OpenViewModuleId,
  fieldId: string,
): string {
  return (
    getModuleDefinition(moduleId).fields.find((field) => field.id === fieldId)
      ?.label ?? fieldId
  );
}

export function formatSampleSnapshotDate(
  value = OPENVIEW_SAMPLE_SNAPSHOT_DATE,
): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function valueFor(row: OpenViewRow, fieldId: string): string {
  return String(row.values[fieldId] ?? "");
}

export function toLegacyReport(
  report: OpenViewReport,
  lookup: AudienceLookup = {},
): Report {
  return {
    id: report.id,
    name: report.name,
    subtitle: report.subtitle,
    moduleId: report.moduleId,
    fields: [...report.fields],
    grouping: report.grouping ?? "None",
    totals: report.totals,
    schedule: scheduleLabel(report.schedule),
    audience: clone(report.audience),
    audienceLabel: audienceLabel(report.audience, lookup),
    permission: audienceLabel(report.audience, lookup),
    filters: clone(report.filters),
    sorts: clone(report.sorts),
  };
}

function rawRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function normalizeDashboards(
  raw: unknown,
  lookup: AudienceLookup,
): OpenViewDashboard[] {
  const entries = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  return entries.flatMap((entry) => {
    const dashboard = decodeDashboards([entry], lookup)[0];
    if (!dashboard) return [];
    if (seen.has(dashboard.id)) return [];
    seen.add(dashboard.id);
    const source = rawRecord(entry);
    const sourceWidgets = Array.isArray(source?.widgets) ? source.widgets : [];
    // Decode the complete widget slice once. Decoding each widget through a
    // one-item dashboard would lose the decoder's first-valid-ID guarantee
    // when this normalization rebuilds the dashboard.
    const widgets = decodeDashboardWidgets(sourceWidgets, lookup);
    return [
      {
        ...dashboard,
        widgets,
      },
    ];
  });
}

export function normalizeReportRecord(
  raw: unknown,
  lookup: AudienceLookup,
): OpenViewReport {
  const report = decodeReport(raw, lookup);
  const source = rawRecord(raw);
  return {
    ...report,
    audience: decodeAudienceRef(source?.audience, lookup),
    schedule: scheduleFromValue(source?.schedule ?? report.schedule),
  };
}

export function normalizeReportTemplates(
  raw: unknown,
  lookup: AudienceLookup,
): OpenViewReport[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.flatMap((entry) => {
    const source = rawRecord(entry);
    if (!source?.name || typeof source.name !== "string") return [];
    const report = normalizeReportRecord(entry, lookup);
    if (seen.has(report.id)) return [];
    seen.add(report.id);
    return [report];
  });
}

export function emptyFilters(): FilterGroup {
  return { logic: "and", clauses: [] };
}

export function defaultWidget(
  type: OpenViewWidget["type"],
  moduleId: OpenViewModuleId,
): OpenViewWidget {
  const moduleDefinition = getModuleDefinition(moduleId);
  return {
    id: makeId("sample-widget"),
    name:
      type === "summary"
        ? `${moduleDefinition.name} summary`
        : type === "workload"
          ? `${moduleDefinition.name} workload`
          : type === "records"
            ? `${moduleDefinition.name} records`
            : `${moduleDefinition.name} chart`,
    type,
    moduleId,
    size: type === "summary" ? "full" : "half",
    audience: { kind: "private" },
    refresh: "manual",
    pinned: false,
    fields: moduleDefinition.fields.slice(0, 3).map((field) => field.id),
    filters: emptyFilters(),
    metric: "count",
    visualization: "bar",
  };
}

export function defaultDashboard(name = "New dashboard"): OpenViewDashboard {
  return {
    id: makeId("sample-dashboard"),
    name,
    audience: { kind: "private" },
    refresh: "manual",
    widgets: [],
  };
}

export function isNumericChartMetric(
  moduleId: OpenViewModuleId,
  metric: string,
): boolean {
  return getModuleDefinition(moduleId).fields.some(
    (field) => field.id === metric && field.type === "number",
  );
}

export function chartAggregationOptions(
  moduleId: OpenViewModuleId,
  metric: string,
): { value: ChartSettings["aggregation"]; label: string }[] {
  if (metric === "count" || !isNumericChartMetric(moduleId, metric))
    return [{ value: "count", label: "Count" }];
  return [
    { value: "sum", label: "Sum" },
    { value: "average", label: "Average" },
  ];
}

export type ChartDatum = { label: string; value: number; key: string };

function chartGroupKey(
  moduleId: OpenViewModuleId,
  dimension: string,
  rows: OpenViewRow[],
): string {
  const fingerprint = `${moduleId}\u0000${dimension}\u0000${rows
    .map((row) => row.id)
    .sort()
    .join("\u001f")}`;
  let hash = 2166136261;
  for (const character of fingerprint) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return `chart-group-${(hash >>> 0).toString(36)}`;
}

export function chartRows(
  settings: ChartSettings,
  rows: OpenViewRow[],
): { rows: OpenViewRow[]; data: ChartDatum[] } {
  const normalizedSettings = normalizeChartSettings(settings);
  const dateField = normalizedSettings.dateField;
  const selected = filterRows(rows, normalizedSettings.filters).filter(
    (row) => {
      if (!dateField) return true;
      if (!normalizedSettings.from && !normalizedSettings.to) return true;
      const date = valueFor(row, dateField);
      if (!isOpenViewIsoDate(date)) return false;
      return (
        (!normalizedSettings.from || date >= normalizedSettings.from) &&
        (!normalizedSettings.to || date <= normalizedSettings.to)
      );
    },
  );
  const groups = new Map<string, OpenViewRow[]>();
  selected.forEach((row) => {
    const label = valueFor(row, normalizedSettings.dimension) || "Unspecified";
    const group = groups.get(label);
    if (group) group.push(row);
    else groups.set(label, [row]);
  });
  const sortedGroups = [...groups.entries()]
    .map(([label, group]) => {
      const values =
        normalizedSettings.metric === "count"
          ? []
          : group
              .flatMap((row) => {
                const rawValue = row.values[normalizedSettings.metric];
                if (
                  rawValue === undefined ||
                  rawValue === null ||
                  (typeof rawValue === "string" && rawValue.trim() === "")
                )
                  return [];
                return [Number(rawValue)];
              })
              .filter((value) => Number.isFinite(value));
      const sum = values.reduce((total, value) => total + value, 0);
      const value =
        normalizedSettings.aggregation === "count"
          ? group.length
          : normalizedSettings.aggregation === "sum"
            ? sum
            : values.length
              ? sum / values.length
              : 0;
      return {
        label,
        value,
        group,
        fingerprint: group
          .map((row) => row.id)
          .sort()
          .join("\u001f"),
      };
    })
    .sort(
      (left, right) =>
        right.value - left.value ||
        left.fingerprint.localeCompare(right.fingerprint),
    )
    .slice(0, normalizedSettings.limit);
  const usedKeys = new Set<string>();
  const data = sortedGroups.map((item) => {
    const baseKey = chartGroupKey(
      normalizedSettings.moduleId,
      normalizedSettings.dimension,
      item.group,
    );
    let key = baseKey;
    let collision = 1;
    while (usedKeys.has(key)) key = `${baseKey}-${collision++}`;
    usedKeys.add(key);
    return { label: item.label, value: item.value, key };
  });
  return { rows: selected, data };
}
