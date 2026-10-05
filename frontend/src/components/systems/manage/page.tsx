"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  LockKeyhole,
  Database,
  X,
} from "lucide-react";
import {
  Suspense,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspaceNavigationGuard } from "@/components/workspace-navigation-guard";
import { DiscardChangesDialog } from "../access/components/people-fields";
import { ApiError } from "@/lib/api";
import { requestSessionRecheck } from "@/lib/auth-api";
import { useMfaFlow } from "@/components/mfa-flow";
import ManageAudit from "./components/audit";
import {
  initialManageSettings,
  type ManageSection,
  type ManageSettings,
} from "./state/model";
import {
  ManageMfaDialog,
  ManageConfirmationDialog,
  type ConfirmState,
} from "./components/manage-dialogs";
import { OrganizationPanel } from "./components/organization-panel";
import {
  afterManageWorkspaceChange,
  afterManageSecurityChange,
  afterManageSessionsChange,
  manageWorkspaceOptions,
  manageKeys,
  manageSecurityOptions,
  manageSessionsOptions,
} from "./adapters/manage-queries";
import {
  isStaleWorkspaceRevision,
  organizationLocaleTag,
  workspaceSettingsFormFields,
  workspaceSettingsPatch,
  updateManageWorkspace,
  type WorkspaceSettingsFormDraft,
} from "./adapters/workspace-api";
import {
  defaultManageSessionsRequest,
  endAllManageRemoteSessions,
  endManageSession,
  securitySettingsFormFields,
  securitySettingsPatch,
  updateManageSecurityPolicy,
  type ManageAdminSession,
  type SecuritySettingsFormDraft,
} from "./adapters/security-api";
import { SecurityPanel, SecurityPolicyForm } from "./components/security-panel";
import {
  BackupPanel,
  BackupRunnerStatus,
  SnapshotScheduleForm,
} from "./components/backup-panel";
import { useManageMaintenance } from "./state/controller";
import { backupScheduleLabels } from "./adapters/backup-api";
import { UpdatesPanel } from "./components/updates-panel";
import { LicensingPanel } from "./components/licensing-panel";

type ViewTab =
  "Organization" | "Security" | "Audit" | "Backup" | "Updates & licensing";

function organizationErrors(
  draft: WorkspaceSettingsFormDraft,
  workspaceReady: boolean,
): Partial<Record<keyof ManageSettings, string>> {
  const errors: Partial<Record<keyof ManageSettings, string>> = {};
  if (!workspaceReady) return errors;
  if (draft.name !== undefined) {
    if (!draft.name.trim()) errors.name = "Enter an organization name.";
    else if (draft.name.length > 200)
      errors.name = "Use 200 characters or fewer.";
  }
  if (draft.logo !== undefined && draft.logo.trim().length > 32)
    errors.logo = "Use 32 characters or fewer.";
  if (draft.hours !== undefined && draft.hours.trim().length > 200)
    errors.hours = "Use 200 characters or fewer.";
  return errors;
}

const manageTabs: readonly ViewTab[] = [
  "Organization",
  "Security",
  "Audit",
  "Backup",
  "Updates & licensing",
];

function manageTabFromQuery(value: string | null): ViewTab {
  const normalized = value?.toLowerCase();
  if (normalized === "updates" || normalized === "licensing")
    return "Updates & licensing";
  return (
    manageTabs.find((tab) => tab.toLowerCase() === normalized) ?? "Organization"
  );
}

export default function Manage() {
  return (
    <Suspense
      fallback={
        <div role="status" className="flex flex-col gap-4">
          <span className="sr-only">Opening management settings…</span>
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-48 w-full" />
        </div>
      }
    >
      <ManageContent />
    </Suspense>
  );
}

function ManageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const requestedTab = manageTabFromQuery(searchParams.get("view"));
  const queryClient = useQueryClient();
  const maintenance = useManageMaintenance({
    recoveryActive: requestedTab === "Security" || requestedTab === "Backup",
    historyActive: requestedTab === "Backup",
    versionActive: requestedTab === "Updates & licensing",
  });
  const tab = requestedTab;
  const [workspaceDraft, setWorkspaceDraft] =
    useState<WorkspaceSettingsFormDraft>({});
  const [workspaceStale, setWorkspaceStale] = useState(false);
  const [workspaceRefreshRequired, setWorkspaceRefreshRequired] =
    useState(false);
  const [workspaceSavePending, setWorkspaceSavePending] = useState(false);
  const workspaceQuery = useQuery({
    ...manageWorkspaceOptions(),
    enabled: tab === "Organization",
  });
  const [securityDraft, setSecurityDraft] = useState<SecuritySettingsFormDraft>(
    {},
  );
  const [securityStale, setSecurityStale] = useState(false);
  const [securityRefreshRequired, setSecurityRefreshRequired] = useState(false);
  const [securitySavePending, setSecuritySavePending] = useState(false);
  const [sessionEndPending, setSessionEndPending] = useState(false);
  const [sessionsReadDenied, setSessionsReadDenied] = useState(false);
  const [policyReadDenied, setPolicyReadDenied] = useState(false);
  const [sessionRequest, setSessionRequest] = useState(
    defaultManageSessionsRequest,
  );
  const securityQuery = useQuery({
    ...manageSecurityOptions(),
    enabled: (tab === "Security" || tab === "Backup") && !policyReadDenied,
  });
  const sessionsQuery = useQuery({
    ...manageSessionsOptions(sessionRequest),
    enabled: (tab === "Security" || tab === "Backup") && !sessionsReadDenied,
  });
  const currentPolicyReadDenied =
    securityQuery.error instanceof ApiError &&
    securityQuery.error.status === 403;
  if (currentPolicyReadDenied && !policyReadDenied) setPolicyReadDenied(true);
  const securityDenied = policyReadDenied || currentPolicyReadDenied;
  const currentSessionReadDenied =
    sessionsQuery.error instanceof ApiError &&
    sessionsQuery.error.status === 403;
  // A cached filter revisit cannot clear a server refusal. Only Retry's fresh
  // successful read can admit the session collection again for this account.
  if (currentSessionReadDenied && !sessionsReadDenied)
    setSessionsReadDenied(true);
  const sessionsDenied = sessionsReadDenied || currentSessionReadDenied;
  useEffect(() => {
    const refusedKeys = [
      ...(sessionsReadDenied ? [manageKeys.sessions()] : []),
      ...(policyReadDenied ? [manageKeys.security()] : []),
    ];
    for (const queryKey of refusedKeys) {
      void queryClient.cancelQueries({ queryKey }).then(() => {
        queryClient.removeQueries({ queryKey });
      });
    }
  }, [sessionsReadDenied, policyReadDenied, queryClient]);
  const securityFields =
    securityQuery.data && !securityDenied
      ? securitySettingsFormFields(securityQuery.data)
      : null;
  const securityPatch = securityQuery.data
    ? securitySettingsPatch(securityQuery.data, securityDraft)
    : null;
  const securityDirty =
    securityPatch !== null ||
    (!securityQuery.data && Object.keys(securityDraft).length > 0);
  const livePending =
    workspaceSavePending ||
    securitySavePending ||
    sessionEndPending ||
    maintenance.pending;
  const [notice, setNotice] = useState("");
  const [navigationNotice, setNavigationNotice] = useState("");
  const [pendingLeave, setPendingLeave] = useState<{
    resume: () => void;
  } | null>(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [draftAcknowledged, setDraftAcknowledged] = useState(false);
  const mfa = useMfaFlow();
  const cancelMfa = mfa.cancel;
  useEffect(() => () => cancelMfa(), [cancelMfa]);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const policyOpener = useRef<HTMLButtonElement | null>(null);
  const scheduleOpener = useRef<HTMLButtonElement | null>(null);
  const confirmOpener = useRef<HTMLElement | null>(null);
  const mfaOpener = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const sessionConfirmationRefused =
    sessionsDenied && confirm?.origin === "admin-sessions";
  if (sessionConfirmationRefused) setConfirm(null);
  const recoveryView = tab === "Security" || tab === "Backup";
  const pageTitle = recoveryView ? "Security & recovery" : tab;
  const liveSourceStatus =
    tab === "Organization"
      ? "Settings save to the organization."
      : tab === "Audit"
        ? "Audit entries are loaded from your organization."
        : recoveryView
          ? "Account policy, sessions, backup policy, and backup history are loaded from your server."
          : "The running version and host runner release observations are loaded from your server. No license is required.";
  const pageDescription =
    tab === "Organization"
      ? "Make this workspace feel like your organization."
      : tab === "Audit"
        ? "See who changed what, then inspect the details."
        : tab === "Updates & licensing"
          ? "Your running version and license status, together in one place."
          : "Review sessions and manage backup requests.";

  const workspacePatch = workspaceQuery.data
    ? workspaceSettingsPatch(workspaceQuery.data, workspaceDraft)
    : null;
  const workspaceDraftDirty = workspacePatch !== null;
  const allDraftsDirty =
    securityDirty || maintenance.dirty || workspaceDraftDirty;
  const workspaceFields = workspaceQuery.data
    ? workspaceSettingsFormFields(workspaceQuery.data)
    : null;
  const current: ManageSettings = {
    ...initialManageSettings,
    ...workspaceFields,
    ...workspaceDraft,
  };
  const dirty = workspaceDraftDirty;
  const errors = organizationErrors(
    workspaceDraft,
    workspaceQuery.data !== undefined,
  );
  const localeCode = organizationLocaleTag(current.locale);
  const regionalDate = new Intl.DateTimeFormat(localeCode, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: current.timezone,
  }).format(new Date("2026-09-11T09:00:00Z"));
  const regionalCurrency = new Intl.NumberFormat(localeCode, {
    style: "currency",
    currency: current.currency,
  }).format(12500);

  useWorkspaceNavigationGuard((href, resume) => {
    if (livePending) {
      setNavigationNotice(
        "Finish the current change before leaving this page.",
      );
      return false;
    }
    setNavigationNotice("");
    // Switching Manage sections keeps drafts; only leaving Manage loses them.
    const leavesManage =
      new URL(href, window.location.origin).pathname !==
      window.location.pathname;
    if (allDraftsDirty && leavesManage) {
      setPendingLeave({ resume });
      return false;
    }
    return true;
  });

  useEffect(() => {
    if (!allDraftsDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [allDraftsDirty]);

  function discardAndLeave() {
    const leave = pendingLeave;
    setPendingLeave(null);
    setWorkspaceDraft({});
    setWorkspaceStale(false);
    setWorkspaceRefreshRequired(false);
    maintenance.discardDraft();
    setSecurityDraft({});
    setSecurityStale(false);
    setSecurityRefreshRequired(false);
    leave?.resume();
  }

  function changeSetting(
    target: ManageSection,
    key: keyof ManageSettings,
    value: string,
  ) {
    if (
      target === "organization" &&
      (key === "name" ||
        key === "locale" ||
        key === "timezone" ||
        key === "logo" ||
        key === "currency" ||
        key === "week" ||
        key === "hours")
    ) {
      const saved = workspaceQuery.data
        ? workspaceSettingsFormFields(workspaceQuery.data)
        : null;
      setWorkspaceDraft((currentDraft) => {
        const next = { ...currentDraft, [key]: value };
        const unchanged = saved
          ? key === "name" || key === "logo" || key === "hours"
            ? value.trim() === saved[key]
            : value === saved[key]
          : false;
        if (unchanged) delete next[key];
        return next;
      });
      setNotice("");
      setError("");
      return;
    }
    if (
      target === "security" &&
      (key === "password" ||
        key === "timeout" ||
        key === "mfa" ||
        key === "ips")
    ) {
      setSecurityDraft((draft) => {
        const next = { ...draft, [key]: value };
        if (securityFields && value === securityFields[key]) delete next[key];
        return next;
      });
      setNotice("");
      setError("");
      return;
    }
    setNotice("");
    setError("");
  }

  function clearDraft(target: ManageSection) {
    if (livePending) return;
    if (target === "security") {
      setSecurityDraft({});
      setSecurityStale(false);
      setSecurityRefreshRequired(false);
    } else if (target === "backup") maintenance.discardDraft();
    if (target === "organization") {
      setWorkspaceDraft({});
      setWorkspaceStale(false);
      setWorkspaceRefreshRequired(false);
    }
    setError("");
    setNotice("Unsaved changes discarded.");
  }

  async function saveSection(target: ManageSection) {
    if (target === "organization") {
      await saveOrganization();
      return;
    }
    if (target === "security") {
      await saveSecurity();
      return;
    }
    if (target === "backup") {
      await maintenance.savePolicy();
      return;
    }
  }

  async function retryWorkspace() {
    const result = await workspaceQuery.refetch();
    if (result.isError || !result.data) {
      setError("The organization settings could not be loaded. Try again.");
      return;
    }
    setError("");
    if (workspaceRefreshRequired) {
      setWorkspaceRefreshRequired(false);
      setWorkspaceStale(true);
    }
  }

  async function saveOrganization() {
    if (livePending) return;
    const validationError = Object.values(
      organizationErrors(workspaceDraft, workspaceQuery.data !== undefined),
    )[0];
    if (validationError) {
      setError(validationError);
      return;
    }

    if (!workspaceQuery.data) {
      setError(
        "The organization settings could not be loaded. Retry before saving.",
      );
      return;
    }

    const patch = workspaceQuery.data
      ? workspaceSettingsPatch(workspaceQuery.data, workspaceDraft)
      : null;
    setNotice("");
    setError("");
    if (patch) {
      setWorkspaceSavePending(true);
      try {
        const saved = await updateManageWorkspace(patch);
        afterManageWorkspaceChange(queryClient, saved);
        setWorkspaceDraft({});
        setWorkspaceStale(false);
        setWorkspaceRefreshRequired(false);
        setNotice("Organization settings saved.");
      } catch (caught) {
        if (isStaleWorkspaceRevision(caught)) {
          setWorkspaceRefreshRequired(true);
          const refreshed = await workspaceQuery.refetch();
          if (refreshed.isError || !refreshed.data) {
            setError(
              "Workspace settings changed, but the latest values could not be loaded. Retry before saving again.",
            );
          } else {
            setWorkspaceRefreshRequired(false);
            setWorkspaceStale(true);
            setError("");
          }
          return;
        }
        setError(
          caught instanceof ApiError && caught.status === 403
            ? "Only administrators can change these settings. Reload the page to check your access."
            : "The settings could not be saved. Try again.",
        );
        return;
      } finally {
        setWorkspaceSavePending(false);
      }
    } else if (Object.keys(workspaceDraft).length > 0) {
      setWorkspaceDraft({});
      setWorkspaceStale(false);
    }

    setError("");
    setNotice("Organization settings saved.");
  }

  async function retrySecurity() {
    const result = await securityQuery.refetch();
    if (!result.isError && result.data) {
      setPolicyReadDenied(false);
      setSecurityRefreshRequired(false);
      setError("");
    }
  }

  async function retrySessions() {
    const result = await sessionsQuery.refetch();
    if (!result.isError && result.data) setSessionsReadDenied(false);
  }

  async function saveSecurity() {
    if (livePending) return;
    if (!securityQuery.data || securityDenied || securityRefreshRequired) {
      setError("Account policy could not be loaded. Retry before saving.");
      return;
    }
    const patch = securitySettingsPatch(securityQuery.data, securityDraft);
    if (!patch) {
      setSecurityDraft({});
      return;
    }
    setError("");
    setNotice("");
    setSecuritySavePending(true);
    try {
      const saved = await updateManageSecurityPolicy(patch);
      afterManageSecurityChange(queryClient, saved);
      setSecurityDraft({});
      setSecurityStale(false);
      setSecurityRefreshRequired(false);
      setNotice("Account policy saved.");
      requestSessionRecheck();
    } catch (caught) {
      if (isStaleWorkspaceRevision(caught)) {
        setSecurityStale(true);
        setSecurityRefreshRequired(true);
        const refreshed = await securityQuery.refetch();
        if (!refreshed.isError && refreshed.data)
          setSecurityRefreshRequired(false);
        else
          setError(
            "The latest policy could not be loaded. Retry before saving again.",
          );
      } else {
        setError(
          caught instanceof ApiError && caught.code === "ip_lockout"
            ? "The IP allow list would block your current address. Include your current address before saving."
            : caught instanceof ApiError && caught.status === 422
              ? "Check the policy values and IP addresses. Your changes are still here."
              : caught instanceof ApiError && caught.status === 403
                ? "Only administrators can change account policy. Reload the page to check your access."
                : "The policy could not be saved. Try again.",
        );
      }
    } finally {
      setSecuritySavePending(false);
    }
  }

  function requestConfirm(next: ConfirmState, event?: MouseEvent<HTMLElement>) {
    confirmOpener.current = event?.currentTarget ?? null;
    setDraftAcknowledged(false);
    setError("");
    setConfirm(next);
  }

  async function runSessionEnd(action: () => Promise<null>, all: boolean) {
    if (livePending) return false;
    setSessionEndPending(true);
    setError("");
    setNotice("");
    try {
      await action();
      await afterManageSessionsChange(queryClient);
      setSessionRequest((request) => ({ ...request, offset: 0 }));
      setNotice(
        all
          ? "Remote sessions ended. Your current session stays active."
          : "Session ended.",
      );
      return true;
    } catch {
      setError(
        all
          ? "Remote sessions could not be ended. Try again."
          : "The session could not be ended. Try again.",
      );
      return false;
    } finally {
      setSessionEndPending(false);
    }
  }

  function endSession(
    session: ManageAdminSession,
    event: MouseEvent<HTMLElement>,
  ) {
    if (session.current) return;
    requestConfirm(
      {
        origin: "admin-sessions",
        title: "End session",
        description: `${session.person_name}'s ${session.device} ${session.browser} session will be signed out. Your current session stays active.`,
        confirmLabel: "Confirm end session",
        action: () => runSessionEnd(() => endManageSession(session), false),
      },
      event,
    );
  }

  function endAllRemoteSessions(event: MouseEvent<HTMLElement>) {
    requestConfirm(
      {
        origin: "admin-sessions",
        title: "End all remote sessions",
        description:
          "End all other active sessions across the organization? Your current session stays active.",
        confirmLabel: "Confirm end all remote sessions",
        action: () => runSessionEnd(endAllManageRemoteSessions, true),
      },
      event,
    );
  }

  function openMfa(event?: MouseEvent<HTMLButtonElement>) {
    mfaOpener.current = event?.currentTarget ?? null;
    mfa.openManage();
  }

  const panelClass =
    "min-w-0 w-full rounded-[var(--radius)] border-border bg-card";

  const renderPageHeader = (actions?: ReactNode) => (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1
            ref={headingRef}
            data-slot="page-title"
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight sm:text-3xl"
          >
            {pageTitle}
          </h1>
        </div>
        <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
          {pageDescription}
        </p>
        <p
          role="note"
          aria-label={
            tab === "Backup" || tab === "Updates & licensing"
              ? "Server data"
              : "Organization data"
          }
          className="text-muted-foreground mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
        >
          <Badge variant="outline">
            {tab === "Backup" || tab === "Updates & licensing"
              ? "Server"
              : "Organization"}
          </Badge>
          <span> {liveSourceStatus}</span>
        </p>
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );

  return (
    <div className="min-w-0 space-y-6">
      <fieldset
        disabled={livePending}
        aria-busy={livePending}
        className="min-w-0 space-y-6"
      >
        {livePending ? (
          <p role="status" className="text-muted-foreground text-sm">
            Saving changes…
          </p>
        ) : null}
        {tab !== "Audit" ? renderPageHeader() : null}

        <div className="flex flex-col gap-6">
          {navigationNotice ? (
            <Alert role="status" variant="warning">
              {navigationNotice}
            </Alert>
          ) : null}
          <DiscardChangesDialog
            open={pendingLeave !== null}
            title="Discard unsaved Manage changes?"
            description="Your unsaved organization, security or backup changes will be lost."
            onKeep={() => setPendingLeave(null)}
            onDiscard={discardAndLeave}
          />
          {notice || (recoveryView && maintenance.notice) ? (
            <Alert
              role="status"
              variant="success"
              className="flex items-center gap-2"
            >
              <CheckCircle2 aria-hidden="true" />
              {notice || maintenance.notice}
            </Alert>
          ) : null}
          {error ? (
            <Alert
              role="alert"
              variant="destructive"
              className="flex items-center gap-2"
            >
              <AlertTriangle aria-hidden="true" />
              {error}
            </Alert>
          ) : null}
          {tab === "Organization" ? (
            <OrganizationPanel
              form={{
                dirty,
                saveSection,
                current,
                changeSetting,
                errors,
                clearDraft,
              }}
              panelClass={panelClass}
              regionalDate={regionalDate}
              regionalCurrency={regionalCurrency}
              workspace={workspaceQuery.data}
              workspaceLoading={workspaceQuery.isPending}
              workspaceLoadFailed={workspaceQuery.isError}
              onRetryWorkspace={retryWorkspace}
              staleRevision={workspaceStale}
            />
          ) : null}

          {recoveryView ? (
            <section
              aria-label="Security and recovery workspace"
              className="min-w-0 space-y-5"
            >
              <Alert role="note">
                Backup requests are queued for a configured host runner. Restore
                and software updates are offline server-operator procedures.
              </Alert>
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="bg-card flex flex-wrap items-center gap-4 rounded-lg border p-5">
                  <LockKeyhole
                    aria-hidden="true"
                    className="text-muted-foreground size-6 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 data-slot="section-title" className="font-semibold">
                        Account policy
                      </h2>
                      {securityDirty ? (
                        <Badge variant="warning">Unsaved changes</Badge>
                      ) : null}
                    </div>
                    <p className="text-muted-foreground mt-1 text-sm">
                      {securityFields
                        ? `${securityFields.mfa === "Optional" ? "Optional two-factor" : securityFields.mfa} · ${securityFields.timeout} timeout`
                        : securityQuery.isPending && !securityDenied
                          ? "Loading policy…"
                          : "Account policy unavailable"}
                    </p>
                  </div>
                  <Button
                    ref={policyOpener}
                    variant="outline"
                    className="min-h-11"
                    onClick={() => {
                      setError("");
                      setPolicyOpen(true);
                    }}
                  >
                    Edit policy
                  </Button>
                </div>
                <div className="bg-card flex flex-wrap items-center gap-4 rounded-lg border p-5">
                  <Database
                    aria-hidden="true"
                    className="text-muted-foreground size-6 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 data-slot="section-title" className="font-semibold">
                        Backup schedule
                      </h2>
                      {maintenance.dirty ? (
                        <Badge variant="warning">Unsaved changes</Badge>
                      ) : null}
                    </div>
                    <p className="text-muted-foreground mt-1 text-sm">
                      {maintenance.acceptedStatus
                        ? `${backupScheduleLabels[maintenance.acceptedStatus.policy.schedule]} · Keep ${maintenance.acceptedStatus.policy.retention_days} days`
                        : maintenance.status.isPending &&
                            !maintenance.policyRefused
                          ? "Loading backup policy…"
                          : "Backup policy unavailable"}
                    </p>
                    {maintenance.acceptedStatus ? (
                      <BackupRunnerStatus status={maintenance.acceptedStatus} />
                    ) : maintenance.status.isError ||
                      maintenance.policyRefused ? (
                      <Alert role="alert" variant="destructive">
                        <p>
                          {maintenance.policyRefused
                            ? "Only administrators can review backup policy."
                            : "Backup policy could not be loaded."}
                        </p>
                        <Button
                          variant="outline"
                          onClick={() => void maintenance.retryPolicy()}
                        >
                          Retry backup policy
                        </Button>
                      </Alert>
                    ) : null}
                  </div>
                  <Button
                    ref={scheduleOpener}
                    variant="outline"
                    className="min-h-11"
                    onClick={() => {
                      setError("");
                      setScheduleOpen(true);
                    }}
                  >
                    Edit schedule
                  </Button>
                </div>
              </div>
              <Tabs
                value={tab === "Backup" ? "snapshots" : "sessions"}
                onValueChange={(value) => {
                  if (!livePending)
                    router.push(
                      `/manage?view=${value === "snapshots" ? "backup" : "security"}`,
                      { scroll: false },
                    );
                }}
              >
                <TabsList aria-label="Security and recovery views">
                  <TabsTrigger value="sessions" className="min-h-11 gap-2 px-4">
                    Sessions{" "}
                    <Badge variant="outline">
                      {sessionsDenied
                        ? "—"
                        : (sessionsQuery.data?.pagination.total ?? "—")}
                    </Badge>
                  </TabsTrigger>
                  <TabsTrigger
                    value="snapshots"
                    className="min-h-11 gap-2 px-4"
                  >
                    Backups{" "}
                    <Badge variant="outline">
                      {maintenance.acceptedHistory?.pagination.total ?? "—"}
                    </Badge>
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="sessions" keepMounted className="min-w-0">
                  <SecurityPanel
                    sessions={
                      sessionsDenied || sessionsQuery.isError
                        ? {
                            status: "error",
                            message: sessionsDenied
                              ? "Only administrators can review sessions."
                              : "Sessions could not be loaded.",
                            page: sessionsDenied
                              ? undefined
                              : sessionsQuery.data,
                          }
                        : sessionsQuery.isPending
                          ? { status: "loading" }
                          : { status: "ready", page: sessionsQuery.data }
                    }
                    request={sessionRequest}
                    onRequestChange={setSessionRequest}
                    onRetry={() => void retrySessions()}
                    actions={{ endAllRemoteSessions, endSession }}
                  />
                </TabsContent>
                <TabsContent value="snapshots" keepMounted className="min-w-0">
                  <BackupPanel maintenance={maintenance} />
                </TabsContent>
              </Tabs>
            </section>
          ) : null}

          {tab === "Audit" ? (
            <ManageAudit renderHeader={renderPageHeader} />
          ) : null}

          {tab === "Updates & licensing" ? (
            <div className="min-w-0 space-y-5">
              <Alert role="note">
                This page reads the running server version and recorded release
                observations. Updates are applied by your server operator. No
                license is required.
              </Alert>
              <div className="bg-card grid min-w-0 divide-y overflow-hidden rounded-lg border xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] xl:divide-x xl:divide-y-0">
                <UpdatesPanel maintenance={maintenance} />
                <LicensingPanel />
              </div>
            </div>
          ) : null}
        </div>
      </fieldset>
      <Dialog
        open={policyOpen}
        onOpenChange={setPolicyOpen}
        dismissible={!livePending}
      >
        <DialogContent
          className="max-w-3xl"
          finalFocus={() => policyOpener.current}
        >
          <DialogHeader className="mb-5">
            <div className="flex items-center justify-between gap-3">
              <DialogTitle>Account policy</DialogTitle>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close account policy"
                disabled={livePending}
                onClick={() => setPolicyOpen(false)}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
            <DialogDescription>
              Set the account policy enforced by your organization. Closing
              keeps your unsaved changes.
            </DialogDescription>
          </DialogHeader>
          <fieldset
            disabled={livePending}
            aria-busy={livePending}
            className="min-w-0 space-y-4"
          >
            {error ? (
              <Alert role="alert" variant="destructive">
                {error}
              </Alert>
            ) : null}
            {securityStale ? (
              <Alert role="note" variant="warning">
                Policy changed since you opened it. Your draft is kept; review
                the latest values before saving again.
              </Alert>
            ) : null}
            {securityQuery.isPending && !securityDenied ? (
              <p role="status">Loading account policy…</p>
            ) : null}
            {securityDenied ||
            securityQuery.isError ||
            securityRefreshRequired ? (
              <Alert role="alert" variant="destructive">
                <p>
                  {securityDenied
                    ? "Only administrators can review account policy."
                    : "Account policy could not be loaded."}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void retrySecurity()}
                >
                  Retry account policy
                </Button>
              </Alert>
            ) : null}
            {securityFields ? (
              <SecurityPolicyForm
                form={{
                  dirty: securityDirty,
                  current: {
                    ...initialManageSettings,
                    ...securityFields,
                    ...securityDraft,
                  },
                  errors: {},
                  saveSection,
                  clearDraft,
                  changeSetting,
                }}
                onManageMfa={() => {
                  setPolicyOpen(false);
                  openMfa();
                  mfaOpener.current = policyOpener.current;
                }}
              />
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => setPolicyOpen(false)}>
                Close
              </Button>
            </DialogFooter>
          </fieldset>
        </DialogContent>
      </Dialog>
      <Dialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        dismissible={!maintenance.pending}
      >
        <DialogContent
          className="max-w-3xl"
          finalFocus={() => scheduleOpener.current}
        >
          <DialogHeader className="mb-5">
            <div className="flex items-center justify-between gap-3">
              <DialogTitle>Backup schedule</DialogTitle>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close backup schedule"
                disabled={maintenance.pending}
                onClick={() => setScheduleOpen(false)}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
            <DialogDescription>
              Save the server’s schedule and retention policy. Your server
              operator configures the host runner.
            </DialogDescription>
          </DialogHeader>
          <fieldset
            disabled={maintenance.pending}
            aria-busy={maintenance.pending}
            className="min-w-0 space-y-4"
          >
            <SnapshotScheduleForm maintenance={maintenance} />
            <DialogFooter>
              <Button variant="outline" onClick={() => setScheduleOpen(false)}>
                Close
              </Button>
            </DialogFooter>
          </fieldset>
        </DialogContent>
      </Dialog>
      <ManageMfaDialog opener={mfaOpener} />
      <ManageConfirmationDialog
        confirm={sessionConfirmationRefused ? null : confirm}
        pending={livePending}
        error={error}
        draftAcknowledged={draftAcknowledged}
        confirmOpener={confirmOpener}
        headingRef={headingRef}
        onClose={() => setConfirm(null)}
        onDraftAcknowledgedChange={setDraftAcknowledged}
      />
    </div>
  );
}
