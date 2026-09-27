"use client";

import { useState } from "react";
import {
  useSampleState,
  useSampleStorage,
  useSampleRuntime,
  type SampleTransactionDraft,
} from "../../shared/runtime/sample-state";
import { initialManageSessions } from "./sessions";
import type { SampleRuntime } from "../../shared/runtime/sample-runtime";
import { completeCollection } from "../../shared/helpers/sample-collections";
import { initialPeople } from "../../shared/data/sample-people";
import {
  useSampleCommands,
  useSampleResource,
  sampleOperationMessage,
} from "../../shared/runtime/sample-async";
import {
  diffManageSettings,
  dirty,
  executeManageCommand,
  type ManageCommand,
} from "./commands";
import {
  decodeActivity,
  decodeBackups,
  decodeDrafts,
  decodeHistory,
  decodeManageSettings,
  validateManageSection,
} from "./decode";
import {
  initialManageState,
  manageSectionKeys,
  type ManageActionResult,
  type ManageSection,
  type ManageSettings,
  type ManageState,
} from "./model";

const keys = {
  settings: "manage-settings",
  backups: "manage-backups",
  sessions: "manage-sessions",
  history: "manage-history",
  activity: "manage-activity-v1",
  drafts: "manage-drafts-v1",
} as const;
function readState(
  transaction: Pick<SampleTransactionDraft, "read">,
): ManageState {
  const { read } = transaction;
  return {
    settings: decodeManageSettings(
      read<Record<string, unknown>>(keys.settings, {}),
    ),
    backups: decodeBackups(read<unknown>(keys.backups, null)),
    sessions: read(keys.sessions, initialManageSessions),
    history: decodeHistory(
      read<unknown>(keys.history, initialManageState.history),
    ),
    activity: decodeActivity(read<unknown>(keys.activity, null)),
    drafts: decodeDrafts(read<Record<string, unknown>>(keys.drafts, {})),
  };
}

function applyManageRuntimeCommand(
  draft: SampleTransactionDraft,
  command: ManageCommand,
): ManageActionResult {
  const current = readState(draft);
  const outcome = executeManageCommand(current, command);
  if (!outcome.result.ok) return draft.reject(outcome.result);
  for (const key of Object.keys(keys) as (keyof ManageState)[])
    if (outcome.state[key] !== current[key])
      draft.update<unknown>(
        keys[key],
        initialManageState[key],
        outcome.state[key],
      );
  return outcome.result;
}

export function executeManageRuntimeCommand(
  runtime: SampleRuntime,
  command: ManageCommand,
  signal?: AbortSignal,
): Promise<ManageActionResult> {
  return runtime.execute((draft) => applyManageRuntimeCommand(draft, command), {
    keys: Object.values(keys),
    signal,
  });
}

export function useManageController() {
  const runtime = useSampleRuntime();
  const commands = useSampleCommands();
  const resource = useSampleResource({
    keys: [
      ...Object.values(keys).filter((key) => key !== keys.drafts),
      "access-people",
    ],
    queryKey: "manage",
    load: (signal) =>
      runtime.load(
        (source) => ({
          ...readState(source),
          people: source.read("access-people", initialPeople),
        }),
        { keys: [...Object.values(keys), "access-people"], signal },
      ),
  });
  // Drafts stay synchronous and at route lifetime while confirmed data loads.
  const [rawDrafts] = useSampleState<Record<string, unknown>>(keys.drafts, {});
  const { storageUnavailable } = useSampleStorage();
  const [checked, setChecked] = useState(false);
  const state: ManageState = {
    ...(resource.data ?? initialManageState),
    drafts: decodeDrafts(rawDrafts),
  };
  async function run(command: ManageCommand): Promise<ManageActionResult> {
    try {
      return await commands.run("manage", (signal) =>
        executeManageRuntimeCommand(runtime, command, signal),
      );
    } catch (error) {
      return {
        ok: false,
        message: sampleOperationMessage(
          error,
          "This change could not be saved. Try again.",
        ),
      };
    }
  }
  function local(command: ManageCommand) {
    if (commands.isPending()) return;
    runtime.commit((draft) => applyManageRuntimeCommand(draft, command));
  }
  return {
    ...state,
    resource,
    pending: commands.isPending(),
    people: resource.data?.people ?? [],
    collections: {
      sessions: completeCollection(state.sessions, "manage:sessions"),
      snapshots: completeCollection(state.backups, "manage:snapshots"),
      activity: completeCollection(state.activity, "manage:activity"),
    },
    snapshots: state.backups,
    storageUnavailable,
    hasDrafts: (Object.keys(manageSectionKeys) as ManageSection[]).some(
      (section) => dirty(state, section),
    ),
    updateAvailable: checked && state.settings.version !== "1.5.0",
    getDraft: (section: ManageSection): ManageSettings => ({
      ...state.settings,
      ...state.drafts[section],
    }),
    dirty: (section: ManageSection) => dirty(state, section),
    isDirty: (section: ManageSection) => dirty(state, section),
    errors: (section: ManageSection) =>
      validateManageSection(section, {
        ...state.settings,
        ...state.drafts[section],
      }),
    change: (
      section: ManageSection,
      key: keyof ManageSettings,
      value: string,
    ) => {
      local({ type: "change", section, key, value });
    },
    save: (section: ManageSection) => run({ type: "save", section }),
    discard: (section: ManageSection) => {
      local({ type: "discard", section });
    },
    createSnapshot: (name?: string) => run({ type: "create-snapshot", name }),
    renameSnapshot: (id: string, name: string) =>
      run({ type: "rename-snapshot", id, name }),
    deleteSnapshot: (id: string) => run({ type: "delete-snapshot", id }),
    snapshotDiff: (id: string) => {
      const snapshot = state.backups.find((item) => item.id === id);
      return snapshot
        ? diffManageSettings(state.settings, snapshot.settings)
        : [];
    },
    restoreSnapshot: (id: string, options?: { discardDrafts?: boolean }) =>
      run({ type: "restore-snapshot", id, ...options }),
    reset: (options?: { discardDrafts?: boolean }) =>
      run({ type: "reset", ...options }),
    revokeSession: (id: string) => run({ type: "revoke-session", id }),
    revokeAllSessions: () => run({ type: "revoke-all-sessions" }),
    checkForUpdate: async (): Promise<
      ManageActionResult & { available?: boolean }
    > => {
      try {
        const settings = await commands.run("manage", (signal) =>
          runtime.load(
            (source) => decodeManageSettings(source.read(keys.settings, {})),
            { keys: [keys.settings], signal },
          ),
        );
        setChecked(true);
        return {
          ok: true,
          available: settings.version !== "1.5.0",
          message: "Update check completed.",
        };
      } catch (error) {
        return {
          ok: false,
          message: sampleOperationMessage(
            error,
            "Could not check for updates. Try again.",
          ),
        };
      }
    },
    applyUpdate: () => run({ type: "apply-update" }),
    rollbackUpdate: () => run({ type: "rollback-update" }),
    activateLicense: (key: string) => run({ type: "activate-license", key }),
    renewLicense: () => run({ type: "renew-license" }),
    retentionPreview: () => {
      const days = Number.parseInt(state.settings.retention, 10);
      const cutoff = Date.now() - days * 86400000;
      const candidates = state.backups.filter(
        (item) =>
          Number.isFinite(Date.parse(item.date)) &&
          Date.parse(item.date) < cutoff,
      );
      return {
        days,
        candidates,
        count: candidates.length,
        schedule: state.settings.schedule,
        timezone: state.settings.timezone,
      };
    },
  };
}
