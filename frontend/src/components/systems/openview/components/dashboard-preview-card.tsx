"use client";

import type {
  OpenViewDashboard,
  OpenViewWidgetSource,
} from "../adapters/dashboards-api";
import type { OpenViewDataSource } from "../adapters/views-api";
import type {
  DashboardWidgetData,
  DraftWidget,
} from "../domain/dashboard-draft";
import type { Size, WidgetKind } from "../domain/dashboard-grid";
import { cn } from "@/lib/utils";
import { DashboardWidgetCard } from "./dashboard-widget-card";

/** The widget as it shows at its size, from the last Update preview. */
export function PreviewCard({
  data,
  stale,
  kind,
  size,
  sources,
  departmentNames,
  dashboard,
  source,
}: {
  data: DashboardWidgetData | null;
  stale: boolean;
  kind: WidgetKind;
  size: Size | null;
  sources: readonly OpenViewDataSource[];
  departmentNames: ReadonlyMap<string, string>;
  dashboard: OpenViewDashboard | null;
  source?: OpenViewWidgetSource;
}) {
  const columns = size?.columns ?? 2;
  const rows = size?.rows ?? 2;
  const style = {
    width: `min(100%, ${columns * 15}rem)`,
    height: `${rows * 8.25 + (rows - 1) * 0.75}rem`,
  };
  if (!data)
    return (
      <div
        style={style}
        className="text-muted-foreground flex shrink-0 items-center justify-center rounded-lg border border-dashed p-4 text-center text-sm"
      >
        Update the preview to see this chart with your records.
      </div>
    );
  const widget = {
    ...(source ??
      ({
        widgetType: data.kind === "records" ? "records" : kindWidgetType(kind),
        chartId: null,
        config: data.config,
      } as OpenViewWidgetSource)),
    key: "preview",
    placement: { column: 0, row: 0, columnSpan: columns, rowSpan: rows },
  } as DraftWidget;
  return (
    <div style={style} className="relative flex shrink-0">
      {stale ? (
        // The last preview stays, dimmed, until the next Update preview.
        <p
          role="status"
          className="bg-popover absolute inset-x-3 top-12 z-10 rounded-md border px-3 py-2 text-center text-sm shadow-sm"
        >
          The setup changed. Update the preview.
        </p>
      ) : null}
      <div className={cn("flex flex-1", stale && "opacity-50")}>
        <DashboardWidgetCard
          widget={widget}
          kind={kind}
          dashboard={dashboard}
          sources={sources}
          departmentNames={departmentNames}
          read={{
            snapshot: {
              widgetKey: "preview",
              configSignature: "preview",
              data,
            },
            loading: false,
            error: "",
            locked: false,
          }}
          issues={[]}
          stacked={false}
          style={{ flex: 1 }}
          modeProps={{ mode: "view" }}
          refreshSignal={0}
          preview
        />
      </div>
    </div>
  );
}

function kindWidgetType(kind: WidgetKind): OpenViewWidgetSource["widgetType"] {
  if (kind === "number") return "summary";
  if (kind === "table") return "workload";
  if (kind === "records") return "records";
  return "chart";
}
