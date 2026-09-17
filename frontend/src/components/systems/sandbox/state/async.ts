"use client";

import { useCallback } from "react";
import {
  sampleOperationMessage,
  useSampleCommands,
} from "../../shared/runtime/sample-async";
import {
  useSampleRuntime,
  type SampleTransactionDraft,
} from "../../shared/runtime/sample-state";
import {
  applySandboxCommand,
  normalizeSandboxHistory,
  redoSandboxCommand,
  undoSandboxCommand,
  type SandboxHistory,
} from "./controller";
import {
  appendVersion,
  initialDesign,
  initialSandboxHistory,
  uid,
  type Design,
  type DesignUpdate,
  type Version,
} from "../domain/model";
import { validateSandboxDesign } from "../domain/validation";
import type { SandboxFileV1 } from "../helpers/file-format";

export const SANDBOX_RUNTIME_KEYS = [
  "sandbox.design",
  "sandbox.versions",
  "sandbox.simulation",
] as const;

export type SandboxCommandFailure = { ok: false; error: string };
export type SandboxCommandSuccess<T> = { ok: true; value: T };
export type SandboxCommandResult<T> =
  SandboxCommandSuccess<T> | SandboxCommandFailure;

/** Marks an expected, user-actionable rejection without exposing internals. */
export class SandboxCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxCommandError";
  }
}

export type StoredSandboxHistory =
  SandboxHistory | { past: Design[]; present: Design; future: Design[] };

export type SandboxSimulationUpdate = (
  current: unknown,
  design: Design,
) => unknown;

export type SandboxSnapshot = {
  history: SandboxHistory;
  versions: Version[];
  simulation: unknown;
};

export const initialRuntimeSandboxHistory =
  initialSandboxHistory as unknown as SandboxHistory;

export const initialSandboxVersions: Version[] = [
  {
    id: "sample-v1",
    label: "Starting structure",
    design: initialDesign,
    published: true,
    date: "Initial version",
  },
];

export const emptySandboxSimulation = {
  records: [],
  users: [],
  trace: [],
  runs: [],
};

export function readSandboxState(
  draft: Pick<SampleTransactionDraft, "read">,
): SandboxSnapshot {
  return {
    history: normalizeSandboxHistory(
      draft.read<unknown>("sandbox.design", initialRuntimeSandboxHistory),
      initialDesign,
    ),
    versions: draft.read<Version[]>("sandbox.versions", initialSandboxVersions),
    simulation: draft.read<unknown>(
      "sandbox.simulation",
      emptySandboxSimulation,
    ),
  };
}

function reject(draft: SampleTransactionDraft, error: string): never {
  return draft.reject<SandboxCommandFailure>({ ok: false, error });
}

function updateHistory(
  draft: SampleTransactionDraft,
  update: (history: SandboxHistory) => SandboxHistory,
): SandboxHistory {
  const current = readSandboxState(draft).history;
  const next = update(current);
  draft.update("sandbox.design", initialRuntimeSandboxHistory, next);
  return next;
}

/**
 * Apply one confirmed Sandbox command to the latest transaction draft.
 * Every cross-owner operation stages all of its owners before the runtime
 * publishes, so rejection cannot leave a checkpoint, release, or import half
 * applied.
 */
export function applySandboxRuntimeCommand(
  draft: SampleTransactionDraft,
  command:
    | { type: "change-design"; update: DesignUpdate }
    | { type: "undo" }
    | { type: "redo" }
    | { type: "checkpoint"; label: string; note: string }
    | { type: "release"; note: string }
    | { type: "import"; file: SandboxFileV1 }
    | { type: "reset-design" }
    | {
        type: "update-versions";
        update: (current: Version[]) => Version[];
      }
    | { type: "restore-version"; id: string }
    | { type: "rollback-version"; id: string }
    | { type: "delete-version"; id: string }
    | { type: "restore-deleted-version"; version: Version; index: number }
    | { type: "update-simulation"; update: SandboxSimulationUpdate }
    | { type: "restore-snapshot"; snapshot: SandboxSnapshot },
): SandboxCommandResult<unknown> {
  const state = readSandboxState(draft);
  switch (command.type) {
    case "change-design": {
      const nextDesign =
        typeof command.update === "function"
          ? command.update(state.history.present)
          : command.update;
      updateHistory(draft, (history) =>
        applySandboxCommand(history, {
          type: "replace-design",
          design: nextDesign,
        }),
      );
      return { ok: true, value: nextDesign };
    }
    case "undo": {
      updateHistory(draft, undoSandboxCommand);
      return { ok: true, value: null };
    }
    case "redo": {
      updateHistory(draft, redoSandboxCommand);
      return { ok: true, value: null };
    }
    case "checkpoint": {
      const version: Version = {
        id: uid(),
        label: command.label.trim(),
        design: structuredClone(state.history.present),
        published: false,
        date: new Date().toLocaleString(),
        ...(command.note.trim() ? { note: command.note.trim() } : {}),
      };
      draft.update(
        "sandbox.versions",
        initialSandboxVersions,
        appendVersion(state.versions, version),
      );
      return { ok: true, value: version };
    }
    case "release": {
      const issue = validateSandboxDesign(state.history.present).find(
        (entry) => entry.severity === "error",
      );
      if (issue) return reject(draft, issue.message);
      const releaseNumber = state.versions.filter(
        (version) => version.published,
      ).length;
      const version: Version = {
        id: uid(),
        label: `Release snapshot ${releaseNumber + 1}`,
        design: structuredClone(state.history.present),
        published: true,
        date: new Date().toLocaleString(),
        ...(command.note.trim() ? { note: command.note.trim() } : {}),
      };
      draft.update(
        "sandbox.versions",
        initialSandboxVersions,
        appendVersion(state.versions, version),
      );
      return { ok: true, value: version };
    }
    case "import": {
      const beforeImport: Version = {
        id: uid(),
        label: "Before import",
        design: structuredClone(state.history.present),
        published: false,
        date: new Date().toLocaleString(),
        note: "Automatic recovery checkpoint",
      };
      const versions = appendVersion(
        command.file.versions ?? state.versions,
        beforeImport,
      );
      const history = applySandboxCommand(state.history, {
        type: "replace-design",
        design: structuredClone(command.file.design),
      });
      draft.update("sandbox.versions", initialSandboxVersions, versions);
      draft.update("sandbox.design", initialRuntimeSandboxHistory, history);
      return { ok: true, value: { history, versions } };
    }
    case "reset-design": {
      const history = applySandboxCommand(state.history, {
        type: "replace-design",
        design: structuredClone(initialDesign),
      });
      draft.update("sandbox.design", initialRuntimeSandboxHistory, history);
      return { ok: true, value: history.present };
    }
    case "update-versions": {
      const versions = command.update(state.versions);
      draft.update("sandbox.versions", initialSandboxVersions, versions);
      return { ok: true, value: versions };
    }
    case "restore-version": {
      const version = state.versions.find((entry) => entry.id === command.id);
      if (!version)
        return reject(draft, "This version is no longer available.");
      const issue = validateSandboxDesign(version.design).find(
        (entry) => entry.severity === "error",
      );
      if (issue)
        return reject(draft, `Stored snapshot is malformed: ${issue.message}`);
      const history = applySandboxCommand(state.history, {
        type: "replace-design",
        design: structuredClone(version.design),
      });
      draft.update("sandbox.design", initialRuntimeSandboxHistory, history);
      return { ok: true, value: version };
    }
    case "rollback-version": {
      const version = state.versions.find((entry) => entry.id === command.id);
      if (!version)
        return reject(draft, "This version is no longer available.");
      const issue = validateSandboxDesign(version.design).find(
        (entry) => entry.severity === "error",
      );
      if (issue)
        return reject(draft, `Stored snapshot is malformed: ${issue.message}`);
      const restoredDesign = structuredClone(version.design);
      const history = applySandboxCommand(state.history, {
        type: "replace-design",
        design: restoredDesign,
      });
      const release: Version = {
        id: uid(),
        label: `Rollback to ${version.label}`,
        design: restoredDesign,
        published: true,
        date: new Date().toLocaleString(),
        note: `Rollback snapshot created from ${version.label}`,
      };
      draft.update("sandbox.design", initialRuntimeSandboxHistory, history);
      draft.update(
        "sandbox.versions",
        initialSandboxVersions,
        appendVersion(state.versions, release),
      );
      return { ok: true, value: { version, release } };
    }
    case "delete-version": {
      const index = state.versions.findIndex(
        (entry) => entry.id === command.id,
      );
      const version = state.versions[index];
      if (!version)
        return reject(draft, "This version is no longer available.");
      const latestPublished = state.versions
        .filter((entry) => entry.published)
        .at(-1);
      if (state.versions.length === 1 || latestPublished?.id === version.id)
        return reject(draft, "The current release snapshot cannot be deleted.");
      const versions = state.versions.filter(
        (entry) => entry.id !== version.id,
      );
      draft.update("sandbox.versions", initialSandboxVersions, versions);
      return { ok: true, value: { version, index, versions } };
    }
    case "restore-deleted-version": {
      if (state.versions.some((entry) => entry.id === command.version.id))
        return reject(draft, "This version has already been restored.");
      const versions = [...state.versions];
      versions.splice(
        Math.min(command.index, versions.length),
        0,
        command.version,
      );
      draft.update("sandbox.versions", initialSandboxVersions, versions);
      return { ok: true, value: versions };
    }
    case "update-simulation": {
      const simulation = command.update(
        state.simulation,
        state.history.present,
      );
      draft.update("sandbox.simulation", emptySandboxSimulation, simulation);
      return { ok: true, value: simulation };
    }
    case "restore-snapshot": {
      draft.update(
        "sandbox.design",
        initialRuntimeSandboxHistory,
        command.snapshot.history,
      );
      draft.update(
        "sandbox.versions",
        initialSandboxVersions,
        command.snapshot.versions,
      );
      draft.update(
        "sandbox.simulation",
        emptySandboxSimulation,
        command.snapshot.simulation,
      );
      return { ok: true, value: null };
    }
  }
}

export function useSandboxCommands() {
  const runtime = useSampleRuntime();
  const commands = useSampleCommands();
  const run = useCallback(
    <T>(
      key: string,
      command: Parameters<typeof applySandboxRuntimeCommand>[1],
      keys: readonly string[] = SANDBOX_RUNTIME_KEYS,
    ): Promise<SandboxCommandResult<T>> =>
      commands
        .run(key, (signal) =>
          runtime.execute<SandboxCommandResult<T>>(
            (draft) =>
              applySandboxRuntimeCommand(
                draft,
                command,
              ) as SandboxCommandResult<T>,
            { keys, signal },
          ),
        )
        .catch((error: unknown) => ({
          ok: false as const,
          error:
            error instanceof SandboxCommandError && error.message
              ? error.message
              : sampleOperationMessage(
                  error,
                  "This Sandbox change could not be saved. Try again.",
                ),
        })),
    [commands, runtime],
  );
  const change = useCallback(
    (update: DesignUpdate, commandKey = "sandbox.design") =>
      run<Design>(commandKey, { type: "change-design", update }, [
        "sandbox.design",
      ]),
    [run],
  );
  const undo = useCallback(
    () =>
      run<null>("sandbox.history.undo", { type: "undo" }, ["sandbox.design"]),
    [run],
  );
  const redo = useCallback(
    () =>
      run<null>("sandbox.history.redo", { type: "redo" }, ["sandbox.design"]),
    [run],
  );
  const checkpoint = useCallback(
    (label: string, note: string) =>
      run<Version>("sandbox.checkpoint", { type: "checkpoint", label, note }, [
        "sandbox.design",
        "sandbox.versions",
      ]),
    [run],
  );
  const release = useCallback(
    (note: string) =>
      run<Version>("sandbox.release", { type: "release", note }, [
        "sandbox.design",
        "sandbox.versions",
      ]),
    [run],
  );
  const importFile = useCallback(
    (file: SandboxFileV1) =>
      run<{ history: SandboxHistory; versions: Version[] }>(
        "sandbox.import",
        { type: "import", file },
        ["sandbox.design", "sandbox.versions"],
      ),
    [run],
  );
  const resetDesign = useCallback(
    () =>
      run<Design>("sandbox.design.reset", { type: "reset-design" }, [
        "sandbox.design",
      ]),
    [run],
  );
  const updateVersions = useCallback(
    (update: (current: Version[]) => Version[]) =>
      run<Version[]>("sandbox.versions", { type: "update-versions", update }, [
        "sandbox.versions",
      ]),
    [run],
  );
  const restoreVersion = useCallback(
    (id: string) =>
      run<Version>(
        `sandbox.version.restore:${id}`,
        { type: "restore-version", id },
        ["sandbox.design", "sandbox.versions"],
      ),
    [run],
  );
  const rollbackVersion = useCallback(
    (id: string) =>
      run<{ version: Version; release: Version }>(
        `sandbox.version.rollback:${id}`,
        { type: "rollback-version", id },
        ["sandbox.design", "sandbox.versions"],
      ),
    [run],
  );
  const deleteVersion = useCallback(
    (id: string) =>
      run<{ version: Version; index: number; versions: Version[] }>(
        `sandbox.version.delete:${id}`,
        { type: "delete-version", id },
        ["sandbox.versions"],
      ),
    [run],
  );
  const restoreDeletedVersion = useCallback(
    (version: Version, index: number) =>
      run<Version[]>(
        `sandbox.version.restore-deleted:${version.id}`,
        { type: "restore-deleted-version", version, index },
        ["sandbox.versions"],
      ),
    [run],
  );
  const updateSimulation = useCallback(
    (update: SandboxSimulationUpdate, commandKey = "sandbox.simulation") =>
      run<unknown>(commandKey, { type: "update-simulation", update }, [
        "sandbox.design",
        "sandbox.simulation",
      ]),
    [run],
  );
  const clear = useCallback(async (): Promise<SandboxCommandResult<null>> => {
    if (commands.isPending())
      return {
        ok: false,
        error: "Finish the current Sandbox change before clearing data.",
      };
    return commands
      .run("sandbox.clear", async (signal) => {
        if (signal.aborted)
          throw new DOMException("The clear was cancelled.", "AbortError");
        runtime.resetKeys(SANDBOX_RUNTIME_KEYS);
        return { ok: true as const, value: null };
      })
      .catch((error: unknown) => ({
        ok: false as const,
        error: sampleOperationMessage(
          error,
          "This Sandbox change could not be saved. Try again.",
        ),
      }));
  }, [commands, runtime]);
  const restoreSnapshot = useCallback(
    (snapshot: SandboxSnapshot) =>
      run<null>(
        "sandbox.clear.undo",
        { type: "restore-snapshot", snapshot },
        SANDBOX_RUNTIME_KEYS,
      ),
    [run],
  );
  return {
    change,
    undo,
    redo,
    checkpoint,
    release,
    importFile,
    resetDesign,
    updateVersions,
    restoreVersion,
    rollbackVersion,
    deleteVersion,
    restoreDeletedVersion,
    updateSimulation,
    clear,
    restoreSnapshot,
    isPending: commands.isPending,
    pendingKeys: commands.pendingKeys,
    runtime,
  };
}
