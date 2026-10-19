"use client";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  useSampleCommands,
  useSampleResource,
  sampleOperationMessage,
} from "../../shared/runtime/sample-async";
import type { CommsClient } from "../contract/client";
import { useCommsClient } from "./client-context";

export function useCommsCommands() {
  const { client } = useCommsClient();
  const latest = useRef(client);
  useLayoutEffect(() => {
    latest.current = client;
  }, [client]);
  const commands = useSampleCommands();
  const run = useCallback(
    <T>(
      key: string,
      action: (client: CommsClient, signal: AbortSignal) => Promise<T>,
    ) =>
      commands.run(key, async (signal) => {
        if (!client) throw new Error("Organization is not admitted");
        const result = await action(client, signal);
        await client.bootstrap({ signal });
        if (latest.current !== client)
          throw Object.assign(new Error("OpenComms operation cancelled"), {
            kind: "cancelled",
          });
        return result;
      }),
    [client, commands.run],
  );
  return { ...commands, run };
}
export function messageFromCommsError(
  error: unknown,
  fallback: string,
): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    error.kind === "cancelled"
  )
    return "The workspace changed before this operation finished. Try again.";
  return sampleOperationMessage(error, fallback);
}

export function useCommsRead<T>(
  key: string,
  load: (client: CommsClient, signal: AbortSignal) => Promise<T>,
) {
  const binding = useCommsClient();
  const [refused, setRefused] = useState(false);
  const result = useSampleResource<{
    client: CommsClient;
    key: string;
    value: T;
  }>({
    keys: ["comms-memory-v1"],
    queryKey: `${binding.generation}:${key}`,
    load: async (signal) => {
      if (!binding.client) throw new Error("Organization is not admitted");
      try {
        const value = await load(binding.client, signal);
        if (!signal.aborted) setRefused(false);
        return { client: binding.client, key, value };
      } catch (error) {
        if (!signal.aborted && isCommsReadRefusal(error)) setRefused(true);
        throw error;
      }
    },
  });
  return {
    ...result,
    data:
      !refused &&
      binding.client &&
      result.data?.client === binding.client &&
      result.data.key === key
        ? result.data.value
        : undefined,
    error: binding.error || result.error,
    status: binding.error
      ? "error"
      : !binding.client
        ? "loading"
        : result.status,
  };
}
export function isCommsReadRefusal(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "failure" in error &&
    typeof error.failure === "object" &&
    error.failure !== null &&
    "status" in error.failure &&
    [401, 403, 404].includes(Number(error.failure.status))
  );
}
