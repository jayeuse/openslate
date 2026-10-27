"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { subscribeWorkspaceInvalidations } from "@/components/systems/shared/adapters/invalidation-events";
import { useWorkspaceInteractionSuspended } from "@/components/systems/shared/runtime/workspace-identity";
import { boardsNavigationOptions } from "@/components/systems/boards/adapters/boards-queries";

/**
 * Reads the board list for the Boards group while it is open away from
 * /boards (BR2), and keeps it current with the live stream. The sidebar
 * reads the cache only and shows no names after a refused read.
 */
export function BoardsNavigationReader() {
  const suspended = useWorkspaceInteractionSuspended();
  // The sidebar observes this key with `skipToken`, so a refresh goes
  // through this observer's own read (`refetch`), never a bare invalidation.
  const { refetch } = useQuery({
    ...boardsNavigationOptions(),
    enabled: !suspended,
  });
  useEffect(() => {
    const unsubscribe = subscribeWorkspaceInvalidations((event) => {
      if (event.type === "resync" || event.entity === "boards") void refetch();
    });
    // No invalidation on close: the Boards page reads the list as it opens
    // (one read, BF-7), and elsewhere the 30-second freshness bounds it.
    return unsubscribe;
  }, [refetch]);
  return null;
}
