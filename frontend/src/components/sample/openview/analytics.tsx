"use client";

import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  CalendarClock,
  Copy,
  Download,
  FileBarChart,
  FileText,
  LineChart as LineChartIcon,
  Plus,
  PieChart as PieChartIcon,
  Printer,
  RotateCcw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  Fragment,
  type ReactNode,
} from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import { z } from "zod";
import { Alert } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  ChartContainer,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import { useSampleState } from "@/components/sample/sample-state";
import type { SampleRecord } from "@/components/sample/sample-data";
import {
  initialPeople,
  initialRoles,
  type Person,
  type Role,
} from "../access/model";
import { WidgetSurface, type SampleWidget } from "./widgets";
import {
  FILTER_OPERATORS,
  INITIAL_CHART_SETTINGS,
  INITIAL_DASHBOARDS,
  OPENVIEW_MODULE_IDS,
  OPENVIEW_MODULES,
  audienceLabel,
  decodeAudienceRef,
  decodeChartSettings,
  decodeDashboardWidgets,
  decodeDashboards,
  decodeReport,
  defaultChartSettings,
  filterRows,
  getModuleDefinition,
  getOpenViewOperationalDeadlineField,
  getOpenViewRows,
  groupRows,
  isUnresolvedAudience,
  normalizeChartSettings,
  safeOpenViewFilename,
  serializeOpenViewCsv,
  sortRows,
  type AudienceLookup,
  type AudienceRef,
  type ChartSettings,
  type FilterClause,
  type FilterGroup,
  type FilterOperator,
  type OpenViewField,
  type OpenViewModule,
  type OpenViewModuleId,
  type OpenViewRow,
  type OpenViewWidget,
  type RefreshCadence,
  type Report as OpenViewReport,
  type SortRule,
  type Dashboard as OpenViewDashboard,
} from "./model";
import {
  OPENVIEW_SAMPLE_SNAPSHOT_DATE,
  OPENVIEW_SAMPLE_TIMEZONE,
} from "./operations";

/*
 * Access still consumes the original sample-workspace shapes. These exports
 * intentionally remain compatible adapters; OpenView itself uses the typed
 * model records below and writes legacy-compatible owner slices.
 */
export type Dashboard = {
  id: string;
  name: string;
  permission?: string;
  audience?: AudienceRef;
  refresh: string;
  widgets: Array<Omit<SampleWidget, "permission"> & { permission?: string }>;
};

export type Report = {
  id?: string;
  name: string;
  subtitle?: string;
  moduleId?: OpenViewModuleId;
  fields: string[];
  grouping: string | null;
  totals: boolean;
  schedule: string;
  audience: string | AudienceRef;
  audienceLabel?: string;
  permission?: string;
  filters?: unknown;
  sorts?: unknown;
};

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

export const initialReport: Report = {
  name: "Weekly service review",
  fields: ["title", "status", "assignee"],
  grouping: "status",
  totals: true,
  schedule: "Manual",
  audience: { kind: "private" },
  audienceLabel: "Only me",
  permission: "Only me",
};

export const initialDashboards: Dashboard[] = [
  {
    id: "sample-dashboard-operations",
    name: "Operations pulse",
    permission: "Everyone",
    audience: { kind: "everyone" },
    refresh: "Manual",
    widgets: [
      {
        id: "sample-widget-summary",
        type: "Summary",
        size: "Full",
        permission: "Everyone",
        refresh: "Manual",
        pinned: false,
      },
      {
        id: "sample-widget-workload",
        type: "Workload",
        size: "Half",
        permission: "Everyone",
        refresh: "Manual",
        pinned: false,
      },
    ],
  },
];

export const initialReportTemplates: Report[] = [];

const cadenceLabels: Record<RefreshCadence, string> = {
  manual: "Manual",
  "one-minute": "Every minute",
  "five-minutes": "Every 5 minutes",
};
const scheduleLabels: Record<OpenViewReport["schedule"]["cadence"], string> = {
  manual: "Manual",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};
const operatorLabels: Record<FilterOperator, string> = {
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

function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function lookupFor(roles: Role[], people: Person[]): AudienceLookup {
  return {
    roles: roles.map(({ id, name }) => ({ id, name })),
    identities: people.map(({ id, name }) => ({ id, name })),
  };
}

function audienceValue(audience: AudienceRef): string {
  if (audience.kind === "private") return "private";
  if (audience.kind === "everyone") return "everyone";
  return `${audience.kind}:${audience.id}`;
}

function parseAudienceValue(value: string): AudienceRef {
  if (value === "everyone") return { kind: "everyone" };
  if (value === "private") return { kind: "private" };
  if (value.startsWith("role:")) return { kind: "role", id: value.slice(5) };
  if (value.startsWith("identity:"))
    return { kind: "identity", id: value.slice(9) };
  return { kind: "private" };
}

function refreshValue(refresh: RefreshCadence): string {
  return refresh;
}

function refreshFromValue(value: string): RefreshCadence {
  return value === "one-minute" || value === "five-minutes" ? value : "manual";
}

function refreshLabel(refresh: RefreshCadence): string {
  return cadenceLabels[refresh];
}

function scheduleLabel(schedule: OpenViewReport["schedule"]): string {
  if (schedule.cadence === "manual") return "Manual";
  if (schedule.cadence === "daily") return "Daily at 09:00";
  if (schedule.cadence === "weekly") return "Weekly on Monday at 09:00";
  return "Monthly on the 1st at 09:00";
}

function scheduleFromValue(value: unknown): OpenViewReport["schedule"] {
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

function fieldLabel(moduleId: OpenViewModuleId, fieldId: string): string {
  return (
    getModuleDefinition(moduleId).fields.find((field) => field.id === fieldId)
      ?.label ?? fieldId
  );
}

function fieldFor(
  moduleId: OpenViewModuleId,
  fieldId: string,
): OpenViewField | undefined {
  return getModuleDefinition(moduleId).fields.find(
    (field) => field.id === fieldId,
  );
}

function formatSampleSnapshotDate(
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

function fieldValues(rows: OpenViewRow[], fieldId: string): string[] {
  return [
    ...new Set(
      rows.map((row) => String(row.values[fieldId] ?? "")).filter(Boolean),
    ),
  ].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
}

function valueFor(row: OpenViewRow, fieldId: string): string {
  return String(row.values[fieldId] ?? "");
}

function toLegacyDashboard(
  dashboard: OpenViewDashboard,
  lookup: AudienceLookup,
): Dashboard {
  return {
    id: dashboard.id,
    name: dashboard.name,
    permission: audienceLabel(dashboard.audience, lookup),
    audience: clone(dashboard.audience),
    refresh: refreshLabel(dashboard.refresh),
    widgets: dashboard.widgets.map((widget) => ({
      id: widget.id,
      name: widget.name,
      type:
        widget.type === "summary"
          ? "Summary"
          : widget.type === "workload"
            ? "Workload"
            : widget.type === "chart"
              ? "Chart"
              : "OpenView",
      size: widget.size === "full" ? "Full" : "Half",
      permission: audienceLabel(widget.audience, lookup),
      refresh: refreshLabel(widget.refresh),
      pinned: widget.pinned,
      moduleId: widget.moduleId,
      audience: widget.audience,
      fields: [...widget.fields],
      filters: clone(widget.filters),
      metric: widget.metric,
      visualization: widget.visualization,
    })),
  };
}

function toLegacyReport(
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

function normalizeDashboards(
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

function normalizeReportRecord(
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

function normalizeReportTemplates(
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

function emptyFilters(): FilterGroup {
  return { logic: "and", clauses: [] };
}

function defaultWidget(
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

function defaultDashboard(name = "New dashboard"): OpenViewDashboard {
  return {
    id: makeId("sample-dashboard"),
    name,
    audience: { kind: "private" },
    refresh: "manual",
    widgets: [],
  };
}

function Choice({
  id,
  label,
  value,
  values,
  onChange,
  description,
  disabled = false,
}: {
  id?: string;
  label: string;
  value: string;
  values: { value: string; label: string }[] | string[];
  onChange: (value: string) => void;
  description?: string;
  disabled?: boolean;
}) {
  const options = values.map((item) =>
    typeof item === "string" ? { value: item, label: item } : item,
  );
  const inputId =
    id ?? `openview-choice-${label.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <Field data-disabled={disabled ? true : undefined}>
      <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
      <Select
        id={inputId}
        className="h-11 min-h-11"
        value={value}
        disabled={disabled}
        onValueChange={onChange}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}

function AudienceField({
  id,
  label = "Audience preview",
  audience,
  roles,
  people,
  onChange,
}: {
  id: string;
  label?: string;
  audience: AudienceRef;
  roles: Role[];
  people: Person[];
  onChange: (audience: AudienceRef) => void;
}) {
  const [pending, setPending] = useState<AudienceRef | null>(null);
  const lookup = lookupFor(roles, people);
  const audienceOptions = [
    { value: "private", label: "Only me" },
    { value: "everyone", label: "Everyone" },
    ...roles.map((role) => ({
      value: `role:${role.id}`,
      label: `Role: ${role.name}`,
    })),
    ...people
      .filter((person) => person.active)
      .map((person) => ({
        value: `identity:${person.id}`,
        label: `User: ${person.name}`,
      })),
  ];
  return (
    <>
      <Choice
        id={id}
        label={label}
        value={audienceValue(audience)}
        values={audienceOptions}
        onChange={(value) => {
          const next = parseAudienceValue(value);
          if (next.kind === "everyone" && audience.kind !== "everyone")
            setPending(next);
          else onChange(decodeAudienceRef(next, lookup));
        }}
        description="Sample sharing metadata only; it does not change live access."
      />
      <div className="flex items-center gap-2">
        <Badge
          variant={
            audience.kind === "everyone" || isUnresolvedAudience(audience)
              ? "warning"
              : "secondary"
          }
        >
          {audienceLabel(audience, lookup)}
        </Badge>
        {audience.kind === "everyone" ? (
          <span className="text-muted-foreground text-xs">Preview only</span>
        ) : null}
      </div>
      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Preview sharing with everyone?</AlertDialogTitle>
            <AlertDialogDescription>
              This sample setting demonstrates a wider audience. It does not
              grant access, send invitations, or publish this artifact.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setPending(null)}
            >
              Keep private
            </Button>
            <Button
              className="min-h-11"
              onClick={() => {
                if (pending) onChange(pending);
                setPending(null);
              }}
            >
              Use Everyone preview
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function RefreshField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: RefreshCadence;
  onChange: (value: RefreshCadence) => void;
}) {
  return (
    <Choice
      id={id}
      label="Refresh preview"
      value={refreshValue(value)}
      values={[
        { value: "manual", label: "Manual" },
        { value: "one-minute", label: "Every minute" },
        { value: "five-minutes", label: "Every 5 minutes" },
      ]}
      onChange={(next) => onChange(refreshFromValue(next))}
      description="No background refresh runs in this sample workspace."
    />
  );
}

function FilterEditor({
  moduleId,
  rows,
  filters,
  onChange,
  title = "Filters",
}: {
  moduleId: OpenViewModuleId;
  rows: OpenViewRow[];
  filters: FilterGroup;
  onChange: (filters: FilterGroup) => void;
  title?: string;
}) {
  const moduleDefinition = getModuleDefinition(moduleId);
  const updateClause = (index: number, change: Partial<FilterClause>) => {
    onChange({
      ...filters,
      clauses: filters.clauses.map((clause, clauseIndex) =>
        clauseIndex === index ? { ...clause, ...change } : clause,
      ),
    });
  };
  return (
    <FieldSet>
      <FieldLegend>{title}</FieldLegend>
      <p className="text-muted-foreground text-sm">
        Combine up to eight conditions with AND or OR.
      </p>
      {filters.clauses.length > 0 ? (
        <Choice
          id={`${title.toLowerCase().replaceAll(" ", "-")}-logic`}
          label="Match"
          value={filters.logic}
          values={[
            { value: "and", label: "All conditions (AND)" },
            { value: "or", label: "Any condition (OR)" },
          ]}
          onChange={(logic) =>
            onChange({ ...filters, logic: logic === "or" ? "or" : "and" })
          }
        />
      ) : null}
      <FieldGroup>
        {filters.clauses.map((clause, index) => {
          const field =
            fieldFor(moduleId, clause.field) ?? moduleDefinition.fields[0];
          const valueOptions =
            field?.type === "select" ? fieldValues(rows, clause.field) : [];
          const needsValue =
            clause.operator !== "is-empty" &&
            clause.operator !== "is-not-empty";
          return (
            <div
              key={`${clause.field}-${index}`}
              className="border-border grid gap-3 rounded-[var(--radius)] border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
            >
              <Choice
                id={`filter-field-${index}`}
                label="Field"
                value={clause.field}
                values={moduleDefinition.fields.map((candidate) => ({
                  value: candidate.id,
                  label: candidate.label,
                }))}
                onChange={(fieldId) =>
                  updateClause(index, { field: fieldId, value: "" })
                }
              />
              <Choice
                id={`filter-operator-${index}`}
                label="Condition"
                value={clause.operator}
                values={FILTER_OPERATORS.map((operator) => ({
                  value: operator,
                  label: operatorLabels[operator],
                }))}
                onChange={(operator) =>
                  updateClause(index, { operator: operator as FilterOperator })
                }
              />
              <Field data-disabled={!needsValue}>
                <FieldLabel htmlFor={`filter-value-${index}`}>Value</FieldLabel>
                {field?.type === "select" && needsValue ? (
                  <Select
                    id={`filter-value-${index}`}
                    className="h-11 min-h-11"
                    value={clause.value}
                    onValueChange={(value) => updateClause(index, { value })}
                  >
                    <option value="">Choose a value</option>
                    {valueOptions.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    id={`filter-value-${index}`}
                    className="min-h-11"
                    value={clause.value}
                    disabled={!needsValue}
                    placeholder={needsValue ? "Enter a value" : "Not needed"}
                    onChange={(event) =>
                      updateClause(index, { value: event.target.value })
                    }
                  />
                )}
              </Field>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="min-h-11 min-w-11"
                aria-label={`Remove filter ${index + 1}`}
                onClick={() =>
                  onChange({
                    ...filters,
                    clauses: filters.clauses.filter(
                      (_, clauseIndex) => clauseIndex !== index,
                    ),
                  })
                }
              >
                <X data-icon="inline-start" />
              </Button>
            </div>
          );
        })}
      </FieldGroup>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 self-start"
        disabled={filters.clauses.length >= 8}
        onClick={() =>
          onChange({
            ...filters,
            clauses: [
              ...filters.clauses,
              {
                field: moduleDefinition.fields[0]?.id ?? "",
                operator: "contains",
                value: "",
              },
            ],
          })
        }
      >
        <Plus data-icon="inline-start" />
        Add filter
      </Button>
    </FieldSet>
  );
}

function SortEditor({
  moduleId,
  sorts,
  onChange,
}: {
  moduleId: OpenViewModuleId;
  sorts: SortRule[];
  onChange: (sorts: SortRule[]) => void;
}) {
  const moduleDefinition = getModuleDefinition(moduleId);
  return (
    <FieldSet>
      <FieldLegend>Sort order</FieldLegend>
      <p className="text-muted-foreground text-sm">
        Use up to three ordered sort rules.
      </p>
      <FieldGroup>
        {sorts.map((sort, index) => (
          <div
            key={`${sort.field}-${index}`}
            className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
          >
            <Choice
              id={`sort-field-${index}`}
              label={`Sort ${index + 1} field`}
              value={sort.field}
              values={moduleDefinition.fields.map((field) => ({
                value: field.id,
                label: field.label,
              }))}
              onChange={(field) =>
                onChange(
                  sorts.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, field } : item,
                  ),
                )
              }
            />
            <Choice
              id={`sort-direction-${index}`}
              label="Direction"
              value={sort.direction}
              values={[
                { value: "asc", label: "Ascending" },
                { value: "desc", label: "Descending" },
              ]}
              onChange={(direction) =>
                onChange(
                  sorts.map((item, itemIndex) =>
                    itemIndex === index
                      ? {
                          ...item,
                          direction: direction === "desc" ? "desc" : "asc",
                        }
                      : item,
                  ),
                )
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="min-h-11 min-w-11"
              aria-label={`Remove sort ${index + 1}`}
              onClick={() =>
                onChange(sorts.filter((_, itemIndex) => itemIndex !== index))
              }
            >
              <X data-icon="inline-start" />
            </Button>
          </div>
        ))}
      </FieldGroup>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 self-start"
        disabled={sorts.length >= 3}
        onClick={() =>
          onChange([
            ...sorts,
            { field: moduleDefinition.primaryField, direction: "asc" },
          ])
        }
      >
        <Plus data-icon="inline-start" />
        Add sort
      </Button>
    </FieldSet>
  );
}

function Workbench({
  controls,
  children,
}: {
  controls: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(17rem,20rem)_minmax(0,1fr)]">
      <aside className="bg-card flex h-fit flex-col gap-5 rounded-[var(--radius)] border p-5">
        {controls}
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Dashboards({
  records,
  moduleId = "service-requests",
  dashboardUrlId,
  onDashboardUrlChange,
  onDashboardDirtyChange,
}: {
  records: SampleRecord[];
  moduleId?: OpenViewModuleId;
  dashboardUrlId?: string;
  onDashboardUrlChange?: (id: string | undefined) => void;
  onDashboardDirtyChange?: (dirty: boolean) => void;
}) {
  const [roles] = useSampleState("access-roles", initialRoles);
  const [people] = useSampleState("access-people", initialPeople);
  const lookup = lookupFor(roles, people);
  const [rawDashboards, setRawDashboards] = useSampleState<unknown>(
    "views-dashboards",
    null,
  );
  const [selectedId, setSelectedId] = useSampleState(
    "views-dashboard-selected",
    "",
  );
  const [defaultId, setDefaultId] = useSampleState(
    "views-dashboard-default",
    "",
  );
  const dashboards = useMemo(
    () => normalizeDashboards(rawDashboards ?? initialDashboards, lookup),
    [rawDashboards, lookup.roles, lookup.identities],
  );
  const urlDashboard = dashboardUrlId
    ? dashboards.find((dashboard) => dashboard.id === dashboardUrlId)
    : undefined;
  const storedDashboard = dashboards.find(
    (dashboard) => dashboard.id === selectedId,
  );
  const defaultDashboardRecord = dashboards.find(
    (dashboard) => dashboard.id === defaultId,
  );
  const selected =
    urlDashboard ?? storedDashboard ?? defaultDashboardRecord ?? dashboards[0];
  const unknownUrlDashboard = Boolean(dashboardUrlId && !urlDashboard);
  const fallback = useMemo(
    () => clone(INITIAL_DASHBOARDS[0] ?? defaultDashboard("Operations pulse")),
    [],
  );
  const [draft, setDraft] = useState<OpenViewDashboard>(() =>
    clone(selected ?? fallback),
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [pendingSelection, setPendingSelection] = useState<string | null>(null);
  const [pendingTransition, setPendingTransition] = useState<
    { kind: "create"; name: string } | { kind: "duplicate" } | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState("");
  const dirty = selected
    ? JSON.stringify(draft) !== JSON.stringify(selected)
    : dashboards.length > 0 &&
      (draft.widgets.length > 0 || draft.name !== "New dashboard");

  useEffect(() => {
    onDashboardDirtyChange?.(dirty);
    return () => onDashboardDirtyChange?.(false);
  }, [dirty, onDashboardDirtyChange]);

  useEffect(() => {
    if (selected && selected.id !== draft.id) setDraft(clone(selected));
  }, [selected?.id, draft.id]);

  function persist(next: OpenViewDashboard[]) {
    setRawDashboards(
      next.map((dashboard) => toLegacyDashboard(dashboard, lookup)),
    );
  }

  function chooseDashboard(id: string) {
    if (id === draft.id || !dirty) {
      setSelectedId(id);
      const next = dashboards.find((dashboard) => dashboard.id === id);
      if (next) setDraft(clone(next));
      onDashboardUrlChange?.(id);
      return;
    }
    setPendingSelection(id);
  }

  function saveDashboard() {
    const name = draft.name.trim();
    if (!name) {
      setMessage("Give this dashboard a name before saving.");
      return;
    }
    const nextDashboard = { ...draft, name };
    persist(
      dashboards.some((item) => item.id === nextDashboard.id)
        ? dashboards.map((item) =>
            item.id === nextDashboard.id ? nextDashboard : item,
          )
        : [...dashboards, nextDashboard],
    );
    setDraft(nextDashboard);
    setSelectedId(nextDashboard.id);
    onDashboardUrlChange?.(nextDashboard.id);
    setMessage(
      "Dashboard saved in this tab. Audience and refresh remain previews.",
    );
  }

  function commitCreateDashboard(name: string) {
    const dashboard = defaultDashboard(name || "New dashboard");
    persist([...dashboards, dashboard]);
    setSelectedId(dashboard.id);
    onDashboardUrlChange?.(dashboard.id);
    setDraft(dashboard);
    setCreateName("");
    setCreateOpen(false);
    setMessage("Dashboard created in this tab.");
  }

  function requestCreateDashboard(name: string) {
    if (dirty) {
      setPendingTransition({ kind: "create", name });
      return;
    }
    commitCreateDashboard(name);
  }

  function createDashboard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    requestCreateDashboard(createName.trim() || "New dashboard");
  }

  function commitDuplicateDashboard() {
    const dashboard = {
      ...clone(draft),
      id: makeId("sample-dashboard"),
      name: `${draft.name || "Dashboard"} copy`,
      widgets: draft.widgets.map((widget) => ({
        ...clone(widget),
        id: makeId("sample-widget"),
      })),
    };
    persist([...dashboards, dashboard]);
    setSelectedId(dashboard.id);
    onDashboardUrlChange?.(dashboard.id);
    setDraft(dashboard);
    setMessage("Dashboard duplicated.");
  }

  function duplicateDashboard() {
    if (dirty) {
      setPendingTransition({ kind: "duplicate" });
      return;
    }
    commitDuplicateDashboard();
  }

  function handleSurfaceChange(next: OpenViewWidget[]) {
    setDraft((current) => ({ ...current, widgets: next }));
  }

  if (!selected && dashboards.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Dashboards</CardTitle>
          <CardDescription>
            Build a reusable operational surface from local sample data.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {unknownUrlDashboard ? (
            <div className="mb-5">
              <DashboardLinkWarning
                hasFallback={false}
                onClear={() => onDashboardUrlChange?.(undefined)}
              />
            </div>
          ) : null}
          <EmptyState
            icon={<BarChart3 />}
            title="No dashboards yet"
            description="Create a dashboard to start arranging summaries, workloads, records, and charts."
            action={
              <Button
                className="min-h-11"
                onClick={() => requestCreateDashboard("New dashboard")}
              >
                <Plus data-icon="inline-start" />
                Create dashboard
              </Button>
            }
          />
        </CardContent>
      </Card>
    );
  }

  const activeDashboard = selected ?? draft;
  const rowsByModule = {
    "service-requests": getOpenViewRows("service-requests", records),
    equipment: getOpenViewRows("equipment"),
    customers: getOpenViewRows("customers"),
  };
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Choice
          id="openview-dashboard"
          label="Dashboard"
          value={activeDashboard.id}
          values={dashboards.map((dashboard) => ({
            value: dashboard.id,
            label: dashboard.name,
          }))}
          onChange={chooseDashboard}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => setCreateOpen((open) => !open)}
          >
            <Plus data-icon="inline-start" />
            Create dashboard
          </Button>
          <Button
            variant="ghost"
            className="min-h-11"
            onClick={duplicateDashboard}
          >
            <Copy data-icon="inline-start" />
            Duplicate
          </Button>
        </div>
      </div>
      {createOpen ? (
        <Card>
          <CardHeader>
            <CardTitle>Create dashboard</CardTitle>
            <CardDescription>
              Name the local dashboard; you can configure and save it after
              creation.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-4 sm:flex-row sm:items-end"
              onSubmit={createDashboard}
            >
              <Field className="min-w-0 flex-1">
                <FieldLabel htmlFor="new-dashboard-name">
                  Dashboard name
                </FieldLabel>
                <Input
                  id="new-dashboard-name"
                  className="min-h-11"
                  value={createName}
                  maxLength={80}
                  autoFocus
                  onChange={(event) => setCreateName(event.target.value)}
                />
              </Field>
              <Button className="min-h-11">Create dashboard</Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : null}
      {unknownUrlDashboard ? (
        <DashboardLinkWarning
          onClear={() => onDashboardUrlChange?.(undefined)}
        />
      ) : null}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <Field>
                <FieldLabel htmlFor="dashboard-name">Dashboard name</FieldLabel>
                <Input
                  id="dashboard-name"
                  className="min-h-11"
                  value={draft.name}
                  maxLength={80}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
              </Field>
              <p className="text-muted-foreground mt-3 text-sm">
                Arrange local widgets around one operating question. Saving
                writes to this browser tab only.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={
                  draft.audience.kind === "everyone" ||
                  isUnresolvedAudience(draft.audience)
                    ? "warning"
                    : "secondary"
                }
              >
                {audienceLabel(draft.audience, lookup)}
              </Badge>
              <Badge variant="outline">{refreshLabel(draft.refresh)}</Badge>
              {defaultId === draft.id ? (
                <Badge variant="success">Default</Badge>
              ) : null}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <AudienceField
              id="dashboard-audience"
              audience={draft.audience}
              roles={roles}
              people={people}
              onChange={(audience) =>
                setDraft((current) => ({ ...current, audience }))
              }
            />
            <RefreshField
              id="dashboard-refresh"
              value={draft.refresh}
              onChange={(refresh) =>
                setDraft((current) => ({ ...current, refresh }))
              }
            />
          </div>
          <Separator className="my-6" />
          <section
            className="border-border mb-5 border-y py-4"
            aria-labelledby="dashboard-attention-question"
          >
            <h3 id="dashboard-attention-question" className="font-semibold">
              What needs attention now?
            </h3>
            <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
              Summary and record widgets surface deadlines, blocked work,
              priority, ownership, and progress. Use charts for the broader
              pattern behind the work.
            </p>
          </section>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold">Widgets</h3>
              <p className="text-muted-foreground text-sm">
                Add a catalog item, then tune its source, fields, filters, and
                display. {draft.widgets.length} of 12 widgets used.
              </p>
            </div>
            <WidgetCatalog
              disabled={draft.widgets.length >= 12}
              onAdd={(type) =>
                setDraft((current) =>
                  current.widgets.length >= 12
                    ? current
                    : {
                        ...current,
                        widgets: [
                          ...current.widgets,
                          defaultWidget(type, moduleId),
                        ],
                      },
                )
              }
            />
          </div>
          <div className="mt-5">
            <WidgetSurface
              widgets={draft.widgets}
              onChange={handleSurfaceChange}
              maxWidgets={12}
              records={records}
              rowsByModule={rowsByModule}
              audienceLookup={lookup}
            />
          </div>
          {draft.widgets.length === 0 ? (
            <EmptyState
              className="mt-5"
              icon={<Plus />}
              title="No widgets on this dashboard"
              description="Use Add widget to choose a summary, workload, record list, or chart."
            />
          ) : null}
        </CardContent>
        <CardFooter className="flex-wrap justify-between">
          <div className="flex flex-wrap gap-2">
            <Button className="min-h-11" onClick={saveDashboard}>
              <Save data-icon="inline-start" />
              {dirty ? "Save changes" : "Saved"}
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={!dirty}
              onClick={() => selected && setDraft(clone(selected))}
            >
              <RotateCcw data-icon="inline-start" />
              Reset draft
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() =>
                setDefaultId(defaultId === draft.id ? "" : draft.id)
              }
            >
              {defaultId === draft.id ? "Unset default" : "Set as default"}
            </Button>
          </div>
          <Button
            variant="destructive"
            className="min-h-11"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 data-icon="inline-start" />
            Delete dashboard
          </Button>
        </CardFooter>
      </Card>
      {message ? (
        <Alert variant={message.includes("before") ? "warning" : "success"}>
          {message}
        </Alert>
      ) : null}
      <AlertDialog
        open={pendingTransition !== null}
        onOpenChange={(open) => !open && setPendingTransition(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingTransition?.kind === "create"
                ? "Create dashboard and discard changes?"
                : "Duplicate dashboard and replace draft?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your current dashboard draft has unsaved changes. This action will
              replace the draft in the editor without saving those changes
              first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setPendingTransition(null)}
            >
              Keep editing
            </Button>
            <Button
              className="min-h-11"
              onClick={() => {
                const transition = pendingTransition;
                if (!transition) return;
                setPendingTransition(null);
                if (transition.kind === "create")
                  commitCreateDashboard(transition.name);
                else commitDuplicateDashboard();
              }}
            >
              {pendingTransition?.kind === "create"
                ? "Discard and create"
                : "Discard and duplicate"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={pendingSelection !== null}
        onOpenChange={(open) => !open && setPendingSelection(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard dashboard changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your current dashboard draft has unsaved changes. Switching
              dashboards will discard them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setPendingSelection(null)}
            >
              Keep editing
            </Button>
            <Button
              className="min-h-11"
              onClick={() => {
                if (pendingSelection) {
                  setSelectedId(pendingSelection);
                  const next = dashboards.find(
                    (item) => item.id === pendingSelection,
                  );
                  if (next) {
                    setDraft(clone(next));
                    onDashboardUrlChange?.(next.id);
                  }
                }
                setPendingSelection(null);
              }}
            >
              Discard and switch
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{draft.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the dashboard from this tab. Its source records are
              unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              onClick={() => {
                const remaining = dashboards.filter(
                  (item) => item.id !== draft.id,
                );
                persist(remaining);
                setDefaultId(defaultId === draft.id ? "" : defaultId);
                const next = remaining[0];
                if (next) {
                  setSelectedId(next.id);
                  setDraft(clone(next));
                  onDashboardUrlChange?.(next.id);
                } else {
                  setSelectedId("");
                  setDraft(defaultDashboard());
                  onDashboardUrlChange?.(undefined);
                }
                setConfirmDelete(false);
                setMessage("Dashboard deleted from this tab.");
              }}
            >
              Delete dashboard
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function WidgetCatalog({
  onAdd,
  disabled = false,
}: {
  onAdd: (type: OpenViewWidget["type"]) => void;
  disabled?: boolean;
}) {
  const items: {
    type: OpenViewWidget["type"];
    label: string;
    description: string;
    icon: ReactNode;
  }[] = [
    {
      type: "summary",
      label: "Summary",
      description: "Count records and show a compact status breakdown.",
      icon: <FileBarChart data-icon="inline-start" />,
    },
    {
      type: "workload",
      label: "Workload",
      description: "Compare records by the selected people or category.",
      icon: <BarChart3 data-icon="inline-start" />,
    },
    {
      type: "records",
      label: "Record list",
      description: "Keep a short, linked list of matching records in view.",
      icon: <FileText data-icon="inline-start" />,
    },
    {
      type: "chart",
      label: "Chart",
      description: "Add a configurable bar, line, or pie summary.",
      icon: <PieChartIcon data-icon="inline-start" />,
    },
  ];
  return (
    <div className="flex flex-wrap gap-2" aria-label="Widget catalog">
      {items.map((item) => (
        <Button
          key={item.type}
          type="button"
          variant="outline"
          className="min-h-11"
          title={item.description}
          disabled={disabled}
          onClick={() => onAdd(item.type)}
        >
          {item.icon}
          {item.label}
        </Button>
      ))}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description,
  action,
  className = "",
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Empty className={className}>
      <EmptyHeader>
        {icon ? <EmptyMedia variant="icon">{icon}</EmptyMedia> : null}
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}

function DashboardLinkWarning({
  onClear,
  hasFallback = true,
}: {
  onClear?: () => void;
  hasFallback?: boolean;
}) {
  return (
    <Alert variant="warning">
      {hasFallback
        ? "This dashboard link is unavailable in the current sample tab. The selected dashboard is a safe recovery view; choose another dashboard to update the link."
        : "This dashboard link is unavailable in the current sample tab. Choose a dashboard to recover the workspace."}
      {onClear ? (
        <Button variant="outline" className="mt-3 min-h-11" onClick={onClear}>
          Clear unavailable link
        </Button>
      ) : null}
    </Alert>
  );
}

function isNumericChartMetric(
  moduleId: OpenViewModuleId,
  metric: string,
): boolean {
  return getModuleDefinition(moduleId).fields.some(
    (field) => field.id === metric && field.type === "number",
  );
}

function chartAggregationOptions(
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

type ChartDatum = { label: string; value: number; key: string };

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

function chartRows(
  settings: ChartSettings,
  rows: OpenViewRow[],
): { rows: OpenViewRow[]; data: ChartDatum[] } {
  const normalizedSettings = normalizeChartSettings(settings);
  const dateField = normalizedSettings.dateField;
  const selected = filterRows(rows, normalizedSettings.filters).filter(
    (row) => {
      if (!dateField) return true;
      const date = valueFor(row, dateField);
      return (
        (!normalizedSettings.from || date >= normalizedSettings.from) &&
        (!normalizedSettings.to || date <= normalizedSettings.to)
      );
    },
  );
  const groups = new Map<string, OpenViewRow[]>();
  selected.forEach((row) => {
    const label = valueFor(row, normalizedSettings.dimension) || "Unspecified";
    groups.set(label, [...(groups.get(label) ?? []), row]);
  });
  const sortedGroups = [...groups.entries()]
    .map(([label, group]) => {
      const values =
        normalizedSettings.metric === "count"
          ? []
          : group
              .map((row) => Number(row.values[normalizedSettings.metric]))
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

function ChartPreview({
  settings,
  data,
}: {
  settings: ChartSettings;
  data: ChartDatum[];
}) {
  const config: ChartConfig = {
    value: {
      label:
        settings.metric === "count"
          ? "Records"
          : fieldLabel(settings.moduleId, settings.metric),
      color: "var(--chart-1)",
    },
    ...Object.fromEntries(
      data.map((item, index) => [
        item.key,
        {
          label: item.label,
          color: `var(--chart-${(index % 5) + 1})`,
        },
      ]),
    ),
  };
  return (
    <ChartContainer
      config={config}
      className="border-border/70 bg-muted/15 h-[20rem] w-full rounded-[var(--radius)] border p-3"
    >
      {settings.type === "bar" ? (
        <BarChart
          accessibilityLayer
          data={data}
          margin={{
            top: settings.showLabels ? 24 : 8,
            right: 12,
            left: 0,
            bottom: 8,
          }}
        >
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          <YAxis
            allowDecimals={settings.aggregation === "average"}
            tickLine={false}
            axisLine={false}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          {settings.showLegend ? (
            <Legend content={<ChartLegendContent />} />
          ) : null}
          <Bar dataKey="value" radius={[7, 7, 0, 0]} maxBarSize={58}>
            {data.map((item) => (
              <Cell key={item.key} fill={`var(--color-${item.key})`} />
            ))}
            {settings.showLabels ? (
              <LabelList dataKey="value" position="top" />
            ) : null}
          </Bar>
        </BarChart>
      ) : settings.type === "line" ? (
        <LineChart
          accessibilityLayer
          data={data}
          margin={{
            top: settings.showLabels ? 24 : 8,
            right: 12,
            left: 0,
            bottom: 8,
          }}
        >
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          <YAxis
            allowDecimals={settings.aggregation === "average"}
            tickLine={false}
            axisLine={false}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          {settings.showLegend ? (
            <Legend content={<ChartLegendContent />} />
          ) : null}
          <Line
            dataKey="value"
            type="monotone"
            stroke="var(--color-value)"
            strokeWidth={3}
            dot={
              settings.showLabels
                ? {
                    r: 5,
                    fill: "var(--color-value)",
                    stroke: "var(--background)",
                    strokeWidth: 2,
                  }
                : false
            }
            activeDot={{ r: 7 }}
          >
            {settings.showLabels ? (
              <LabelList dataKey="value" position="top" />
            ) : null}
          </Line>
        </LineChart>
      ) : (
        <PieChart accessibilityLayer>
          <ChartTooltip content={<ChartTooltipContent nameKey="label" />} />
          {settings.showLegend ? (
            <Legend content={<ChartLegendContent nameKey="label" />} />
          ) : null}
          <Pie
            data={data}
            dataKey="value"
            nameKey="label"
            innerRadius={62}
            outerRadius={96}
            paddingAngle={3}
            stroke="var(--background)"
            strokeWidth={2}
            label={
              settings.showLabels
                ? ({ name, value }) => `${String(name ?? "Group")}: ${value}`
                : false
            }
          >
            {data.map((item) => (
              <Cell key={item.key} fill={`var(--color-${item.key})`} />
            ))}
          </Pie>
        </PieChart>
      )}
    </ChartContainer>
  );
}

function Charts({
  records,
  moduleId = "service-requests",
}: {
  records: SampleRecord[];
  moduleId?: OpenViewModuleId;
}) {
  const [rawSettings, setRawSettings] = useSampleState<unknown>(
    "views-chart",
    INITIAL_CHART_SETTINGS,
  );
  const [settings, setSettings] = useState<ChartSettings>(() => {
    const stored = decodeChartSettings(rawSettings);
    if (stored.moduleId === moduleId) return stored;
    return defaultChartSettings(moduleId);
  });
  const modulePropRef = useRef(moduleId);
  useEffect(() => {
    if (modulePropRef.current === moduleId) return;
    modulePropRef.current = moduleId;
    const next = defaultChartSettings(moduleId);
    setSettings(next);
    setRawSettings(next);
  }, [moduleId, setRawSettings]);
  const [exportRequest, setExportRequest] = useState<ExportRequest | null>(
    null,
  );
  const [message, setMessage] = useState("");
  const rows = useMemo(
    () => getOpenViewRows(settings.moduleId, records),
    [settings.moduleId, records],
  );
  const { rows: filteredRows, data } = useMemo(
    () => chartRows(settings, rows),
    [settings, rows],
  );
  const moduleDefinition = getModuleDefinition(settings.moduleId);
  const dateFields = moduleDefinition.fields.filter(
    (field) => field.type === "date",
  );
  const operationalDateField = getOpenViewOperationalDeadlineField(
    settings.moduleId,
  );
  const selectedDateField = dateFields.find(
    (field) => field.id === settings.dateField,
  );
  const invalidDateRange = Boolean(
    settings.from && settings.to && settings.from > settings.to,
  );
  const chartTotal = data.reduce((total, item) => total + item.value, 0);
  const topGroup = data[0];

  function update(change: Partial<ChartSettings>) {
    const next = normalizeChartSettings({ ...settings, ...change });
    setSettings(next);
    setRawSettings(next);
    setMessage("");
  }

  function chartExportRows(): { rows: OpenViewRow[]; fields: string[] } {
    const fields =
      settings.metric === "count"
        ? [settings.dimension, "count"]
        : [settings.dimension, settings.metric];
    return {
      fields,
      rows: data.map((item) => ({
        id: `chart-${item.key}`,
        moduleId: settings.moduleId,
        values: {
          [settings.dimension]: item.label,
          [settings.metric]: item.value,
        },
      })),
    };
  }

  return (
    <Workbench
      controls={
        <FieldGroup>
          <div>
            <h2 className="font-semibold">Chart builder</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Compose a small, readable summary from one sample module.
            </p>
          </div>
          <Choice
            id="chart-module"
            label="Source module"
            value={settings.moduleId}
            values={OPENVIEW_MODULES.map((item) => ({
              value: item.id,
              label: item.name,
            }))}
            onChange={(moduleId) => {
              const nextModuleId = moduleId as OpenViewModuleId;
              const nextModule = getModuleDefinition(nextModuleId);
              update({
                moduleId: nextModuleId,
                dimension:
                  nextModule.fields.find((field) => field.type === "select")
                    ?.id ?? nextModule.primaryField,
                metric: "count",
                dateField:
                  getOpenViewOperationalDeadlineField(nextModuleId) ?? "",
                filters: emptyFilters(),
                from: "",
                to: "",
              });
            }}
          />
          <FieldSet>
            <FieldLegend>Chart type</FieldLegend>
            <ToggleGroup
              aria-label="Chart type"
              value={[settings.type]}
              onValueChange={(values) => {
                const type = values[0];
                if (type === "bar" || type === "line" || type === "pie")
                  update({ type });
              }}
            >
              <ToggleGroupItem className="min-h-11" value="bar">
                <BarChart3 data-icon="inline-start" />
                Bar
              </ToggleGroupItem>
              <ToggleGroupItem className="min-h-11" value="line">
                <LineChartIcon data-icon="inline-start" />
                Line
              </ToggleGroupItem>
              <ToggleGroupItem className="min-h-11" value="pie">
                <PieChartIcon data-icon="inline-start" />
                Pie
              </ToggleGroupItem>
            </ToggleGroup>
          </FieldSet>
          <Choice
            id="chart-dimension"
            label="Dimension"
            value={settings.dimension}
            values={moduleDefinition.fields.map((field) => ({
              value: field.id,
              label: field.label,
            }))}
            onChange={(dimension) => update({ dimension })}
          />
          <Choice
            id="chart-metric"
            label="Metric"
            value={settings.metric}
            values={[
              { value: "count", label: "Record count" },
              ...moduleDefinition.fields
                .filter((field) => field.type === "number")
                .map((field) => ({ value: field.id, label: field.label })),
            ]}
            onChange={(metric) => {
              const nextMetric =
                metric === "count" ||
                isNumericChartMetric(settings.moduleId, metric)
                  ? metric
                  : "count";
              update({
                metric: nextMetric,
                aggregation: nextMetric === "count" ? "count" : "sum",
              });
            }}
          />
          <Choice
            id="chart-aggregation"
            label="Aggregation"
            value={settings.aggregation}
            values={chartAggregationOptions(settings.moduleId, settings.metric)}
            onChange={(aggregation) =>
              update({
                aggregation: aggregation as ChartSettings["aggregation"],
              })
            }
            description={
              settings.metric === "count"
                ? "Record count is the only available aggregation for this metric."
                : "Numeric metrics support sum or average."
            }
          />
          {dateFields.length > 0 ? (
            <>
              <Choice
                id="chart-date-field"
                label="Date field"
                value={settings.dateField}
                values={dateFields.map((field) => ({
                  value: field.id,
                  label:
                    field.id === operationalDateField
                      ? `${field.label} · operational deadline`
                      : field.label,
                }))}
                onChange={(dateField) => update({ dateField })}
                description="Choose which date should control the chart window."
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="chart-from">From date</FieldLabel>
                  <Input
                    id="chart-from"
                    className="min-h-11"
                    type="date"
                    value={settings.from}
                    onChange={(event) => update({ from: event.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="chart-to">To date</FieldLabel>
                  <Input
                    id="chart-to"
                    className="min-h-11"
                    type="date"
                    value={settings.to}
                    onChange={(event) => update({ to: event.target.value })}
                  />
                </Field>
              </div>
            </>
          ) : (
            <Alert>
              This module has no date field in this sample dataset, so date
              filtering is unavailable.
            </Alert>
          )}
          {invalidDateRange ? (
            <Alert variant="destructive">
              End date must be on or after the start date.
            </Alert>
          ) : null}
          <FilterEditor
            moduleId={settings.moduleId}
            rows={rows}
            filters={settings.filters}
            onChange={(filters) => update({ filters })}
            title="Chart filters"
          />
          <Field>
            <FieldLabel htmlFor="chart-limit">Top results</FieldLabel>
            <Input
              id="chart-limit"
              className="min-h-11"
              type="number"
              min={1}
              max={20}
              value={settings.limit}
              onChange={(event) =>
                update({
                  limit: Math.max(
                    1,
                    Math.min(20, Number(event.target.value) || 1),
                  ),
                })
              }
            />
            <FieldDescription>
              Limit the chart to the highest-value groups.
            </FieldDescription>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field className="min-h-11 flex-row items-center gap-3">
              <Checkbox
                id="chart-legend"
                className="size-5 after:-inset-3"
                checked={settings.showLegend}
                onCheckedChange={(checked) =>
                  update({ showLegend: Boolean(checked) })
                }
              />
              <FieldLabel htmlFor="chart-legend">Show legend</FieldLabel>
            </Field>
            <Field className="min-h-11 flex-row items-center gap-3">
              <Checkbox
                id="chart-labels"
                className="size-5 after:-inset-3"
                checked={settings.showLabels}
                onCheckedChange={(checked) =>
                  update({ showLabels: Boolean(checked) })
                }
              />
              <FieldLabel htmlFor="chart-labels">Show values</FieldLabel>
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="min-h-11"
              disabled={invalidDateRange || data.length === 0}
              onClick={() => {
                const exportData = chartExportRows();
                setExportRequest({
                  kind: "csv",
                  title: `${moduleDefinition.name} chart`,
                  source: moduleDefinition.name,
                  dateField: selectedDateField?.label,
                  dateFrom: settings.from,
                  dateTo: settings.to,
                  fields: exportData.fields,
                  fieldLabels: {
                    [settings.dimension]: fieldLabel(
                      settings.moduleId,
                      settings.dimension,
                    ),
                    [settings.metric]:
                      settings.metric === "count"
                        ? "Records"
                        : fieldLabel(settings.moduleId, settings.metric),
                  },
                  rows: exportData.rows,
                  filters: settings.filters,
                  grouping: settings.dimension,
                  totals: false,
                });
              }}
            >
              <Download data-icon="inline-start" />
              Download CSV
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={invalidDateRange || data.length === 0}
              onClick={() => {
                const exportData = chartExportRows();
                setExportRequest({
                  kind: "pdf",
                  title: `${moduleDefinition.name} chart`,
                  source: moduleDefinition.name,
                  dateField: selectedDateField?.label,
                  dateFrom: settings.from,
                  dateTo: settings.to,
                  fields: exportData.fields,
                  fieldLabels: {
                    [settings.dimension]: fieldLabel(
                      settings.moduleId,
                      settings.dimension,
                    ),
                    [settings.metric]:
                      settings.metric === "count"
                        ? "Records"
                        : fieldLabel(settings.moduleId, settings.metric),
                  },
                  rows: exportData.rows,
                  filters: settings.filters,
                  grouping: settings.dimension,
                  totals: false,
                  chart: { settings, data },
                });
              }}
            >
              <Printer data-icon="inline-start" />
              Print / save PDF
            </Button>
          </div>
        </FieldGroup>
      }
    >
      <Card className="overflow-hidden">
        <CardHeader className="bg-muted/25">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>
                {topGroup
                  ? `${topGroup.label} leads this view`
                  : `${moduleDefinition.name} chart`}
              </CardTitle>
              <CardDescription className="mt-1 space-y-0.5">
                <span className="block">
                  Source: {moduleDefinition.name} · {data.length} groups from{" "}
                  {filteredRows.length} matching records ·{" "}
                  {settings.aggregation}{" "}
                  {settings.metric === "count"
                    ? "records"
                    : fieldLabel(settings.moduleId, settings.metric)}
                </span>
                <span className="block">
                  Date field: {selectedDateField?.label ?? "None"}
                  {settings.from || settings.to
                    ? ` · window ${settings.from || "any date"} → ${settings.to || "any date"}`
                    : " · all dates"}
                </span>
                <span className="block">
                  Sample snapshot: {formatSampleSnapshotDate()} ·{" "}
                  {OPENVIEW_SAMPLE_TIMEZONE} · synthetic data for local preview
                  only.
                </span>
              </CardDescription>
            </div>
            <Badge variant="outline" className="bg-card">
              Sample data
            </Badge>
          </div>
          {data.length ? (
            <div className="border-border mt-4 flex flex-wrap gap-x-8 gap-y-3 border-t pt-3 text-sm">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="bg-chart-1 size-2.5 shrink-0 rounded-full"
                  aria-hidden="true"
                />
                <span className="text-muted-foreground">Largest group</span>
                <span className="truncate font-semibold">
                  {topGroup?.label}
                </span>
                <span className="font-semibold tabular-nums">
                  {topGroup?.value.toLocaleString(undefined, {
                    maximumFractionDigits:
                      settings.aggregation === "average" ? 2 : 0,
                  })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="bg-chart-3 size-2.5 shrink-0 rounded-full"
                  aria-hidden="true"
                />
                <span className="text-muted-foreground">
                  {settings.aggregation === "average"
                    ? "Combined displayed value"
                    : "Displayed total"}
                </span>
                <span className="font-semibold tabular-nums">
                  {chartTotal.toLocaleString(undefined, {
                    maximumFractionDigits:
                      settings.aggregation === "average" ? 2 : 0,
                  })}
                </span>
              </div>
            </div>
          ) : null}
        </CardHeader>
        <CardContent>
          {invalidDateRange ? (
            <EmptyState
              icon={<CalendarClock />}
              title="Correct the date range"
              description="The chart will appear after the end date is on or after the start date."
            />
          ) : data.length === 0 ? (
            <EmptyState
              icon={<BarChart3 />}
              title="No matching groups"
              description="Try clearing a filter or widening the date range."
            />
          ) : (
            <Tabs defaultValue="chart">
              <TabsList>
                <TabsTrigger value="chart" className="min-h-11">
                  Chart
                </TabsTrigger>
                <TabsTrigger value="table" className="min-h-11">
                  Data table
                </TabsTrigger>
              </TabsList>
              <TabsContent value="chart" className="mt-5">
                <ChartPreview settings={settings} data={data} />
              </TabsContent>
              <TabsContent value="table" className="mt-5">
                <ChartTable settings={settings} data={data} />
              </TabsContent>
            </Tabs>
          )}
          {message ? (
            <Alert variant="success" className="mt-5">
              {message}
            </Alert>
          ) : null}
        </CardContent>
      </Card>
      <ExportConfirmation
        request={exportRequest}
        onClose={() => setExportRequest(null)}
        onComplete={(result) => {
          setExportRequest(null);
          setMessage(result);
        }}
      />
    </Workbench>
  );
}

function ChartTable({
  settings,
  data,
}: {
  settings: ChartSettings;
  data: ChartDatum[];
}) {
  const max = Math.max(...data.map((item) => item.value), 1);
  return (
    <Table className="overflow-hidden rounded-[var(--radius)] border">
      <TableCaption className="sr-only">
        Chart values for {fieldLabel(settings.moduleId, settings.dimension)}.
      </TableCaption>
      <TableHeader className="bg-muted/65">
        <TableRow className="hover:bg-muted/65">
          <TableHead className="px-4 text-[0.6875rem] font-semibold tracking-wide uppercase">
            {fieldLabel(settings.moduleId, settings.dimension)}
          </TableHead>
          <TableHead className="px-4 text-right text-[0.6875rem] font-semibold tracking-wide uppercase">
            {settings.aggregation === "count"
              ? "Records"
              : settings.aggregation}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((item, index) => (
          <TableRow key={item.key} className="odd:bg-muted/20">
            <TableCell className="px-4 font-medium">
              <span className="flex items-center gap-2">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{
                    backgroundColor: `var(--chart-${(index % 5) + 1})`,
                  }}
                  aria-hidden="true"
                />
                {item.label}
              </span>
            </TableCell>
            <TableCell className="relative overflow-hidden px-4 text-right tabular-nums">
              <span
                className="absolute inset-y-1 right-0 opacity-15"
                style={{
                  width: `${Math.max(6, (item.value / max) * 100)}%`,
                  backgroundColor: `var(--chart-${(index % 5) + 1})`,
                }}
                aria-hidden="true"
              />
              <span className="relative font-semibold">
                {item.value.toLocaleString(undefined, {
                  maximumFractionDigits:
                    settings.aggregation === "average" ? 2 : 0,
                })}
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

type ExportRequest = {
  kind: "csv" | "pdf";
  title: string;
  source: string;
  dateField?: string;
  dateFrom?: string;
  dateTo?: string;
  subtitle?: string;
  fields: string[];
  fieldLabels?: Record<string, string>;
  rows: OpenViewRow[];
  filters: FilterGroup;
  grouping: string | null;
  totals: boolean;
  groups?: { label: string; rows: OpenViewRow[] }[];
  chart?: { settings: ChartSettings; data: ChartDatum[] };
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function chartColor(index: number): string {
  const colors = ["#2563eb", "#059669", "#c2410c", "#7c3aed", "#be185d"];
  return colors[index % colors.length] ?? colors[0];
}

function chartSvg(settings: ChartSettings, data: ChartDatum[]): string {
  const width = 760;
  const height = 300;
  const left = 54;
  const right = 20;
  const top = settings.showLabels ? 32 : 16;
  const bottom = 54;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const max = Math.max(1, ...data.map((item) => item.value));
  const labels = data
    .map(
      (item, index) =>
        `<text x="${left + ((index + 0.5) * plotWidth) / Math.max(data.length, 1)}" y="${height - 18}" text-anchor="middle">${escapeHtml(item.label.slice(0, 18))}</text>`,
    )
    .join("");
  if (settings.type === "bar") {
    const slot = plotWidth / Math.max(data.length, 1);
    const bars = data
      .map((item, index) => {
        const barHeight = (item.value / max) * plotHeight;
        const x = left + index * slot + slot * 0.18;
        const y = top + plotHeight - barHeight;
        return `<rect x="${x}" y="${y}" width="${slot * 0.64}" height="${barHeight}" rx="4" fill="${chartColor(index)}" />${settings.showLabels ? `<text x="${x + slot * 0.32}" y="${Math.max(y - 8, 14)}" text-anchor="middle">${item.value.toLocaleString()}</text>` : ""}`;
      })
      .join("");
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Bar chart" xmlns="http://www.w3.org/2000/svg"><line x1="${left}" y1="${top + plotHeight}" x2="${width - right}" y2="${top + plotHeight}" stroke="#9ca3af" /><g font-family="system-ui, sans-serif" font-size="12" fill="#171819">${bars}${labels}</g></svg>`;
  }
  if (settings.type === "line") {
    const points = data
      .map((item, index) => {
        const x = left + ((index + 0.5) * plotWidth) / Math.max(data.length, 1);
        const y = top + plotHeight - (item.value / max) * plotHeight;
        return `${x},${y}`;
      })
      .join(" ");
    const dots = data
      .map((item, index) => {
        const x = left + ((index + 0.5) * plotWidth) / Math.max(data.length, 1);
        const y = top + plotHeight - (item.value / max) * plotHeight;
        return `${settings.showLabels ? `<text x="${x}" y="${Math.max(y - 10, 14)}" text-anchor="middle">${item.value.toLocaleString()}</text>` : ""}<circle cx="${x}" cy="${y}" r="4" fill="#2563eb" />`;
      })
      .join("");
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Line chart" xmlns="http://www.w3.org/2000/svg"><line x1="${left}" y1="${top + plotHeight}" x2="${width - right}" y2="${top + plotHeight}" stroke="#9ca3af" /><polyline points="${points}" fill="none" stroke="#2563eb" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" /><g font-family="system-ui, sans-serif" font-size="12" fill="#171819">${dots}${labels}</g></svg>`;
  }
  const total = data.reduce((sum, item) => sum + item.value, 0) || 1;
  let currentAngle = -Math.PI / 2;
  const centerX = width / 2;
  const centerY = 126;
  const radius = 88;
  const sectors = data
    .map((item, index) => {
      const nextAngle = currentAngle + (item.value / total) * Math.PI * 2;
      const startX = centerX + radius * Math.cos(currentAngle);
      const startY = centerY + radius * Math.sin(currentAngle);
      const endX = centerX + radius * Math.cos(nextAngle);
      const endY = centerY + radius * Math.sin(nextAngle);
      const largeArc = nextAngle - currentAngle > Math.PI ? 1 : 0;
      const path = `M ${centerX} ${centerY} L ${startX} ${startY} A ${radius} ${radius} 0 ${largeArc} 1 ${endX} ${endY} Z`;
      const midAngle = (currentAngle + nextAngle) / 2;
      const labelX = centerX + (radius + 24) * Math.cos(midAngle);
      const labelY = centerY + (radius + 24) * Math.sin(midAngle);
      currentAngle = nextAngle;
      return `<path d="${path}" fill="${chartColor(index)}" stroke="#ffffff" stroke-width="2" />${settings.showLabels ? `<text x="${labelX}" y="${labelY}" text-anchor="middle">${item.value.toLocaleString()}</text>` : ""}`;
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Pie chart" xmlns="http://www.w3.org/2000/svg"><g font-family="system-ui, sans-serif" font-size="12" fill="#171819">${sectors}</g></svg>`;
}

function chartLegendMarkup(
  settings: ChartSettings,
  data: ChartDatum[],
  metricLabel: string,
): string {
  if (!settings.showLegend) return "";
  const entries =
    settings.type === "pie"
      ? data
          .map(
            (item, index) =>
              `<span><i style="background:${chartColor(index)}"></i>${escapeHtml(item.label)}</span>`,
          )
          .join("")
      : `<span><i style="background:${chartColor(0)}"></i>${escapeHtml(metricLabel)}</span>`;
  return `<div class="legend">${entries}</div>`;
}

function printExport(request: ExportRequest): boolean {
  const printWindow = window.open("", "_blank");
  if (!printWindow) return false;
  const headers = request.fields
    .map((field) => `<th>${escapeHtml(exportFieldLabel(request, field))}</th>`)
    .join("");
  const body = request.chart
    ? `${chartSvg(request.chart.settings, request.chart.data)}${chartLegendMarkup(request.chart.settings, request.chart.data, request.fieldLabels?.[request.fields[1] ?? ""] ?? "Records")}`
    : request.grouping && request.groups?.length
      ? request.groups
          .map(
            (group) =>
              `<tr class="group"><th colspan="${Math.max(request.fields.length, 1)}">${escapeHtml(group.label)}</th></tr>${group.rows
                .map(
                  (row) =>
                    `<tr>${request.fields
                      .map(
                        (field) =>
                          `<td>${escapeHtml(valueFor(row, field))}</td>`,
                      )
                      .join("")}</tr>`,
                )
                .join(
                  "",
                )}${request.totals ? `<tr class="total"><td colspan="${Math.max(request.fields.length, 1)}">Group total: ${group.rows.length}</td></tr>` : ""}`,
          )
          .join("") +
        (request.totals
          ? `<tr class="grand-total"><td colspan="${Math.max(request.fields.length, 1)}">Grand total: ${request.rows.length}</td></tr>`
          : "")
      : request.rows
          .map(
            (row) =>
              `<tr>${request.fields
                .map((field) => `<td>${escapeHtml(valueFor(row, field))}</td>`)
                .join("")}</tr>`,
          )
          .join("");
  printWindow.document.open();
  const subtitle = request.subtitle
    ? `<p>${escapeHtml(request.subtitle)}</p>`
    : "";
  const dateContext = request.dateField
    ? ` · Date field: ${escapeHtml(request.dateField)}${request.dateFrom || request.dateTo ? ` · Window: ${escapeHtml(request.dateFrom || "any date")} → ${escapeHtml(request.dateTo || "any date")}` : " · All dates"}`
    : "";
  const sampleContext = `Source: ${escapeHtml(request.source)} · ${request.rows.length} rows${dateContext} · Sample snapshot: ${escapeHtml(OPENVIEW_SAMPLE_SNAPSHOT_DATE)} · Timezone: ${escapeHtml(OPENVIEW_SAMPLE_TIMEZONE)} · Synthetic data; local preview only.`;
  const chartContent = request.chart
    ? `<section class="chart">${body}</section><table><caption>Chart data</caption><thead><tr>${headers}</tr></thead><tbody>${request.rows
        .map(
          (row) =>
            `<tr>${request.fields
              .map((field) => `<td>${escapeHtml(valueFor(row, field))}</td>`)
              .join("")}</tr>`,
        )
        .join("")}</tbody></table>`
    : `<table><thead><tr>${headers}</tr></thead><tbody>${body}</tbody></table>`;
  printWindow.document.write(
    `<!doctype html><html><head><title>${escapeHtml(request.title)}</title><style>body{font:14px system-ui,sans-serif;color:#171819;padding:32px}h1{font-size:24px;margin:0 0 4px}p{color:#5f6368;margin:0 0 24px}table{border-collapse:collapse;width:100%;margin-top:20px}caption{text-align:left;font-weight:600;margin-bottom:8px}th,td{text-align:left;border-bottom:1px solid #ddd;padding:10px 8px}.group th{background:#f2f2f2}.total td,.grand-total td{font-weight:600;text-align:right}.chart{width:100%;max-width:760px}.chart svg{display:block;width:100%;height:auto}.legend{display:flex;flex-wrap:wrap;gap:16px;margin:8px 0 20px}.legend span{display:inline-flex;align-items:center;gap:6px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px}@media print{body{padding:0}}</style></head><body><h1>${escapeHtml(request.title)}</h1>${subtitle}<p>${sampleContext}</p>${chartContent}</body></html>`,
  );
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
  printWindow.close();
  return true;
}

function exportFieldLabel(request: ExportRequest, field: string): string {
  return request.fieldLabels?.[field] ?? field;
}

function serializeExportCsv(request: ExportRequest): string {
  const fields = request.fields.map((field) =>
    exportFieldLabel(request, field),
  );
  const rows: OpenViewRow[] = request.rows.map((row) => ({
    ...row,
    values: Object.fromEntries(
      request.fields.map((field, index) => [
        fields[index] ?? field,
        row.values[field] ?? "",
      ]),
    ),
  }));
  return serializeOpenViewCsv(rows, fields);
}

function downloadExport(request: ExportRequest): boolean {
  const content = serializeExportCsv(request);
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  let anchor: HTMLAnchorElement | null = null;
  try {
    anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = safeOpenViewFilename(request.title, "csv");
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    return true;
  } finally {
    anchor?.remove();
    URL.revokeObjectURL(url);
  }
}

function ExportConfirmation({
  request,
  onClose,
  onComplete,
}: {
  request: ExportRequest | null;
  onClose: () => void;
  onComplete: (message: string) => void;
}) {
  const [error, setError] = useState("");
  useEffect(() => setError(""), [request]);
  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {request?.kind === "csv"
              ? "Download this CSV?"
              : "Print or save this PDF?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Review the exact local sample slice before exporting. No server
            upload or sharing occurs.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {request ? (
          <>
            <div className="bg-muted grid gap-3 rounded-[var(--radius)] p-4 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Source</span>
                <strong>{request.source}</strong>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Fields</span>
                <strong className="text-right">
                  {request.fields
                    .map((field) => exportFieldLabel(request, field))
                    .join(", ")}
                </strong>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Filters</span>
                <strong>
                  {request.filters.clauses.length
                    ? `${request.filters.clauses.length} active`
                    : "None"}
                </strong>
              </div>
              {request.dateField ? (
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Date window</span>
                  <strong className="text-right">
                    {request.dateField} · {request.dateFrom || "Any date"} →{" "}
                    {request.dateTo || "Any date"}
                  </strong>
                </div>
              ) : null}
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Grouping / totals</span>
                <strong>
                  {request.grouping
                    ? exportFieldLabel(request, request.grouping)
                    : "None"}
                  {" · "}
                  {request.totals ? "Included" : "Off"}
                </strong>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Rows</span>
                <strong>{request.rows.length}</strong>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Sample snapshot</span>
                <strong className="text-right">
                  {formatSampleSnapshotDate()} · {OPENVIEW_SAMPLE_TIMEZONE}
                </strong>
              </div>
            </div>
            <p className="text-muted-foreground text-xs">
              Synthetic sample data only. This export is local and does not
              upload, share, or schedule anything.
            </p>
          </>
        ) : null}
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        <AlertDialogFooter>
          <Button variant="outline" className="min-h-11" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="min-h-11"
            onClick={() => {
              if (!request) return;
              try {
                const completed =
                  request.kind === "csv"
                    ? downloadExport(request)
                    : printExport(request);
                if (!completed) {
                  setError(
                    "The print window was blocked. Allow pop-ups for this sample workspace and try again.",
                  );
                  return;
                }
                onComplete(
                  request.kind === "csv"
                    ? "CSV downloaded from the current sample slice."
                    : "Print dialog opened for the current sample slice.",
                );
              } catch {
                setError(
                  "The export could not be prepared. Your sample data is unchanged.",
                );
              }
            }}
          >
            {request?.kind === "csv" ? "Download CSV" : "Print / save PDF"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Reports({
  records,
  moduleId = "service-requests",
}: {
  records: SampleRecord[];
  moduleId?: OpenViewModuleId;
}) {
  const [roles] = useSampleState("access-roles", initialRoles);
  const [people] = useSampleState("access-people", initialPeople);
  const lookup = lookupFor(roles, people);
  const [rawDraft, setRawDraft] = useSampleState<unknown>(
    "views-report-draft",
    null,
  );
  const [rawTemplates, setRawTemplates] = useSampleState<unknown>(
    "views-report-templates",
    null,
  );
  const [selectedTemplateId, setSelectedTemplateId] = useSampleState(
    "views-report-template-selected",
    "",
  );
  const storedDraft = useMemo(
    () => normalizeReportRecord(rawDraft ?? initialReport, lookup),
    [rawDraft, lookup.roles, lookup.identities],
  );
  const templates = useMemo(
    () =>
      normalizeReportTemplates(rawTemplates ?? initialReportTemplates, lookup),
    [rawTemplates, lookup.roles, lookup.identities],
  );
  const selectedTemplate = templates.find(
    (template) => template.id === selectedTemplateId,
  );
  const [draft, setDraft] = useState<OpenViewReport>(() => {
    if (storedDraft.moduleId === moduleId) return clone(storedDraft);
    const moduleDefinition = getModuleDefinition(moduleId);
    return {
      ...decodeReport(initialReport, lookup),
      moduleId,
      fields: moduleDefinition.fields.slice(0, 3).map((field) => field.id),
      sorts: [{ field: moduleDefinition.primaryField, direction: "asc" }],
      grouping:
        moduleDefinition.fields.find((field) => field.id === "status")?.id ??
        null,
    };
  });
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState("");
  const [exportRequest, setExportRequest] = useState<ExportRequest | null>(
    null,
  );
  const dirty = selectedTemplate
    ? JSON.stringify(draft) !== JSON.stringify(selectedTemplate)
    : true;
  const rows = useMemo(
    () =>
      sortRows(
        filterRows(getOpenViewRows(draft.moduleId, records), draft.filters),
        draft.sorts,
      ),
    [draft, records],
  );
  const groups = useMemo(
    () => groupRows(rows, draft.grouping),
    [rows, draft.grouping],
  );
  const moduleDefinition = getModuleDefinition(draft.moduleId);
  const update = (change: Partial<OpenViewReport>) => {
    const next = { ...draft, ...change };
    setDraft(next);
    setRawDraft(toLegacyReport(next, lookup));
    setMessage("");
  };

  function saveTemplate() {
    const name = draft.name.trim();
    if (!name || draft.fields.length === 0) {
      setMessage(
        "Enter a report title and select at least one field before saving.",
      );
      return;
    }
    const next = { ...draft, name };
    const nextTemplates = templates.some((template) => template.id === next.id)
      ? templates.map((template) => (template.id === next.id ? next : template))
      : [...templates, next];
    setRawTemplates(
      nextTemplates.map((template) => toLegacyReport(template, lookup)),
    );
    setRawDraft(toLegacyReport(next, lookup));
    setSelectedTemplateId(next.id);
    setDraft(next);
    setMessage(
      "Report template saved in this tab. Audience and schedule remain previews.",
    );
  }

  function createTemplate() {
    const nextModule = getModuleDefinition(draft.moduleId);
    const next = {
      ...decodeReport(initialReport, lookup),
      id: makeId("sample-report"),
      name: "Untitled report",
      moduleId: draft.moduleId,
      fields: nextModule.fields.slice(0, 3).map((field) => field.id),
      grouping:
        nextModule.fields.find((field) => field.id === "status")?.id ?? null,
    };
    setDraft(next);
    setSelectedTemplateId("");
    setRawDraft(toLegacyReport(next, lookup));
    setMessage(
      "New report draft ready. Save it to create a reusable template.",
    );
  }

  function duplicateTemplate() {
    const next = {
      ...clone(draft),
      id: makeId("sample-report"),
      name: `${draft.name || "Report"} copy`,
    };
    setDraft(next);
    setSelectedTemplateId("");
    setRawDraft(toLegacyReport(next, lookup));
    setMessage("Report duplicated as a new draft.");
  }

  function chooseTemplate(id: string) {
    if (!id) return;
    if (dirty) setPendingTemplateId(id);
    else {
      const next = templates.find((template) => template.id === id);
      if (next) {
        setSelectedTemplateId(id);
        setDraft(clone(next));
        setRawDraft(toLegacyReport(next, lookup));
      }
    }
  }

  function updateModule(moduleId: OpenViewModuleId) {
    const nextModule = getModuleDefinition(moduleId);
    update({
      moduleId,
      fields: nextModule.fields.slice(0, 3).map((field) => field.id),
      filters: emptyFilters(),
      sorts: [{ field: nextModule.primaryField, direction: "asc" }],
      grouping:
        nextModule.fields.find((field) => field.id === "status")?.id ?? null,
    });
  }

  return (
    <Workbench
      controls={
        <FieldGroup>
          <div>
            <h2 className="font-semibold">Report builder</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Shape an operational report, then save the recipe for reuse.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="min-h-11"
              onClick={createTemplate}
            >
              <Plus data-icon="inline-start" />
              New report
            </Button>
            <Button
              variant="ghost"
              className="min-h-11"
              onClick={duplicateTemplate}
            >
              <Copy data-icon="inline-start" />
              Duplicate
            </Button>
          </div>
          {templates.length > 0 ? (
            <Choice
              id="report-template"
              label="Saved template"
              value={selectedTemplateId}
              values={[
                { value: "", label: "Choose a template" },
                ...templates.map((template) => ({
                  value: template.id,
                  label: template.name,
                })),
              ]}
              onChange={chooseTemplate}
            />
          ) : null}
          <Choice
            id="report-module"
            label="Source module"
            value={draft.moduleId}
            values={OPENVIEW_MODULES.map((item) => ({
              value: item.id,
              label: item.name,
            }))}
            onChange={(moduleId) => updateModule(moduleId as OpenViewModuleId)}
          />
          <Field>
            <FieldLabel htmlFor="report-title">Report title</FieldLabel>
            <Input
              id="report-title"
              className="min-h-11"
              value={draft.name}
              maxLength={80}
              onChange={(event) => update({ name: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="report-subtitle">Subtitle</FieldLabel>
            <Input
              id="report-subtitle"
              className="min-h-11"
              value={draft.subtitle}
              maxLength={160}
              placeholder="Optional context for readers"
              onChange={(event) => update({ subtitle: event.target.value })}
            />
          </Field>
          <FieldSet>
            <FieldLegend>Report fields</FieldLegend>
            <p className="text-muted-foreground text-sm">
              Check fields, then use the arrows to set column order.
            </p>
            <FieldGroup>
              {moduleDefinition.fields.map((field) => (
                <Field
                  key={field.id}
                  className="min-h-11 flex-row items-center gap-3"
                >
                  <Checkbox
                    id={`report-field-${field.id}`}
                    className="size-5 after:-inset-3"
                    checked={draft.fields.includes(field.id)}
                    onCheckedChange={(checked) => {
                      const fields = checked
                        ? [...draft.fields, field.id]
                        : draft.fields.filter((item) => item !== field.id);
                      update({ fields });
                    }}
                  />
                  <FieldLabel htmlFor={`report-field-${field.id}`}>
                    {field.label}
                  </FieldLabel>
                  {draft.fields.includes(field.id) ? (
                    <ButtonGroup className="ml-auto">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="min-h-11 min-w-11"
                        disabled={draft.fields.indexOf(field.id) === 0}
                        aria-label={`Move ${field.label} up`}
                        onClick={() => {
                          const index = draft.fields.indexOf(field.id);
                          const fields = [...draft.fields];
                          [fields[index - 1], fields[index]] = [
                            fields[index],
                            fields[index - 1],
                          ];
                          update({ fields });
                        }}
                      >
                        <ArrowUp data-icon="inline-start" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="min-h-11 min-w-11"
                        disabled={
                          draft.fields.indexOf(field.id) ===
                          draft.fields.length - 1
                        }
                        aria-label={`Move ${field.label} down`}
                        onClick={() => {
                          const index = draft.fields.indexOf(field.id);
                          const fields = [...draft.fields];
                          [fields[index + 1], fields[index]] = [
                            fields[index],
                            fields[index + 1],
                          ];
                          update({ fields });
                        }}
                      >
                        <ArrowDown data-icon="inline-start" />
                      </Button>
                    </ButtonGroup>
                  ) : null}
                </Field>
              ))}
            </FieldGroup>
          </FieldSet>
          <FilterEditor
            moduleId={draft.moduleId}
            rows={getOpenViewRows(draft.moduleId, records)}
            filters={draft.filters}
            onChange={(filters) => update({ filters })}
            title="Report filters"
          />
          <SortEditor
            moduleId={draft.moduleId}
            sorts={draft.sorts}
            onChange={(sorts) => update({ sorts })}
          />
          <Choice
            id="report-grouping"
            label="Group rows by"
            value={draft.grouping ?? "none"}
            values={[
              { value: "none", label: "Do not group" },
              ...moduleDefinition.fields.map((field) => ({
                value: field.id,
                label: field.label,
              })),
            ]}
            onChange={(grouping) =>
              update({ grouping: grouping === "none" ? null : grouping })
            }
          />
          <Field className="min-h-11 flex-row items-center gap-3">
            <Checkbox
              id="report-totals"
              className="size-5 after:-inset-3"
              checked={draft.totals}
              onCheckedChange={(totals) => update({ totals: Boolean(totals) })}
            />
            <FieldLabel htmlFor="report-totals">Show group totals</FieldLabel>
          </Field>
          <Choice
            id="report-schedule"
            label="Schedule preview"
            value={draft.schedule.cadence}
            values={[
              { value: "manual", label: "Manual" },
              { value: "daily", label: "Daily" },
              { value: "weekly", label: "Weekly" },
              { value: "monthly", label: "Monthly" },
            ]}
            onChange={(cadence) =>
              update({
                schedule: {
                  ...draft.schedule,
                  cadence: cadence as OpenViewReport["schedule"]["cadence"],
                },
              })
            }
            description="No report delivery or background job runs here."
          />
          <Choice
            id="report-timezone"
            label="Timezone"
            value={draft.schedule.timezone}
            values={["Asia/Manila", "Asia/Singapore", "UTC"]}
            onChange={(timezone) =>
              update({ schedule: { ...draft.schedule, timezone } })
            }
          />
          <AudienceField
            id="report-audience"
            audience={draft.audience}
            roles={roles}
            people={people}
            onChange={(audience) => update({ audience })}
          />
          <Button className="min-h-11" onClick={saveTemplate}>
            <Save data-icon="inline-start" />
            {dirty ? "Save template" : "Saved"}
          </Button>
        </FieldGroup>
      }
    >
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle className="mt-2 text-2xl">
                {draft.name || "Untitled report"}
              </CardTitle>
              {draft.subtitle ? (
                <CardDescription className="mt-2">
                  {draft.subtitle}
                </CardDescription>
              ) : null}
              <p className="text-muted-foreground mt-2 text-sm">
                Source: {moduleDefinition.name} · {rows.length} matching records
                · Snapshot: {formatSampleSnapshotDate()} ·{" "}
                {OPENVIEW_SAMPLE_TIMEZONE} ·{" "}
                {scheduleLabels[draft.schedule.cadence]} preview · schedule
                timezone: {draft.schedule.timezone}
              </p>
              <p className="text-muted-foreground mt-2 max-w-3xl text-sm">
                Synthetic sample data for local planning only; it is not a live
                report and will not be delivered automatically.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={
                  draft.audience.kind === "everyone" ||
                  isUnresolvedAudience(draft.audience)
                    ? "warning"
                    : "secondary"
                }
              >
                {audienceLabel(draft.audience, lookup)}
              </Badge>
              <Badge variant="outline">{dirty ? "Draft" : "Saved"}</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {draft.fields.length === 0 ? (
            <EmptyState
              icon={<FileText />}
              title="Choose fields for this report"
              description="Select at least one field from the builder to render a report preview."
            />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<FileText />}
              title="No matching records"
              description="Try clearing a filter or choosing another source module."
            />
          ) : (
            <ReportTable report={draft} groups={groups} rows={rows} />
          )}
          <Separator className="my-6" />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold">Local export</h3>
              <p className="text-muted-foreground text-sm">
                Exports include only this preview, its selected fields, and its
                current filters.
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                Snapshot: {formatSampleSnapshotDate()} ·{" "}
                {OPENVIEW_SAMPLE_TIMEZONE} · synthetic data; nothing is uploaded
                or delivered.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                className="min-h-11"
                disabled={draft.fields.length === 0 || rows.length === 0}
                onClick={() =>
                  setExportRequest({
                    kind: "csv",
                    title: draft.name || "OpenView report",
                    source: moduleDefinition.name,
                    subtitle: draft.subtitle,
                    fields: draft.fields,
                    fieldLabels: Object.fromEntries(
                      draft.fields.map((field) => [
                        field,
                        fieldLabel(draft.moduleId, field),
                      ]),
                    ),
                    rows,
                    filters: draft.filters,
                    grouping: draft.grouping,
                    totals: draft.totals,
                  })
                }
              >
                <Download data-icon="inline-start" />
                Download CSV
              </Button>
              <Button
                variant="outline"
                className="min-h-11"
                disabled={draft.fields.length === 0 || rows.length === 0}
                onClick={() =>
                  setExportRequest({
                    kind: "pdf",
                    title: draft.name || "OpenView report",
                    source: moduleDefinition.name,
                    subtitle: draft.subtitle,
                    fields: draft.fields,
                    fieldLabels: Object.fromEntries(
                      draft.fields.map((field) => [
                        field,
                        fieldLabel(draft.moduleId, field),
                      ]),
                    ),
                    rows,
                    filters: draft.filters,
                    grouping: draft.grouping,
                    totals: draft.totals,
                    groups: draft.grouping ? groups : undefined,
                  })
                }
              >
                <Printer data-icon="inline-start" />
                Print / save PDF
              </Button>
            </div>
          </div>
          {message ? (
            <Alert
              variant={message.includes("before") ? "warning" : "success"}
              className="mt-5"
            >
              {message}
            </Alert>
          ) : null}
        </CardContent>
        <CardFooter className="flex-wrap justify-between">
          <p className="text-muted-foreground text-xs">
            Audience, schedule, and refresh settings are sample previews; no
            invitations or delivery jobs run.
          </p>
          <Button
            variant="destructive"
            className="min-h-11"
            disabled={!selectedTemplate}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 data-icon="inline-start" />
            Delete template
          </Button>
        </CardFooter>
      </Card>
      <ExportConfirmation
        request={exportRequest}
        onClose={() => setExportRequest(null)}
        onComplete={(result) => {
          setExportRequest(null);
          setMessage(result);
        }}
      />
      <AlertDialog
        open={pendingTemplateId !== null}
        onOpenChange={(open) => !open && setPendingTemplateId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard report changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your current report draft has unsaved changes. Loading a template
              will replace it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setPendingTemplateId(null)}
            >
              Keep editing
            </Button>
            <Button
              className="min-h-11"
              onClick={() => {
                if (pendingTemplateId) {
                  const next = templates.find(
                    (template) => template.id === pendingTemplateId,
                  );
                  if (next) {
                    setSelectedTemplateId(next.id);
                    setDraft(clone(next));
                    setRawDraft(toLegacyReport(next, lookup));
                  }
                }
                setPendingTemplateId(null);
              }}
            >
              Discard and load
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete “{selectedTemplate?.name}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the saved report template from this tab. It does not
              remove source records.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              onClick={() => {
                if (!selectedTemplate) return;
                const remaining = templates.filter(
                  (template) => template.id !== selectedTemplate.id,
                );
                setRawTemplates(
                  remaining.map((template) => toLegacyReport(template, lookup)),
                );
                setSelectedTemplateId("");
                const next = normalizeReportRecord(initialReport, lookup);
                setDraft(next);
                setRawDraft(toLegacyReport(next, lookup));
                setConfirmDelete(false);
                setMessage("Report template deleted from this tab.");
              }}
            >
              Delete template
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Workbench>
  );
}

function ReportTable({
  report,
  groups,
  rows,
}: {
  report: OpenViewReport;
  groups: { label: string; rows: OpenViewRow[] }[];
  rows: OpenViewRow[];
}) {
  return (
    <Table className="min-w-[38rem]">
      <TableCaption className="sr-only">
        {rows.length} matching records from{" "}
        {getModuleDefinition(report.moduleId).name}.
      </TableCaption>
      <TableHeader className="bg-muted/65">
        <TableRow className="hover:bg-muted/65">
          {report.fields.map((field) => (
            <TableHead
              key={field}
              className="px-4 text-[0.6875rem] font-semibold tracking-wide uppercase"
            >
              {fieldLabel(report.moduleId, field)}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group, groupIndex) => (
          <Fragment key={group.label}>
            {report.grouping ? (
              <TableRow className="hover:bg-muted/60 bg-muted/45">
                <TableHead colSpan={report.fields.length} className="px-4">
                  <span className="flex items-center gap-2">
                    <span
                      className="size-2 rounded-full"
                      style={{
                        backgroundColor: `var(--chart-${(groupIndex % 5) + 1})`,
                      }}
                      aria-hidden="true"
                    />
                    <span className="font-semibold">{group.label}</span>
                    <span className="text-muted-foreground font-normal">
                      {group.rows.length}{" "}
                      {group.rows.length === 1 ? "record" : "records"}
                    </span>
                  </span>
                </TableHead>
              </TableRow>
            ) : null}
            {group.rows.map((row) => (
              <TableRow key={row.id} className="odd:bg-muted/15">
                {report.fields.map((field, fieldIndex) => (
                  <TableCell
                    key={`${row.id}-${field}`}
                    className={cn(
                      "px-4",
                      fieldIndex === 0 ? "font-medium" : undefined,
                    )}
                  >
                    {valueFor(row, field)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {report.totals && report.grouping ? (
              <TableRow className="bg-muted/20">
                <TableCell
                  colSpan={report.fields.length}
                  className="px-4 text-right text-xs font-medium"
                >
                  Group total: {group.rows.length}
                </TableCell>
              </TableRow>
            ) : null}
          </Fragment>
        ))}
      </TableBody>
      {report.totals ? (
        <TableFooter>
          <TableRow>
            <TableCell
              colSpan={report.fields.length}
              className="px-4 text-right font-semibold"
            >
              Grand total: {rows.length}
            </TableCell>
          </TableRow>
        </TableFooter>
      ) : null}
    </Table>
  );
}

type SampleAnalyticsProps = {
  section: string;
  records: SampleRecord[];
  rows?: OpenViewRow[];
  module?: OpenViewModule;
  config?: unknown;
  audienceLookup?: AudienceLookup;
  moduleId?: OpenViewModuleId;
  dashboardUrlId?: string;
  onDashboardUrlChange?: (id: string | undefined) => void;
  onDashboardDirtyChange?: (dirty: boolean) => void;
};

export default function SampleAnalytics({
  section,
  records,
  module: selectedModule,
  moduleId,
  dashboardUrlId,
  onDashboardUrlChange,
  onDashboardDirtyChange,
}: SampleAnalyticsProps) {
  const normalized = section.toLowerCase();
  const startingModule = selectedModule?.id ?? moduleId ?? "service-requests";
  if (normalized === "dashboards")
    return (
      <Dashboards
        records={records}
        moduleId={startingModule}
        dashboardUrlId={dashboardUrlId}
        onDashboardUrlChange={onDashboardUrlChange}
        onDashboardDirtyChange={onDashboardDirtyChange}
      />
    );
  if (normalized === "charts")
    return <Charts records={records} moduleId={startingModule} />;
  if (normalized === "reports")
    return <Reports records={records} moduleId={startingModule} />;
  return (
    <Alert variant="warning">
      Choose Dashboards, Charts, or Reports to open an analytics workspace.
    </Alert>
  );
}
