"use client";

import { useCallback } from "react";
import { sampleOperationMessage, useSampleCommands } from "../sample-async";
import { useSampleRuntime, type SampleTransactionDraft } from "../sample-state";
import type { SampleRecord } from "../sample-data";
import type { RecordThread } from "./model";
import {
  normalizeCommsConfiguration,
  type CommsConfiguration,
} from "./configuration";

export const COMMS_CONFIGURATION_KEY = "comms-configuration";

export type CommsRecipe<T> = (draft: SampleTransactionDraft) => T;

export type CommsCommandResult = { ok: true } | { ok: false; error: string };

/** Read the latest configuration inside an atomic runtime recipe. */
export function readCommsConfiguration(
  draft: Pick<SampleTransactionDraft, "read">,
): CommsConfiguration {
  return normalizeCommsConfiguration(
    draft.read<unknown>(COMMS_CONFIGURATION_KEY, null),
  );
}

/** Stage a normalized configuration update in the current atomic recipe. */
export function stageCommsConfiguration(
  draft: SampleTransactionDraft,
  action: (current: CommsConfiguration) => CommsConfiguration,
): CommsConfiguration {
  const next = normalizeCommsConfiguration(
    action(readCommsConfiguration(draft)),
  );
  draft.update(COMMS_CONFIGURATION_KEY, null, next);
  return next;
}

/** Stage the Comms-owned record thread created from a Platform record action. */
export function stageRecordDiscussion(
  draft: SampleTransactionDraft,
  record: Pick<SampleRecord, "id" | "title">,
): RecordThread {
  const current = draft.read<RecordThread[]>("commsRecordThreads", []);
  const existing = current.find((item) => item.recordId === record.id);
  if (existing) return existing;
  const thread: RecordThread = {
    id: `sample-record-thread-${crypto.randomUUID()}`,
    recordId: record.id,
    text: `Discuss ${record.title}`,
  };
  draft.update<RecordThread[]>("commsRecordThreads", [], (items) => [
    ...items,
    thread,
  ]);
  return thread;
}

/**
 * Feature-owned async command boundary for Comms. Recipes remain synchronous;
 * the runtime reads current state and commits all staged owners together.
 */
export function useCommsCommands() {
  const runtime = useSampleRuntime();
  const { run: executeCommand, isPending, pendingKeys } = useSampleCommands();
  const run = useCallback(
    <T>(
      key: string,
      recipe: CommsRecipe<T>,
      keys: readonly string[],
    ): Promise<T> =>
      executeCommand(key, (signal) =>
        runtime.execute(recipe, { keys, signal }),
      ),
    [executeCommand, runtime],
  );
  return {
    run,
    isPending,
    pendingKeys,
  };
}

export function messageFromCommsError(
  error: unknown,
  fallback: string,
): string {
  return sampleOperationMessage(error, fallback);
}
