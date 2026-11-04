"use client";

import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleGauge,
  CircleMinus,
  CircleX,
  ExternalLink,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import type { Route } from "next";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import { ApiError } from "@/lib/api";
import { apiErrorReference, type ApiErrorText } from "@/lib/api-errors";
import {
  notLoadingAdvice,
  referenceAdvice,
  type ReferenceViewer,
} from "@/lib/reference-viewer";
import { cn } from "@/lib/utils";

import {
  manageSystemStatusOptions,
  manageVersionOptions,
} from "../adapters/manage-queries";
import {
  getSystemStatus,
  type SystemStatus,
} from "../adapters/system-status-api";
import {
  backupsRow,
  checkAnnouncement,
  createAnnouncer,
  checkTime,
  checkTimeText,
  failedJobsText,
  installationRows,
  nextCheckSuffix,
  PART_NAMES,
  PART_ORDER,
  partRows,
  signInActivityText,
  storageText,
  systemHeadline,
  type BackupState,
  type BackupsRow,
  type CheckSuffix,
  type CheckTrigger,
  type HeadlineTone,
  type InstallationRows,
  type PartStatus,
  type WorkerState,
  WORKER_LABELS,
} from "../domain/health-rules";
import { useWorkspaceRegion } from "./backup-time";
import { SupportFile } from "./system-health-support-file";
import { SystemHealthTimeline } from "./system-health-timeline";

const CONNECTION_MESSAGE =
  "Could not connect. Check your connection and try again.";

/**
 * Block 3's values (D8), or "pending" for an admin's card before any result:
 * a skeleton while the first read runs, dashes when it failed.
 */
export type OrganizationBlock =
  | {
      backups: BackupsRow;
      failedJobs: string;
      signIns: string;
      storage: string;
    }
  | "pending";

/**
 * Block 4's values (D18), or "pending" for the installation owner's card
 * before any result.
 */
export type InstallationBlock = InstallationRows | "pending";

/** What the page shows for its status read (D2.7). */
export type SystemHealthState =
  | { kind: "loading" }
  | {
      kind: "result";
      status: SystemStatus;
      checkLine: string;
      /** The last check failed; the result shown is from the check before. */
      failure: ApiErrorText | null;
    }
  | { kind: "unavailable"; failure: ApiErrorText };

const TONE_ICONS: Readonly<
  Record<HeadlineTone, { icon: LucideIcon; className: string }>
> = {
  working: { icon: CircleCheck, className: "text-flow-text" },
  not_set_up: { icon: CircleMinus, className: "text-warn-text" },
  // D14.1: no other word on the page uses the gauge shape.
  slow: { icon: CircleGauge, className: "text-warn-text" },
  not_working: { icon: CircleX, className: "text-danger-text" },
};

const PART_ICONS: Readonly<
  Record<PartStatus, { icon: LucideIcon; className: string } | null>
> = {
  working: { icon: CircleCheck, className: "text-flow-text" },
  set_up: { icon: CircleDashed, className: "text-muted-foreground" },
  not_set_up: { icon: CircleMinus, className: "text-warn-text" },
  not_working: { icon: CircleX, className: "text-danger-text" },
  slow: { icon: CircleGauge, className: "text-warn-text" },
  unknown: null,
};

// D18.3: a worker's state by shape as well as color.
const WORKER_ICONS: Readonly<
  Record<WorkerState, { icon: LucideIcon; className: string }>
> = {
  running: { icon: CircleCheck, className: "text-flow-text" },
  not_seen: { icon: CircleX, className: "text-danger-text" },
  never_seen: { icon: CircleDashed, className: "text-muted-foreground" },
};

// D8.3: these words extend R2 for the Backups row only; Late has its own
// shape, and CircleMinus means "not set up" here as in block 2.
const BACKUP_ICONS: Readonly<
  Record<BackupState, { icon: LucideIcon; className: string } | null>
> = {
  on_time: { icon: CircleCheck, className: "text-flow-text" },
  late: { icon: CircleAlert, className: "text-warn-text" },
  no_schedule: { icon: CircleMinus, className: "text-warn-text" },
  never_backed_up: { icon: CircleX, className: "text-danger-text" },
  // D13 item 1: in block 2 this shape already means "cannot confirm".
  unknown: { icon: CircleDashed, className: "text-muted-foreground" },
};

/** A failed status read as the page words it; a refused session shows
 * nothing here (the signed-out behavior applies), so it returns null. */
export function statusFailure(
  error: unknown,
  hasResult: boolean,
): ApiErrorText | null {
  if (error instanceof ApiError && error.status === 401) return null;
  // With a result on screen, the message says that the result is older (D2.7).
  if (error instanceof TypeError)
    return {
      message: hasResult
        ? `${CONNECTION_MESSAGE} The result below is from the last check.`
        : CONNECTION_MESSAGE,
      reference: undefined,
    };
  return {
    message: hasResult
      ? "The status could not be checked. The result below is from the last check."
      : "The status could not be loaded. Try Check again in a minute.",
    reference: apiErrorReference(error),
  };
}

/**
 * The page's status read (S2-C6). Opening the page is the person's action, so
 * the first read, before the query has ever settled, refreshes a refused
 * session. Every later read is the 60-second or focus refresh, even after a
 * first read that failed with no result, and stays `background`, so it never
 * extends an idle session. The settle counts are used because a fetch on a
 * query without data resets its status to `pending`.
 */
export const systemHealthStatusOptions = () =>
  queryOptions({
    ...manageSystemStatusOptions(),
    queryFn: ({ client, queryKey, signal }) => {
      const state = client.getQueryState(queryKey);
      const opening =
        !state || state.dataUpdateCount + state.errorUpdateCount === 0;
      return getSystemStatus(opening ? "person" : "background", signal);
    },
  });

/**
 * Manage → System health (S2, docs/specs/system-health.md D2): whether Slate
 * Operations works now, for every role. The status loads in the page frame
 * and refreshes every 60 seconds while visible and when the window regains
 * focus; neither refresh is the person's activity. Opening the page and
 * "Check again" are (`systemHealthStatusOptions`). An admin's block 3 comes
 * from the same read (S3-C5), so nobody makes an extra request for it.
 */
export function SystemHealth({ viewer }: { viewer: ReferenceViewer }) {
  const installationOwner = viewer === "owner";
  const client = useQueryClient();
  const region = useWorkspaceRegion();
  const status = useQuery(systemHealthStatusOptions());
  const version = useQuery({
    ...manageVersionOptions(),
    enabled: installationOwner,
  });
  const [personCheck, setPersonCheck] = useState(false);
  const [shown, setShown] = useState<{
    check: SystemStatus | null;
    at: number;
    suffix: CheckSuffix;
    announcement: string;
  }>({ check: null, at: 0, suffix: null, announcement: "" });
  const [trigger, setTrigger] = useState<CheckTrigger>("background");
  // The status span's text; each announcement empties it first (D4 answer 10).
  const [spoken, setSpoken] = useState("");
  const announcer = useRef<ReturnType<typeof createAnnouncer> | null>(null);
  useEffect(() => {
    const current = createAnnouncer(setSpoken, {
      set: (run, delay) => window.setTimeout(run, delay),
      clear: (id) => window.clearTimeout(id),
    });
    announcer.current = current;
    return () => {
      current.stop();
      announcer.current = null;
    };
  }, []);
  useEffect(() => {
    if (shown.announcement) announcer.current?.say(shown.announcement);
  }, [shown.at]);

  // Each result, from a person or a refresh, updates the line and the
  // announcement once (D2.4).
  useEffect(() => {
    const next = status.data;
    if (!next || status.dataUpdatedAt === shown.at) return;
    setShown((current) => ({
      check: next,
      at: status.dataUpdatedAt,
      suffix: nextCheckSuffix({
        previous: current.check,
        next,
        trigger,
        suffix: current.suffix,
      }),
      announcement: checkAnnouncement({
        previous: current.check,
        next,
        trigger,
        time: checkTime(next.checked_at, region),
      }),
    }));
    setTrigger("background");
  }, [status.data, status.dataUpdatedAt]);

  // The focus refresh belongs to this read only; the global one stays off.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible")
        void status.refetch({ cancelRefetch: false });
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [status.refetch]);

  const checkAgain = async () => {
    if (personCheck) return;
    setPersonCheck(true);
    setTrigger("person");
    try {
      await client.fetchQuery({
        ...manageSystemStatusOptions(),
        queryFn: ({ signal }) => getSystemStatus("person", signal),
        staleTime: 0,
      });
    } catch {
      // The query keeps the error; the page shows it below the headline.
      setTrigger("background");
    } finally {
      setPersonCheck(false);
    }
  };

  const data = status.data;
  const failure = status.isError
    ? statusFailure(status.error, data !== undefined)
    : null;
  let state: SystemHealthState;
  if (data) {
    const line = checkTimeText(
      data.checked_at,
      new Date(status.dataUpdatedAt),
      region,
    );
    const suffix =
      shown.check === data
        ? shown.suffix === "latest"
          ? " · This is the latest check"
          : shown.suffix === "no-change"
            ? " · No change"
            : ""
        : "";
    state = { kind: "result", status: data, checkLine: line + suffix, failure };
  } else if (failure) state = { kind: "unavailable", failure };
  else state = { kind: "loading" };

  const releaseUrl = installationOwner ? version.data?.release_url : null;
  const releaseLink = !installationOwner ? null : releaseUrl ? (
    <a
      href={releaseUrl}
      target="_blank"
      rel="noreferrer"
      className={linkClassName}
    >
      Release notes
      <ExternalLink aria-hidden="true" className="size-3.5" />
    </a>
  ) : (
    <GuardedWorkspaceLink href="/manage?view=updates" className={linkClassName}>
      Updates &amp; licensing
    </GuardedWorkspaceLink>
  );

  // D8.1: after a result, the card shows only when the response carries the
  // part; before one, only when the identity says this person is an admin.
  const organizationPart = data?.organization;
  const organization: OrganizationBlock | null = organizationPart
    ? {
        backups: backupsRow(organizationPart.backups, {
          now: new Date(status.dataUpdatedAt),
          region,
          installationOwner,
        }),
        failedJobs: failedJobsText(organizationPart.failed_jobs, region),
        signIns: signInActivityText(
          organizationPart.failed_sign_ins,
          organizationPart.lockouts,
          region,
        ),
        storage: storageText(organizationPart.storage_used_bytes, region),
      }
    : !data && viewer !== "member"
      ? "pending"
      : null;
  // D18.1: the same rule for block 4 and the installation owner.
  const installationPart = data?.installation;
  const installation: InstallationBlock | null = installationPart
    ? installationRows(installationPart, new Date(status.dataUpdatedAt), region)
    : !data && installationOwner
      ? "pending"
      : null;

  return (
    <SystemHealthView
      state={state}
      busy={personCheck || (status.isPending && status.isFetching)}
      onCheckAgain={() => void checkAgain()}
      announcement={spoken}
      releaseLink={releaseLink}
      viewer={viewer}
      organization={organization}
      installation={installation}
      timeline={<SystemHealthTimeline />}
      supportFile={<SupportFile viewer={viewer} />}
      linkTo={(href, label) => (
        <GuardedWorkspaceLink href={href} className={linkClassName}>
          {label}
        </GuardedWorkspaceLink>
      )}
    />
  );
}

const linkClassName =
  "text-action-text inline-flex min-h-11 items-center gap-1 text-sm underline-offset-4 hover:underline xl:min-h-0";

const cardClassName =
  "bg-card border-border min-w-0 rounded-[var(--radius)] border";

function CardHeader({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div className="border-border flex min-h-14 items-center border-b px-4 py-2">
      <h2 id={id} data-slot="section-title" className="font-semibold">
        {children}
      </h2>
    </div>
  );
}

/** The four parts in R1 order; with no rows, a skeleton beside each name. */
function PartList({ rows }: { rows: ReturnType<typeof partRows> | null }) {
  return (
    <dl className="grid min-w-0 gap-3 px-4 py-3 text-sm sm:gap-0 sm:py-2">
      {PART_ORDER.map((key, index) => {
        const row = rows?.[index];
        const icon = row ? PART_ICONS[row.status] : null;
        return (
          <div
            key={key}
            className="grid min-w-0 gap-0.5 sm:grid-cols-[14rem_minmax(0,1fr)] sm:gap-3 sm:py-1.5"
          >
            <dt className="text-muted-foreground">{PART_NAMES[key]}</dt>
            <dd className="min-w-0">
              {row ? (
                <>
                  <span className="flex items-center gap-2 font-medium">
                    {icon ? (
                      <icon.icon
                        aria-hidden="true"
                        className={cn("size-4 shrink-0", icon.className)}
                      />
                    ) : null}
                    {row.word}
                  </span>
                  {row.cause ? (
                    <span className="text-muted-foreground block">
                      {row.cause}
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="flex items-center gap-2">
                  <Skeleton className="size-4 rounded-full" />
                  <Skeleton className="h-3.5 w-16" />
                </span>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** One labelled row of block 3, in the block 2 grid (D8.2). */
function OrganizationRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-0.5 sm:grid-cols-[14rem_minmax(0,1fr)] sm:gap-3 sm:py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-col items-start">{children}</dd>
    </div>
  );
}

/**
 * Block 3's rows (D8.2): Backups, Failed jobs and Sign-in activity, always in
 * this order. Line 1 is the value, line 2 is muted, the link comes last.
 * `skeleton` is the first load (a 160px bar each, a circle before Backups);
 * `dash` is a failed first read, which keeps the links (D8.6).
 */
function OrganizationList({
  cells,
  linkTo,
}: {
  cells: Exclude<OrganizationBlock, "pending"> | "skeleton" | "dash";
  linkTo: (href: Route, label: string) => ReactNode;
}) {
  const values = typeof cells === "string" ? null : cells;
  const placeholder = (withIcon: boolean) =>
    cells === "skeleton" ? (
      <span className="flex items-center gap-2">
        {withIcon ? <Skeleton className="size-4 rounded-full" /> : null}
        <Skeleton className="h-3.5 w-40" />
      </span>
    ) : (
      <span className="font-medium">—</span>
    );
  const links = cells !== "skeleton";
  const backups = values?.backups;
  const icon = backups ? BACKUP_ICONS[backups.state] : null;
  return (
    <dl className="grid min-w-0 gap-3 px-4 py-3 text-sm sm:gap-0 sm:py-2">
      <OrganizationRow label="Backups">
        {backups ? (
          <>
            <span className="flex items-center gap-2 font-medium">
              {icon ? (
                <icon.icon
                  aria-hidden="true"
                  className={cn("size-4 shrink-0", icon.className)}
                />
              ) : null}
              {backups.word}
            </span>
            {/* Finding 4: each part stays whole; the line wraps only
                between parts. */}
            <span className="text-muted-foreground tabular-nums">
              {backups.detail.map((part, index) => (
                <Fragment key={part}>
                  {index > 0 ? " · " : null}
                  <span className="whitespace-nowrap">{part}</span>
                </Fragment>
              ))}
            </span>
            {backups.followUp === "open-backup" ? (
              linkTo("/manage?view=backup", "Open Backup")
            ) : backups.followUp === "owner-manages" ? (
              <span className="text-muted-foreground">
                The person who runs your server manages backups.
              </span>
            ) : null}
          </>
        ) : (
          placeholder(true)
        )}
      </OrganizationRow>
      <OrganizationRow label="Failed jobs">
        {values ? (
          <span className="font-medium tabular-nums">{values.failedJobs}</span>
        ) : (
          placeholder(false)
        )}
        {links ? linkTo("/manage?view=jobs", "Open Jobs") : null}
      </OrganizationRow>
      <OrganizationRow label="Sign-in activity">
        {values ? (
          <span className="font-medium tabular-nums">{values.signIns}</span>
        ) : (
          placeholder(false)
        )}
        {links
          ? linkTo("/access?view=security", "Open Security in Access")
          : null}
      </OrganizationRow>
      {/* D17: a size is not a status, so no icon; no page lists storage by
          organization, so no link. */}
      <OrganizationRow label="File storage">
        {values ? (
          <span className="font-medium tabular-nums">{values.storage}</span>
        ) : (
          placeholder(false)
        )}
        {links ? (
          <span className="text-muted-foreground">
            Storage limit: not set yet
          </span>
        ) : null}
      </OrganizationRow>
    </dl>
  );
}

/** Block 3, Your organization (D8), with one loading region (D8.6). */
function OrganizationCard({
  block,
  loading,
  linkTo,
}: {
  block: OrganizationBlock;
  loading: boolean;
  linkTo: (href: Route, label: string) => ReactNode;
}) {
  return (
    <section
      aria-labelledby="system-health-organization"
      className={cardClassName}
    >
      <CardHeader id="system-health-organization">Your organization</CardHeader>
      <LoadingRegion
        loading={loading}
        label="Loading system status"
        skeleton={<OrganizationList cells="skeleton" linkTo={linkTo} />}
      >
        <OrganizationList
          cells={block === "pending" ? "dash" : block}
          linkTo={linkTo}
        />
      </LoadingRegion>
    </section>
  );
}

/**
 * Block 4's rows (D18.2): Database size, then the five workers, always in this
 * order. `skeleton` is the first load (a 120px bar each, a circle before each
 * worker); `dash` is a failed first read.
 */
function InstallationList({
  cells,
}: {
  cells: InstallationRows | "skeleton" | "dash";
}) {
  const values = typeof cells === "string" ? null : cells;
  const placeholder = (withIcon: boolean) =>
    cells === "skeleton" ? (
      <span className="flex items-center gap-2">
        {withIcon ? <Skeleton className="size-4 rounded-full" /> : null}
        <Skeleton className="h-3.5 w-30" />
      </span>
    ) : (
      <span className="font-medium">—</span>
    );
  return (
    <dl className="grid min-w-0 gap-3 px-4 py-3 text-sm sm:gap-0 sm:py-2">
      <OrganizationRow label="Database size">
        {values ? (
          <span className="font-medium tabular-nums">{values.database}</span>
        ) : (
          placeholder(false)
        )}
      </OrganizationRow>
      {WORKER_LABELS.map(([key, label]) => {
        const worker = values?.workers.find((row) => row.key === key);
        const icon = worker?.state ? WORKER_ICONS[worker.state] : null;
        return (
          <OrganizationRow key={key} label={label}>
            {worker ? (
              <>
                <span className="flex items-center gap-2 font-medium tabular-nums">
                  {icon ? (
                    <icon.icon
                      aria-hidden="true"
                      className={cn("size-4 shrink-0", icon.className)}
                    />
                  ) : null}
                  {worker.word}
                </span>
                {worker.detail ? (
                  <span className="text-muted-foreground">{worker.detail}</span>
                ) : null}
              </>
            ) : (
              placeholder(true)
            )}
          </OrganizationRow>
        );
      })}
    </dl>
  );
}

/** Block 4, Installation (D18), for the installation owner only. */
function InstallationCard({
  block,
  loading,
}: {
  block: InstallationBlock;
  loading: boolean;
}) {
  return (
    <section
      aria-labelledby="system-health-installation"
      className={cardClassName}
    >
      <CardHeader id="system-health-installation">Installation</CardHeader>
      <LoadingRegion
        loading={loading}
        label="Loading system status"
        skeleton={<InstallationList cells="skeleton" />}
      >
        <InstallationList cells={block === "pending" ? "dash" : block} />
      </LoadingRegion>
    </section>
  );
}

/** The page body for one state: blocks 1, 2, 3 (admins), 4 (the owner), 5
 * and 6 in reading order. */
export function SystemHealthView({
  state,
  busy,
  onCheckAgain,
  announcement,
  releaseLink,
  viewer,
  organization,
  installation,
  timeline,
  supportFile,
  linkTo,
}: {
  state: SystemHealthState;
  busy: boolean;
  onCheckAgain: () => void;
  announcement: string;
  releaseLink: ReactNode;
  /** Whom block 6 tells the reader to contact (D6). */
  viewer: ReferenceViewer;
  /** Block 3; null renders no card, heading or gap (D8.1). */
  organization: OrganizationBlock | null;
  /** Block 4; null renders no card, heading or gap (D18.1). */
  installation: InstallationBlock | null;
  /** The 30-day timeline under the parts (D15.1). */
  timeline: ReactNode;
  /** Block 6's support file, for admins and the owner (D19.1). */
  supportFile: ReactNode;
  linkTo: (href: Route, label: string) => ReactNode;
}) {
  const loading = state.kind === "loading";
  const result = state.kind === "result" ? state : null;
  const headline = result ? systemHeadline(result.status.parts) : null;
  const headlineIcon = headline ? TONE_ICONS[headline.tone] : null;
  const failure = state.kind === "loading" ? null : state.failure;
  const rows = partRows(result?.status.parts ?? []);
  const advice = referenceAdvice(viewer);
  return (
    <div className="flex max-w-2xl min-w-0 flex-col gap-4">
      <section
        aria-labelledby="system-health-headline"
        className={cn(cardClassName, "p-4")}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <LoadingRegion
              loading={loading}
              label="Loading system status"
              skeleton={
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-[1.125rem] w-3/5" />
                  <Skeleton className="h-3.5 w-24" />
                </div>
              }
            >
              <div className="flex items-start gap-2">
                {headlineIcon ? (
                  <headlineIcon.icon
                    aria-hidden="true"
                    className={cn(
                      "mt-0.5 size-5 shrink-0",
                      headlineIcon.className,
                    )}
                  />
                ) : null}
                <h2
                  id="system-health-headline"
                  data-slot="section-title"
                  className="text-lg font-semibold"
                >
                  {headline
                    ? headline.sentence
                    : state.kind === "unavailable"
                      ? "The status cannot be checked now."
                      : "System status"}
                </h2>
              </div>
              {result ? (
                <p className="text-muted-foreground mt-1 text-sm tabular-nums">
                  {result.checkLine}
                </p>
              ) : null}
            </LoadingRegion>
          </div>
          {/* A focused button that turns disabled loses focus, so a running
              check uses aria-disabled and ignores presses (D2.4). */}
          <Button
            type="button"
            variant="ghost"
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
            className="min-h-11 shrink-0 self-start max-sm:-ml-3 xl:min-h-8"
            onClick={() => {
              if (!busy) onCheckAgain();
            }}
          >
            <RefreshCw
              aria-hidden="true"
              className={busy ? "motion-safe:animate-spin" : undefined}
            />
            Check again
          </Button>
        </div>
        {failure ? (
          <Alert
            role="alert"
            variant="destructive"
            className="mt-3"
            reference={failure.reference}
          >
            <p>{failure.message}</p>
          </Alert>
        ) : null}
        <span role="status" className="sr-only">
          {announcement}
        </span>
      </section>

      <section aria-labelledby="system-health-parts" className={cardClassName}>
        <CardHeader id="system-health-parts">
          Parts of Slate Operations
        </CardHeader>
        {/* One region for the four cells, so the label is announced once;
            the part names are fixed and render at once (D2.7). */}
        <LoadingRegion
          loading={loading}
          label="Loading system status"
          skeleton={<PartList rows={null} />}
        >
          <PartList rows={rows} />
        </LoadingRegion>
        {timeline}
      </section>

      {organization ? (
        <OrganizationCard
          block={organization}
          loading={loading}
          linkTo={linkTo}
        />
      ) : null}

      {installation ? (
        <InstallationCard block={installation} loading={loading} />
      ) : null}

      <section aria-labelledby="system-health-about" className={cardClassName}>
        <CardHeader id="system-health-about">About this system</CardHeader>
        <dl className="grid min-w-0 px-4 py-2 text-sm">
          <div className="grid min-w-0 grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-3 py-1.5 sm:grid-cols-[8.5rem_minmax(0,1fr)]">
            <dt className="text-muted-foreground">Version</dt>
            <dd className="min-w-0 tabular-nums">
              <LoadingRegion
                loading={loading}
                label="Loading system status"
                skeleton={<Skeleton className="h-3.5 w-12" />}
              >
                <span className="flex flex-wrap items-baseline gap-x-1">
                  <span>{result ? result.status.version : "—"}</span>
                  {releaseLink ? (
                    <>
                      <span
                        aria-hidden="true"
                        className="text-muted-foreground"
                      >
                        ·
                      </span>
                      {releaseLink}
                    </>
                  ) : null}
                </span>
              </LoadingRegion>
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="system-health-help" className={cardClassName}>
        <CardHeader id="system-health-help">
          When something goes wrong
        </CardHeader>
        <div className="flex flex-col gap-2 px-4 py-3 text-sm leading-6">
          <p>
            When an action fails, its message shows a reference, for example
            “Reference <code className="font-mono">4f9c2e1a</code>”, with a Copy
            button.{advice ? ` ${advice}` : ""}
          </p>
          <p>{notLoadingAdvice(viewer)}</p>
          {supportFile}
        </div>
      </section>
    </div>
  );
}
