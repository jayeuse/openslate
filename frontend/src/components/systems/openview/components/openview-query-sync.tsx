"use client";

import { useEffect } from "react";
import {
  useQueryClient,
  type Query,
  type QueryKey,
} from "@tanstack/react-query";
import { subscribeWorkspaceInvalidations } from "../../shared/adapters/invalidation-events";
import {
  openViewKeys,
  openViewKeysForEntity,
} from "../adapters/openview-queries";

/**
 * Keeps cached OpenView reads current while a section that uses them is open.
 * It holds the shared invalidation stream across changes between those
 * sections and maps each event to the cached reads that depend on it. When
 * it stops (another section, or leaving OpenView), events stop arriving, so
 * every cached read is marked stale: the next visit shows it at once and
 * refreshes it in the background.
 */
export function OpenViewQuerySync({ active }: { active: boolean }) {
  const client = useQueryClient();
  useEffect(() => {
    if (!active) return;
    // Reads again every cached read under `queryKey` that `matches`. A read
    // in flight with data is restarted by invalidation, but one with no data
    // is not (TanStack reuses its request), and it may have read before the
    // change: cancel it first so the refetch starts after the event.
    const refresh = (
      queryKey: QueryKey,
      matches: (query: Query) => boolean,
    ) => {
      const cold = client
        .getQueryCache()
        .findAll({ queryKey, fetchStatus: "fetching" })
        .filter((query) => matches(query) && query.state.data === undefined);
      void Promise.all(
        cold.map((query) => query.cancel({ revert: true })),
      ).then(() => client.invalidateQueries({ queryKey, predicate: matches }));
    };
    const everyRead = () => true;
    const unsubscribe = subscribeWorkspaceInvalidations(
      (event) => {
        if (event.type === "resync") {
          refresh(openViewKeys.all, everyRead);
          return;
        }
        for (const queryKey of openViewKeysForEntity(event.entity))
          refresh(queryKey, everyRead);
      },
      // Every read that exists now started before the stream connected (a
      // hover prefetch, an earlier visit, or a read that overlapped the
      // handshake), so it may have missed a change: read it again. Reads
      // that start after this moment are covered by the stream.
      () => refresh(openViewKeys.all, everyRead),
    );
    return () => {
      unsubscribe();
      void client.invalidateQueries({
        queryKey: openViewKeys.all,
        refetchType: "none",
      });
    };
  }, [active, client]);
  return null;
}
