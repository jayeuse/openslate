"use client";

import type { Ref } from "react";
import { AlertTriangle, HardDrive } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";

import { backupStatusFacts } from "../domain/backup-rules";
import type { useManageMaintenance } from "../state/controller";
import { formatBackupTime, useWorkspaceRegion } from "./backup-time";

type Maintenance = ReturnType<typeof useManageMaintenance>;

/**
 * Summary first (MD8): one panel of label-left facts (Schedule, Last good
 * backup, Service, Queue), with Back up now as the section's one primary
 * action and a quiet Edit schedule. A service that needs attention says so
 * in one warning line. After a refusal or a failed read both actions stay
 * disabled and say why (M-F15).
 */
export function BackupStatusPanel({
  maintenance,
  backUpRef,
  scheduleRef,
  onBackUp,
  onEditSchedule,
}: {
  maintenance: Maintenance;
  backUpRef: Ref<HTMLButtonElement>;
  scheduleRef: Ref<HTMLButtonElement>;
  onBackUp: () => void;
  onEditSchedule: () => void;
}) {
  const region = useWorkspaceRegion();
  const status = maintenance.acceptedStatus;
  const facts = status
    ? backupStatusFacts(status, maintenance.acceptedLastGood, (value) =>
        formatBackupTime(value, region),
      )
    : null;
  const reason = maintenance.actionsReason;
  const ready = Boolean(status) && !reason;
  return (
    <section
      aria-label="Backup status"
      className="bg-card border-border min-w-0 shrink-0 rounded-[var(--radius)] border"
    >
      <div className="border-border flex min-h-14 flex-wrap items-center gap-2 border-b px-4 py-2">
        <h2 data-slot="section-title" className="mr-auto font-semibold">
          Status
        </h2>
        {maintenance.dirty ? (
          <Badge variant="warning">Unsaved changes</Badge>
        ) : null}
        <DisabledReason reason={reason}>
          <Button
            ref={scheduleRef}
            type="button"
            variant="ghost"
            className="min-h-11"
            disabled={!ready}
            onClick={onEditSchedule}
          >
            Edit schedule
          </Button>
        </DisabledReason>
        <DisabledReason reason={reason}>
          <Button
            ref={backUpRef}
            type="button"
            className="min-h-11 gap-2"
            disabled={!ready}
            onClick={onBackUp}
          >
            <HardDrive data-icon="inline-start" /> Back up now
          </Button>
        </DisabledReason>
      </div>
      {facts ? (
        <div className="px-4 py-2">
          <dl className="grid min-w-0 gap-x-6 text-sm lg:grid-cols-2">
            {(
              [
                ["Schedule", facts.schedule],
                ["Last good backup", facts.lastGood],
                [
                  "Service",
                  <>
                    <span>{facts.service.state}</span>
                    {` · ${facts.service.detail}`}
                  </>,
                ],
                ["Queue", facts.queue],
              ] as const
            ).map(([label, value]) => (
              <div
                key={label}
                className="grid min-w-0 grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-3 py-1.5 sm:grid-cols-[8.5rem_minmax(0,1fr)]"
              >
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0 tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          {facts.warning ? (
            <p
              data-testid="backup-service-warning"
              className="text-warn-text flex items-start gap-2 pt-1 pb-1.5 text-sm"
            >
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4" />
              {facts.warning}
            </p>
          ) : null}
        </div>
      ) : maintenance.status.isError || maintenance.policyRefused ? (
        <div className="p-3">
          <Alert role="alert" variant="destructive">
            <p>
              {maintenance.policyRefused
                ? "Only the installation owner can review backup status."
                : "Backup status could not be loaded."}
            </p>
            <Button
              variant="outline"
              className="mt-2 min-h-11"
              onClick={() => void maintenance.retryPolicy()}
            >
              Retry backup status
            </Button>
          </Alert>
        </div>
      ) : (
        <p role="status" className="text-muted-foreground px-4 py-3 text-sm">
          Loading backup status…
        </p>
      )}
    </section>
  );
}
