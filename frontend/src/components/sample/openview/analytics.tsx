"use client";

import { useState, type ReactNode } from "react";
import { z } from "zod";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useSampleState } from "@/components/sample/sample-state";
import { initialRoles, initialPeople } from "../access/model";
import type { SampleRecord } from "@/components/sample/sample-data";
import { WidgetSurface, newWidget, type SampleWidget } from "./widgets";

export type Dashboard = {
  id: string;
  name: string;
  permission: string;
  refresh: string;
  widgets: SampleWidget[];
};
export type Report = {
  name: string;
  fields: string[];
  grouping: string;
  totals: boolean;
  schedule: string;
  audience: string;
};
const reportSchema = z.object({
  name: z.string(),
  fields: z.array(
    z.enum(["title", "customer", "status", "assignee", "dueDate"]),
  ),
  grouping: z.string(),
  totals: z.boolean(),
  schedule: z.string(),
  audience: z.string(),
});
export function normalizeReports(raw: unknown): Report[] {
  return Array.isArray(raw)
    ? raw.flatMap((value) => {
        const result = reportSchema.safeParse(value);
        return result.success ? [result.data] : [];
      })
    : [];
}
export const initialReport: Report = {
  name: "Weekly service review",
  fields: ["title", "status", "assignee"],
  grouping: "status",
  totals: true,
  schedule: "Manual",
  audience: "Only me",
};
export const initialDashboards: Dashboard[] = [
  {
    id: "sample-dashboard-operations",
    name: "Operations pulse",
    permission: "Everyone",
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
const fieldNames: Record<string, string> = {
  title: "Request",
  customer: "Customer",
  status: "Status",
  assignee: "Assignee",
  dueDate: "Due date",
};
function Choice({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: string;
  values: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="block space-y-2 text-xs font-medium">
      {label}
      <Select aria-label={label} value={value} onValueChange={onChange}>
        {values.map((v) => (
          <option key={v}>{v}</option>
        ))}
      </Select>
    </label>
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
    <div className="grid gap-6 lg:grid-cols-[250px_minmax(0,1fr)]">
      <aside className="bg-card space-y-5 rounded-xl border p-5">
        {controls}
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export default function SampleAnalytics({
  section,
  records,
}: {
  section: string;
  records: SampleRecord[];
}) {
  return section === "Dashboards" ? (
    <Dashboards records={records} />
  ) : section === "Charts" ? (
    <Charts records={records} />
  ) : (
    <Reports records={records} />
  );
}

function Dashboards({ records }: { records: SampleRecord[] }) {
  const [roles] = useSampleState("access-roles", initialRoles);
  const [dashboards, setDashboards] = useSampleState<Dashboard[]>(
    "views-dashboards",
    initialDashboards,
  );
  const [selected, setSelected] = useSampleState(
    "views-dashboard-selected",
    "sample-dashboard-operations",
  );
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [widgetType, setWidgetType] = useState("Summary");
  const emptyDashboard: Dashboard = {
    id: "sample-dashboard-empty",
    name: "New dashboard",
    permission: "Only me",
    refresh: "Manual",
    widgets: [],
  };
  const dashboard =
    dashboards.find((item) => item.id === selected) ??
    dashboards[0] ??
    emptyDashboard;
  function update(change: Partial<Dashboard>) {
    setDashboards(
      (dashboards.length ? dashboards : [emptyDashboard]).map((item) =>
        item.id === dashboard.id ? { ...item, ...change } : item,
      ),
    );
  }
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <label className="min-w-56 space-y-2 text-xs font-medium">
          Dashboard
          <Select value={dashboard.id} onValueChange={setSelected}>
            {(dashboards.length ? dashboards : [emptyDashboard]).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        </label>
        <Button onClick={() => setCreating(true)}>
          <Plus />
          Create dashboard
        </Button>
      </div>
      {creating && (
        <form
          className="flex flex-wrap items-end gap-3 rounded-xl border p-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            const id = `sample-dashboard-${crypto.randomUUID()}`;
            setDashboards([
              ...dashboards,
              {
                id,
                name: name.trim(),
                permission: "Only me",
                refresh: "Manual",
                widgets: [],
              },
            ]);
            setSelected(id);
            setCreating(false);
            setName("");
          }}
        >
          <label className="flex-1 space-y-2 text-sm">
            Dashboard name
            <Input
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <Button>Save dashboard</Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setCreating(false)}
          >
            Cancel
          </Button>
        </form>
      )}
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-48">
          <Choice
            label="Dashboard permission"
            value={dashboard.permission}
            values={["Only me", "Everyone", ...roles.map((role) => role.name)]}
            onChange={(permission) => update({ permission })}
          />
        </div>
        <div className="min-w-48">
          <Choice
            label="Dashboard refresh"
            value={dashboard.refresh}
            values={["Manual", "Every minute", "Every 5 minutes"]}
            onChange={(refresh) => update({ refresh })}
          />
        </div>
        <Button variant="outline" onClick={() => setAdding(true)}>
          <Plus />
          Add widget
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        Access and automatic refresh are sample configuration previews.
      </p>
      {adding && (
        <form
          className="flex flex-wrap items-end gap-3 rounded-xl border p-5"
          onSubmit={(event) => {
            event.preventDefault();
            update({ widgets: [...dashboard.widgets, newWidget(widgetType)] });
            setAdding(false);
          }}
        >
          <Choice
            label="Widget type"
            value={widgetType}
            values={["Summary", "Workload", "OpenView"]}
            onChange={setWidgetType}
          />
          <Button>Add to dashboard</Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setAdding(false)}
          >
            Cancel
          </Button>
        </form>
      )}
      <WidgetSurface
        widgets={dashboard.widgets}
        onChange={(widgets) => update({ widgets })}
        records={records}
      />
    </div>
  );
}

function Charts({ records }: { records: SampleRecord[] }) {
  const [settings, setSettings] = useSampleState("views-chart", {
    type: "Bar",
    source: "All service requests",
    aggregation: "Count",
    from: "",
    to: "",
  });
  const [preview, setPreview] = useState(false);
  const change = (partial: Partial<typeof settings>) => {
    setSettings({ ...settings, ...partial });
    setPreview(false);
  };
  const invalid = Boolean(
    settings.from && settings.to && settings.from > settings.to,
  );
  const filtered = records
    .map((record, index) => ({ ...record, hours: 2 + (index % 5) * 2 }))
    .filter(
      (record) =>
        (settings.source === "All service requests" ||
          record.status !== "Completed") &&
        (!settings.from || record.dueDate >= settings.from) &&
        (!settings.to || record.dueDate <= settings.to),
    );
  const series = [...new Set(filtered.map((record) => record.status))].map(
    (status) => {
      const items = filtered.filter((record) => record.status === status);
      const sum = items.reduce((total, record) => total + record.hours, 0);
      return {
        label: status,
        value:
          settings.aggregation === "Count"
            ? items.length
            : settings.aggregation === "Sum"
              ? sum
              : sum / items.length,
      };
    },
  );
  const unit =
    settings.aggregation === "Count" ? "requests" : "estimated hours";
  const max = Math.max(1, ...series.map((item) => item.value));
  const total = series.reduce((sum, item) => sum + item.value, 0);
  let cumulative = 0;
  const pie = series
    .map((item, index) => {
      const start = cumulative;
      cumulative += (item.value / Math.max(total, 1)) * 100;
      return `color-mix(in oklch, var(--foreground) ${90 - (index % 6) * 13}%, var(--background)) ${start}% ${cumulative}%`;
    })
    .join(",");
  return (
    <Workbench
      controls={
        <>
          <h2 className="text-sm font-semibold">Chart settings</h2>
          <Choice
            label="Chart type"
            value={settings.type}
            values={["Bar", "Line", "Pie"]}
            onChange={(type) => change({ type })}
          />
          <Choice
            label="Data source"
            value={settings.source}
            values={["All service requests", "Active service requests"]}
            onChange={(source) => change({ source })}
          />
          <Choice
            label="Aggregation"
            value={settings.aggregation}
            values={["Count", "Sum", "Average"]}
            onChange={(aggregation) => change({ aggregation })}
          />
          <label className="block space-y-2 text-xs font-medium">
            From date
            <Input
              type="date"
              value={settings.from}
              onChange={(event) => change({ from: event.target.value })}
            />
          </label>
          <label className="block space-y-2 text-xs font-medium">
            To date
            <Input
              type="date"
              value={settings.to}
              onChange={(event) => change({ to: event.target.value })}
            />
          </label>
          {invalid && (
            <p role="alert" className="text-destructive text-sm">
              End date must be on or after start date.
            </p>
          )}
          <Button
            variant="outline"
            className="w-full"
            disabled={invalid || !series.length}
            onClick={() => setPreview(true)}
          >
            Preview image export
          </Button>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Sum and average use illustrative estimates of 2–10 hours per
            request. These are sample values.
          </p>
        </>
      }
    >
      <section className="bg-card rounded-xl border p-6 sm:p-8">
        <p className="text-muted-foreground text-xs tracking-widest uppercase">
          Service intelligence
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">
          {settings.aggregation} by status
        </h2>
        <p className="text-muted-foreground mt-2 text-sm">
          {filtered.length} requests · {unit}
        </p>
        {invalid ? (
          <p className="text-muted-foreground py-16 text-center">
            Correct the date range to preview your chart.
          </p>
        ) : series.length === 0 ? (
          <p className="text-muted-foreground py-16 text-center">
            No requests in this date range.
          </p>
        ) : (
          <div
            className="my-10"
            aria-label={`${settings.type} chart of ${unit} by status`}
            role="img"
          >
            {settings.type === "Bar" ? (
              <div className="space-y-5">
                {series.map((item) => (
                  <div key={item.label}>
                    <div className="mb-2 flex justify-between gap-4 text-sm">
                      <span>{item.label}</span>
                      <span>
                        {item.value.toFixed(
                          settings.aggregation === "Average" ? 1 : 0,
                        )}
                      </span>
                    </div>
                    <div className="bg-muted h-8 rounded">
                      <div
                        className="bg-foreground/80 h-full rounded"
                        style={{ width: `${(item.value / max) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : settings.type === "Line" ? (
              <svg viewBox="0 0 600 230" className="w-full" aria-hidden="true">
                <path
                  d="M20 10 V200 H580"
                  fill="none"
                  stroke="currentColor"
                  opacity=".2"
                />
                <polyline
                  points={series
                    .map(
                      (item, index) =>
                        `${30 + (index * 540) / Math.max(series.length - 1, 1)},${190 - (item.value / max) * 160}`,
                    )
                    .join(" ")}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                />
                {series.map((item, index) => (
                  <circle
                    key={item.label}
                    cx={30 + (index * 540) / Math.max(series.length - 1, 1)}
                    cy={190 - (item.value / max) * 160}
                    r="5"
                    fill="currentColor"
                  />
                ))}
              </svg>
            ) : (
              <div
                className="mx-auto size-52 rounded-full border"
                style={{ background: `conic-gradient(${pie})` }}
              />
            )}
          </div>
        )}
        {!invalid && (
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Chart values in {unit}</caption>
            <thead>
              <tr className="border-b">
                <th className="py-3 font-medium">Status</th>
                <th className="py-3 text-right font-medium">
                  {settings.aggregation} ({unit})
                </th>
              </tr>
            </thead>
            <tbody>
              {series.map((item, index) => (
                <tr key={item.label} className="border-b last:border-0">
                  <td className="py-3">
                    {settings.type === "Pie" && (
                      <span
                        aria-hidden="true"
                        className="mr-2 inline-block size-3 rounded-full border"
                        style={{
                          background: `color-mix(in oklch, var(--foreground) ${90 - (index % 6) * 13}%, var(--background))`,
                        }}
                      />
                    )}
                    {item.label}
                  </td>
                  <td className="py-3 text-right tabular-nums">
                    {item.value.toFixed(
                      settings.aggregation === "Average" ? 1 : 0,
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {preview && (
          <div role="status" className="mt-6 border-t pt-5">
            <p className="text-sm font-medium">
              Image export preview — no file was downloaded.
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              PNG · {settings.type} chart · {series.length} groups · includes
              title and legend. The chart above is the sample export
              composition.
            </p>
            <Button
              variant="ghost"
              className="mt-2"
              onClick={() => setPreview(false)}
            >
              Close preview
            </Button>
          </div>
        )}
      </section>
    </Workbench>
  );
}

function Reports({ records }: { records: SampleRecord[] }) {
  const [roles] = useSampleState("access-roles", initialRoles);
  const [people] = useSampleState("access-people", initialPeople);
  const [report, setReport] = useSampleState<Report>(
    "views-report-draft",
    initialReport,
  );
  const [storedTemplates, setTemplates] = useSampleState<Report[]>(
    "views-report-templates",
    initialReportTemplates,
  );
  const templates = normalizeReports(storedTemplates);
  const [format, setFormat] = useState("PDF");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState(false);
  function update(change: Partial<Report>) {
    setReport({ ...report, ...change });
    setPreview(false);
  }
  const groups =
    report.grouping === "None"
      ? ["All requests"]
      : [
          ...new Set(
            records.map((record) =>
              String(record[report.grouping as keyof SampleRecord]),
            ),
          ),
        ];
  return (
    <Workbench
      controls={
        <>
          <h2 className="text-sm font-semibold">Report template</h2>
          {templates.length > 0 && (
            <label className="block space-y-2 text-xs">
              Saved templates
              <Select
                value=""
                onValueChange={(name) => {
                  const template = templates.find((item) => item.name === name);
                  if (template) setReport(template);
                }}
              >
                <option value="">Load a template</option>
                {templates.map((template) => (
                  <option key={template.name}>{template.name}</option>
                ))}
              </Select>
            </label>
          )}
          <label className="block space-y-2 text-xs font-medium">
            Report name
            <Input
              value={report.name}
              maxLength={80}
              onChange={(event) => update({ name: event.target.value })}
            />
          </label>
          <fieldset className="space-y-2">
            <legend className="mb-3 text-xs font-medium">Report fields</legend>
            {Object.entries(fieldNames).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={report.fields.includes(key)}
                  onChange={(event) =>
                    update({
                      fields: event.target.checked
                        ? [...report.fields, key]
                        : report.fields.filter((field) => field !== key),
                    })
                  }
                />
                {label}
              </label>
            ))}
          </fieldset>
          <Choice
            label="Report grouping"
            value={report.grouping}
            values={["None", "status", "assignee", "customer"]}
            onChange={(grouping) => update({ grouping })}
          />
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={report.totals}
              onChange={(event) => update({ totals: event.target.checked })}
            />
            Show group totals
          </label>
          <Choice
            label="Generation schedule"
            value={report.schedule}
            values={[
              "Manual",
              "Daily at 09:00",
              "Weekly on Monday at 09:00",
              "Monthly on the 1st at 09:00",
            ]}
            onChange={(schedule) => update({ schedule })}
          />
          <Choice
            label="Share report with"
            value={report.audience}
            values={[
              "Only me",
              ...roles.map((role) => `Role: ${role.name}`),
              ...people
                .filter((person) => person.active)
                .map((person) => `User: ${person.name}`),
            ]}
            onChange={(audience) => update({ audience })}
          />
          <Button
            className="w-full"
            onClick={() => {
              if (!report.name.trim() || report.fields.length === 0) {
                setMessage(
                  "Enter a report name and select at least one field.",
                );
                return;
              }
              setTemplates([
                ...templates.filter(
                  (template) => template.name !== report.name.trim(),
                ),
                { ...report, name: report.name.trim() },
              ]);
              setMessage(
                `Sample template saved. Audience: ${report.audience}. Schedule: ${report.schedule}. No report delivery is scheduled.`,
              );
            }}
          >
            Save report template
          </Button>
        </>
      }
    >
      <section className="bg-card rounded-xl border p-5 sm:p-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-muted-foreground text-xs tracking-widest uppercase">
              Sample report / Operations
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight">
              {report.name || "Untitled report"}
            </h2>
            <p className="text-muted-foreground mt-2 text-xs">
              Prepared from {records.length} synthetic service requests
            </p>
          </div>
          <div className="flex items-end gap-2">
            <Choice
              label="Export format"
              value={format}
              values={["PDF", "CSV", "XLSX"]}
              onChange={setFormat}
            />
            <Button
              variant="outline"
              disabled={!report.fields.length}
              onClick={() => setPreview(true)}
            >
              Preview export
            </Button>
          </div>
        </header>
        {report.fields.length === 0 ? (
          <p className="text-muted-foreground py-12 text-sm">
            Choose fields to build the report.
          </p>
        ) : (
          <div className="mt-8 space-y-8">
            {groups.map((group) => {
              const rows =
                report.grouping === "None"
                  ? records
                  : records.filter(
                      (record) =>
                        String(
                          record[report.grouping as keyof SampleRecord],
                        ) === group,
                    );
              return (
                <section key={group}>
                  <h3 className="mb-3 text-sm font-semibold">{group}</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="bg-muted/30 border-y">
                          {report.fields.map((field) => (
                            <th
                              key={field}
                              className="px-3 py-3 font-medium whitespace-nowrap"
                            >
                              {fieldNames[field]}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((record) => (
                          <tr key={record.id} className="border-b">
                            {report.fields.map((field) => (
                              <td key={field} className="px-3 py-3">
                                {record[field as keyof SampleRecord]}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {report.totals && (
                    <p className="mt-3 text-right text-xs font-medium">
                      Group total: {rows.length} requests
                    </p>
                  )}
                </section>
              );
            })}
            {report.totals && (
              <p className="border-t pt-4 text-right font-semibold">
                Grand total: {records.length} requests
              </p>
            )}
          </div>
        )}
        {message && (
          <p role="status" className="bg-muted mt-6 rounded-lg p-4 text-sm">
            {message}
          </p>
        )}
        {preview && (
          <div className="mt-6 rounded-lg border p-4" role="status">
            <p className="font-medium">
              {format} export preview — no file was downloaded.
            </p>
            <p className="text-muted-foreground mt-2 text-sm">
              {report.name} · {report.fields.length} columns · {records.length}{" "}
              rows.{" "}
              {format === "PDF"
                ? "The report above previews the document layout."
                : `The selected fields become ${format} columns, with ${report.totals ? "group totals included" : "no total rows"}.`}
            </p>
            <Button
              variant="ghost"
              className="mt-3"
              onClick={() => setPreview(false)}
            >
              Close export preview
            </Button>
          </div>
        )}
      </section>
    </Workbench>
  );
}
