"use client";

import { useEffect } from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { subscribeOpenViewInvalidations } from "../adapters/invalidation-events";
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
    // Saved chart settings stay as loaded: reloading them can re-apply
    // settings over a Chart draft being edited, which the stream never did
    // before.
    const listeningSince = Date.now();
    const notChartPreferences = (query: Query) =>
      query.queryKey[1] !== openViewKeys.chartPreferences()[1];
    const unsubscribe = subscribeOpenViewInvalidations(
      (event) => {
        if (event.type === "resync") {
          void client.invalidateQueries({
            queryKey: openViewKeys.all,
            predicate: notChartPreferences,
          });
          return;
        }
        for (const queryKey of openViewKeysForEntity(event.entity))
          void client.invalidateQueries({ queryKey });
      },
      () => {
        // Reads cached before OpenView listened (a hover prefetch) could have
        // missed a change; refresh them once the stream is connected. Reads
        // already marked stale or in flight refresh on their own. Choose them
        // first: invalidateQueries applies its predicate again to pick what
        // to refetch, when every chosen read is already marked stale.
        const unprotected = new Set(
          client
            .getQueryCache()
            .findAll({ queryKey: openViewKeys.all })
            .filter(
              (query) =>
                notChartPreferences(query) &&
                query.state.dataUpdatedAt > 0 &&
                query.state.dataUpdatedAt < listeningSince &&
                !query.state.isInvalidated &&
                query.state.fetchStatus !== "fetching",
            ),
        );
        if (unprotected.size === 0) return;
        void client.invalidateQueries({
          queryKey: openViewKeys.all,
          predicate: (query) => unprotected.has(query),
        });
      },
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
