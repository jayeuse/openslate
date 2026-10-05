"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { FileSearch, HardDrive, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardFooter } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { AccessSearchToolbar } from "../../access/components/access-search-toolbar";
import {
  backupNameError,
  backupScheduleLabels,
  backupStateLabels,
  failureLabel,
  restoreProcedureUrl,
  type ManageBackupRun,
  type ManageBackupsRequest,
} from "../adapters/backup-api";
import type { useManageMaintenance } from "../state/controller";
import { SettingSelect } from "./panel-ui";

type Maintenance = ReturnType<typeof useManageMaintenance>;
const PAGE_SIZES = [4, 10, 25] as const;
const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "name", label: "Name" },
] as const;

export function formatBackupTime(value: string | null): string {
  return value === null
    ? "Not recorded"
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value));
}

export function BackupRunnerStatus({
  status,
}: {
  status: NonNullable<Maintenance["acceptedStatus"]>;
}) {
  const labels = {
    unknown: "Host runner status unknown",
    available: "Host runner available",
    stale: "Host runner observation is stale",
    recovery_required: "Operator recovery required",
    adoption_required: "Operator adoption required",
  } as const;
  return (
    <div className="text-muted-foreground min-w-0 space-y-1 text-sm">
      <p className="font-medium">{labels[status.runner.state]}</p>
      <p>
        {status.runner.last_seen_at
          ? `Last observed: ${formatBackupTime(status.runner.last_seen_at)}`
          : "No host runner observation has been recorded."}
      </p>
      <p>
        {status.queued_count} queued ·{" "}
        {status.active_run
          ? `${status.active_run.name}: ${backupStateLabels[status.active_run.state]}`
          : "No active backup"}
      </p>
      {status.runner.state === "recovery_required" ||
      status.runner.state === "adoption_required" ? (
        <p>
          A server operator must resolve this state before the host runner can
          proceed. Requests only enter the queue.
        </p>
      ) : null}
    </div>
  );
}

export function BackupPanel({ maintenance }: { maintenance: Maintenance }) {
  const id = useId();
  const [selectedId, setSelectedId] = useState<string | null | undefined>(
    undefined,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("Manual backup");
  const [nameError, setNameError] = useState<string | null>(null);
  const createOpener = useRef<HTMLButtonElement | null>(null);
  const { acceptedHistory: page, request, setRequest } = maintenance;
  useEffect(() => {
    if (
      !page ||
      page.pagination.offset !== request.offset ||
      page.pagination.limit !== request.limit ||
      request.offset === 0 ||
      request.offset < page.pagination.total
    )
      return;
    const offset =
      page.pagination.total > 0
        ? Math.floor((page.pagination.total - 1) / request.limit) *
          request.limit
        : 0;
    setSelectedId(null);
    setRequest((value) => (value === request ? { ...value, offset } : value));
  }, [page, request, setRequest]);
  const runs = page?.items ?? [];
  const selected =
    runs.find((run) => run.id === selectedId) ??
    (selectedId === undefined ? runs[0] : undefined);
  const total = page?.pagination.total ?? 0;
  const first = runs.length ? request.offset + 1 : 0;
  const last = runs.length ? request.offset + runs.length : 0;
  const order =
    request.sort_by === "name"
      ? "name"
      : request.sort_order === "asc"
        ? "oldest"
        : "newest";
  function changeRequest(next: Partial<ManageBackupsRequest>) {
    maintenance.setRequest((value) => ({ ...value, offset: 0, ...next }));
    setSelectedId(null);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const invalid = backupNameError(createName);
    setNameError(invalid);
    if (invalid || maintenance.pending) return;
    if (await maintenance.queueBackup(createName)) {
      setCreateOpen(false);
      setSelectedId(null);
      setCreateName("Manual backup");
    }
  }
  const statusBadge = (run: ManageBackupRun) => (
    <Badge
      variant={
        run.state === "succeeded"
          ? "success"
          : run.state === "failed" || run.state === "interrupted"
            ? "warning"
            : "secondary"
      }
    >
      {backupStateLabels[run.state]}
    </Badge>
  );
  const inspectButton = (run: ManageBackupRun) => (
    <Button
      type="button"
      variant="ghost"
      aria-label={`Inspect ${run.name}`}
      aria-pressed={run.id === selected?.id}
      className="h-auto min-h-11 min-w-0 justify-start px-2 py-1 text-left font-medium whitespace-normal"
      onClick={() => setSelectedId(run.id)}
    >
      <span className="break-words">{run.name}</span>
    </Button>
  );
  const columns: DataTableColumn<ManageBackupRun>[] = [
    {
      id: "backup",
      header: "Backup",
      cell: ({ row }) => (
        <div className="flex min-w-0 flex-col gap-1">
          {inspectButton(row.original)}
          <span className="text-muted-foreground px-2 text-xs">
            {row.original.installation === "previous"
              ? "Previous installation"
              : "Current installation"}{" "}
            ·{" "}
            {row.original.provenance === "manual"
              ? "Manual request"
              : "Scheduled request"}
          </span>
        </div>
      ),
    },
    {
      id: "requested",
      header: "Requested",
      cell: ({ row }) => (
        <time
          className="text-muted-foreground tabular-nums"
          dateTime={row.original.requested_at}
        >
          {formatBackupTime(row.original.requested_at)}
        </time>
      ),
    },
    {
      id: "state",
      header: "Status",
      cell: ({ row }) => statusBadge(row.original),
    },
  ];
  return (
    <section
      aria-labelledby={`${id}-backups-heading`}
      className="flex min-w-0 flex-col gap-3"
    >
      <div
        className={`grid min-w-0 gap-3 ${selected ? "lg:grid-cols-[minmax(0,1fr)_minmax(18rem,25rem)]" : "grid-cols-1"}`}
      >
        <section
          aria-labelledby={`${id}-backups-heading`}
          className="bg-card min-w-0 overflow-hidden rounded-lg border"
        >
          <header className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
            <div className="min-w-0">
              <h2
                data-slot="section-title"
                id={`${id}-backups-heading`}
                className="text-lg font-semibold"
              >
                Backup history
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Inspect requests and verified backup results. Back up now queues
                work for the server operator’s host runner.
              </p>
            </div>
            <Button
              ref={createOpener}
              type="button"
              className="min-h-11 shrink-0 gap-2"
              disabled={!maintenance.acceptedStatus}
              onClick={() => {
                maintenance.clearCommandMessage();
                setNameError(null);
                setCreateOpen(true);
              }}
            >
              <HardDrive data-icon="inline-start" /> Back up now
            </Button>
          </header>
          <div className="flex min-w-0 flex-col gap-3 p-3">
            <AccessSearchToolbar
              searchLabel="Search backups"
              placeholder="Search backup history..."
              query={request.search}
              onQueryChange={(search) => changeRequest({ search })}
              sortLabel="Sort backups"
              sort={order}
              sortOptions={SORT_OPTIONS}
              onSortChange={(value) =>
                changeRequest({
                  sort_by: value === "name" ? "name" : "requested_at",
                  sort_order:
                    value === "oldest" || value === "name" ? "asc" : "desc",
                })
              }
              activeFilterCount={
                [
                  request.state,
                  request.provenance,
                  request.installation,
                ].filter((value) => value !== "all").length
              }
            >
              {(
                [
                  [
                    "state",
                    "Status",
                    [
                      "all",
                      "queued",
                      "running",
                      "succeeded",
                      "failed",
                      "interrupted",
                    ],
                  ],
                  [
                    "provenance",
                    "Request source",
                    ["all", "manual", "scheduled"],
                  ],
                  [
                    "installation",
                    "Installation",
                    ["all", "current", "previous"],
                  ],
                ] as const
              ).map(([key, label, options]) => (
                <Field key={key}>
                  <FieldLabel htmlFor={`${id}-${key}`}>{label}</FieldLabel>
                  <NativeSelect
                    id={`${id}-${key}`}
                    className="w-full [&_select]:min-h-11"
                    value={request[key]}
                    onChange={(event) => {
                      const value = options.find(
                        (option) => option === event.currentTarget.value,
                      );
                      if (value) changeRequest({ [key]: value });
                    }}
                  >
                    {options.map((value) => (
                      <NativeSelectOption key={value} value={value}>
                        {value === "all"
                          ? "All"
                          : value === "succeeded"
                            ? "Completed"
                            : `${value[0].toUpperCase()}${value.slice(1)}`}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
              ))}
            </AccessSearchToolbar>
            {maintenance.historyRefused || maintenance.history.isError ? (
              <Alert role="alert" variant="destructive">
                <p>
                  {maintenance.historyRefused
                    ? "Only administrators can review backups."
                    : "Backup history could not be loaded."}
                </p>
                <Button
                  variant="outline"
                  onClick={() => void maintenance.retryHistory()}
                >
                  Retry backup history
                </Button>
              </Alert>
            ) : maintenance.history.isPending ? (
              <p role="status">Loading backup history…</p>
            ) : runs.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FileSearch aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>
                    {request.search ||
                    request.state !== "all" ||
                    request.provenance !== "all" ||
                    request.installation !== "all"
                      ? "No backups match these filters"
                      : total > 0
                        ? "No backups on this page"
                        : "No backup requests yet"}
                  </EmptyTitle>
                  <EmptyDescription>
                    Requests appear here after the server accepts them. A queued
                    request has no verified snapshot yet.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <div className="hidden min-w-0 lg:block">
                  <DataTable
                    ariaLabel="Backup history"
                    cellClassName="px-3 py-3 whitespace-normal"
                    columns={columns}
                    data={runs}
                    getRowId={(run) => run.id}
                    rowClassName={(run) =>
                      run.id === selected?.id ? "bg-muted/70" : undefined
                    }
                    rowState={(run) =>
                      run.id === selected?.id ? "selected" : undefined
                    }
                  />
                </div>
                <div className="divide-border divide-y rounded-lg border lg:hidden">
                  {runs.map((run) => (
                    <article
                      key={run.id}
                      className={`flex min-w-0 flex-col gap-3 p-3 ${run.id === selected?.id ? "bg-muted/70" : ""}`}
                    >
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <div className="min-w-0">
                          {inspectButton(run)}
                          <p className="text-muted-foreground px-2 text-xs">
                            {run.installation === "previous"
                              ? "Previous installation"
                              : "Current installation"}
                          </p>
                        </div>
                        {statusBadge(run)}
                      </div>
                      <time
                        className="text-muted-foreground px-2 text-sm tabular-nums"
                        dateTime={run.requested_at}
                      >
                        {formatBackupTime(run.requested_at)}
                      </time>
                    </article>
                  ))}
                </div>
              </>
            )}
            {page ? (
              <footer className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-t pt-3">
                <p
                  className="text-muted-foreground text-sm tabular-nums"
                  role="status"
                >{`Showing ${first}–${last} of ${total}`}</p>
                <div className="flex min-w-0 flex-wrap items-center gap-3 sm:justify-end">
                  <div className="flex items-center gap-2">
                    <label
                      htmlFor={`${id}-page-size`}
                      className="text-muted-foreground text-sm"
                    >
                      Rows per page
                    </label>
                    <NativeSelect
                      id={`${id}-page-size`}
                      className="w-20 [&_select]:min-h-11"
                      value={String(request.limit)}
                      onChange={(event) => {
                        const size = PAGE_SIZES.find(
                          (value) =>
                            String(value) === event.currentTarget.value,
                        );
                        if (size) changeRequest({ limit: size });
                      }}
                    >
                      {PAGE_SIZES.map((size) => (
                        <NativeSelectOption key={size} value={String(size)}>
                          {size}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </div>
                  {total > 0 ? (
                    <PaginationControls
                      ariaLabel="Backup pages"
                      className="w-auto sm:justify-end"
                      pageCount={Math.max(1, Math.ceil(total / request.limit))}
                      pageIndex={Math.floor(request.offset / request.limit)}
                      onPageIndexChange={(index) =>
                        changeRequest({ offset: index * request.limit })
                      }
                    />
                  ) : null}
                </div>
              </footer>
            ) : null}
          </div>
        </section>
        {selected ? (
          <section
            aria-label="Selected backup"
            className="bg-card min-w-0 overflow-hidden rounded-lg border"
          >
            <header className="flex flex-col gap-3 border-b p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-muted-foreground text-sm">Selected backup</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Close selected backup"
                  className="size-11 shrink-0"
                  onClick={() => setSelectedId(null)}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
              <h2
                data-slot="section-title"
                className="min-w-0 text-lg font-semibold break-words"
              >
                {selected.name}
              </h2>
              {statusBadge(selected)}
              <p className="text-muted-foreground text-sm">
                {selected.installation === "previous"
                  ? "Previous installation · Read-only history"
                  : "Current installation"}
              </p>
            </header>
            <div className="flex min-w-0 flex-col gap-4 p-4">
              <h3 data-slot="section-title" className="font-semibold">
                Backup details
              </h3>
              <dl className="min-w-0 divide-y rounded-lg border">
                {[
                  ["Requested", formatBackupTime(selected.requested_at)],
                  [
                    "Source",
                    selected.provenance === "manual"
                      ? "Manual request"
                      : "Scheduled request",
                  ],
                  [
                    "Schedule at request",
                    backupScheduleLabels[selected.schedule],
                  ],
                  ["Retention at request", `${selected.retention_days} days`],
                  ["Started", formatBackupTime(selected.started_at)],
                  ["Finished", formatBackupTime(selected.finished_at)],
                  ["Snapshot", selected.snapshot_id ?? "Not verified"],
                  [
                    "Verification",
                    selected.verified_at
                      ? `Verified · ${formatBackupTime(selected.verified_at)}`
                      : "Not verified",
                  ],
                  [
                    "Restart / reconciliation",
                    selected.reconciled_at
                      ? `Reconciled · ${formatBackupTime(selected.reconciled_at)}`
                      : "Not reconciled",
                  ],
                  [
                    "Failure",
                    selected.failure_code
                      ? failureLabel(selected.failure_code)
                      : "None recorded",
                  ],
                  ["Confirmed expiry", formatBackupTime(selected.expired_at)],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-3 px-3 py-2.5 text-sm"
                  >
                    <dt className="text-muted-foreground min-w-0 break-words">
                      {label}
                    </dt>
                    <dd className="min-w-0 text-right break-words">{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-muted-foreground text-sm">
                Snapshot verification and service restart are separate facts.
                Restore is performed offline by a server operator.
              </p>
              <Button asChild variant="outline" className="min-h-11 min-w-0">
                <a href={restoreProcedureUrl} target="_blank" rel="noreferrer">
                  Restore procedure
                </a>
              </Button>
              <p className="text-muted-foreground text-xs">
                Use the procedure included with this release. Repository access
                may be required.
              </p>
            </div>
          </section>
        ) : null}
      </div>
      <Dialog
        open={createOpen}
        dismissible={!maintenance.pending}
        onOpenChange={(open) => {
          if (!maintenance.pending) setCreateOpen(open);
        }}
      >
        <DialogContent finalFocus={() => createOpener.current}>
          <DialogHeader>
            <DialogTitle>Back up now</DialogTitle>
            <DialogDescription>
              Queue a named backup request. This page does not stop services or
              execute a backup; the configured host runner performs the offline
              procedure.
            </DialogDescription>
          </DialogHeader>
          <form className="mt-4 flex flex-col gap-4" onSubmit={submit}>
            <fieldset disabled={maintenance.pending} className="min-w-0">
              <Field data-invalid={Boolean(nameError)}>
                <FieldLabel htmlFor={`${id}-backup-name`}>
                  Backup name
                </FieldLabel>
                <Input
                  id={`${id}-backup-name`}
                  value={createName}
                  aria-invalid={Boolean(nameError)}
                  aria-describedby={nameError ? `${id}-name-error` : undefined}
                  onChange={(event) => {
                    setCreateName(event.target.value);
                    setNameError(null);
                  }}
                  className="min-h-11"
                />
                <FieldError id={`${id}-name-error`}>{nameError}</FieldError>
              </Field>
            </fieldset>
            {maintenance.error ? (
              <Alert role="alert" variant="destructive">
                {maintenance.error}
              </Alert>
            ) : null}
            <DialogFooter className="mt-0">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={maintenance.pending}
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="min-h-11"
                disabled={maintenance.pending}
              >
                {maintenance.pending ? "Queueing…" : "Back up now"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export function SnapshotScheduleForm({
  maintenance,
}: {
  maintenance: Maintenance;
}) {
  const id = useId();
  const status = maintenance.acceptedStatus;
  if (!status)
    return (
      <Alert role="alert" variant="destructive">
        <p>
          {maintenance.policyRefused
            ? "Only administrators can review backup policy."
            : "Backup policy could not be loaded."}
        </p>
        <Button
          variant="outline"
          onClick={() => void maintenance.retryPolicy()}
        >
          Retry backup policy
        </Button>
      </Alert>
    );
  const current = {
    ...(maintenance.draftPolicy ?? status.policy),
    ...maintenance.draft,
  };
  return (
    <form
      className="flex min-w-0 flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void maintenance.savePolicy();
      }}
    >
      {maintenance.stale ? (
        <Alert
          role={maintenance.staleRevision ? "alert" : "status"}
          variant={maintenance.staleRevision ? "destructive" : "warning"}
        >
          <p>
            Backup policy changed. Your draft is still here. Review the latest
            policy before saving again.
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
        className="min-w-0 space-y-3"
      >
        <SettingSelect
          id={`${id}-schedule`}
          label="Backup schedule"
          value={current.schedule}
          options={["disabled", "daily", "weekly"]}
          optionLabels={backupScheduleLabels}
          onChange={(value) => {
            if (value === "disabled" || value === "daily" || value === "weekly")
              maintenance.changeDraft({ schedule: value });
          }}
        />
        <SettingSelect
          id={`${id}-retention`}
          label="Retention period"
          value={String(current.retention_days)}
          options={["7", "30", "90"]}
          optionLabels={{ "7": "7 days", "30": "30 days", "90": "90 days" }}
          onChange={(value) => {
            const days = Number(value);
            if (days === 7 || days === 30 || days === 90)
              maintenance.changeDraft({ retention_days: days });
          }}
        />
        <CardFooter className="flex flex-wrap justify-end gap-2 px-0 pt-4">
          {maintenance.dirty ? (
            <Badge variant="warning">Unsaved changes</Badge>
          ) : (
            <Badge variant="outline">Saved</Badge>
          )}
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={!maintenance.dirty}
            onClick={maintenance.discardDraft}
          >
            Discard changes
          </Button>
          <Button
            type="submit"
            className="min-h-11"
            disabled={!maintenance.dirty || maintenance.stale}
          >
            Save settings
          </Button>
        </CardFooter>
      </fieldset>
      <div className="text-muted-foreground min-w-0 space-y-2 border-t pt-3 text-sm">
        <p>
          {backupScheduleLabels[status.policy.schedule]} ·{" "}
          {status.policy.timezone} · Keep {status.policy.retention_days} days
        </p>
        <p>Next due: {formatBackupTime(status.policy.next_due_at)}</p>
        <p>
          Saving this policy does not install a host runner. A server operator
          configures the scheduler. Retention is applied only after a later
          usable recovery point is verified.
        </p>
        <BackupRunnerStatus status={status} />
      </div>
    </form>
  );
}
