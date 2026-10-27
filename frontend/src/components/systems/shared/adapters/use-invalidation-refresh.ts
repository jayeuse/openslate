"use client";

import { useEffect, useState } from "react";
import {
  subscribeWorkspaceInvalidations,
  type WorkspaceInvalidation,
} from "./invalidation-events";

/** A data refresh signal; it never owns a draft, mutation or stream. */
export function useInvalidationRefresh(
  scope: string | null,
  accepts: (event: WorkspaceInvalidation) => boolean,
): number {
  const [key, setKey] = useState(0);
  useEffect(() => {
    if (scope === null) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (active) setKey((value) => value + 1);
    };
    // A stream that is already live admits this listener in the microtask it
    // queued while subscribing, before the one below. Reads of this scope
    // start in the same commit, after the stream was live, so they are
    // covered and are not read again (BF-7). A stream that connects later
    // may have missed a change since those reads: they read again.
    let subscribing = true;
    const unsubscribe = subscribeWorkspaceInvalidations(
      (event) => {
        if (event.type !== "resync" && !accepts(event)) return;
        clearTimeout(timer);
        timer = setTimeout(refresh, 300);
      },
      () => {
        if (!subscribing) refresh();
      },
    );
    queueMicrotask(() => {
      subscribing = false;
    });
    return () => {
      active = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [scope, accepts]);
  return key;
}
