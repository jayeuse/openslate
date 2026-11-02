"use client";

import { useCallback, useState } from "react";

import { errorTextFor, type ApiErrorText } from "@/lib/api-errors";

/**
 * One error state that keeps the message and its request's reference together
 * (D1.6, docs/specs/system-health.md). `setError("")` or `setError(null)`
 * clears it; an API failure passes the caught error as `cause`. Render
 * `failure?.message` and give `failure?.reference` to the alert's `reference`.
 */
export function useErrorText(): readonly [
  ApiErrorText | null,
  (message: string | null, cause?: unknown) => void,
] {
  const [failure, setFailure] = useState<ApiErrorText | null>(null);
  const setError = useCallback(
    (message: string | null, cause?: unknown) =>
      setFailure(errorTextFor(message ?? "", cause)),
    [],
  );
  return [failure, setError] as const;
}
