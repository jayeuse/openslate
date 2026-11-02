"use client";

import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  ExternalLink,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import { ApiError } from "@/lib/api";
import { apiErrorReference, type ApiErrorText } from "@/lib/api-errors";
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
  checkAnnouncement,
  createAnnouncer,
  checkTime,
  checkTimeText,
  nextCheckSuffix,
  PART_NAMES,
  PART_ORDER,
  partRows,
  systemHeadline,
  type CheckSuffix,
  type CheckTrigger,
  type HeadlineTone,
  type PartStatus,
} from "../domain/health-rules";
import { useWorkspaceRegion } from "./backup-time";

const CONNECTION_MESSAGE =
  "Could not connect. Check your connection and try again.";

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

const TONE_ICONS: Readonly<Record<HeadlineTone, LucideIcon>> = {
  working: CircleCheck,
  not_set_up: CircleMinus,
  not_working: CircleX,
};

const PART_ICONS: Readonly<
  Record<PartStatus, { icon: LucideIcon; className: string } | null>
> = {
  working: { icon: CircleCheck, className: "text-flow-text" },
  set_up: { icon: CircleDashed, className: "text-muted-foreground" },
  not_set_up: { icon: CircleMinus, className: "text-warn-text" },
  not_working: { icon: CircleX, className: "text-danger-text" },
  unknown: null,
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
 * "Check again" are (`systemHealthStatusOptions`).
 */
export function SystemHealth({
  installationOwner,
}: {
  installationOwner: boolean;
}) {
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

  return (
    <SystemHealthView
      state={state}
      busy={personCheck || (status.isPending && status.isFetching)}
      onCheckAgain={() => void checkAgain()}
      announcement={spoken}
      releaseLink={releaseLink}
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

/** The page body for one state: blocks 1, 2, 5 and 6 in reading order. Block
 * 3 (Your organization) belongs between 2 and 5 from S3; nothing renders for
 * it now. */
export function SystemHealthView({
  state,
  busy,
  onCheckAgain,
  announcement,
  releaseLink,
}: {
  state: SystemHealthState;
  busy: boolean;
  onCheckAgain: () => void;
  announcement: string;
  releaseLink: ReactNode;
}) {
  const loading = state.kind === "loading";
  const result = state.kind === "result" ? state : null;
  const headline = result ? systemHeadline(result.status.parts) : null;
  const HeadlineIcon = headline ? TONE_ICONS[headline.tone] : null;
  const failure = state.kind === "loading" ? null : state.failure;
  const rows = partRows(result?.status.parts ?? []);
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
                {HeadlineIcon ? (
                  <HeadlineIcon
                    aria-hidden="true"
                    className={cn(
                      "mt-0.5 size-5 shrink-0",
                      headline?.tone === "working"
                        ? "text-flow-text"
                        : headline?.tone === "not_set_up"
                          ? "text-warn-text"
                          : "text-danger-text",
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
      </section>

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
            button. Give this reference to your administrator.
          </p>
          <p>
            When Slate Operations does not load: wait a minute and reload. If it
            still does not load, tell your administrator.
          </p>
        </div>
      </section>
    </div>
  );
}
