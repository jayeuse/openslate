"use client";

import { useId, type ReactNode } from "react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { Select, SelectItem } from "@/components/ui/select";

import {
  SandboxDialogFooter,
  SandboxDialogHeader,
  sandboxDialogContentClass,
} from "../../sandbox/components/sandbox-dialog-frame";
import { backupScheduleLabels } from "../adapters/backup-api";
import type { useManageMaintenance } from "../state/controller";
import { formatBackupTime, useWorkspaceRegion } from "./backup-time";

type Maintenance = ReturnType<typeof useManageMaintenance>;

const RETENTION_LABELS = {
  "7": "7 days",
  "30": "30 days",
  "90": "90 days",
} as const;

/**
 * The schedule dialog (MD8, layout direction 8): a pinned header with a
 * named close, label-left rows, and a pinned footer that shows Close at
 * rest and the Save bar only after an edit (M-F10).
 */
export function BackupScheduleDialog({
  maintenance,
  open,
  onOpenChange,
  finalFocus,
}: {
  maintenance: Maintenance;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  finalFocus: () => HTMLElement | null;
}) {
  const id = useId();
  const region = useWorkspaceRegion();
  const status = maintenance.acceptedStatus;
  const current = status
    ? { ...(maintenance.draftPolicy ?? status.policy), ...maintenance.draft }
    : null;
  const close = () => onOpenChange(false);
  const saveReason = maintenance.stale
    ? "Review the latest policy first."
    : maintenance.actionsReason;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      dismissible={!maintenance.pending}
    >
      <DialogContent
        className={`${sandboxDialogContentClass} max-w-xl`}
        finalFocus={finalFocus}
      >
        <SandboxDialogHeader
          title={<DialogTitle>Backup schedule</DialogTitle>}
          description={
            <DialogDescription>
              Choose when backups run and how long they are kept.
            </DialogDescription>
          }
          closeLabel="Close backup schedule"
          closeDisabled={maintenance.pending}
          onClose={close}
        />
        <form
          id={`${id}-form`}
          aria-busy={maintenance.pending}
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void maintenance.savePolicy();
          }}
        >
          {!status || !current ? (
            <Alert role="alert" variant="destructive">
              <p>
                {maintenance.policyRefused
                  ? "Only administrators can review backup status."
                  : "Backup status could not be loaded."}
              </p>
              <Button
                type="button"
                variant="outline"
                className="mt-2 min-h-11"
                onClick={() => void maintenance.retryPolicy()}
              >
                Retry backup status
              </Button>
            </Alert>
          ) : (
            <>
              {maintenance.stale ? (
                <Alert
                  role={maintenance.staleRevision ? "alert" : "status"}
                  variant={
                    maintenance.staleRevision ? "destructive" : "warning"
                  }
                >
                  <p>
                    Backup policy changed. Your draft is still here. Review the
                    latest policy before saving again.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-2 min-h-11"
                    disabled={maintenance.pending}
                    onClick={() => void maintenance.reviewLatestPolicy()}
                  >
                    Review latest policy
                  </Button>
                </Alert>
              ) : null}
              {maintenance.error ? (
                <Alert role="alert" variant="destructive">
                  {maintenance.error}
                </Alert>
              ) : null}
              <fieldset
                disabled={maintenance.pending || !status.policy.adopted}
                className="grid min-w-0 gap-3"
              >
                <ScheduleRow id={`${id}-schedule`} label="Schedule">
                  <Select
                    id={`${id}-schedule`}
                    aria-label="Backup schedule"
                    value={current.schedule}
                    className="min-h-11"
                    onValueChange={(value) => {
                      if (
                        value === "disabled" ||
                        value === "daily" ||
                        value === "weekly"
                      )
                        maintenance.changeDraft({ schedule: value });
                    }}
                  >
                    {(["disabled", "daily", "weekly"] as const).map((value) => (
                      <SelectItem key={value} value={value}>
                        {backupScheduleLabels[value]}
                      </SelectItem>
                    ))}
                  </Select>
                </ScheduleRow>
                <ScheduleRow id={`${id}-retention`} label="Retention period">
                  <Select
                    id={`${id}-retention`}
                    value={String(current.retention_days)}
                    className="min-h-11"
                    onValueChange={(value) => {
                      const days = Number(value);
                      if (days === 7 || days === 30 || days === 90)
                        maintenance.changeDraft({ retention_days: days });
                    }}
                  >
                    {(["7", "30", "90"] as const).map((value) => (
                      <SelectItem key={value} value={value}>
                        {RETENTION_LABELS[value]}
                      </SelectItem>
                    ))}
                  </Select>
                </ScheduleRow>
              </fieldset>
              <dl className="grid min-w-0 gap-x-3 gap-y-2 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
                <dt className="text-muted-foreground">Time zone</dt>
                <dd>{status.policy.timezone}</dd>
                <dt className="text-muted-foreground">Next backup</dt>
                <dd className="tabular-nums">
                  {status.policy.next_due_at
                    ? formatBackupTime(status.policy.next_due_at, region)
                    : "Not scheduled"}
                </dd>
              </dl>
              <p className="text-muted-foreground text-sm">
                Saving this schedule does not set up the backup service; the
                person who runs your server does that. Old backups are removed
                only after a newer backup is checked.
              </p>
            </>
          )}
        </form>
        <SandboxDialogFooter data-testid="backup-schedule-footer">
          <DialogFooter className="mt-0 items-center">
            {maintenance.dirty ? (
              <Badge variant="warning" className="mr-auto">
                Unsaved changes
              </Badge>
            ) : null}
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={maintenance.pending}
              onClick={close}
            >
              Close
            </Button>
            {maintenance.dirty ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={maintenance.pending}
                  onClick={maintenance.discardDraft}
                >
                  Discard changes
                </Button>
                <DisabledReason reason={saveReason}>
                  <Button
                    type="submit"
                    form={`${id}-form`}
                    className="min-h-11"
                    disabled={maintenance.pending}
                  >
                    {maintenance.pending ? "Saving…" : "Save settings"}
                  </Button>
                </DisabledReason>
              </>
            ) : null}
          </DialogFooter>
        </SandboxDialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A label-left row: the label column beside the field (a stack on phones). */
function ScheduleRow({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-1.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center sm:gap-x-3">
      <label htmlFor={id} className="text-muted-foreground text-sm">
        {label}
      </label>
      {children}
    </div>
  );
}
