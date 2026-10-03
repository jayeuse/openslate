"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { subscribeOpenViewInvalidations } from "../../openview/adapters/invalidation-events";
import {
  afterManageBackupPolicyChange,
  afterManageBackupQueue,
  manageBackupListOptions,
  manageBackupStatusOptions,
  manageKeys,
  manageVersionOptions,
} from "../adapters/manage-queries";
import {
  backupNameError,
  backupPolicyPatch,
  defaultManageBackupsRequest,
  getManageBackupStatus,
  queueManageBackup,
  updateManageBackupPolicy,
  type BackupPolicyDraft,
  type ManageBackupStatus,
} from "../adapters/backup-api";
import { isStaleWorkspaceRevision } from "../adapters/workspace-api";
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
import { dirty, executeManageCommand, type ManageCommand } from "./commands";
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
    storageUnavailable,
    hasDrafts: (Object.keys(manageSectionKeys) as ManageSection[]).some(
      (section) => dirty(state, section),
    ),
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
    reset: (options?: { discardDrafts?: boolean }) =>
      run({ type: "reset", ...options }),
    revokeSession: (id: string) => run({ type: "revoke-session", id }),
    revokeAllSessions: () => run({ type: "revoke-all-sessions" }),
  };
}

/** Owns live maintenance reads and commands; legacy Reset Manage stays above. */
export function useManageMaintenance({
  recoveryActive,
  historyActive,
  versionActive,
}: {
  recoveryActive: boolean;
  historyActive: boolean;
  versionActive: boolean;
}) {
  const client = useQueryClient();
  const [request, setRequest] = useState(defaultManageBackupsRequest);
  const [draft, setDraft] = useState<BackupPolicyDraft>({});
  const [draftPolicy, setDraftPolicy] = useState<
    ManageBackupStatus["policy"] | null
  >(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [staleRevision, setStaleRevision] = useState(false);
  const [policyDenied, setPolicyDenied] = useState(false);
  const [historyDenied, setHistoryDenied] = useState(false);
  const [versionDenied, setVersionDenied] = useState(false);
  const command = useRef<AbortController | null>(null);
  const queueAttempt = useRef<{ name: string; key: string } | null>(null);
  const status = useQuery({
    ...manageBackupStatusOptions(),
    enabled: recoveryActive && !policyDenied,
  });
  const history = useQuery({
    ...manageBackupListOptions(request),
    enabled: historyActive && !historyDenied,
  });
  const version = useQuery({
    ...manageVersionOptions(),
    enabled: versionActive && !versionDenied,
  });
  const policyRefused =
    policyDenied ||
    (status.error instanceof ApiError && status.error.status === 403);
  const historyRefused =
    historyDenied ||
    (history.error instanceof ApiError && history.error.status === 403);
  const versionRefused =
    versionDenied ||
    (version.error instanceof ApiError && version.error.status === 403);
  if (policyRefused && !policyDenied) setPolicyDenied(true);
  if (historyRefused && !historyDenied) setHistoryDenied(true);
  if (versionRefused && !versionDenied) setVersionDenied(true);
  const acceptedStatus =
    status.isError || policyRefused ? undefined : status.data;
  const patch = draftPolicy ? backupPolicyPatch(draftPolicy, draft) : null;
  const dirty = patch !== null;
  const stale =
    staleRevision ||
    Boolean(
      draftPolicy &&
      acceptedStatus &&
      draftPolicy.revision !== acceptedStatus.policy.revision,
    );

  useEffect(() => {
    if (!recoveryActive && !versionActive) return;
    const refresh = (queryKey: QueryKey) => {
      const cold = client
        .getQueryCache()
        .findAll({ queryKey, fetchStatus: "fetching" })
        .filter((query) => query.state.data === undefined);
      void Promise.all(
        cold.map((query) => query.cancel({ revert: true })),
      ).then(() => client.invalidateQueries({ queryKey }));
    };
    const unsubscribe = subscribeOpenViewInvalidations(
      (event) => {
        if (event.type === "resync") {
          refresh(manageKeys.maintenance());
          return;
        }
        if (
          event.entity === "backup_policies" ||
          event.entity === "workspace_profiles"
        )
          refresh(manageKeys.backupStatus());
        if (event.entity === "backup_runs") {
          refresh(manageKeys.backupStatus());
          refresh(manageKeys.backups());
        }
        if (event.entity === "update_statuses") refresh(manageKeys.version());
      },
      () => refresh(manageKeys.maintenance()),
    );
    return () => {
      unsubscribe();
      void client.invalidateQueries({
        queryKey: manageKeys.maintenance(),
        refetchType: "none",
      });
    };
  }, [client, recoveryActive, versionActive]);
  useEffect(
    () => () => {
      command.current?.abort();
    },
    [recoveryActive, versionActive],
  );

  async function retryPolicy() {
    const result = await status.refetch();
    if (!result.isError) setPolicyDenied(false);
  }
  async function retryHistory() {
    const result = await history.refetch();
    if (!result.isError) setHistoryDenied(false);
  }
  async function refreshVersion() {
    const result = await version.refetch();
    if (!result.isError) setVersionDenied(false);
  }
  async function savePolicy() {
    if (command.current || !acceptedStatus || !patch || stale) return false;
    const operation = new AbortController();
    command.current = operation;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const saved = await updateManageBackupPolicy(patch, operation.signal);
      if (operation.signal.aborted) return false;
      afterManageBackupPolicyChange(client, saved);
      setDraft({});
      setDraftPolicy(null);
      setStaleRevision(false);
      setNotice("Backup policy saved.");
      return true;
    } catch (caught) {
      if (operation.signal.aborted) return false;
      if (isStaleWorkspaceRevision(caught)) {
        setStaleRevision(true);
        await status.refetch();
      } else
        setError(
          caught instanceof ApiError && caught.status === 403
            ? "Only administrators can change backup policy."
            : "Backup policy could not be saved. Your draft is still here.",
        );
      return false;
    } finally {
      if (command.current === operation) {
        command.current = null;
        setPending(false);
      }
    }
  }
  async function reviewLatestPolicy() {
    if (command.current || !draftPolicy) return;
    const operation = new AbortController();
    command.current = operation;
    setPending(true);
    setError("");
    try {
      const latest = await getManageBackupStatus(operation.signal);
      if (operation.signal.aborted) return;
      afterManageBackupPolicyChange(client, latest);
      const next = { ...draft };
      if (next.schedule === latest.policy.schedule) delete next.schedule;
      if (next.retention_days === latest.policy.retention_days)
        delete next.retention_days;
      setDraft(next);
      setDraftPolicy(Object.keys(next).length ? latest.policy : null);
      setStaleRevision(false);
    } catch (caught) {
      if (operation.signal.aborted) return;
      if (caught instanceof ApiError && caught.status === 403)
        setPolicyDenied(true);
      setError(
        "The latest backup policy could not be loaded. Your draft is still here.",
      );
    } finally {
      if (command.current === operation) {
        command.current = null;
        setPending(false);
      }
    }
  }
  async function queueBackup(name: string) {
    if (command.current || !acceptedStatus) return false;
    const invalid = backupNameError(name);
    if (invalid) {
      setError(invalid);
      return false;
    }
    const trimmed = name.trim();
    if (!queueAttempt.current || queueAttempt.current.name !== trimmed)
      queueAttempt.current = { name: trimmed, key: crypto.randomUUID() };
    const operation = new AbortController();
    command.current = operation;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const run = await queueManageBackup(
        trimmed,
        queueAttempt.current.key,
        operation.signal,
      );
      if (operation.signal.aborted) return false;
      queueAttempt.current = null;
      setRequest((value) => ({
        ...value,
        offset: 0,
        search: "",
        state: "all",
        provenance: "all",
        installation: "all",
        run_id: undefined,
        sort_by: "requested_at",
        sort_order: "desc",
      }));
      await afterManageBackupQueue(client);
      if (operation.signal.aborted) return false;
      setNotice(
        `${run.name}: ${run.state === "queued" ? "queued for the host runner" : run.state}. Queueing does not execute a backup.`,
      );
      return true;
    } catch (caught) {
      if (operation.signal.aborted) return false;
      setError(
        caught instanceof ApiError && caught.status === 403
          ? "Only administrators can request a backup."
          : "The backup request could not be confirmed. Retry the same name to check the same request.",
      );
      return false;
    } finally {
      if (command.current === operation) {
        command.current = null;
        setPending(false);
      }
    }
  }
  return {
    status,
    history,
    version,
    acceptedStatus,
    acceptedHistory:
      history.isError || historyRefused ? undefined : history.data,
    acceptedVersion:
      version.isError || versionRefused ? undefined : version.data,
    policyRefused,
    historyRefused,
    versionRefused,
    request,
    setRequest,
    draft,
    draftPolicy,
    dirty,
    stale,
    pending,
    error,
    notice,
    changeDraft: (next: BackupPolicyDraft) => {
      const base = draftPolicy ?? acceptedStatus?.policy;
      if (!command.current && base) {
        const changes = { ...draft, ...next };
        if (changes.schedule === base.schedule) delete changes.schedule;
        if (changes.retention_days === base.retention_days)
          delete changes.retention_days;
        setDraft(changes);
        setDraftPolicy(Object.keys(changes).length ? base : null);
        setError("");
        if (!Object.keys(changes).length) setStaleRevision(false);
      }
    },
    discardDraft: () => {
      if (!command.current) {
        setDraft({});
        setDraftPolicy(null);
        setError("");
        setStaleRevision(false);
      }
    },
    clearCommandMessage: () => {
      if (!command.current) {
        setError("");
        setNotice("");
      }
    },
    retryPolicy,
    retryHistory,
    refreshVersion,
    reviewLatestPolicy,
    savePolicy,
    queueBackup,
  };
}
