"use client";
import { useCallback, type Dispatch, type SetStateAction } from "react";
import { useSampleState } from "../sample-state";
import {
  normalizeCommsConfiguration,
  type CommsConfiguration,
} from "./configuration";
export function useCommsConfiguration(): [
  CommsConfiguration,
  Dispatch<SetStateAction<CommsConfiguration>>,
] {
  const [raw, setRaw] = useSampleState<unknown>("comms-configuration", null);
  const value = normalizeCommsConfiguration(raw);
  const setValue = useCallback<Dispatch<SetStateAction<CommsConfiguration>>>(
    (action) => {
      setRaw((previous: unknown) => {
        const current = normalizeCommsConfiguration(previous);
        return normalizeCommsConfiguration(
          typeof action === "function" ? action(current) : action,
        );
      });
    },
    [setRaw],
  );
  return [value, setValue];
}
