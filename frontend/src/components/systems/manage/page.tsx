"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, CheckCircle2, Database, X } from "lucide-react";
import {
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  GuardedWorkspaceLink,
  useWorkspaceNavigationGuard,
  useWorkspaceNavigationRequest,
} from "@/components/workspace-navigation-guard";
import { DiscardChangesDialog } from "../access/components/people-fields";
import { useOrganizationTheme } from "@/components/organization-theme-provider";
import {
  useVerifiedWorkspaceUserId,
  useWorkspaceInteractionSuspended,
} from "@/components/systems/shared/runtime/workspace-identity";
import { authMeOptions } from "../access/adapters/access-queries";
import type { OrganizationTheme } from "@/lib/appearance-preferences";
import { ApiError } from "@/lib/api";
import { requestSessionRecheck } from "@/lib/auth-api";
import ManageAudit from "./components/audit";
import {
  initialManageSettings,
  type ManageSection,
  type ManageSettings,
} from "./state/model";
import { OrganizationPanel } from "./components/organization-panel";
import {
  afterManageWorkspaceChange,
  manageWorkspaceOptions,
  manageKeys,
} from "./adapters/manage-queries";
import {
  getManageWorkspace,
  isStaleWorkspaceRevision,
  organizationLocaleTag,
  workspaceSettingsFormFields,
  workspaceSettingsPatch,
  workspaceHasContacts,
  updateManageWorkspace,
  type WorkspaceSettingsFormDraft,
  type WorkspaceSettingsFormFields,
  type WorkspaceProfileField,
} from "./adapters/workspace-api";
import {
  BackupPanel,
  BackupRunnerStatus,
  SnapshotScheduleForm,
} from "./components/backup-panel";
import { useManageMaintenance } from "./state/controller";
import { backupScheduleLabels } from "./adapters/backup-api";
import { UpdatesPanel } from "./components/updates-panel";
import { LicensingPanel } from "./components/licensing-panel";

type ViewTab = "Organization" | "Audit" | "Backup" | "Updates & licensing";

function organizationErrors(
  draft: WorkspaceSettingsFormDraft,
  workspaceReady: boolean,
): Partial<Record<keyof WorkspaceSettingsFormFields, string>> {
  const errors: Partial<Record<keyof WorkspaceSettingsFormFields, string>> = {};
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
  const limits = {
    legalName: 200,
    description: 2000,
    contactEmail: 254,
    contactPhone: 50,
    postalAddress: 2000,
  } as const;
  for (const key of Object.keys(limits) as WorkspaceProfileField[]) {
    if ((draft[key]?.trim().length ?? 0) > limits[key])
      errors[key] = `Use ${limits[key]} characters or fewer.`;
  }
  return errors;
}

function profileResponseErrors(
  error: ApiError,
): Partial<Record<WorkspaceProfileField, string>> {
  if (!Array.isArray(error.details)) return {};
  const keys = {
    legal_name: "legalName",
    description: "description",
    contact_email: "contactEmail",
    contact_phone: "contactPhone",
    postal_address: "postalAddress",
  } as const;
  const errors: Partial<Record<WorkspaceProfileField, string>> = {};
  for (const detail of error.details) {
    if (
      typeof detail !== "object" ||
      detail === null ||
      !("loc" in detail) ||
      !Array.isArray(detail.loc)
    )
      continue;
    const name: unknown = detail.loc[1];
    if (
      detail.loc[0] !== "body" ||
      typeof name !== "string" ||
      !Object.hasOwn(keys, name)
    )
      continue;
    const key = keys[name as keyof typeof keys];
    errors[key] =
      key === "contactEmail"
        ? "Enter a valid email address."
        : "Check this field and try again.";
  }
  return errors;
}

const manageTabs: readonly ViewTab[] = [
  "Organization",
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
  const legacySecurity = searchParams.get("view")?.toLowerCase() === "security";
  const requestedTab = manageTabFromQuery(searchParams.get("view"));
  const requestNavigation = useWorkspaceNavigationRequest();
  const legacyRequested = useRef(false);
  const queryClient = useQueryClient();
  const userId = useVerifiedWorkspaceUserId();
  const suspended = useWorkspaceInteractionSuspended();
  const organizationTheme = useOrganizationTheme();
  const {
    confirm: confirmTheme,
    preview: previewTheme,
    release: releaseTheme,
    getCommittedTheme,
  } = organizationTheme;
  const [roleAwaitingVerification, setRoleAwaitingVerification] =
    useState(false);
  const roleVerificationCycle = useRef(0);
  const identity = useQuery({
    ...authMeOptions(),
    enabled: !suspended && !roleAwaitingVerification,
  });
  useLayoutEffect(() => {
    if (suspended) {
      roleVerificationCycle.current += 1;
      setRoleAwaitingVerification(true);
    }
  }, [suspended]);
  const canEditOrganization =
    !suspended &&
    !roleAwaitingVerification &&
    !identity.isError &&
    identity.data?.id === userId &&
    identity.data.role === "admin";
  const liveWorkspace = useRef(false);
  const workspaceOwner = useRef(Symbol("organization-preview"));
  const workspaceEpoch = useRef(0);
  const workspaceCommand = useRef<AbortController | null>(null);
  const workspaceWriting = useRef(false);
  const workspaceNeedsReadback = useRef(false);
  const workspaceAdmission = useRef({
    suspended,
    canEdit: canEditOrganization,
  });
  useLayoutEffect(() => {
    liveWorkspace.current = true;
    const owner = workspaceOwner.current;
    return () => {
      liveWorkspace.current = false;
      workspaceEpoch.current += 1;
      workspaceCommand.current?.abort();
      releaseTheme(owner);
    };
  }, [releaseTheme]);
  useEffect(() => {
    if (suspended || !roleAwaitingVerification) return;
    const cycle = roleVerificationCycle.current;
    let cancelled = false;
    const ownsRead = () =>
      !cancelled &&
      liveWorkspace.current &&
      cycle === roleVerificationCycle.current &&
      !workspaceAdmission.current.suspended;
    // A read started before verification cannot admit this cycle. Keep the
    // ordinary trusted background behavior; only verification requires this
    // cancellation followed by a fresh, account-owned role read.
    void queryClient
      .cancelQueries({ queryKey: authMeOptions().queryKey, exact: true })
      .then(() =>
        ownsRead()
          ? queryClient.fetchQuery({ ...authMeOptions(), staleTime: 0 })
          : undefined,
      )
      .then((currentIdentity) => {
        if (currentIdentity && ownsRead()) setRoleAwaitingVerification(false);
      })
      .catch(() => {
        // The failed identity read keeps the picker read-only. A subsequent
        // session recheck starts another owned verification cycle.
      });
    return () => {
      cancelled = true;
    };
  }, [suspended, roleAwaitingVerification, queryClient]);
  const maintenance = useManageMaintenance({
    recoveryActive: requestedTab === "Backup",
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
  const [profileServerErrors, setProfileServerErrors] = useState<
    Partial<Record<WorkspaceProfileField, string>>
  >({});
  const workspaceQuery = useQuery({
    ...manageWorkspaceOptions(),
    enabled: tab === "Organization" && !suspended && !legacySecurity,
    // A resumed verified editor needs a current revision, including after an
    // uncertain response. Cached data stays visible during this fresh read.
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const epoch = workspaceEpoch.current;
      const workspace = await getManageWorkspace(signal);
      if (
        liveWorkspace.current &&
        !signal.aborted &&
        epoch === workspaceEpoch.current &&
        !workspaceAdmission.current.suspended
      )
        confirmTheme(workspace.theme);
      return workspace;
    },
  });
  const verifiedOrganizationRole =
    !suspended &&
    !roleAwaitingVerification &&
    !identity.isError &&
    identity.data?.id === userId
      ? identity.data.role
      : null;
  const profileMismatch =
    workspaceQuery.data !== undefined &&
    (verifiedOrganizationRole === "admin" ||
      verifiedOrganizationRole === "member") &&
    !workspaceHasContacts(workspaceQuery.data);
  const canEditLoadedOrganization = canEditOrganization && !profileMismatch;
  const contactsVisible =
    (verifiedOrganizationRole === "admin" ||
      verifiedOrganizationRole === "member") &&
    workspaceQuery.data !== undefined &&
    workspaceHasContacts(workspaceQuery.data);
  useLayoutEffect(() => {
    const previous = workspaceAdmission.current;
    workspaceAdmission.current = {
      suspended,
      canEdit: canEditLoadedOrganization,
    };
    if (suspended || (previous.canEdit && !canEditLoadedOrganization)) {
      workspaceEpoch.current += 1;
      workspaceCommand.current?.abort();
      if (workspaceWriting.current) {
        workspaceNeedsReadback.current = true;
        workspaceWriting.current = false;
        setWorkspaceSavePending(false);
        setWorkspaceRefreshRequired(true);
      }
    }
  }, [suspended, canEditLoadedOrganization]);
  useLayoutEffect(() => {
    const owner = workspaceOwner.current;
    if (
      tab === "Organization" &&
      canEditLoadedOrganization &&
      workspaceDraft.theme !== undefined
    )
      previewTheme(owner, workspaceDraft.theme);
    else releaseTheme(owner);
    return () => releaseTheme(owner);
  }, [
    tab,
    canEditLoadedOrganization,
    workspaceDraft.theme,
    previewTheme,
    releaseTheme,
  ]);
  const livePending = workspaceSavePending || maintenance.pending;
  const [notice, setNotice] = useState("");
  const [navigationNotice, setNavigationNotice] = useState("");
  const [pendingLeave, setPendingLeave] = useState<{
    resume: () => void;
  } | null>(null);
  const [error, setError] = useState("");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const scheduleOpener = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const recoveryView = tab === "Backup";
  const pageTitle = tab;
  const liveSourceStatus =
    tab === "Organization"
      ? "Settings save to the organization."
      : tab === "Audit"
        ? "Audit entries are loaded from your organization."
        : recoveryView
          ? "Backup policy and backup history are loaded from your server."
          : "The running version and host runner release observations are loaded from your server. No license is required.";
  const pageDescription =
    tab === "Organization"
      ? "Make this workspace feel like your organization."
      : tab === "Audit"
        ? "See who changed what, then inspect the details."
        : tab === "Updates & licensing"
          ? "Your running version and license status, together in one place."
          : "Manage backup schedules and requests.";

  const workspacePatch = workspaceQuery.data
    ? workspaceSettingsPatch(
        workspaceQuery.data,
        workspaceDraft,
        organizationTheme.theme,
      )
    : null;
  const workspaceDraftDirty = workspacePatch !== null;
  const allDraftsDirty = maintenance.dirty || workspaceDraftDirty;
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
    const destination = new URL(href, window.location.origin);
    const leavesManage =
      destination.pathname !== window.location.pathname ||
      (destination.pathname === "/manage" &&
        destination.searchParams.get("view") === "security");
    if (allDraftsDirty && leavesManage) {
      setPendingLeave({ resume });
      return false;
    }
    return true;
  });

  useEffect(() => {
    if (!legacySecurity) {
      legacyRequested.current = false;
      return;
    }
    if (legacyRequested.current) return;
    legacyRequested.current = true;
    if (
      requestNavigation("/access?view=security", () =>
        router.replace("/access?view=security"),
      )
    )
      router.replace("/access?view=security");
  }, [legacySecurity, requestNavigation, router]);

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
    setProfileServerErrors({});
    maintenance.discardDraft();
    leave?.resume();
  }

  function changeOrganizationTheme(theme: OrganizationTheme) {
    if (
      !workspaceAdmission.current.canEdit ||
      workspaceWriting.current ||
      !workspaceQuery.data ||
      workspaceQuery.isError ||
      profileMismatch
    )
      return;
    setWorkspaceDraft((draft) => {
      const next: WorkspaceSettingsFormDraft = { ...draft, theme };
      if (theme === getCommittedTheme()) delete next.theme;
      return next;
    });
    setNotice("");
    setError("");
  }

  function changeProfileField(key: WorkspaceProfileField, value: string) {
    if (
      !workspaceAdmission.current.canEdit ||
      workspaceWriting.current ||
      !workspaceQuery.data ||
      workspaceQuery.isError ||
      profileMismatch
    )
      return;
    const saved = workspaceSettingsFormFields(workspaceQuery.data);
    setWorkspaceDraft((draft) => {
      const next = { ...draft, [key]: value };
      if ((value.trim() || null) === (saved[key]?.trim() || null))
        delete next[key];
      return next;
    });
    setProfileServerErrors((currentErrors) => {
      const next = { ...currentErrors };
      delete next[key];
      return next;
    });
    setNotice("");
    setError("");
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
      if (!workspaceAdmission.current.canEdit || workspaceWriting.current)
        return;
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
    setNotice("");
    setError("");
  }

  function clearDraft(target: ManageSection) {
    if (livePending) return;
    if (target === "backup") maintenance.discardDraft();
    if (target === "organization") {
      setWorkspaceDraft({});
      setWorkspaceStale(false);
      setWorkspaceRefreshRequired(false);
      setProfileServerErrors({});
    }
    setError("");
    setNotice("Unsaved changes discarded.");
  }

  async function saveSection(target: ManageSection) {
    if (target === "organization") {
      await saveOrganization();
      return;
    }
    if (target === "backup") {
      await maintenance.savePolicy();
      return;
    }
  }

  async function retryWorkspace() {
    if (workspaceAdmission.current.suspended || workspaceWriting.current)
      return;
    const epoch = workspaceEpoch.current;
    const result = await workspaceQuery.refetch();
    if (
      !liveWorkspace.current ||
      epoch !== workspaceEpoch.current ||
      workspaceAdmission.current.suspended
    )
      return;
    if (result.isError || !result.data) {
      setError("The organization settings could not be loaded. Try again.");
      return;
    }
    setError("");
    workspaceNeedsReadback.current = false;
    if (workspaceRefreshRequired) {
      setWorkspaceRefreshRequired(false);
      setWorkspaceStale(true);
    }
  }

  async function saveOrganization() {
    if (
      livePending ||
      workspaceWriting.current ||
      !workspaceAdmission.current.canEdit ||
      workspaceQuery.isError ||
      profileMismatch
    )
      return;
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
    const epoch = ++workspaceEpoch.current;
    const controller = new AbortController();
    workspaceCommand.current = controller;
    workspaceWriting.current = true;
    setWorkspaceSavePending(true);
    const ownsCommand = () =>
      liveWorkspace.current &&
      epoch === workspaceEpoch.current &&
      !controller.signal.aborted &&
      workspaceAdmission.current.canEdit;
    setNotice("");
    setError("");
    setProfileServerErrors({});
    try {
      // Older reads cannot undo this command. An uncertain previous write
      // requires confirmed readback before another explicit write.
      await queryClient.cancelQueries({
        queryKey: manageKeys.workspace(),
        exact: true,
      });
      if (!ownsCommand()) return;
      let workspace = workspaceQuery.data;
      if (workspaceNeedsReadback.current) {
        const refreshed = await workspaceQuery.refetch();
        if (!ownsCommand()) return;
        if (refreshed.isError || !refreshed.data) {
          setWorkspaceRefreshRequired(true);
          setError(
            "The organization settings could not be loaded. Retry before saving.",
          );
          return;
        }
        workspace = refreshed.data;
        workspaceNeedsReadback.current = false;
        setWorkspaceRefreshRequired(false);
      }
      const patch = workspaceSettingsPatch(
        workspace,
        workspaceDraft,
        getCommittedTheme(),
      );
      if (patch) {
        const saved = await updateManageWorkspace(patch, controller.signal);
        if (!ownsCommand()) return;
        confirmTheme(saved.theme);
        afterManageWorkspaceChange(queryClient, saved);
      }
      if (!ownsCommand()) return;
      releaseTheme(workspaceOwner.current);
      setWorkspaceDraft({});
      setWorkspaceStale(false);
      setWorkspaceRefreshRequired(false);
      setNotice("Organization settings saved.");
    } catch (caught) {
      if (!ownsCommand()) return;
      workspaceNeedsReadback.current = true;
      if (isStaleWorkspaceRevision(caught)) {
        setWorkspaceRefreshRequired(true);
        const refreshed = await workspaceQuery.refetch();
        if (!ownsCommand()) return;
        if (refreshed.isError || !refreshed.data) {
          setError(
            "Workspace settings changed, but the latest values could not be loaded. Retry before saving again.",
          );
        } else {
          workspaceNeedsReadback.current = false;
          setWorkspaceRefreshRequired(false);
          setWorkspaceStale(true);
          setError("");
        }
        return;
      }
      if (
        caught instanceof ApiError &&
        (caught.status === 401 || caught.status === 403)
      )
        requestSessionRecheck();
      if (caught instanceof ApiError && caught.status === 422)
        setProfileServerErrors(profileResponseErrors(caught));
      setError(
        caught instanceof ApiError && caught.status === 403
          ? "Only administrators can change these settings. Reload the page to check your access."
          : "The settings could not be saved. Try again.",
      );
    } finally {
      if (ownsCommand()) {
        workspaceWriting.current = false;
        setWorkspaceSavePending(false);
      }
    }
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

  if (legacySecurity && !allDraftsDirty && !livePending)
    return <p role="status">Opening Access Security…</p>;

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
            description="Your unsaved organization or backup changes will be lost."
            onKeep={() => {
              setPendingLeave(null);
              if (legacySecurity) router.replace("/manage?view=organization");
            }}
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
              workspaceLoadFailed={workspaceQuery.isError || profileMismatch}
              profile={
                workspaceFields && !profileMismatch
                  ? { ...workspaceFields, ...workspaceDraft }
                  : undefined
              }
              profileErrors={{ ...errors, ...profileServerErrors }}
              onProfileChange={changeProfileField}
              contactsVisible={contactsVisible}
              onRetryWorkspace={retryWorkspace}
              staleRevision={workspaceStale}
              theme={
                (canEditOrganization ? workspaceDraft.theme : undefined) ??
                organizationTheme.theme
              }
              onThemeChange={changeOrganizationTheme}
              readOnly={!canEditLoadedOrganization}
              editDisabled={
                !canEditLoadedOrganization ||
                !workspaceQuery.data ||
                workspaceQuery.isError
              }
            />
          ) : null}

          {recoveryView ? (
            <section
              aria-label="Backup workspace"
              className="min-w-0 space-y-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Alert role="note" className="min-w-0 flex-1">
                  Backup requests are queued for a configured host runner.
                  Restore and software updates are offline server-operator
                  procedures.
                </Alert>
                {canEditOrganization ? (
                  <Button asChild variant="outline" className="min-h-11">
                    <GuardedWorkspaceLink href="/access?view=security">
                      Sign-in &amp; security
                    </GuardedWorkspaceLink>
                  </Button>
                ) : null}
              </div>
              <div className="min-w-0">
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
              <BackupPanel maintenance={maintenance} />
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
    </div>
  );
}
