"use client";
import { useDisplayRegion } from "@/components/use-display-region";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Route } from "next";
import { ApiError } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";
import { requestSessionRecheck } from "@/lib/auth-api";
import { formatWorkspaceDateTime } from "@/lib/date-time";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Field, FieldLabel } from "@/components/ui/field";
import { LoadingRegion } from "@/components/ui/loading-region";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { Skeleton } from "@/components/ui/skeleton";
import { workspaceCalendarQueryOptions } from "../adapters/workspace-api";
import {
  manageJobIdentity,
  retryManageJob,
  type ManageJob,
  type ManageJobIdentity,
} from "../adapters/jobs-api";
import {
  fenceManageJobsReads,
  getManageJobsRecovery,
  isManageJobsDenied,
  manageJobsListOptions,
  manageKeys,
  setManageJobsDenied,
  setManageJobsRecovery,
  type ManageJobsRecovery,
} from "../adapters/manage-queries";

const kinds = [
  ["report-run", "Report runs"],
  ["post-publish", "Post publications"],
  ["event-reminder", "Event reminders"],
  ["backup", "Backups"],
] as const;
const states = [
  "queued",
  "pending",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "interrupted",
];
function label(value: string): string {
  return value
    ? value.charAt(0).toUpperCase() + value.slice(1).replaceAll(/[-_]/g, " ")
    : "Unknown";
}
function kindLabel(value: string): string {
  return kinds.find(([kind]) => kind === value)?.[1] ?? label(value);
}

export default function ManageJobs({ admitted }: { admitted: boolean }) {
  const client = useQueryClient();
  const [kind, setKind] = useState("");
  const [state, setState] = useState("");
  const [limit, setLimit] = useState(10);
  const [offset, setOffset] = useState(0);
  const [phone, setPhone] = useState(false);
  const [recovery, setRecovery] = useState<ManageJobsRecovery | null>(() =>
    getManageJobsRecovery(client),
  );
  const [requiresRead, setRequiresRead] = useState(
    () => !admitted || Boolean(getManageJobsRecovery(client)?.readFirst),
  );
  const [readBusy, setReadBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [readError, setReadError] = useState("");
  const [commandError, setCommandError] = useState("");
  const [notice, setNotice] = useState("");
  const live = useRef(false);
  const epoch = useRef(0);
  const admission = useRef(admitted);
  const command = useRef<AbortController | null>(null);
  const reading = useRef(false);
  const denied = isManageJobsDenied(client);
  const request = {
    kind: kind || undefined,
    state: state || undefined,
    limit,
    offset,
  };
  const query = useQuery({
    ...manageJobsListOptions(request, client),
    enabled: admitted && !denied && !requiresRead,
  });
  const calendar = useQuery({
    ...workspaceCalendarQueryOptions(),
    enabled: admitted,
  });
  const displayRegion = useDisplayRegion(calendar.data);
  const storeRecovery = useCallback(
    (value: ManageJobsRecovery | null) => {
      setManageJobsRecovery(client, value);
      setRecovery(value);
    },
    [client],
  );
  const owns = (started: number) =>
    live.current && admission.current && epoch.current === started;

  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      epoch.current += 1;
      command.current?.abort();
      fenceManageJobsReads(client);
      void client.cancelQueries({ queryKey: manageKeys.jobs() });
    };
  }, [client]);
  useLayoutEffect(() => {
    admission.current = admitted;
    if (!admitted || denied) {
      epoch.current += 1;
      command.current?.abort();
      command.current = null;
      fenceManageJobsReads(client);
      void client.cancelQueries({ queryKey: manageKeys.jobs() });
      if (denied) client.removeQueries({ queryKey: manageKeys.jobs() });
      setRequiresRead(true);
      setPending(null);
      reading.current = false;
      setReadBusy(false);
      setNotice("");
    }
  }, [admitted, denied, client]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setPhone(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const freshRead = useCallback(async (): Promise<boolean> => {
    if (!admission.current || !live.current || reading.current) return false;
    reading.current = true;
    const started = epoch.current;
    setReadBusy(true);
    setReadError("");
    try {
      await client.cancelQueries({ queryKey: manageKeys.jobs() });
      await client.fetchQuery({
        ...manageJobsListOptions(
          { kind: kind || undefined, state: state || undefined, limit, offset },
          client,
        ),
        staleTime: 0,
      });
      if (!live.current || !admission.current || epoch.current !== started)
        return false;
      setManageJobsDenied(client, false);
      setRequiresRead(false);
      setReadError("");
      const saved = getManageJobsRecovery(client);
      if (saved)
        storeRecovery(
          saved.confirmed || saved.kind !== "backup"
            ? null
            : { ...saved, readFirst: false },
        );
      return true;
    } catch (error) {
      if (live.current && admission.current && epoch.current === started) {
        setReadError(
          `Jobs could not be loaded. ${apiErrorMessage(error, "Try again.")}`,
        );
        if (
          error instanceof ApiError &&
          ["mfa_required", "ip_not_allowed"].includes(error.code ?? "")
        )
          requestSessionRecheck();
      }
      return false;
    } finally {
      if (live.current && epoch.current === started) {
        reading.current = false;
        setReadBusy(false);
      }
    }
  }, [client, kind, state, limit, offset, storeRecovery]);
  useEffect(() => {
    if (admitted && requiresRead && !denied) void freshRead();
  }, [admitted, requiresRead, denied, freshRead]);

  const rows =
    admitted && !denied && !requiresRead ? (query.data?.items ?? []) : [];
  const readingFailed = Boolean(readError || query.error);
  const readPending = readBusy || query.isFetching;
  const commandsBlocked =
    !admitted ||
    denied ||
    requiresRead ||
    readingFailed ||
    readPending ||
    pending !== null ||
    recovery !== null;
  async function retry(target: ManageJobIdentity, replay = false) {
    const saved = getManageJobsRecovery(client);
    if (
      !admission.current ||
      denied ||
      command.current ||
      pending !== null ||
      readPending ||
      readingFailed ||
      requiresRead
    )
      return;
    if (
      replay
        ? !saved?.key || saved.readFirst || saved.confirmed
        : saved !== null ||
          !rows.some(
            (row) =>
              manageJobIdentity(row) === manageJobIdentity(target) &&
              row.canRetry,
          )
    )
      return;
    const actual = replay ? saved! : target;
    const key = replay
      ? saved!.key
      : target.kind === "backup"
        ? crypto.randomUUID()
        : undefined;
    const started = ++epoch.current;
    const controller = new AbortController();
    command.current = controller;
    fenceManageJobsReads(client);
    const attempt: ManageJobsRecovery = {
      kind: actual.kind,
      id: actual.id,
      key,
      readFirst: true,
      confirmed: false,
    };
    storeRecovery(attempt);
    setPending(manageJobIdentity(actual));
    setCommandError("");
    setNotice("");
    try {
      await retryManageJob(actual, { key, signal: controller.signal });
      if (!owns(started)) return;
      storeRecovery({ ...attempt, confirmed: true });
      setNotice(
        actual.kind === "backup"
          ? "Backup retry request confirmed."
          : "Retry requested.",
      );
      if (actual.kind === "backup") {
        void client.invalidateQueries({ queryKey: manageKeys.backups() });
        void client.invalidateQueries({ queryKey: manageKeys.backupStatus() });
      }
      await freshRead();
    } catch (error) {
      if (!owns(started)) return;
      const refusal =
        error instanceof ApiError && [401, 403].includes(error.status);
      const known =
        error instanceof ApiError && [404, 409, 422].includes(error.status);
      if (refusal && error.status === 403) setManageJobsDenied(client, true);
      if (known || refusal) {
        storeRecovery(null);
        setCommandError(
          apiErrorMessage(error, "The retry could not be requested."),
        );
      } else {
        setCommandError(
          "Retry outcome unconfirmed. Reload Jobs before checking this request.",
        );
        setRequiresRead(true);
      }
      if (
        error instanceof ApiError &&
        ["mfa_required", "ip_not_allowed"].includes(error.code ?? "")
      )
        requestSessionRecheck();
      if (!refusal) await freshRead();
    } finally {
      if (owns(started)) {
        setPending(null);
        command.current = null;
      }
    }
  }
  function time(value: string | null, empty: string) {
    return value ? (
      <time dateTime={value}>
        {displayRegion
          ? formatWorkspaceDateTime(value, displayRegion, {
              dateStyle: "medium",
              timeStyle: "short",
            })
          : "Date unavailable"}
      </time>
    ) : (
      empty
    );
  }
  function subject(row: ManageJob) {
    const name = row.subjectLabel.trim() || "Unnamed job";
    return row.subjectLink ? (
      <GuardedWorkspaceLink
        href={row.subjectLink as Route}
        className="text-primary break-words underline-offset-4 hover:underline"
      >
        {name}
      </GuardedWorkspaceLink>
    ) : (
      <span className="break-words">{name}</span>
    );
  }
  function badge(row: ManageJob) {
    return (
      <Badge
        variant={
          row.state === "failed"
            ? "destructive"
            : row.state === "succeeded"
              ? "success"
              : "outline"
        }
      >
        {label(row.state)}
      </Badge>
    );
  }
  function actions(row: ManageJob) {
    return (
      <div className="flex flex-wrap gap-2">
        {row.canRetry ? (
          <Button
            variant="outline"
            className="min-h-11"
            aria-label={`Retry ${row.subjectLabel.trim() || "Unnamed job"}`}
            disabled={commandsBlocked}
            onClick={() => void retry(row)}
          >
            {pending === manageJobIdentity(row) ? "Retrying…" : "Retry"}
          </Button>
        ) : null}
        {row.kind === "backup" ? (
          <GuardedWorkspaceLink
            href="/manage?view=backup"
            className="text-primary inline-flex min-h-11 items-center text-sm underline-offset-4 hover:underline"
          >
            View all backups
          </GuardedWorkspaceLink>
        ) : null}
      </div>
    );
  }
  const columns: DataTableColumn<ManageJob>[] = [
    {
      id: "kind",
      header: "Job",
      cell: ({ row }) => kindLabel(row.original.kind),
    },
    {
      id: "subject",
      header: "Subject",
      cell: ({ row }) => subject(row.original),
    },
    { id: "state", header: "State", cell: ({ row }) => badge(row.original) },
    {
      id: "last",
      header: "Last attempt",
      cell: ({ row }) => time(row.original.lastAttemptAt, "Not recorded"),
    },
    {
      id: "next",
      header: "Next run",
      cell: ({ row }) => time(row.original.nextAttemptAt, "Not scheduled"),
    },
    {
      id: "attempts",
      header: "Attempts",
      cell: ({ row }) => (
        <span className="tabular-nums">{row.original.attempts}</span>
      ),
    },
    {
      id: "problem",
      header: "Problem",
      cell: ({ row }) => row.original.failureLabel ?? "No problem recorded",
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => actions(row.original),
    },
  ];
  const p = query.data?.pagination;
  const error =
    readError ||
    (query.error
      ? `Jobs could not be loaded. ${apiErrorMessage(query.error, "Try again.")}`
      : denied
        ? "Jobs could not be loaded. Access is unavailable."
        : "");
  const controlsLocked = pending !== null || recovery !== null || readBusy;
  if (!admitted)
    return <Alert role="note">Only an administrator can view Jobs.</Alert>;
  return (
    <section aria-label="Jobs workspace" className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="jobs-kind">Job kind</FieldLabel>
            <NativeSelect
              id="jobs-kind"
              value={kind}
              disabled={controlsLocked}
              onChange={(event) => {
                setKind(event.target.value);
                setOffset(0);
                setReadError("");
              }}
            >
              <NativeSelectOption value="">All kinds</NativeSelectOption>
              {kinds.map(([key, text]) => (
                <NativeSelectOption key={key} value={key}>
                  {text}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="jobs-state">Job state</FieldLabel>
            <NativeSelect
              id="jobs-state"
              value={state}
              disabled={controlsLocked}
              onChange={(event) => {
                setState(event.target.value);
                setOffset(0);
                setReadError("");
              }}
            >
              <NativeSelectOption value="">All states</NativeSelectOption>
              {states.map((value) => (
                <NativeSelectOption key={value} value={value}>
                  {label(value)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="jobs-size">Rows per page</FieldLabel>
            <NativeSelect
              id="jobs-size"
              value={String(limit)}
              disabled={controlsLocked}
              onChange={(event) => {
                setLimit(Number(event.target.value));
                setOffset(0);
                setReadError("");
              }}
            >
              {[10, 25, 50, 100].map((value) => (
                <NativeSelectOption key={value} value={String(value)}>
                  {value}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <Button
          variant="outline"
          className="min-h-11"
          disabled={pending !== null || readBusy}
          onClick={() => void freshRead()}
        >
          Refresh Jobs
        </Button>
      </div>
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      {commandError ? (
        <Alert role="alert" variant="warning">
          {commandError}
        </Alert>
      ) : null}
      {recovery?.kind === "backup" &&
      !recovery.confirmed &&
      pending === null ? (
        <Button
          variant="outline"
          className="min-h-11"
          disabled={
            recovery.readFirst ||
            requiresRead ||
            readBusy ||
            readingFailed ||
            denied
          }
          onClick={() => void retry(recovery, true)}
        >
          Check retry result
        </Button>
      ) : null}
      {error ? (
        <Alert role="alert" variant="destructive" className="space-y-3">
          <p>{error}</p>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={readBusy || pending !== null}
            onClick={() => void freshRead()}
          >
            Retry Jobs
          </Button>
        </Alert>
      ) : null}
      <LoadingRegion
        loading={!denied && (readBusy || query.isPending) && rows.length === 0}
        label="Loading Jobs…"
        skeleton={<Skeleton className="h-64 w-full" />}
      >
        <div className="border-card-edge bg-card shadow-card min-w-0 overflow-hidden rounded-xl border">
          {phone ? (
            <div className="divide-border divide-y">
              {rows.map((row) => (
                <article
                  key={manageJobIdentity(row)}
                  aria-label={`Job ${row.subjectLabel}`}
                  className="space-y-3 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-muted-foreground text-xs">
                        {kindLabel(row.kind)}
                      </p>
                      <p className="font-semibold">{subject(row)}</p>
                    </div>
                    {badge(row)}
                  </div>
                  <dl className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <dt className="text-muted-foreground">Last attempt</dt>
                      <dd>{time(row.lastAttemptAt, "Not recorded")}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Next run</dt>
                      <dd>{time(row.nextAttemptAt, "Not scheduled")}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Attempts</dt>
                      <dd className="tabular-nums">{row.attempts}</dd>
                    </div>
                  </dl>
                  <p className="text-sm break-words">
                    {row.failureLabel ?? "No problem recorded"}
                  </p>
                  {actions(row)}
                </article>
              ))}
            </div>
          ) : (
            <DataTable
              ariaLabel="Jobs"
              columns={columns}
              data={rows}
              getRowId={manageJobIdentity}
              emptyState={
                <p className="py-8 text-center text-sm">
                  {denied || requiresRead || error
                    ? "Jobs are unavailable."
                    : "No jobs match these filters."}
                </p>
              }
            />
          )}
          {phone && rows.length === 0 ? (
            <p className="p-5 text-sm">
              {denied || requiresRead || error
                ? "Jobs are unavailable."
                : "No jobs match these filters."}
            </p>
          ) : null}
        </div>
      </LoadingRegion>
      {p && !denied && !requiresRead ? (
        <div className="space-y-3">
          <p className="text-muted-foreground text-sm">
            Showing {p.count ? p.offset + 1 : 0}–
            {p.count ? p.offset + p.count : 0} of {p.total} jobs
          </p>
          <div
            className={controlsLocked ? "pointer-events-none opacity-50" : ""}
          >
            <PaginationControls
              ariaLabel="Jobs pages"
              pageIndex={Math.floor(p.offset / p.limit)}
              pageCount={Math.ceil(p.total / p.limit)}
              onPageIndexChange={(page) => {
                if (!controlsLocked) {
                  setOffset(page * limit);
                  setReadError("");
                }
              }}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}
