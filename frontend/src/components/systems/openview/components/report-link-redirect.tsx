"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { getOpenViewReport } from "../adapters/reports-api";
import { serializeOpenViewUrl } from "../domain/model";
import { OpenViewLoading } from "./openview-skeletons";

/**
 * The Reports page is gone (DC8, DC9). An old link or a notification link,
 * `/openview?section=reports&report=<id>[&run=<id>]`, reads the report to find
 * its module, then opens that module page's Reports view with the report and
 * the copy. A report that is gone or not readable keeps its id in the
 * address, so the first readable module's Reports view says "This report is
 * not available." A link without a report opens that view as well.
 */
export function ReportLinkRedirect({
  reportId,
  runId,
}: {
  reportId: string | undefined;
  runId: string | undefined;
}) {
  const router = useRouter();
  useEffect(() => {
    let current = true;
    const fallback = serializeOpenViewUrl({
      section: "views",
      tab: "reports",
      report: reportId,
    });
    if (!reportId) {
      router.replace(fallback as Route, { scroll: false });
      return;
    }
    getOpenViewReport(reportId)
      .then((report) => {
        if (!current) return;
        router.replace(
          serializeOpenViewUrl({
            section: "views",
            module: report.moduleId,
            tab: "reports",
            report: report.id,
            copy: runId,
          }) as Route,
          { scroll: false },
        );
      })
      .catch(() => {
        if (current) router.replace(fallback as Route, { scroll: false });
      });
    return () => {
      current = false;
    };
  }, [reportId, runId, router]);
  // The page frame shows while the report is read (Risks: one read).
  return <OpenViewLoading />;
}
