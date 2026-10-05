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
/** Owns live maintenance reads and commands. */
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
    staleRevision,
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
