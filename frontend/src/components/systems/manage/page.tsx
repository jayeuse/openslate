"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  MoreHorizontal,
  LockKeyhole,
  Database,
  X,
  RotateCcw,
} from "lucide-react";
import {
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { SampleDataNote } from "@/components/sample-data-note";
import { useWorkspaceNavigationGuard } from "@/components/workspace-navigation-guard";
import { ApiError } from "@/lib/api";
import { requestSessionRecheck } from "@/lib/auth-api";
import { useMfaFlow } from "@/components/mfa-flow";
import ManageAudit from "./components/audit";
import {
  decodeManageSettings,
  diffManageSettings,
  downloadManageSnapshot,
  initialManageSettings,
  useManageController,
  type ManageSection,
  type ManageSettings,
  type ManageSnapshot,
} from "./state/state";
import { SettingsChanges } from "./components/panel-ui";
import {
  ManageMfaDialog,
  ManagePreviewDialog,
  ManageSnapshotCompareDialog,
  ManageSnapshotRenameDialog,
  ManageConfirmationDialog,
  type ConfirmState,
  type PreviewState,
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
import { BackupPanel, SnapshotScheduleForm } from "./components/backup-panel";
import { UpdatesPanel } from "./components/updates-panel";
import {
  LicensingPanel,
  LicenseTierComparison,
} from "./components/licensing-panel";

type ViewTab =
  "Organization" | "Security" | "Audit" | "Backup" | "Updates & licensing";

type Snapshot = ManageSnapshot;

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

function sectionForTab(tab: ViewTab): ManageSection | null {
  if (tab === "Organization") return "organization";
  if (tab === "Security") return "security";
  if (tab === "Backup") return "backup";
  return null;
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
  const manage = useManageController();
  const queryClient = useQueryClient();
  const activeUsers = manage.people.filter((person) => person.active).length;
  const { settings, snapshots: backups, history, storageUnavailable } = manage;
  const seatLimit = settings.tier === "Business" ? 100 : 25;
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
    workspaceSavePending || securitySavePending || sessionEndPending;
  const [notice, setNotice] = useState("");
  const [navigationNotice, setNavigationNotice] = useState("");
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [draftAcknowledged, setDraftAcknowledged] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const mfa = useMfaFlow();
  const cancelMfa = mfa.cancel;
  useEffect(() => () => cancelMfa(), [cancelMfa]);
  const [showChangelog, setShowChangelog] = useState(false);
  const [dummyKey, setDummyKey] = useState("SAMPLE-TEAM-2026");
  const [policyOpen, setPolicyOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const policyOpener = useRef<HTMLButtonElement | null>(null);
  const scheduleOpener = useRef<HTMLButtonElement | null>(null);
  const [renameTarget, setRenameTarget] = useState<Snapshot | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState("");
  const [compareTarget, setCompareTarget] = useState<Snapshot | null>(null);
  const confirmOpener = useRef<HTMLElement | null>(null);
  const renameOpener = useRef<HTMLElement | null>(null);
  const mfaOpener = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const optionsOpener = useRef<HTMLButtonElement | null>(null);
  const sessionConfirmationRefused =
    sessionsDenied && confirm?.origin === "admin-sessions";
  if (sessionConfirmationRefused) setConfirm(null);
  const recoveryView = tab === "Security" || tab === "Backup";
  const pageTitle = recoveryView ? "Security & recovery" : tab;
  const sampleSubject =
    tab === "Audit"
      ? "Audit entries"
      : tab === "Updates & licensing"
        ? "Versions and licenses"
        : recoveryView
          ? "Sessions and snapshots"
          : "Settings";
  const liveSourceStatus =
    tab === "Organization"
      ? "Settings save to the organization."
      : tab === "Audit"
        ? "Audit entries are loaded from your organization."
        : recoveryView
          ? "Account policy and sessions are loaded from your organization. Snapshots use browser preview data."
          : null;
  const pageDescription =
    tab === "Organization"
      ? "Make this workspace feel like your organization."
      : tab === "Audit"
        ? "See who changed what, then inspect the details."
        : tab === "Updates & licensing"
          ? "Your workspace version and plan, together in one place."
          : "Review sessions and keep a copy of your workspace settings.";

  const section = sectionForTab(tab);
  const workspacePatch = workspaceQuery.data
    ? workspaceSettingsPatch(workspaceQuery.data, workspaceDraft)
    : null;
  const workspaceDraftDirty = workspacePatch !== null;
  const allDraftsDirty =
    securityDirty || manage.dirty("backup") || workspaceDraftDirty;
  const currentFor = (view: ViewTab): ManageSettings => {
    const currentSection = sectionForTab(view);
    return currentSection ? manage.getDraft(currentSection) : settings;
  };
  const sampleCurrent = currentFor(tab);
  const workspaceFields = workspaceQuery.data
    ? workspaceSettingsFormFields(workspaceQuery.data)
    : null;
  const current =
    tab === "Organization" && workspaceFields
      ? { ...sampleCurrent, ...workspaceFields, ...workspaceDraft }
      : sampleCurrent;
  const previewSettings =
    tab === "Organization" && workspaceFields
      ? current
      : decodeManageSettings(current);
  const dirty =
    tab === "Organization"
      ? workspaceDraftDirty
      : section
        ? manage.dirty(section)
        : false;
  const sectionErrors = section ? manage.errors(section) : {};
  const errors =
    tab === "Organization"
      ? organizationErrors(workspaceDraft, workspaceQuery.data !== undefined)
      : sectionErrors;
  const updateAvailable = manage.updateAvailable;
  const localeCode = organizationLocaleTag(current.locale);
  const regionalDate = new Intl.DateTimeFormat(localeCode, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: previewSettings.timezone,
  }).format(new Date("2026-09-11T09:00:00Z"));
  const regionalCurrency = new Intl.NumberFormat(localeCode, {
    style: "currency",
    currency: previewSettings.currency,
  }).format(12500);
  const retention = manage.retentionPreview();

  useWorkspaceNavigationGuard(() => {
    if (manage.pending || livePending) {
      setNavigationNotice(
        "Finish the current change before leaving this page.",
      );
      return false;
    }
    setNavigationNotice("");
    return true;
  });

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
    manage.change(target, key, value);
    setNotice("");
    setError("");
  }

  function clearDraft(target: ManageSection) {
    if (manage.pending || livePending) return;
    if (target === "security") {
      setSecurityDraft({});
      setSecurityStale(false);
      setSecurityRefreshRequired(false);
    } else manage.discard(target);
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
    const result = await manage.save(target);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError("");
    setNotice(
      storageUnavailable
        ? "Settings updated in memory only. Browser storage is unavailable."
        : result.message,
    );
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
    if (manage.pending || livePending) return;
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
    if (manage.pending || livePending) return;
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

  async function addSnapshot(name: string) {
    const result = await manage.createSnapshot(
      name.trim() || "Manual snapshot",
    );
    setError(result.ok ? "" : result.message);
    setNotice(result.ok ? result.message : "");
    return result.ok;
  }

  function requestRestore(snapshot: Snapshot, event: MouseEvent<HTMLElement>) {
    const differences = manage.snapshotDiff(snapshot.id);
    requestConfirm(
      {
        title: "Restore configuration",
        description: `Restore preview settings from ${snapshot.name}? This does not change persisted organization or account policy.`,
        confirmLabel: "Confirm restore",
        requiresDraftAck: manage.dirty("backup"),
        body: <SettingsChanges differences={differences} />,
        action: async () => {
          const result = await manage.restoreSnapshot(snapshot.id, {
            discardDrafts: manage.dirty("backup"),
          });
          setError(result.ok ? "" : result.message);
          setNotice(
            result.ok
              ? "Preview settings restored. Organization and account policy are unchanged."
              : "",
          );

          return result.ok;
        },
      },
      event,
    );
  }

  function requestReset(event: MouseEvent<HTMLElement>) {
    requestConfirm(
      {
        title: "Reset Manage configuration",
        description:
          "Restore browser preview settings to bundled defaults and discard unsaved Manage drafts. Persisted organization and account policy are unchanged.",
        confirmLabel: "Reset Manage configuration",
        requiresDraftAck: allDraftsDirty,
        body: (
          <SettingsChanges
            differences={diffManageSettings(settings, initialManageSettings)}
          />
        ),
        action: async () => {
          const result = await manage.reset({
            discardDrafts: allDraftsDirty,
          });
          if (result.ok) {
            setWorkspaceDraft({});
            setWorkspaceStale(false);
            setWorkspaceRefreshRequired(false);
            setSecurityDraft({});
            setSecurityStale(false);
            setSecurityRefreshRequired(false);
          }
          setError(result.ok ? "" : result.message);
          setNotice(
            result.ok
              ? "Preview settings restored. Organization and account policy are unchanged."
              : "",
          );

          return result.ok;
        },
      },
      event,
    );
  }

  async function runSessionEnd(action: () => Promise<null>, all: boolean) {
    if (manage.pending || livePending) return false;
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

  function startUpdate() {
    requestConfirm({
      title: "Apply update",
      description: `Update version ${settings.version} to 1.5.0? This updates the visible version and keeps a rollback point. No software is installed.`,
      confirmLabel: "Confirm update",
      action: async () => {
        const result = await manage.applyUpdate();
        setError(result.ok ? "" : result.message);
        setNotice(result.ok ? result.message : "");

        return result.ok;
      },
    });
  }

  function rollbackUpdate(event: MouseEvent<HTMLElement>) {
    requestConfirm(
      {
        title: "Roll back update",
        description: `Return the version to ${settings.previous}? This only changes the displayed version.`,
        confirmLabel: "Confirm rollback",
        action: async () => {
          const result = await manage.rollbackUpdate();
          setError(result.ok ? "" : result.message);
          setNotice(result.ok ? result.message : "");

          return result.ok;
        },
      },
      event,
    );
  }

  function activateLicense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    requestConfirm({
      title: "Activate license",
      description: `Activate the bundled ${dummyKey.includes("BUSINESS") ? "Business" : "Team"} license? No payment or license service will be contacted.`,
      confirmLabel: "Confirm activation",
      action: async () => {
        const result = await manage.activateLicense(dummyKey);
        setError(result.ok ? "" : result.message);
        setNotice(result.ok ? result.message : "");

        return result.ok;
      },
    });
  }

  function renewLicense(event: MouseEvent<HTMLElement>) {
    requestConfirm(
      {
        title: "Renew license",
        description:
          "Extend the displayed expiration date by one year. No purchase or payment will occur.",
        confirmLabel: "Confirm renewal",
        action: async () => {
          const result = await manage.renewLicense();
          setError(result.ok ? "" : result.message);
          setNotice(result.ok ? result.message : "");

          return result.ok;
        },
      },
      event,
    );
  }

  function downloadSnapshot(snapshot: Snapshot) {
    downloadManageSnapshot(snapshot);
    setNotice(`Downloaded ${snapshot.name}.`);
  }

  async function submitSnapshotRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renameTarget || !renameValue.trim() || manage.pending) return;
    const result = await manage.renameSnapshot(
      renameTarget.id,
      renameValue.trim(),
    );
    if (!result.ok) {
      setRenameError(result.message);
      return;
    }
    setRenameTarget(null);
    setNotice(result.message);
  }

  const panelClass =
    "min-w-0 w-full rounded-[var(--radius)] border-border bg-card";

  if (manage.resource.status !== "ready")
    return (
      <section className="space-y-4">
        <h1 data-slot="page-title" className="text-2xl font-semibold">
          Manage
        </h1>
        {manage.resource.status === "loading" ? (
          <p role="status">Loading management settings…</p>
        ) : (
          <Alert role="alert" variant="destructive">
            <p>{manage.resource.error}</p>
            <Button variant="outline" onClick={manage.resource.reload}>
              Try again
            </Button>
          </Alert>
        )}
      </section>
    );

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
        <SampleDataNote
          ariaLabel={liveSourceStatus ? "Organization data" : undefined}
          className="mt-3"
          sourceLabel={liveSourceStatus ? "Organization" : undefined}
          suffix={liveSourceStatus ? "" : undefined}
        >
          {liveSourceStatus ?? `${sampleSubject} here are examples.`}
        </SampleDataNote>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {actions}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                ref={optionsOpener}
                type="button"
                variant="outline"
                size="icon"
                className="size-11"
                aria-label="Manage options"
              />
            }
          >
            <MoreHorizontal aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={(event) => {
                requestReset(event);
                confirmOpener.current = optionsOpener.current;
              }}
            >
              <RotateCcw aria-hidden="true" /> Reset Manage
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );

  return (
    <div className="min-w-0 space-y-6">
      <fieldset
        disabled={manage.pending || livePending}
        aria-busy={manage.pending || livePending}
        className="min-w-0 space-y-6"
      >
        {manage.pending || livePending ? (
          <p role="status" className="text-muted-foreground text-sm">
            Saving changes…
          </p>
        ) : null}
        {manage.resource.error ? (
          <Alert role="alert" variant="warning">
            <p>
              {manage.resource.error} Your last loaded settings are still shown.
            </p>
            <Button variant="outline" onClick={manage.resource.reload}>
              Retry refresh
            </Button>
          </Alert>
        ) : null}
        {tab !== "Audit" ? renderPageHeader() : null}

        {storageUnavailable ? (
          <Alert role="note" variant="warning">
            Browser storage is unavailable. Your latest changes exist in memory
            only and may be lost on reload.
          </Alert>
        ) : null}

        <div className="flex flex-col gap-6">
          {navigationNotice ? (
            <Alert role="status" variant="warning">
              {navigationNotice}
            </Alert>
          ) : null}
          {notice ? (
            <Alert
              role="status"
              variant="success"
              className="flex items-center gap-2"
            >
              <CheckCircle2 aria-hidden="true" />
              {notice}
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
                Account policy and sessions are live. Snapshots are browser
                previews and do not restore persisted organization or account
                policy.
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
                        Snapshot schedule
                      </h2>
                      {manage.dirty("backup") ? (
                        <Badge variant="warning">Unsaved changes</Badge>
                      ) : null}
                    </div>
                    <p className="text-muted-foreground mt-1 text-sm">
                      {settings.schedule} · Keep{" "}
                      {settings.retention.toLowerCase()}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      Simulated schedule
                    </p>
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
                  if (!manage.pending && !livePending)
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
                    Snapshots <Badge variant="outline">{backups.length}</Badge>
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
                  <BackupPanel
                    snapshots={manage.collections.snapshots}
                    actions={{
                      addSnapshot,
                      requestRestore,
                      setCompareTarget,
                      downloadSnapshot,
                      renameOpener,
                      setRenameTarget,
                      setRenameError,
                      setRenameValue,
                      requestConfirm,
                      manage,
                      setError,
                      setNotice,
                    }}
                  />
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
                Preview environment. Version and license changes here are
                simulated.
              </Alert>
              <div className="bg-card grid min-w-0 divide-y overflow-hidden rounded-lg border xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] xl:divide-x xl:divide-y-0">
                <UpdatesPanel
                  settings={settings}
                  actions={{
                    manage,
                    setError,
                    setNotice,
                    startUpdate,
                    setShowChangelog,
                    rollbackUpdate,
                  }}
                  updateAvailable={updateAvailable}
                  showChangelog={showChangelog}
                  history={history}
                />
                <LicensingPanel
                  settings={settings}
                  activeUsers={activeUsers}
                  seatLimit={seatLimit}
                  actions={{ renewLicense }}
                  licenseForm={{ activateLicense, dummyKey, setDummyKey }}
                />
              </div>
              <div className="bg-card rounded-lg border">
                <LicenseTierComparison
                  settings={settings}
                  setPreview={setPreview}
                />
              </div>
            </div>
          ) : null}
        </div>
      </fieldset>
      <Dialog
        open={policyOpen}
        onOpenChange={setPolicyOpen}
        dismissible={!manage.pending && !livePending}
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
                disabled={manage.pending || livePending}
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
            disabled={manage.pending || livePending}
            aria-busy={manage.pending || livePending}
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
                  current: { ...settings, ...securityFields, ...securityDraft },
                  errors: {},
                  saveSection,
                  clearDraft,
                  changeSetting,
                }}
                onPreviewMfa={() => {
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
        dismissible={!manage.pending}
      >
        <DialogContent
          className="max-w-3xl"
          finalFocus={() => scheduleOpener.current}
        >
          <DialogHeader className="mb-5">
            <div className="flex items-center justify-between gap-3">
              <DialogTitle>Snapshot schedule</DialogTitle>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close snapshot schedule"
                disabled={manage.pending}
                onClick={() => setScheduleOpen(false)}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
            <DialogDescription>
              Save schedule and retention preferences. No background job runs;
              snapshots contain saved Manage settings only.
            </DialogDescription>
          </DialogHeader>
          <fieldset
            disabled={manage.pending}
            aria-busy={manage.pending}
            className="min-w-0 space-y-4"
          >
            {error ? (
              <Alert role="alert" variant="destructive">
                {error}
              </Alert>
            ) : null}
            <SnapshotScheduleForm
              form={{
                dirty: manage.dirty("backup"),
                current: manage.getDraft("backup"),
                errors: manage.errors("backup"),
                saveSection,
                clearDraft,
                changeSetting,
              }}
              settings={settings}
              retention={retention}
              actions={{
                addSnapshot,
                setPreview: (next) => {
                  setScheduleOpen(false);
                  setPreview(next);
                },
              }}
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setScheduleOpen(false)}>
                Close
              </Button>
            </DialogFooter>
          </fieldset>
        </DialogContent>
      </Dialog>
      <ManageMfaDialog opener={mfaOpener} />
      <ManageSnapshotRenameDialog
        open={renameTarget !== null}
        pending={manage.pending}
        value={renameValue}
        error={renameError}
        opener={renameOpener}
        headingRef={headingRef}
        onValueChange={setRenameValue}
        onErrorClear={() => setRenameError("")}
        onCancel={() => setRenameTarget(null)}
        onSubmit={submitSnapshotRename}
      />
      <ManageSnapshotCompareDialog
        target={compareTarget}
        differences={compareTarget ? manage.snapshotDiff(compareTarget.id) : []}
        onClose={() => setCompareTarget(null)}
      />
      <ManagePreviewDialog preview={preview} onClose={() => setPreview(null)} />
      <ManageConfirmationDialog
        confirm={sessionConfirmationRefused ? null : confirm}
        pending={manage.pending || livePending}
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
