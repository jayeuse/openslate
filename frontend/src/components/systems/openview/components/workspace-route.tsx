"use client";

import { Suspense } from "react";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { usePathname, useSearchParams } from "next/navigation";
import { parseOpenViewUrl } from "../domain/model";
import { OpenViewQuerySync } from "./openview-query-sync";
import { OpenViewLoading } from "./openview-skeletons";
import ServerBackedCharts from "./server-backed-charts";
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
  else if (section === "charts") content = <ServerBackedCharts />;
  else if (section === "dashboards") content = <ServerBackedDashboards />;
  else if (section === "reports") content = <ServerBackedReports />;
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
