import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";

import { apiContractError, apiFetch } from "@/lib/api";

import type { HealthPeriod } from "../domain/health-rules";
import { manageKeys } from "./manage-queries";

// System health's 30-day timeline read. Only the timeline imports this
// module, so its schema and query stay out of the shell, which imports
// `manage-queries` (cold Comms budget, tests/http/comms-js-budget.spec.ts).

const instant = z.iso.datetime({ offset: true });

const healthPeriodSchema = z
  .object({
    part: z.enum(["data", "signing_in", "files", "email"]),
    kind: z.enum(["not_working", "slow"]),
    started_at: instant,
    ended_at: instant.nullable(),
  })
  .strict() satisfies z.ZodType<HealthPeriod>;

// GET /api/system/health-periods (API contract S5, S5-C3): the same answer for
// everyone; periods still going first, then ended ones by end time, newest
// first. `oldest_sample_at` tells how far back the history reaches.
const healthPeriodsPageSchema = z
  .object({
    items: z.array(healthPeriodSchema),
    pagination: z
      .object({
        limit: z.number().int().min(1).max(100),
        offset: z.number().int().nonnegative(),
        count: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        has_more: z.boolean(),
      })
      .strict(),
    oldest_sample_at: instant.nullable(),
  })
  .strict();

export type HealthPeriodsPage = z.output<typeof healthPeriodsPageSchema>;

/**
 * One page of the last 30 days. As for the status read, `background` is the
 * 60-second refresh and never renews an idle session; opening the page and
 * "Show older" are the person's (`person`).
 */
export async function listSystemHealthPeriods(
  page: { limit: number; offset: number },
  origin: "person" | "background",
  signal?: AbortSignal,
): Promise<HealthPeriodsPage> {
  const query = new URLSearchParams({
    limit: String(page.limit),
    offset: String(page.offset),
  });
  const result = await apiFetch(
    `/system/health-periods?${query}`,
    healthPeriodsPageSchema,
    { cache: "no-store", signal, refreshOnUnauthorized: origin === "person" },
  );
  const p = result.pagination;
  if (
    p.limit !== page.limit ||
    p.offset !== page.offset ||
    p.count !== result.items.length ||
    // The contract's identity of a period (`healthPeriodKey`).
    new Set(
      result.items.map(
        (item) => `${item.part}:${item.kind}:${item.started_at}`,
      ),
    ).size !== p.count
  )
    throw apiContractError(result);
  return result;
}

/** System health shows the 5 newest periods first (D15.5). */
export const HEALTH_PERIODS_FIRST_PAGE = 5;
/**
 * The first page of System health's 30-day timeline (S5-C3, D15). It polls
 * with the status read, every 60 seconds while the page is visible; the
 * server answers from a 60-second history cache. Opening the page is the
 * person's action, so the first read, before the query has ever settled,
 * refreshes a refused session; every later read is the poll and never renews
 * an idle session (as `systemHealthStatusOptions`).
 */
export const manageSystemHealthPeriodsOptions = () =>
  queryOptions({
    queryKey: manageKeys.systemHealthPeriods(),
    queryFn: ({ client, queryKey, signal }) => {
      const state = client.getQueryState(queryKey);
      const opening =
        !state || state.dataUpdateCount + state.errorUpdateCount === 0;
      return listSystemHealthPeriods(
        { limit: HEALTH_PERIODS_FIRST_PAGE, offset: 0 },
        opening ? "person" : "background",
        signal,
      );
    },
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
