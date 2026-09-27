"use client";

import { Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { OPENVIEW_MODULES, parseOpenViewUrl } from "../domain/model";
import { OpenViewQuerySync } from "./openview-query-sync";
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
  const section = isLegacySampleRecordLink ? null : urlState.section;
  let content;
  if (section === "views")
    content = (
      <ServerBackedViewsWorkspace invalidUrl={Boolean(urlState.invalid)} />
    );
  else if (section === "charts") content = <ServerBackedCharts />;
  else if (section === "dashboards") content = <ServerBackedDashboards />;
  else if (section === "reports") content = <ServerBackedReports />;
  else content = <SampleOpenViewContent />;
  // The sync keeps its place ahead of the section, so it stays mounted while
  // the section changes. It holds the shared stream only for the sections
  // that read through the cache; Dashboards and sample content open none.
  return (
    <>
      <OpenViewQuerySync
        active={
          section === "views" || section === "charts" || section === "reports"
        }
      />
      {content}
    </>
  );
}

export default function OpenViewRoute() {
  return (
    <Suspense fallback={<OpenViewLoading />}>
      <OpenViewRouteContent />
    </Suspense>
  );
}
