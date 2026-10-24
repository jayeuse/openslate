"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { subscribeWorkspaceInvalidations } from "../../shared/adapters/invalidation-events";
import {
  afterManageBackupPolicyChange,
  afterManageBackupQueue,
  manageBackupListOptions,
  manageBackupExportOptions,
  manageBackupStatusOptions,
  manageKeys,
  manageVersionOptions,
} from "../adapters/manage-queries";
import {
  backupNameError,
  backupExportSourceAvailable,
  exportPassphraseError,
  backupPolicyPatch,
  admitManageBackupExportDownload,
  defaultManageBackupsRequest,
  getManageBackupStatus,
  isOwnerRefusal,
  OWNER_REFUSAL_MESSAGE,
  queueManageBackup,
  queueManageBackupExport,
  updateManageBackupPolicy,
  type BackupPolicyDraft,
  type ManageBackupStatus,
  type ManageBackupRun,
} from "../adapters/backup-api";
import { isStaleWorkspaceRevision } from "../adapters/workspace-api";
/** Owns live maintenance reads and commands. */
export function useManageMaintenance({
  recoveryActive,
  historyActive,
  versionActive,
  exportId,
  invalidExportId,
  exportAllowed,
  exportActorId,
  onExportChange,
}: {
  recoveryActive: boolean;
  historyActive: boolean;
  versionActive: boolean;
  exportId: string | null;
  invalidExportId: boolean;
  exportAllowed: boolean;
  exportActorId: string;
  onExportChange: (id: string) => void;
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
  const [exportDenied, setExportDenied] = useState(false);
  const [exportError, setExportError] = useState("");
  const [downloadAdmission, setDownloadAdmission] = useState<{
    actorId: string;
    exportId: string;
    expiresAt: string;
  } | null>(null);
  const exportCommand = useRef<AbortController | null>(null);
  const exportEpoch = useRef(0);
  const exportOwner = useRef({
    actorId: exportActorId,
    allowed: exportAllowed,
    active: recoveryActive,
    id: exportId,
  });
  const exportMounted = useRef(true);
  useLayoutEffect(() => {
    const previous = exportOwner.current;
    exportOwner.current = {
      actorId: exportActorId,
      allowed: exportAllowed,
      active: recoveryActive,
      id: exportId,
    };
    if (previous.actorId !== exportActorId) {
      exportEpoch.current += 1;
      const operation = exportCommand.current;
      operation?.abort();
      if (command.current === operation && operation) {
        command.current = null;
        setPending(false);
      }
      exportCommand.current = null;
      setExportDenied(false);
      setExportError("");
      setDownloadAdmission(null);
    }
  }, [exportActorId, exportAllowed, recoveryActive, exportId]);
  useEffect(() => {
    exportMounted.current = true;
    return () => {
      exportMounted.current = false;
      exportEpoch.current += 1;
      exportCommand.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!downloadAdmission) return;
    const clearAdmission = () => {
      setDownloadAdmission((current) =>
        current === downloadAdmission ? null : current,
      );
    };
    const deadline = window.setTimeout(
      clearAdmission,
      Math.max(0, Date.parse(downloadAdmission.expiresAt) - Date.now()),
    );
    const expireOnVisible = () => {
      if (
        document.visibilityState === "visible" &&
        Date.parse(downloadAdmission.expiresAt) <= Date.now()
      )
        clearAdmission();
    };
    document.addEventListener("visibilitychange", expireOnVisible);
    return () => {
      window.clearTimeout(deadline);
      document.removeEventListener("visibilitychange", expireOnVisible);
    };
  }, [downloadAdmission]);
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
  const exportQuery = useQuery({
    ...manageBackupExportOptions(exportId ?? ""),
    enabled:
      recoveryActive && exportAllowed && Boolean(exportId) && !exportDenied,
    refetchInterval: (query) =>
      recoveryActive &&
      exportAllowed &&
      !exportDenied &&
      !query.state.error &&
      typeof document !== "undefined" &&
      document.visibilityState === "visible" &&
      (query.state.data?.state === "queued" ||
        query.state.data?.state === "preparing")
        ? 5_000
        : false,
    refetchIntervalInBackground: false,
  });
  const exportRefused =
    exportDenied ||
    (exportQuery.error instanceof ApiError && exportQuery.error.status === 403);
  if (exportRefused && !exportDenied) setExportDenied(true);
  const acceptedExport =
    exportAllowed && !exportQuery.isError && !exportRefused && exportId
      ? exportQuery.data
      : undefined;
  const acceptedDownloadAdmission =
    recoveryActive &&
    exportAllowed &&
    !exportRefused &&
    acceptedExport?.state === "ready" &&
    downloadAdmission?.actorId === exportActorId &&
    downloadAdmission.exportId === exportId
      ? downloadAdmission
      : null;
  const exportSource = useQuery({
    ...manageBackupListOptions({
      ...defaultManageBackupsRequest,
      limit: 1,
      run_id: acceptedExport?.backup_run_id,
    }),
    enabled:
      recoveryActive &&
      exportAllowed &&
      Boolean(acceptedExport) &&
      !exportRefused,
  });
  const acceptedExportSource =
    exportAllowed && !exportSource.isError && !exportRefused
      ? exportSource.data?.items.find(
          (run) => run.id === acceptedExport?.backup_run_id,
        )
      : undefined;
  const policyRefused =
    policyDenied ||
    (status.error instanceof ApiError && status.error.status === 403);
  const historyRefused =
    historyDenied ||
    (history.error instanceof ApiError && history.error.status === 403);
  const versionRefused =
    versionDenied ||
    (version.error instanceof ApiError && version.error.status === 403);
  // A refusal that names the installation owner can never pass on Retry; the
  // page shows its notice instead of the section (MD3).
  const ownerRefused = [status.error, history.error, version.error].some(
    isOwnerRefusal,
  );
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
    const unsubscribe = subscribeWorkspaceInvalidations(
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
        if (event.entity === "backup_export_operations")
          refresh(manageKeys.backupExports());
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
  async function retryExport() {
    if (!exportAllowed || !recoveryActive || !exportId) return;
    const result = await exportQuery.refetch();
    if (!result.isError) {
      setExportDenied(false);
      await exportSource.refetch();
    }
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
          isOwnerRefusal(caught)
            ? OWNER_REFUSAL_MESSAGE
            : caught instanceof ApiError && caught.status === 403
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
        isOwnerRefusal(caught)
          ? OWNER_REFUSAL_MESSAGE
          : caught instanceof ApiError && caught.status === 403
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
  async function queueExport(
    source: ManageBackupRun,
    passphrase: string,
    key: string,
  ): Promise<boolean> {
    if (
      command.current ||
      !exportOwner.current.allowed ||
      !exportOwner.current.active ||
      !backupExportSourceAvailable(source)
    )
      return false;
    const invalid = exportPassphraseError(passphrase);
    if (invalid) {
      setExportError(invalid);
      return false;
    }
    const operation = new AbortController();
    const epoch = exportEpoch.current;
    const actorId = exportOwner.current.actorId;
    const owns = () =>
      exportMounted.current &&
      !operation.signal.aborted &&
      exportEpoch.current === epoch &&
      exportOwner.current.actorId === actorId &&
      exportOwner.current.allowed &&
      exportOwner.current.active &&
      exportCommand.current === operation;
    command.current = operation;
    exportCommand.current = operation;
    setPending(true);
    setExportError("");
    try {
      const queued = await queueManageBackupExport(
        { backup_run_id: source.id, passphrase },
        key,
        operation.signal,
      );
      if (!owns()) return false;
      client.setQueryData(manageKeys.backupExport(queued.id), queued);
      setExportDenied(false);
      onExportChange(queued.id);
      return true;
    } catch (caught) {
      if (!owns()) return false;
      setExportError(
        isOwnerRefusal(caught)
          ? OWNER_REFUSAL_MESSAGE
          : caught instanceof ApiError && caught.status === 403
            ? "Only an eligible administrator can request an export."
            : "The export request could not be confirmed. Retry without changing the passphrase to check the same request.",
      );
      return false;
    } finally {
      if (exportCommand.current === operation) exportCommand.current = null;
      if (command.current === operation) {
        command.current = null;
        setPending(false);
      }
    }
  }
  async function confirmExportDownload(password: string): Promise<boolean> {
    if (
      command.current ||
      !exportOwner.current.allowed ||
      !exportOwner.current.active ||
      !acceptedExport ||
      acceptedExport.state !== "ready" ||
      acceptedExport.id !== exportOwner.current.id
    )
      return false;
    const id = acceptedExport.id;
    const operation = new AbortController();
    const epoch = exportEpoch.current;
    const actorId = exportOwner.current.actorId;
    const owns = () =>
      exportMounted.current &&
      !operation.signal.aborted &&
      exportEpoch.current === epoch &&
      exportOwner.current.actorId === actorId &&
      exportOwner.current.allowed &&
      exportOwner.current.active &&
      exportOwner.current.id === id &&
      exportCommand.current === operation;
    command.current = operation;
    exportCommand.current = operation;
    setPending(true);
    setExportError("");
    setDownloadAdmission(null);
    try {
      const admitted = await admitManageBackupExportDownload(
        id,
        password,
        operation.signal,
      );
      if (!owns()) return false;
      if (Date.parse(admitted.expires_at) <= Date.now()) {
        setExportError("Password confirmation expired. Confirm again.");
        return false;
      }
      setDownloadAdmission({
        actorId,
        exportId: id,
        expiresAt: admitted.expires_at,
      });
      return true;
    } catch (caught) {
      if (!owns()) return false;
      if (
        caught instanceof ApiError &&
        (caught.status === 401 ||
          (caught.status === 403 && caught.code !== "export_password_invalid"))
      )
        setExportDenied(true);
      setExportError(
        caught instanceof ApiError && caught.code === "export_password_invalid"
          ? "Your current password could not be verified. Try again."
          : caught instanceof ApiError && caught.status === 429
            ? "Too many password checks. Wait before trying again."
            : "Password confirmation is unavailable. Try again.",
      );
      return false;
    } finally {
      if (exportCommand.current === operation) exportCommand.current = null;
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
    exportQuery,
    exportSource,
    exportId,
    invalidExportId,
    exportAllowed,
    exportActorId,
    exportRefused,
    acceptedExport,
    acceptedExportSource,
    acceptedDownloadAdmission,
    exportError,
    acceptedStatus,
    acceptedHistory:
      history.isError || historyRefused ? undefined : history.data,
    acceptedVersion:
      version.isError || versionRefused ? undefined : version.data,
    policyRefused,
    historyRefused,
    versionRefused,
    ownerRefused,
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
    queueExport,
    confirmExportDownload,
    clearExportDownloadAdmission: () => setDownloadAdmission(null),
    retryExport,
    clearExportError: () => {
      if (!command.current) setExportError("");
    },
  };
}
