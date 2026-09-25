"use client";

import { Alert } from "@/components/ui/alert";
import { Dashboards } from "./analytics-dashboards";
import { Charts } from "./analytics-charts";
import { Reports } from "./analytics-reports";
import type { AudienceLookup, OpenViewModuleId } from "../domain/model";
import type {
  OpenViewCommandController,
  OpenViewReadSnapshot,
} from "../adapters/controller";

export { normalizeReports, chartRows } from "./analytics-data";
export type { ChartDatum } from "./analytics-data";
export { serializeExportCsv } from "./analytics-export";
export type { ExportRequest } from "./analytics-export";

type SampleAnalyticsProps = {
  section: string;
  commands: OpenViewCommandController;
  snapshot: OpenViewReadSnapshot;
  audienceLookup: AudienceLookup;
  moduleId?: OpenViewModuleId;
  dashboardUrlId?: string;
  onDashboardUrlChange?: (id: string | undefined) => void;
  onDashboardDirtyChange?: (dirty: boolean) => void;
  onChartDirtyChange?: (dirty: boolean) => void;
  onReportDirtyChange?: (dirty: boolean) => void;
};

export default function SampleAnalytics({
  section,
  commands,
  moduleId,
  snapshot,
  audienceLookup,
  dashboardUrlId,
  onDashboardUrlChange,
  onDashboardDirtyChange,
  onChartDirtyChange,
  onReportDirtyChange,
}: SampleAnalyticsProps) {
  const normalized = section.toLowerCase();
  const startingModule = moduleId ?? "service-requests";
  if (normalized === "dashboards")
    return (
      <Dashboards
        moduleId={startingModule}
        dashboardUrlId={dashboardUrlId}
        commands={commands}
        snapshot={snapshot}
        audienceLookup={audienceLookup}
        onDashboardUrlChange={onDashboardUrlChange}
        onDashboardDirtyChange={onDashboardDirtyChange}
      />
    );
  if (normalized === "charts")
    return (
      <Charts
        moduleId={startingModule}
        commands={commands}
        snapshot={snapshot}
        onChartDirtyChange={onChartDirtyChange}
      />
    );
  if (normalized === "reports")
    return (
      <Reports
        moduleId={startingModule}
        commands={commands}
        snapshot={snapshot}
        audienceLookup={audienceLookup}
        onReportDirtyChange={onReportDirtyChange}
      />
    );
  return (
    <Alert variant="warning">
      Choose Dashboards, Charts, or Reports to open an analytics workspace.
    </Alert>
  );
}
