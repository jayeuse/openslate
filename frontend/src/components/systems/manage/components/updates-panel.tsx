"use client";

import { Search } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { failureLabel, updateProcedureUrl } from "../adapters/backup-api";
import type { useManageMaintenance } from "../state/controller";
import { formatBackupTime, useWorkspaceRegion } from "./backup-time";

export function UpdatesPanel({
  maintenance,
}: {
  maintenance: ReturnType<typeof useManageMaintenance>;
}) {
  const version = maintenance.acceptedVersion;
  const region = useWorkspaceRegion();
  const statusText = version
    ? {
        unknown: version.observed_at
          ? "Version comparison unavailable"
          : "No release observation recorded",
        available: `Version ${version.latest_version} is available`,
        current: "Up to date",
        unavailable: "Release information unavailable",
        stale: "Release information is stale",
      }[version.status]
    : null;
  return (
    <section className="min-w-0 p-6" aria-labelledby="manage-updates-heading">
      <div className="flex flex-col gap-5">
        <h2
          data-slot="section-title"
          id="manage-updates-heading"
          className="text-xl font-semibold tracking-tight"
        >
          Software version
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">Stable channel</Badge>
          {version?.status === "current" ? (
            <Badge variant="success">Up to date</Badge>
          ) : null}
        </div>
        {maintenance.versionRefused || maintenance.version.isError ? (
          <Alert role="alert" variant="destructive">
            {maintenance.versionRefused
              ? "Only administrators can review version status."
              : "Version status could not be loaded. Try again."}
          </Alert>
        ) : maintenance.version.isPending ? (
          <p role="status">Loading version status…</p>
        ) : null}
        {version ? (
          <>
            <div className="border-border border-b pb-5">
              <p className="text-muted-foreground text-sm">Current version</p>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <p className="text-4xl font-semibold tabular-nums">
                  {version.current_version}
                </p>
                <span className="text-muted-foreground text-sm">
                  Running server
                </span>
              </div>
            </div>
            {version.status !== "current" ? (
              <Alert
                variant={version.status === "available" ? "warning" : "default"}
                role="status"
              >
                <p className="font-medium">{statusText}</p>
                {version.status === "stale" ||
                version.status === "unavailable" ? (
                  <p className="text-sm">
                    The last observation does not establish whether this
                    installation is current.
                  </p>
                ) : null}
              </Alert>
            ) : null}
          </>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={maintenance.version.isFetching}
            onClick={() => void maintenance.refreshVersion()}
          >
            <Search data-icon="inline-start" /> Refresh release status
          </Button>
          <Button asChild variant="outline" className="min-h-11">
            <a href={updateProcedureUrl} target="_blank" rel="noreferrer">
              Update procedure
            </a>
          </Button>
          {version?.release_url ? (
            <Button asChild variant="ghost" className="min-h-11">
              <a href={version.release_url} target="_blank" rel="noreferrer">
                Release notes
              </a>
            </Button>
          ) : null}
        </div>
        <p className="text-muted-foreground text-sm">
          Refresh release status shows the latest release check from your
          server. The person who runs your server installs updates with the
          procedure included with this release.
        </p>
        {version ? (
          <div className="border-border min-w-0 space-y-3 border-t pt-5">
            <h3 data-slot="section-title" className="font-semibold">
              Release check
            </h3>
            <dl className="text-muted-foreground space-y-2 text-sm">
              <div>
                <dt>Last successful check</dt>
                <dd>{formatBackupTime(version.observed_at, region)}</dd>
              </div>
              <div>
                <dt>Last attempt</dt>
                <dd>{formatBackupTime(version.checked_at, region)}</dd>
              </div>
              {version.failure_code ? (
                <div>
                  <dt>Failure</dt>
                  <dd className="break-words">
                    {failureLabel(version.failure_code)}
                  </dd>
                </div>
              ) : null}
              {version.latest_version && version.status !== "available" ? (
                <div>
                  <dt>Last observed release</dt>
                  <dd>{version.latest_version}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        ) : null}
      </div>
    </section>
  );
}
