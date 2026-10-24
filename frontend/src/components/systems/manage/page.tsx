"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  GuardedWorkspaceLink,
  useWorkspaceNavigationGuard,
  useWorkspaceNavigationRequest,
} from "@/components/workspace-navigation-guard";
import {
  accessNavigationFor,
  auditDepartmentsFor,
  getWorkspaceNavigation,
  installationOwnerFor,
} from "@/components/workspace-navigation";
import { DiscardChangesDialog } from "../access/components/people-fields";
import { useOrganizationTheme } from "@/components/organization-theme-provider";
import {
  useVerifiedWorkspaceUserId,
  useWorkspaceInteractionSuspended,
} from "@/components/systems/shared/runtime/workspace-identity";
import { authMeOptions } from "../access/adapters/access-queries";
import type { OrganizationTheme } from "@/lib/appearance-preferences";
import { ApiError } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";
import { requestSessionRecheck } from "@/lib/auth-api";
import ManageAudit from "./components/audit";
import ManageJobs from "./components/jobs";
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
  newestManageWorkspace,
  acceptedWorkspaceRevision,
  workspaceLogoOptions,
} from "./adapters/manage-queries";
import {
  getManageWorkspace,
  isStaleWorkspaceRevision,
  isWorkspaceLogoCleanupPartial,
  organizationLocaleTag,
  workspaceSettingsFormFields,
  workspaceSettingsPatch,
  workspaceHasContacts,
  updateManageWorkspace,
  type WorkspaceSettingsFormDraft,
  type WorkspaceSettingsFormFields,
  type WorkspaceProfileField,
  type ManageWorkspaceSettingsPatch,
} from "./adapters/workspace-api";
import {
  validLogoSelection,
  reserveWorkspaceLogo,
  uploadWorkspaceLogo,
  getWorkspaceLogoFile,
  reconcileWorkspaceLogo,
  WorkspaceLogoBindingChanged,
  type WorkspaceLogoFile,
} from "./adapters/workspace-logo-api";
import { BackupPanel } from "./components/backup-panel";
import { useManageMaintenance } from "./state/controller";
import { isManageBackupExportId } from "./adapters/backup-api";
import { UpdatesPanel } from "./components/updates-panel";
import { ManageUnavailable } from "./components/manage-unavailable";

type ViewTab =
  "Organization" | "Audit" | "Backup" | "Jobs" | "Updates & licensing";
type LogoDraft =
  | { kind: "new" | "reservation-unknown"; file: File }
  | { kind: "candidate"; file: File; candidate: WorkspaceLogoFile }
  | { kind: "remove" };
const COMMITTED_READBACK_MESSAGE =
  "Settings saved. Current organization settings could not be loaded. Retry before making another change.";
const readyLogo = (file: WorkspaceLogoFile) =>
  file.state === "ready" && !file.is_deleted;

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
  if (draft.logo !== undefined && draft.logo.trim().length > 3)
    errors.logo = "Use 3 characters or fewer.";
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
  "Jobs",
  "Updates & licensing",
];

/** Each tab's navigation id (`workspace-navigation.ts`). */
const manageSectionIds: Readonly<Record<ViewTab, string>> = {
  Organization: "organization",
  Audit: "audit",
  Backup: "backup",
  Jobs: "jobs",
  "Updates & licensing": "updates",
};

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
  // Decide from the identity first (MD3): a section the account cannot open
  // shows a notice and sends no request to be refused. Jobs keeps its own
  // admission. Reads wait for a loading identity; a failed identity opens the
  // section, where a real refusal still shows the notice.
  const knownIdentity =
    identity.isSuccess && identity.data.id === userId
      ? identity.data
      : undefined;
  const openSections =
    getWorkspaceNavigation(
      "/manage",
      new URLSearchParams(),
      accessNavigationFor(knownIdentity),
      true,
      installationOwnerFor(knownIdentity),
      (auditDepartmentsFor(knownIdentity)?.length ?? 0) > 0,
    ).find((group) => group.id === "manage")?.items ?? [];
  const sectionDecided =
    requestedTab === "Organization" ||
    requestedTab === "Jobs" ||
    knownIdentity !== undefined ||
    identity.isError;
  const sectionClosed =
    knownIdentity !== undefined &&
    !openSections.some((item) => item.id === manageSectionIds[requestedTab]);
  const sectionOpen = sectionDecided && !sectionClosed;
  const maintenance = useManageMaintenance({
    recoveryActive: requestedTab === "Backup" && sectionOpen,
    historyActive: requestedTab === "Backup" && sectionOpen,
    versionActive: requestedTab === "Updates & licensing" && sectionOpen,
    exportId:
      searchParams.get("export") !== null &&
      isManageBackupExportId(searchParams.get("export")!)
        ? searchParams.get("export")!.toLowerCase()
        : null,
    invalidExportId:
      searchParams.get("export") !== null &&
      !isManageBackupExportId(searchParams.get("export")!),
    exportAllowed: canEditOrganization,
    exportActorId: userId,
    onExportChange: (id) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("view", "backup");
      params.set("export", id);
      router.replace(("/manage?" + params.toString()) as Route, {
        scroll: false,
      });
    },
  });
  const tab = requestedTab;
  const [workspaceDraft, setWorkspaceDraft] =
    useState<WorkspaceSettingsFormDraft>({});
  const [workspaceStale, setWorkspaceStale] = useState(false);
  const [workspaceRefreshRequired, setWorkspaceRefreshRequired] =
    useState(false);
  const [workspaceSavePending, setWorkspaceSavePending] = useState(false);
  const [logoDraft, setLogoDraft] = useState<LogoDraft | null>(null);
  const [logoError, setLogoError] = useState("");
  const [logoNotice, setLogoNotice] = useState("");
  const [logoCleanupId, setLogoCleanupId] = useState<string | null>(null);
  const [committedReadbackRequired, setCommittedReadbackRequired] =
    useState(false);
  const acknowledgedRevision = useRef<number | null>(null);
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
      const workspace = newestManageWorkspace(
        queryClient,
        await getManageWorkspace(signal),
      );
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
  // The reader view (MD5): a verified account that cannot change the loaded
  // settings. Its body and its meta line both follow this one decision; an
  // unverified or loading role keeps the editor, disabled.
  const organizationReader =
    verifiedOrganizationRole !== null && !canEditLoadedOrganization;
  const contactsVisible =
    (verifiedOrganizationRole === "admin" ||
      verifiedOrganizationRole === "member") &&
    workspaceQuery.data !== undefined &&
    workspaceHasContacts(workspaceQuery.data);
  const savedLogoQuery = useQuery({
    ...workspaceLogoOptions(workspaceQuery.data?.logo_file_id ?? ""),
    enabled:
      tab === "Organization" &&
      verifiedOrganizationRole !== null &&
      !profileMismatch &&
      Boolean(workspaceQuery.data?.logo_file_id),
  });
  useEffect(() => {
    if (
      savedLogoQuery.error instanceof WorkspaceLogoBindingChanged &&
      !suspended &&
      !workspaceWriting.current
    )
      void workspaceQuery.refetch();
  }, [savedLogoQuery.error, suspended, workspaceQuery.refetch]);
  const logoReadDenied =
    savedLogoQuery.error instanceof ApiError &&
    (savedLogoQuery.error.status === 401 ||
      savedLogoQuery.error.status === 403);
  const logoDenialReported = useRef(false);
  useEffect(() => {
    if (!logoReadDenied) logoDenialReported.current = false;
    else if (!suspended && !logoDenialReported.current) {
      logoDenialReported.current = true;
      requestSessionRecheck();
    }
  }, [logoReadDenied, suspended]);
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
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const recoveryView = tab === "Backup";
  const pageTitle = tab;
  // One meta line under the title (MD2): what the section is for, or the one
  // fact a reader needs. Where data comes from is not repeated.
  const pageDescription =
    tab === "Organization"
      ? organizationReader
        ? "Only an administrator can change these settings."
        : "Set your organization’s name, region, and look."
      : tab === "Jobs"
        ? "See scheduled work, attempts, and problems."
        : tab === "Audit"
          ? "See who changed what, then inspect the details."
          : tab === "Updates & licensing"
            ? "The person who runs your server installs updates."
            : "The person who runs your server restores backups.";
  // A real owner-only refusal (a stale identity) lands on the same notice.
  const ownerRefused =
    (tab === "Backup" || tab === "Updates & licensing") &&
    maintenance.ownerRefused;
  // Jobs reads need a verified administrator: any other known role gets the
  // notice; an identity that could not be read says so, with a Retry.
  const jobsRefused =
    tab === "Jobs" &&
    knownIdentity !== undefined &&
    knownIdentity.role !== "admin";
  const jobsAccessUnchecked = tab === "Jobs" && identity.isError;
  const unavailable =
    sectionClosed || ownerRefused || jobsRefused || jobsAccessUnchecked;
  // A refusal inside Backup or Updates names the installation owner; the
  // meta line beside it would name another person, so it hides (Phase 8).
  const sectionRefused =
    (tab === "Backup" &&
      (maintenance.policyRefused || maintenance.historyRefused)) ||
    (tab === "Updates & licensing" && maintenance.versionRefused);
  const sectionShown = sectionOpen && !unavailable;
  const organizationErrorInFooter =
    sectionShown && tab === "Organization" && !organizationReader;

  const workspacePatch = workspaceQuery.data
    ? workspaceSettingsPatch(
        workspaceQuery.data,
        workspaceDraft,
        organizationTheme.theme,
      )
    : null;
  const workspaceDraftDirty = workspacePatch !== null || logoDraft !== null;
  const allDraftsDirty =
    maintenance.dirty || (workspaceDraftDirty && !committedReadbackRequired);
  const workspaceFields = workspaceQuery.data
    ? workspaceSettingsFormFields(workspaceQuery.data)
    : null;
  const savedSettings: ManageSettings = {
    ...initialManageSettings,
    ...workspaceFields,
  };
  // A reader sees the saved settings, never a draft an editor role left (MD5).
  const current: ManageSettings = organizationReader
    ? savedSettings
    : { ...savedSettings, ...workspaceDraft };
  const dirty = workspaceDraftDirty && !committedReadbackRequired;
  // Each changed field, plus a logo choice, is one unsaved change.
  const unsavedCount = dirty
    ? Math.max(
        1,
        Object.keys(workspacePatch ?? {}).filter((key) => key !== "revision")
          .length + (logoDraft ? 1 : 0),
      )
    : 0;
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
    setLogoDraft(null);
    setLogoError("");
    setLogoNotice("");
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
      setLogoDraft(null);
      setLogoError("");
      setLogoNotice("");
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
    if (committedReadbackRequired) {
      const current = result.data;
      if (
        current.revision <
        Math.max(
          acknowledgedRevision.current ?? 0,
          acceptedWorkspaceRevision(queryClient),
        )
      ) {
        setError(
          "The current organization settings could not be loaded. Try again.",
        );
        return;
      }
      afterManageWorkspaceChange(queryClient, current);
      confirmTheme(current.theme);
      releaseTheme(workspaceOwner.current);
      setWorkspaceDraft({});
      setLogoDraft(null);
      acknowledgedRevision.current = null;
      setCommittedReadbackRequired(false);
      setWorkspaceStale(false);
      setError("");
    }
    workspaceNeedsReadback.current = false;
    if (workspaceRefreshRequired && !committedReadbackRequired) {
      setWorkspaceRefreshRequired(false);
      setWorkspaceStale(true);
    }
  }

  function chooseLogo(file: File) {
    if (
      !workspaceAdmission.current.canEdit ||
      workspaceWriting.current ||
      committedReadbackRequired
    )
      return;
    if (!validLogoSelection(file)) {
      setLogoError("Choose a PNG or JPEG between 1 byte and 2 MB.");
      return;
    }
    setLogoDraft({ kind: "new", file });
    setLogoError("");
    setLogoNotice("");
    setNotice("");
  }

  function removeLogo() {
    if (
      !workspaceAdmission.current.canEdit ||
      workspaceWriting.current ||
      committedReadbackRequired
    )
      return;
    setLogoDraft(workspaceQuery.data?.logo_file_id ? { kind: "remove" } : null);
    setLogoError("");
    setLogoNotice("");
    setNotice("");
  }

  async function prepareLogo(
    owns: () => boolean,
    signal: AbortSignal,
  ): Promise<{ kind: "ready"; id?: string | null } | { kind: "stopped" }> {
    const selection = logoDraft;
    if (!selection) return { kind: "ready" };
    if (selection.kind === "remove") return { kind: "ready", id: null };
    if (selection.kind === "reservation-unknown") {
      setLogoError(
        "The logo upload could not be confirmed. Choose the logo again.",
      );
      return { kind: "stopped" };
    }
    let candidate = selection.kind === "candidate" ? selection.candidate : null;
    if (!candidate) {
      try {
        candidate = await reserveWorkspaceLogo(selection.file, signal);
      } catch (caught) {
        if (!owns()) return { kind: "stopped" };
        if (!(
          caught instanceof ApiError &&
          caught.status >= 400 &&
          caught.status < 500
        ))
          setLogoDraft({ kind: "reservation-unknown", file: selection.file });
        if (
          caught instanceof ApiError &&
          (caught.status === 401 || caught.status === 403)
        )
          requestSessionRecheck();
        setLogoError(
          "The logo upload could not be confirmed. Choose the logo again.",
        );
        return { kind: "stopped" };
      }
      if (!owns()) return { kind: "stopped" };
      setLogoDraft({ kind: "candidate", file: selection.file, candidate });
      try {
        candidate = await uploadWorkspaceLogo(
          candidate.id,
          selection.file,
          signal,
        );
      } catch (caught) {
        if (!owns()) return { kind: "stopped" };
        if (
          caught instanceof ApiError &&
          (caught.status === 401 || caught.status === 403)
        )
          requestSessionRecheck();
        try {
          candidate = await getWorkspaceLogoFile(candidate.id, signal);
        } catch {
          /* Retain the exact reservation; a fresh check is explicit. */
        }
        if (!owns()) return { kind: "stopped" };
        setLogoDraft({ kind: "candidate", file: selection.file, candidate });
        setLogoError(
          "The logo upload could not be confirmed. Check upload before saving.",
        );
        return { kind: "stopped" };
      }
    } else {
      try {
        candidate = await getWorkspaceLogoFile(candidate.id, signal);
      } catch (caught) {
        if (!owns()) return { kind: "stopped" };
        setLogoError(
          apiErrorMessage(
            caught,
            "The logo upload could not be checked. Try again.",
          ),
        );
        if (
          caught instanceof ApiError &&
          (caught.status === 401 || caught.status === 403)
        )
          requestSessionRecheck();
        return { kind: "stopped" };
      }
    }
    if (!owns()) return { kind: "stopped" };
    setLogoDraft({ kind: "candidate", file: selection.file, candidate });
    if (!readyLogo(candidate)) {
      setLogoError("The logo upload is not ready. Check upload before saving.");
      return { kind: "stopped" };
    }
    setLogoError("");
    return { kind: "ready", id: candidate.id };
  }

  async function recoverLogo(fileId: string, operation: "upload" | "cleanup") {
    if (!workspaceAdmission.current.canEdit || workspaceWriting.current) return;
    const epoch = ++workspaceEpoch.current;
    const controller = new AbortController();
    workspaceCommand.current = controller;
    workspaceWriting.current = true;
    setWorkspaceSavePending(true);
    const owns = () =>
      liveWorkspace.current &&
      epoch === workspaceEpoch.current &&
      !controller.signal.aborted &&
      workspaceAdmission.current.canEdit;
    setLogoError("");
    try {
      let file =
        operation === "upload"
          ? await getWorkspaceLogoFile(fileId, controller.signal)
          : null;
      if (!owns()) return;
      if (!file || file.state === "uploading")
        file = await reconcileWorkspaceLogo(fileId, controller.signal);
      if (!owns()) return;
      if (operation === "upload") {
        const confirmed = file;
        setLogoDraft((draft) =>
          draft?.kind === "candidate" && draft.candidate.id === fileId
            ? { ...draft, candidate: confirmed }
            : draft,
        );
        if (readyLogo(file))
          setLogoNotice("Logo upload confirmed. Save settings to use it.");
        else
          setLogoError(
            "This upload is not ready. Choose the logo again or discard this change.",
          );
      } else if (file.state === "purged") {
        if (logoCleanupId === fileId) setLogoCleanupId(null);
        setLogoNotice("Previous logo cleanup completed.");
      } else
        setLogoError(
          "Cleanup is not finished. Try again when the current task ends.",
        );
    } catch (caught) {
      if (!owns()) return;
      const purgeDisabled =
        caught instanceof ApiError &&
        caught.status === 403 &&
        caught.code === "purge_disabled";
      setLogoError(
        purgeDisabled
          ? "Permanent delete is turned off on this server."
          : apiErrorMessage(
              caught,
              "The logo could not be checked. Try again.",
            ),
      );
      if (
        caught instanceof ApiError &&
        (caught.status === 401 || (caught.status === 403 && !purgeDisabled))
      )
        requestSessionRecheck();
    } finally {
      if (owns()) {
        workspaceWriting.current = false;
        setWorkspaceSavePending(false);
      }
    }
  }

  async function saveOrganization() {
    if (
      livePending ||
      workspaceWriting.current ||
      committedReadbackRequired ||
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
    let attemptedPatch: ManageWorkspaceSettingsPatch | null = null;
    let capturedOldLogo: string | null = null;
    let knownCommitted = false;
    setNotice("");
    setError("");
    setLogoError("");
    setLogoNotice("");
    setProfileServerErrors({});
    const readbackNeeded = () => {
      releaseTheme(workspaceOwner.current);
      workspaceNeedsReadback.current = true;
      setWorkspaceRefreshRequired(true);
      setCommittedReadbackRequired(true);
      // A partial failure, beside Save in the footer, not a success notice.
      setNotice("");
      setError(COMMITTED_READBACK_MESSAGE);
    };
    const adoptCurrent = (
      current: ReturnType<typeof newestManageWorkspace>,
    ) => {
      if (
        current.revision < acceptedWorkspaceRevision(queryClient) ||
        !afterManageWorkspaceChange(queryClient, current)
      )
        return false;
      confirmTheme(current.theme);
      return true;
    };
    const finishDraft = () => {
      releaseTheme(workspaceOwner.current);
      setWorkspaceDraft({});
      setLogoDraft(null);
      setWorkspaceStale(false);
      setWorkspaceRefreshRequired(false);
      setCommittedReadbackRequired(false);
      acknowledgedRevision.current = null;
      workspaceNeedsReadback.current = false;
    };
    try {
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
      const prepared = await prepareLogo(ownsCommand, controller.signal);
      if (!ownsCommand() || prepared.kind === "stopped") return;
      let patch = workspaceSettingsPatch(
        workspace,
        workspaceDraft,
        getCommittedTheme(),
      );
      if (prepared.id !== undefined && prepared.id !== workspace.logo_file_id)
        patch = {
          ...patch,
          revision: workspace.revision,
          logo_file_id: prepared.id,
        };
      if (patch) {
        attemptedPatch = patch;
        capturedOldLogo = workspace.logo_file_id;
        // A logo response is a detached acknowledgement of this admitted write.
        // Only a fresh authorized read may become the current form/brand/theme.
        const receipt = await updateManageWorkspace(patch, controller.signal);
        if (!ownsCommand()) return;
        knownCommitted = true;
        acknowledgedRevision.current = receipt.revision;
        let current = receipt;
        if (
          "logo_file_id" in patch ||
          receipt.revision < acceptedWorkspaceRevision(queryClient)
        ) {
          const read = newestManageWorkspace(
            queryClient,
            await getManageWorkspace(controller.signal),
          );
          if (!ownsCommand()) return;
          if (!workspaceHasContacts(read)) {
            afterManageWorkspaceChange(queryClient, read);
            readbackNeeded();
            requestSessionRecheck();
            return;
          }
          current = read;
        }
        if (!adoptCurrent(current)) {
          readbackNeeded();
          return;
        }
      }
      if (!ownsCommand()) return;
      // The footer chip turning "Saved" is the confirmation (Phase 8).
      finishDraft();
    } catch (caught) {
      if (!ownsCommand()) return;
      workspaceNeedsReadback.current = attemptedPatch !== null;
      if (isStaleWorkspaceRevision(caught)) {
        setWorkspaceRefreshRequired(true);
        const refreshed = await workspaceQuery.refetch();
        if (!ownsCommand()) return;
        if (refreshed.isError || !refreshed.data)
          setError(
            "Organization settings changed, but the latest values could not be loaded. Retry before saving again.",
          );
        else {
          workspaceNeedsReadback.current = false;
          setWorkspaceRefreshRequired(false);
          setWorkspaceStale(true);
          setError("");
        }
        return;
      }
      const partial = isWorkspaceLogoCleanupPartial(caught);
      if (partial) {
        knownCommitted = true;
        acknowledgedRevision.current = (attemptedPatch?.revision ?? 0) + 1;
        setLogoCleanupId(capturedOldLogo);
      }
      const denied =
        caught instanceof ApiError &&
        (caught.status === 401 || caught.status === 403);
      if (knownCommitted && !partial) {
        readbackNeeded();
        if (denied) requestSessionRecheck();
        return;
      }
      if (
        !denied &&
        attemptedPatch &&
        (knownCommitted || "logo_file_id" in attemptedPatch)
      ) {
        try {
          const current = newestManageWorkspace(
            queryClient,
            await getManageWorkspace(controller.signal),
          );
          if (!ownsCommand()) return;
          if (!workspaceHasContacts(current)) {
            afterManageWorkspaceChange(queryClient, current);
            if (knownCommitted) readbackNeeded();
            requestSessionRecheck();
            return;
          }
          const values = new Map(Object.entries(current));
          const matches =
            current.revision > attemptedPatch.revision &&
            Object.entries(attemptedPatch).every(
              ([key, value]) => key === "revision" || values.get(key) === value,
            );
          if (adoptCurrent(current) && (knownCommitted || matches)) {
            finishDraft();
            // A lost response needs old-File readback; a confirmed 200 already
            // guarantees cleanup. No public origin field grants client authority.
            if (capturedOldLogo && (partial || !knownCommitted)) {
              try {
                const old = await getWorkspaceLogoFile(
                  capturedOldLogo,
                  controller.signal,
                );
                if (!ownsCommand()) return;
                if (old.state === "purged") {
                  setLogoCleanupId(null);
                  if (partial)
                    setLogoNotice("Previous logo cleanup completed.");
                } else {
                  setLogoCleanupId(capturedOldLogo);
                }
              } catch (readError) {
                if (!ownsCommand()) return;
                setLogoCleanupId(capturedOldLogo);
                if (
                  readError instanceof ApiError &&
                  (readError.status === 401 || readError.status === 403)
                )
                  requestSessionRecheck();
              }
            }
            return;
          }
        } catch (readError) {
          if (!ownsCommand()) return;
          if (
            readError instanceof ApiError &&
            (readError.status === 401 || readError.status === 403)
          )
            requestSessionRecheck();
        }
      }
      if (knownCommitted) {
        readbackNeeded();
        if (denied) requestSessionRecheck();
        return;
      }
      if (denied) requestSessionRecheck();
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

  const renderPageHeader = (actions?: ReactNode) => (
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3">
      {/* A 16rem basis lets the actions wrap under the title on a phone
          instead of squeezing the meta line into a column. */}
      <div className="min-w-0 flex-1 basis-64">
        <h1
          ref={headingRef}
          data-slot="page-title"
          tabIndex={-1}
          className="text-2xl font-semibold tracking-tight sm:text-3xl"
        >
          {pageTitle}
        </h1>
        {unavailable || sectionRefused || !sectionDecided ? null : (
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
            {pageDescription}
          </p>
        )}
      </div>
      {/* Row 2 on a phone (MD19): the section's actions in one row that
          never scrolls sideways; beside the title from 640px. */}
      {actions && !unavailable ? (
        <div
          data-slot="page-actions"
          className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:shrink-0"
        >
          {actions}
        </div>
      ) : null}
    </header>
  );

  if (legacySecurity && !allDraftsDirty && !livePending)
    return <p role="status">Opening Access Security…</p>;

  return (
    // `manage-ui` scopes the still-page chain and `slim-ui` the slim controls
    // (MD1); dialogs and popups carry `slim-ui` themselves (portals).
    <div className="manage-ui slim-ui min-w-0 space-y-6 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
      {/* A Backup command locks the section; an Organization save locks
          only its editor and keeps focus on Save (Phase 8). */}
      <fieldset
        disabled={maintenance.pending}
        aria-busy={maintenance.pending}
        className="manage-fill min-w-0 space-y-6"
      >
        {tab !== "Audit" || !sectionShown
          ? renderPageHeader(
              tab === "Backup" && canEditOrganization ? (
                // Quiet, with an icon so it reads as an action; on a phone
                // it sits near the title edge with room for its focus ring.
                <Button
                  asChild
                  variant="ghost"
                  className="min-h-11 max-sm:-ml-2 max-sm:px-2"
                >
                  <GuardedWorkspaceLink href="/access?view=security">
                    <ShieldCheck aria-hidden="true" className="size-4" />
                    Access security
                  </GuardedWorkspaceLink>
                </Button>
              ) : null,
            )
          : null}

        <div className="manage-fill flex flex-col gap-6">
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
          {/* The Organization editor shows its errors in its pinned footer,
              beside Save (MD4); a reader and other sections show them here. */}
          {error && !organizationErrorInFooter ? (
            <Alert
              role="alert"
              variant="destructive"
              className="flex items-center gap-2"
            >
              <AlertTriangle aria-hidden="true" />
              {error}
            </Alert>
          ) : null}
          {unavailable ? (
            <ManageUnavailable
              section={tab}
              home={openSections[0] ?? null}
              {...(jobsAccessUnchecked
                ? {
                    message: "Your access could not be checked.",
                    onRetry: () => void identity.refetch(),
                    retrying: identity.isFetching,
                  }
                : {})}
            />
          ) : !sectionDecided ? (
            <div role="status" className="flex flex-col gap-4">
              <span className="sr-only">Checking your access…</span>
              <Skeleton className="h-48 w-full" />
            </div>
          ) : null}
          {sectionShown && tab === "Organization" ? (
            <OrganizationPanel
              form={{
                saveSection,
                current,
                changeSetting,
                errors,
                clearDraft,
              }}
              unsavedCount={unsavedCount}
              checkingSaved={committedReadbackRequired && workspaceDraftDirty}
              saveError={organizationErrorInFooter ? error : ""}
              regionalDate={regionalDate}
              regionalCurrency={regionalCurrency}
              workspace={workspaceQuery.data}
              workspaceLoading={workspaceQuery.isPending}
              workspaceLoadFailed={
                workspaceQuery.isError ||
                profileMismatch ||
                committedReadbackRequired
              }
              logo={{
                blob:
                  verifiedOrganizationRole === null || logoReadDenied
                    ? undefined
                    : logoDraft?.kind === "remove"
                      ? null
                      : canEditLoadedOrganization &&
                          logoDraft &&
                          "file" in logoDraft
                        ? logoDraft.file
                        : savedLogoQuery.isError
                          ? undefined
                          : savedLogoQuery.data,
                concealed: verifiedOrganizationRole === null || logoReadDenied,
                selection:
                  logoDraft?.kind === "remove"
                    ? { kind: "removed" }
                    : logoDraft &&
                        "file" in logoDraft &&
                        canEditLoadedOrganization
                      ? { kind: "selected", name: logoDraft.file.name }
                      : { kind: "none" },
                error: logoError,
                notice: logoNotice,
                cleanupPending: logoCleanupId !== null,
                onSelect: chooseLogo,
                onRemove: removeLogo,
                onCheckUpload:
                  logoDraft?.kind === "candidate" &&
                  (!readyLogo(logoDraft.candidate) || Boolean(logoError))
                    ? () => void recoverLogo(logoDraft.candidate.id, "upload")
                    : undefined,
                onRetryCleanup: logoCleanupId
                  ? () => void recoverLogo(logoCleanupId, "cleanup")
                  : undefined,
                onRetryImage:
                  savedLogoQuery.isError && !suspended && !logoReadDenied
                    ? () => void savedLogoQuery.refetch()
                    : undefined,
              }}
              profile={
                workspaceFields && !profileMismatch
                  ? organizationReader
                    ? workspaceFields
                    : { ...workspaceFields, ...workspaceDraft }
                  : undefined
              }
              profileErrors={{ ...errors, ...profileServerErrors }}
              onProfileChange={changeProfileField}
              contactsVisible={contactsVisible}
              relatedAreasVisible={accessNavigationFor(knownIdentity) === "all"}
              onRetryWorkspace={retryWorkspace}
              staleRevision={workspaceStale}
              theme={
                organizationReader
                  ? (workspaceQuery.data?.theme ?? organizationTheme.theme)
                  : ((canEditOrganization ? workspaceDraft.theme : undefined) ??
                    organizationTheme.theme)
              }
              onThemeChange={changeOrganizationTheme}
              readOnly={organizationReader}
              saving={workspaceSavePending}
              editDisabled={
                workspaceSavePending ||
                !canEditLoadedOrganization ||
                !workspaceQuery.data ||
                workspaceQuery.isError ||
                committedReadbackRequired
              }
            />
          ) : null}

          {sectionShown && recoveryView ? (
            <section
              aria-label="Backup workspace"
              className="manage-scroll min-w-0"
            >
              <BackupPanel
                maintenance={maintenance}
                onOpenSchedule={() => setError("")}
              />
            </section>
          ) : null}

          {sectionShown && tab === "Jobs" ? (
            <div className="manage-fill min-w-0">
              <ManageJobs admitted={verifiedOrganizationRole === "admin"} />
            </div>
          ) : null}

          {sectionShown && tab === "Audit" ? (
            <ManageAudit
              renderHeader={renderPageHeader}
              securityEventsAdmitted={verifiedOrganizationRole === "admin"}
              // A member reads the departments they manage (MD12); a failed
              // identity reads unscoped, and the server's refusal decides.
              managedDepartments={
                knownIdentity?.role === "member"
                  ? (auditDepartmentsFor(knownIdentity) ?? [])
                  : null
              }
              securityEventsSelected={
                searchParams.get("audit") === "security-events"
              }
              onSecurityEventsSelected={(selected) => {
                const params = new URLSearchParams(searchParams.toString());
                params.set("view", "audit");
                if (selected) params.set("audit", "security-events");
                else params.delete("audit");
                router.replace(("/manage?" + params.toString()) as Route, {
                  scroll: false,
                });
              }}
            />
          ) : null}

          {sectionShown && tab === "Updates & licensing" ? (
            <div className="manage-scroll min-w-0">
              <UpdatesPanel maintenance={maintenance} />
            </div>
          ) : null}
        </div>
      </fieldset>
    </div>
  );
}
