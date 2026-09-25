"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  safeOpenViewFilename,
  serializeOpenViewCsv,
  type ChartSettings,
  type FilterGroup,
  type OpenViewRow,
} from "../domain/model";
import {
  formatSampleSnapshotDate,
  valueFor,
  type ChartDatum,
} from "./analytics-data";
import {
  OPENVIEW_SAMPLE_SNAPSHOT_DATE,
  OPENVIEW_SAMPLE_TIMEZONE,
} from "../helpers/operations";

export type ExportRequest = {
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
  const sampleContext = `Source: ${escapeHtml(request.source)} · ${request.rows.length} rows${dateContext} · Snapshot: ${escapeHtml(OPENVIEW_SAMPLE_SNAPSHOT_DATE)} · Timezone: ${escapeHtml(OPENVIEW_SAMPLE_TIMEZONE)} · Generated records; nothing is uploaded or delivered.`;
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
    `<!doctype html><html><head><title>${escapeHtml(request.title)}</title><link rel="stylesheet" href="/openview-print.css"></head><body><h1>${escapeHtml(request.title)}</h1>${subtitle}<p>${sampleContext}</p>${chartContent}</body></html>`,
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

export function serializeExportCsv(request: ExportRequest): string {
  const fields = request.fields.map((field) =>
    exportFieldLabel(request, field),
  );
  const displayRow = (row: OpenViewRow): OpenViewRow => ({
    ...row,
    values: Object.fromEntries(
      request.fields.map((field, index) => [
        fields[index] ?? field,
        row.values[field] ?? "",
      ]),
    ),
  });
  let rows = request.rows.map(displayRow);
  if (request.grouping && request.groups?.length && fields.length > 0) {
    const firstField = fields[0] ?? "";
    const moduleId = request.rows[0]?.moduleId ?? "service-requests";
    const summaryRow = (id: string, label: string): OpenViewRow => ({
      id,
      moduleId,
      values: Object.fromEntries(
        fields.map((field) => [field, field === firstField ? label : ""]),
      ),
    });
    rows = request.groups.flatMap((group, index) => [
      summaryRow(`export-group-${index}`, `Group: ${group.label}`),
      ...group.rows.map(displayRow),
      ...(request.totals
        ? [
            summaryRow(
              `export-group-total-${index}`,
              `Group total: ${group.rows.length}`,
            ),
          ]
        : []),
    ]);
    if (request.totals) {
      rows.push(
        summaryRow("export-grand-total", `Grand total: ${request.rows.length}`),
      );
    }
  }
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

export function ExportConfirmation({
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
            Review the selected records before exporting. No server upload or
            sharing occurs.
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
                <span className="text-muted-foreground">Snapshot</span>
                <strong className="text-right">
                  {formatSampleSnapshotDate()} · {OPENVIEW_SAMPLE_TIMEZONE}
                </strong>
              </div>
            </div>
            <p className="text-muted-foreground text-xs">
              This export contains generated records. Nothing is uploaded,
              shared, or scheduled.
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
                    "The print window was blocked. Allow pop-ups and try again.",
                  );
                  return;
                }
                onComplete(
                  request.kind === "csv"
                    ? "CSV downloaded from the selected records."
                    : "Print dialog opened for the selected records.",
                );
              } catch {
                setError(
                  "The export could not be prepared. Your records are unchanged.",
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
