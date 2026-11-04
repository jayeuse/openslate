"use client";

import { useQuery } from "@tanstack/react-query";
import { CircleGauge, CircleX } from "lucide-react";
import { useEffect, useRef, useState, type Ref } from "react";

import { Button } from "@/components/ui/button";
import { ErrorReference } from "@/components/ui/error-reference";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { apiErrorReference } from "@/lib/api-errors";
import { cn } from "@/lib/utils";

import {
  listSystemHealthPeriods,
  manageSystemHealthPeriodsOptions,
} from "../adapters/system-health-periods-api";
import {
  healthPeriodKey,
  mergePeriods,
  periodRow,
  timelineEmptyText,
  type HealthPeriod,
  type PeriodRow,
} from "../domain/health-rules";
import { useWorkspaceRegion } from "./backup-time";

/** "Show older" adds 10 rows at a time (D15.5). */
const OLDER_PAGE_SIZE = 10;

/** The older pages after the first: "none" when nothing older exists. */
export type OlderPeriods =
  "none" | "idle" | "loading" | { failed: string | undefined };

export type TimelineState =
  /** The session ended: the signed-out behavior applies, so nothing shows. */
  | { kind: "signed-out" }
  | { kind: "loading" }
  | { kind: "error"; reference: string | undefined }
  | { kind: "rows"; rows: PeriodRow[]; empty: string; older: OlderPeriods };

/**
 * The last 30 days under the parts (S5-C3, docs/specs/system-health.md D15):
 * the 5 newest periods from the cached first page, then 10 more for each
 * "Show older". The first page polls every 60 seconds; the older pages stay
 * through each refresh, so a refresh keeps the rows the person opened, and
 * the fresh first page wins over an older copy of the same period.
 */
export function SystemHealthTimeline() {
  const region = useWorkspaceRegion();
  const query = useQuery(manageSystemHealthPeriodsOptions());
  const [older, setOlder] = useState<{
    periods: HealthPeriod[];
    hasMore: boolean;
    status: Exclude<OlderPeriods, "none">;
  } | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const first = query.data;
  const periods = first ? mergePeriods(first.items, older?.periods ?? []) : [];

  let state: TimelineState;
  if (first) {
    const now = new Date(query.dataUpdatedAt);
    const hasMore = older ? older.hasMore : first.pagination.has_more;
    const status = older?.status ?? "idle";
    state = {
      kind: "rows",
      rows: periods.map((period) => periodRow(period, now, region)),
      empty: timelineEmptyText(first.oldest_sample_at, now, region),
      older: typeof status === "object" ? status : hasMore ? status : "none",
    };
  } else if (query.error instanceof ApiError && query.error.status === 401)
    state = { kind: "signed-out" };
  else if (query.isError)
    state = { kind: "error", reference: apiErrorReference(query.error) };
  else state = { kind: "loading" };

  async function showOlder() {
    if (!first || older?.status === "loading") return;
    const loaded = older?.periods ?? [];
    const base = {
      periods: loaded,
      hasMore: older?.hasMore ?? first.pagination.has_more,
    };
    setOlder({ ...base, status: "loading" });
    try {
      // A press is the person's action, so a refused session refreshes.
      const page = await listSystemHealthPeriods(
        { limit: OLDER_PAGE_SIZE, offset: periods.length },
        "person",
      );
      const shown = new Set(periods.map(healthPeriodKey));
      const next = page.items.find(
        (period) => !shown.has(healthPeriodKey(period)),
      );
      setOlder({
        periods: [...loaded, ...page.items],
        hasMore: page.pagination.has_more,
        status: "idle",
      });
      if (next) setFocusKey(healthPeriodKey(next));
    } catch (error) {
      setOlder({ ...base, status: { failed: apiErrorReference(error) } });
    }
  }

  return (
    <TimelineView
      state={state}
      focusKey={focusKey}
      onRetry={() => void query.refetch()}
      onShowOlder={() => void showOlder()}
    />
  );
}

const errorBlockClassName =
  "flex flex-wrap items-center gap-3 rounded-[var(--radius)] border p-3";

/** The timeline for one state (D15.1 to D15.8). */
export function TimelineView({
  state,
  focusKey,
  onRetry,
  onShowOlder,
}: {
  state: TimelineState;
  /** The first row of the page that loaded last; it takes focus. */
  focusKey: string | null;
  onRetry: () => void;
  onShowOlder: () => void;
}) {
  const target = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (focusKey) target.current?.focus();
  }, [focusKey]);
  const older = state.kind === "rows" ? state.older : "none";
  return (
    <div className="border-border grid min-w-0 gap-2 border-t px-4 py-3 text-sm">
      <h3
        id="system-health-timeline"
        className="text-foreground text-sm font-semibold"
      >
        Last 30 days
      </h3>
      <LoadingRegion
        loading={state.kind === "loading"}
        label="Loading the last 30 days…"
        skeleton={
          <div aria-hidden="true" className="grid gap-1">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        }
      >
        {state.kind === "error" ? (
          <div className={errorBlockClassName}>
            <p role="alert" className="text-destructive mr-auto text-sm">
              The last 30 days could not be loaded.
            </p>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 xl:min-h-8"
              onClick={onRetry}
            >
              Retry
            </Button>
            <ErrorReference id={state.reference} className="basis-full" />
          </div>
        ) : state.kind === "rows" && state.rows.length === 0 ? (
          <span className="text-muted-foreground flex min-h-11 items-center text-sm">
            {state.empty}
          </span>
        ) : state.kind === "rows" ? (
          <ol
            aria-labelledby="system-health-timeline"
            className="border-border @container min-w-0 rounded-[var(--radius)] border"
          >
            {state.rows.map((row) => (
              <PeriodItem
                key={row.key}
                row={row}
                rowRef={row.key === focusKey ? target : undefined}
              />
            ))}
          </ol>
        ) : null}
      </LoadingRegion>
      {typeof older === "object" ? (
        <div className={errorBlockClassName}>
          <p role="alert" className="text-destructive mr-auto text-sm">
            Older periods could not be loaded.
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 xl:min-h-8"
            onClick={onShowOlder}
          >
            Retry
          </Button>
          <ErrorReference id={older.failed} className="basis-full" />
        </div>
      ) : older === "idle" || older === "loading" ? (
        <div>
          {/* A focused button that turns disabled loses focus, so a running
              page uses aria-disabled and ignores presses (D9.3, D15.5). */}
          <Button
            type="button"
            variant="outline"
            className="min-h-11 xl:min-h-8"
            aria-disabled={older === "loading" || undefined}
            aria-busy={older === "loading" || undefined}
            onClick={() => {
              if (older !== "loading") onShowOlder();
            }}
          >
            Show older
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** One period in the D9.2 row grammar, with no control (D15.2). */
function PeriodItem({
  row,
  rowRef,
}: {
  row: PeriodRow;
  rowRef: Ref<HTMLLIElement> | undefined;
}) {
  const Icon = row.kind === "slow" ? CircleGauge : CircleX;
  return (
    <li
      ref={rowRef}
      tabIndex={-1}
      className="border-border focus:ring-ring flex min-h-14 min-w-0 items-start gap-2.5 border-b px-3 py-2 outline-none last:border-b-0 focus:ring-2 focus:ring-inset"
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-4 shrink-0",
          row.kind === "slow" ? "text-warn-text" : "text-danger-text",
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium">{row.sentence}</span>
        <span className="text-muted-foreground text-[0.8125rem] tabular-nums">
          {row.meta ? (
            <>
              <span className="whitespace-nowrap">{row.meta.from}</span> to{" "}
              <span className="whitespace-nowrap">{row.meta.to}</span>
            </>
          ) : (
            "Still going"
          )}
        </span>
      </span>
    </li>
  );
}
