"use client";

import { Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { OPENVIEW_MODULES, parseOpenViewUrl } from "../domain/model";
import SampleOpenViewContent, { OpenViewLoading } from "./sample-workspace";
import ServerBackedCharts from "./server-backed-charts";
import ServerBackedDashboards from "./server-backed-dashboards";
import ServerBackedReports from "./server-backed-reports";
import ServerBackedViewsWorkspace from "./server-backed-views-workspace";

function OpenViewRouteContent() {
  const pathname = usePathname();
  const query = useSearchParams();
  const urlState = parseOpenViewUrl(`${pathname}?${query.toString()}`);
  const isLegacySampleRecordLink = Boolean(
    urlState.section === "views" &&
    urlState.record?.startsWith("sample-") &&
    OPENVIEW_MODULES.some((module) => module.id === urlState.module),
  );
  if (isLegacySampleRecordLink) return <SampleOpenViewContent />;
  if (urlState.section === "views") {
    return (
      <ServerBackedViewsWorkspace invalidUrl={Boolean(urlState.invalid)} />
    );
  }
  if (urlState.section === "charts") return <ServerBackedCharts />;
  if (urlState.section === "dashboards") return <ServerBackedDashboards />;
  if (urlState.section === "reports") return <ServerBackedReports />;
  return <SampleOpenViewContent />;
}

export default function OpenViewRoute() {
  return (
    <Suspense fallback={<OpenViewLoading />}>
      <OpenViewRouteContent />
    </Suspense>
  );
}
