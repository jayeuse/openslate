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
import { ApiError } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";
import { requestSessionRecheck } from "@/lib/auth-api";
import { formatWorkspaceDateTime } from "@/lib/date-time";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import { TablePagination } from "@/components/ui/table-pagination";
import { toast } from "@/components/ui/toast";
import { workspaceCalendarQueryOptions } from "../adapters/workspace-api";
import {
  manageJobIdentity,
  retryManageJob,
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
import { jobSubject } from "../domain/job-rules";
import { JobsRows } from "./jobs-rows";
import { JobsToolbar } from "./jobs-toolbar";

/**
 * Manage Jobs (MD9): the toolbar, then one panel whose list is the only part
 * that scrolls from 1280px, then the page footer. This component owns the
 * filters, the reads and the retry command with its recovery; the rules and
 * words are in `domain/job-rules.ts`.
 */
export default function ManageJobs({ admitted }: { admitted: boolean }) {
  const client = useQueryClient();
  const [kind, setKind] = useState("");
  const [state, setState] = useState("");
  const [limit, setLimit] = useState(10);
  const [offset, setOffset] = useState(0);
  // Below 1280px Jobs shows list rows, where the subject reads in full.
  const [narrow, setNarrow] = useState(false);
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
    }
  }, [admitted, denied, client]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1279px)");
    const update = () => setNarrow(media.matches);
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
    try {
      await retryManageJob(actual, { key, signal: controller.signal });
      if (!owns(started)) return;
      storeRecovery({ ...attempt, confirmed: true });
      toast.add({ title: "Retry requested.", type: "success" });
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
          "The retry could not be confirmed. Reload Jobs to see its state.",
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
  const formatTime = (value: string) =>
    displayRegion
      ? formatWorkspaceDateTime(value, displayRegion, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "Date unavailable";
  const p = query.data?.pagination;
  const error =
    readError ||
    (query.error
      ? `Jobs could not be loaded. ${apiErrorMessage(query.error, "Try again.")}`
      : denied
        ? "Jobs could not be loaded. You do not have access."
        : "");
  const controlsLocked = pending !== null || recovery !== null || readBusy;
  const pendingRow = pending
    ? rows.find((row) => manageJobIdentity(row) === pending)
    : undefined;
  const changeFilters = (next: { kind?: string; state?: string }) => {
    // A pending command or read owns the filters; chips and quick filters
    // are disabled then, and a late event changes nothing.
    if (controlsLocked) return;
    if (next.kind !== undefined) setKind(next.kind);
    if (next.state !== undefined) setState(next.state);
    setOffset(0);
    setReadError("");
  };
  // The page shows the notice for an account that is not an administrator;
  // until the role is verified, Jobs waits without a request.
  if (!admitted)
    return (
      <div role="status" className="flex flex-col gap-4">
        <span className="sr-only">Checking your access…</span>
        <Skeleton className="h-48 w-full" />
      </div>
    );
  return (
    <section
      aria-label="Jobs workspace"
      className="manage-fill flex min-w-0 flex-col gap-4"
    >
      {pending !== null ? (
        <p role="status" className="text-muted-foreground shrink-0 text-sm">
          {pendingRow ? `Retrying ${jobSubject(pendingRow)}…` : "Retrying…"}
        </p>
      ) : null}
      {commandError ? (
        // A retry that failed or could not be confirmed is an error.
        <Alert role="alert" variant="destructive" className="shrink-0">
          {commandError}
        </Alert>
      ) : null}
      {recovery?.kind === "backup" &&
      !recovery.confirmed &&
      pending === null ? (
        <Button
          variant="outline"
          className="min-h-11 shrink-0 self-start"
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
      {/* The toolbar sits above the table card, as on Audit (Phase 8). */}
      <div className="shrink-0">
        <JobsToolbar
          kind={kind}
          state={state}
          onKindChange={(value) => changeFilters({ kind: value })}
          onStateChange={(value) => changeFilters({ state: value })}
          locked={controlsLocked}
          refreshDisabled={pending !== null || readBusy}
          onRefresh={() => void freshRead()}
        />
      </div>
      <div className="bg-card border-border manage-fill flex min-w-0 flex-col overflow-clip rounded-[var(--radius)] border">
        {error ? (
          <Alert
            role="alert"
            variant="destructive"
            className="m-3 w-auto shrink-0"
          >
            <p>{error}</p>
            <Button
              variant="outline"
              className="mt-2 min-h-11"
              disabled={readBusy || pending !== null}
              onClick={() => void freshRead()}
            >
              Retry Jobs
            </Button>
          </Alert>
        ) : null}
        {/* From 1280px this is the one part that scrolls; the table header
            stays in view because the table itself does not scroll. */}
        <div className="manage-scroll min-w-0 xl:[&>[data-slot=loading-region]_[data-slot=table-container]]:overflow-visible">
          <LoadingRegion
            loading={
              !denied && (readBusy || query.isPending) && rows.length === 0
            }
            label="Loading Jobs…"
            skeleton={<Skeleton className="m-3 h-64" />}
          >
            <JobsRows
              rows={rows}
              list={narrow}
              formatTime={formatTime}
              blocked={commandsBlocked}
              onRetry={(row) => void retry(row)}
              empty={
                denied || requiresRead || error
                  ? "Jobs are unavailable."
                  : "No jobs match these filters."
              }
            />
          </LoadingRegion>
        </div>
        {p && !denied && !requiresRead ? (
          <TablePagination
            ariaLabel="Jobs pages"
            total={p.total}
            offset={p.offset}
            rowCount={p.count}
            pageSize={limit}
            disabled={controlsLocked}
            onPageIndexChange={(page) => {
              if (!controlsLocked) {
                setOffset(page * limit);
                setReadError("");
              }
            }}
            onPageSizeChange={(size) => {
              if (!controlsLocked) {
                setLimit(size);
                setOffset(0);
                setReadError("");
              }
            }}
            className="shrink-0 px-3 py-2 lg:py-2"
          />
        ) : null}
      </div>
    </section>
  );
}
