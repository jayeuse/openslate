"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
    const unsubscribe = subscribeOpenViewInvalidations((event) => {
      if (event.type === "resync") {
        // Saved chart settings stay as loaded: reloading them can re-apply
        // settings over a Chart draft being edited, which the stream never
        // did before.
        void client.invalidateQueries({
          queryKey: openViewKeys.all,
          predicate: (query) =>
            query.queryKey[1] !== openViewKeys.chartPreferences()[1],
        });
        return;
      }
      for (const queryKey of openViewKeysForEntity(event.entity))
        void client.invalidateQueries({ queryKey });
    });
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
