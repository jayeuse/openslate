"use client";

import { Suspense } from "react";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { usePathname, useSearchParams } from "next/navigation";
import { parseOpenViewUrl } from "../domain/model";
import { OpenViewQuerySync } from "./openview-query-sync";
import { OpenViewLoading } from "./openview-skeletons";
import ServerBackedDashboards from "./server-backed-dashboards";
import ServerBackedReports from "./server-backed-reports";
import ServerBackedViewsWorkspace, {
  OpenViewHeader,
} from "./server-backed-views-workspace";

function OpenViewRouteContent() {
  const pathname = usePathname();
  const query = useSearchParams();
  const urlState = parseOpenViewUrl(`${pathname}?${query.toString()}`);
  const isLegacySampleRecordLink = Boolean(
    urlState.section === "views" && urlState.record?.startsWith("sample-"),
  );
  const section = isLegacySampleRecordLink ? null : urlState.section;
  let content;
  if (section === "views")
    content = (
      <ServerBackedViewsWorkspace invalidUrl={Boolean(urlState.invalid)} />
    );
  // The Charts page is gone (BD10): its links open a department dashboard
  // with the builder's saved-chart list.
  else if (section === "dashboards" || section === "charts")
    content = <ServerBackedDashboards />;
  else if (section === "reports")
    content = (
      <ServerBackedReports
        reportId={urlState.report}
        runId={urlState.run}
        invalidUrl={Boolean(urlState.invalidReportSelection)}
      />
    );
  else
    content = (
      <div className="flex min-w-0 flex-col gap-5">
        <OpenViewHeader />
        <Alert className="flex flex-wrap items-center justify-between gap-3">
          <p>This example record is not in OpenView</p>
          <Link
            href="/openview?section=views"
            className="text-action-text inline-flex min-h-11 items-center font-medium underline underline-offset-4"
          >
            Views
          </Link>
        </Alert>
      </div>
    );
  // The sync keeps its place ahead of the section, so it stays mounted while
  // the section changes. It holds the shared stream only for the sections
  // that read through the cache; Dashboards and example notices open none.
  return (
    <>
      <OpenViewQuerySync
        active={section === "views" || section === "reports"}
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
