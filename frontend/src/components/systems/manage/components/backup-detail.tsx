"use client";

import { useEffect, useId, useState, type ReactNode, type Ref } from "react";
import { ChevronLeft, Copy, Download, ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { cn } from "@/lib/utils";

import {
  failureLabel,
  restoreProcedureUrl,
  type ManageBackupRun,
} from "../adapters/backup-api";
import {
  backupExportReason,
  backupScheduleAtRequest,
  shortSnapshotId,
} from "../domain/backup-rules";
import { BackupStatusWord } from "./backup-history-list";
import { formatBackupTime, useWorkspaceRegion } from "./backup-time";

// One backup's detail (MD8), after Sandbox History: the name, status and
// installation in the head; the facts as label-left rows; then the export
// action with its reason when it cannot run. Restoring stays a server-side
// procedure: the detail links to it and offers no browser restore.

function at(
  value: string | null,
  region: ReturnType<typeof useWorkspaceRegion>,
) {
  return value === null ? "—" : formatBackupTime(value, region);
}

export function BackupDetail({
  run,
  hidden,
  phone,
  headingRef,
  exportButtonRef,
  onPrepareExport,
  exportPending,
  onBack,
  children,
}: {
  run: ManageBackupRun | undefined;
  /** On phones the detail hides while the list shows. */
  hidden: boolean;
  phone: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  exportButtonRef: Ref<HTMLButtonElement>;
  /** Opens Prepare encrypted backup; absent for an account that may not export. */
  onPrepareExport: ((run: ManageBackupRun) => void) | null;
  exportPending: boolean;
  onBack: () => void;
  /** The routed encrypted backup, under the facts. */
  children?: ReactNode;
}) {
  const region = useWorkspaceRegion();
  const exportReasonId = useId();
  if (!run)
    return (
      <div
        className={cn(
          "bg-card border-border @container/detail flex min-w-0 flex-col gap-4 rounded-[var(--radius)] border xl:min-h-0 xl:overflow-y-auto",
          hidden && "hidden",
        )}
      >
        {phone ? <BackButton onBack={onBack} /> : null}
        {children ? (
          <div className="p-4">{children}</div>
        ) : (
          <Empty className="border-0 py-10">
            <EmptyHeader>
              <EmptyTitle>Select a backup to see its details.</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    );
  const exportReason = backupExportReason(run);
  const facts: [string, ReactNode][] = [
    ["Requested", at(run.requested_at, region)],
    [
      "Source",
      run.provenance === "manual" ? "Manual request" : "Scheduled request",
    ],
    ["Schedule at request", backupScheduleAtRequest(run)],
    ["Started", at(run.started_at, region)],
    ["Finished", at(run.finished_at, region)],
    ["Snapshot", run.snapshot_id ? <Snapshot id={run.snapshot_id} /> : "—"],
    [
      "Verification",
      run.verified_at
        ? `Verified · ${formatBackupTime(run.verified_at, region)}`
        : "Not verified",
    ],
    [
      "Restart / reconciliation",
      run.reconciled_at
        ? `Reconciled · ${formatBackupTime(run.reconciled_at, region)}`
        : "Not reconciled",
    ],
  ];
  if (run.failure_code) facts.push(["Failure", failureLabel(run.failure_code)]);
  if (run.expired_at)
    facts.push(["Confirmed expiry", formatBackupTime(run.expired_at, region)]);
  facts.push([
    "Restore",
    <span key="restore" className="block">
      <a
        href={restoreProcedureUrl}
        target="_blank"
        rel="noreferrer"
        className="text-action-text inline-flex min-h-11 items-center gap-1 underline-offset-4 hover:underline xl:min-h-0"
      >
        Restore procedure
        <ExternalLink aria-hidden="true" className="size-3.5" />
      </a>
      <span className="text-muted-foreground block text-xs">
        Use the procedure for this release. It may need repository access.
      </span>
    </span>,
  ]);
  return (
    <section
      aria-label="Selected backup"
      className={cn(
        "bg-card border-border @container/detail flex min-w-0 flex-col rounded-[var(--radius)] border xl:min-h-0 xl:overflow-clip",
        hidden && "hidden",
      )}
    >
      {phone ? <BackButton onBack={onBack} /> : null}
      <div className="border-border flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2">
        <h2
          ref={headingRef}
          tabIndex={-1}
          data-slot="section-title"
          title={run.name}
          className={cn(
            "min-w-0 text-lg font-semibold outline-none",
            phone ? "basis-full [overflow-wrap:anywhere]" : "truncate",
          )}
        >
          {run.name}
        </h2>
        <BackupStatusWord run={run} className="text-sm" />
        <span className="text-muted-foreground text-sm">
          {run.installation === "previous"
            ? "Previous installation · Read-only history"
            : "Current installation"}
        </span>
      </div>
      <div className="min-h-0 min-w-0 flex-1 space-y-4 p-4 xl:overflow-y-auto xl:overscroll-contain">
        <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm @min-[26rem]/detail:grid-cols-[10rem_minmax(0,1fr)]">
          {facts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-words tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        {onPrepareExport ? (
          <div>
            <DisabledReason reason={exportReason} reasonId={exportReasonId}>
              <Button
                ref={exportButtonRef}
                type="button"
                variant="outline"
                className="min-h-11 gap-2"
                disabled={exportPending}
                onClick={() => onPrepareExport(run)}
              >
                <Download data-icon="inline-start" />
                Prepare encrypted backup
              </Button>
            </DisabledReason>
            {exportReason ? (
              <p
                id={exportReasonId}
                className="text-muted-foreground mt-1.5 text-sm"
              >
                {exportReason}
              </p>
            ) : null}
          </div>
        ) : null}
        {children}
      </div>
    </section>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <div className="border-border border-b px-2 py-1">
      <Button variant="ghost" className="min-h-11 px-2" onClick={onBack}>
        <ChevronLeft aria-hidden="true" />
        <span className="sr-only">Back to </span>
        History
      </Button>
    </div>
  );
}

/** The short id with the full value in its title, and a copy button. */
function Snapshot({ id }: { id: string }) {
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 4000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1 gap-y-0">
      <code title={id} className="font-mono text-xs">
        {shortSnapshotId(id)}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 shrink-0"
        aria-label="Copy snapshot ID"
        onClick={() => {
          navigator.clipboard
            .writeText(id)
            .then(() => setCopied("copied"))
            .catch(() => setCopied("failed"));
        }}
      >
        <Copy aria-hidden="true" />
      </Button>
      <span role="status" className="text-muted-foreground text-xs">
        {copied === "copied"
          ? "Snapshot ID copied"
          : copied === "failed"
            ? "Copy failed. Select the ID instead."
            : ""}
      </span>
    </span>
  );
}
