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
    const unsubscribe = subscribeWorkspaceInvalidations((event) => {
      if (event.type !== "resync" && !accepts(event)) return;
      clearTimeout(timer);
      timer = setTimeout(refresh, 300);
    }, refresh);
    return () => {
      active = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [scope, accepts]);
  return key;
}
