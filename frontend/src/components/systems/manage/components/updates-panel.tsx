"use client";

import type { ReactNode } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { updateProcedureUrl } from "../adapters/backup-api";
import {
  LICENSE_WORDS,
  LIMITS_WORDS,
  latestReleaseWords,
  releaseCheckWords,
  versionWords,
} from "../domain/updates-rules";
import type { useManageMaintenance } from "../state/controller";
import { formatBackupTime, useWorkspaceRegion } from "./backup-time";

const linkClassName =
  "text-action-text inline-flex min-h-11 items-center gap-1 underline-offset-4 hover:underline xl:min-h-0";

/**
 * Updates & licensing (MD10): one summary of label-left rows (Version,
 * Release check, Latest release, License, Limits), with a quiet Refresh
 * release status and the Update procedure link in its header. The header
 * meta line already says who installs updates.
 */
export function UpdatesPanel({
  maintenance,
}: {
  maintenance: ReturnType<typeof useManageMaintenance>;
}) {
  const version = maintenance.acceptedVersion;
  const region = useWorkspaceRegion();
  const refreshing =
    maintenance.version.isFetching && !maintenance.version.isPending;
  const check = version
    ? releaseCheckWords(version, (value) => formatBackupTime(value, region))
    : null;
  const latest = version ? latestReleaseWords(version) : null;
  const rows: [string, ReactNode][] = [];
  if (version && check) {
    rows.push(["Version", versionWords(version)]);
    rows.push([
      "Release check",
      <>
        <span className="flex flex-wrap items-baseline gap-x-1">
          <span>{check.result}</span>
          {check.failure ? (
            <span className="text-muted-foreground">· {check.failure}</span>
          ) : null}
          {version.release_url ? (
            <>
              <span aria-hidden="true" className="text-muted-foreground">
                ·
              </span>
              <a
                href={version.release_url}
                target="_blank"
                rel="noreferrer"
                className={linkClassName}
              >
                Release notes
                <ExternalLink aria-hidden="true" className="size-3.5" />
              </a>
            </>
          ) : null}
        </span>
        <span className="text-muted-foreground block text-xs">
          {check.times}
        </span>
      </>,
    ]);
    if (latest) rows.push(["Latest release", latest]);
  }
  rows.push(["License", LICENSE_WORDS], ["Limits", LIMITS_WORDS]);
  return (
    <section
      aria-labelledby="manage-updates-heading"
      className="bg-card border-border min-w-0 shrink-0 rounded-[var(--radius)] border"
    >
      <div className="border-border flex min-h-14 flex-wrap items-center gap-x-2 border-b px-4 py-2">
        <h2
          id="manage-updates-heading"
          data-slot="section-title"
          className="mr-auto font-semibold"
        >
          Installation
        </h2>
        {refreshing ? (
          <span role="status" className="text-muted-foreground text-sm">
            Checking release status…
          </span>
        ) : null}
        <a
          href={updateProcedureUrl}
          target="_blank"
          rel="noreferrer"
          className={linkClassName}
        >
          Update procedure for this release
          <ExternalLink aria-hidden="true" className="size-3.5" />
        </a>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 gap-2 max-sm:-ml-4"
          aria-busy={refreshing}
          disabled={maintenance.version.isFetching}
          onClick={() => void maintenance.refreshVersion()}
        >
          <RefreshCw
            data-icon="inline-start"
            aria-hidden="true"
            className={refreshing ? "motion-safe:animate-spin" : undefined}
          />
          Refresh release status
        </Button>
      </div>
      <div className="px-4 py-2">
        {maintenance.versionRefused || maintenance.version.isError ? (
          <Alert role="alert" variant="destructive" className="my-1.5">
            {maintenance.versionRefused
              ? "Only administrators can review version status."
              : "Version status could not be loaded. Try again."}
          </Alert>
        ) : !version && maintenance.version.isPending ? (
          <p role="status" className="text-muted-foreground py-1.5 text-sm">
            Loading version status…
          </p>
        ) : null}
        <dl className="grid min-w-0 text-sm">
          {rows.map(([label, value]) => (
            <div
              key={label}
              className="grid min-w-0 grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-3 py-1.5 sm:grid-cols-[8.5rem_minmax(0,1fr)]"
            >
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
