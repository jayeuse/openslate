"use client";
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
import type { ManageSession } from "./state/sessions";
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
  const activeUsers = manage.people.filter((person) => person.active).length;
  const {
    settings,
    snapshots: backups,
    sessions,
    history,
    storageUnavailable,
    hasDrafts: allDraftsDirty,
  } = manage;
  const seatLimit = settings.tier === "Business" ? 100 : 25;
  const tab = requestedTab;
  const [notice, setNotice] = useState("");
  const [navigationNotice, setNavigationNotice] = useState("");
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [draftAcknowledged, setDraftAcknowledged] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [mfaStep, setMfaStep] = useState(0);
  const [mfaOpen, setMfaOpen] = useState(false);
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
  const pageDescription =
    tab === "Organization"
      ? "Make this workspace feel like your organization."
      : tab === "Audit"
        ? "See who changed what, then inspect the details."
        : tab === "Updates & licensing"
          ? "Your workspace version and plan, together in one place."
          : "Review sessions and keep a copy of your workspace settings.";

  const section = sectionForTab(tab);
  const currentFor = (view: ViewTab): ManageSettings => {
    const currentSection = sectionForTab(view);
    return currentSection ? manage.getDraft(currentSection) : settings;
  };
  const current = currentFor(tab);
  const previewSettings = decodeManageSettings(current);
  const dirty = section ? manage.dirty(section) : false;
  const errors = section ? manage.errors(section) : {};
  const updateAvailable = manage.updateAvailable;
  const remoteSessions = sessions.filter((session) => !session.current);
  const localeCode =
    current.locale === "Filipino"
      ? "fil-PH"
      : current.locale === "English (US)"
        ? "en-US"
        : "en-PH";
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
    if (manage.pending) {
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
    manage.change(target, key, value);
    setNotice("");
    setError("");
  }

  function clearDraft(target: ManageSection) {
    if (manage.pending) return;
    manage.discard(target);
    setError("");
    setNotice("Unsaved changes discarded.");
  }

  async function saveSection(target: ManageSection) {
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
        description: `Restore the saved Manage settings from ${snapshot.name}? This replaces committed organization, policy, backup, update and license settings only.`,
        confirmLabel: "Confirm restore",
        requiresDraftAck: allDraftsDirty,
        body: <SettingsChanges differences={differences} />,
        action: async () => {
          const result = await manage.restoreSnapshot(snapshot.id, {
            discardDrafts: allDraftsDirty,
          });
          setError(result.ok ? "" : result.message);
          setNotice(result.ok ? result.message : "");

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
          "Restore organization, security, backup, update and license settings to the bundled defaults. People, sessions, snapshots, activity and other pages remain unchanged.",
        confirmLabel: "Reset Manage configuration",
        requiresDraftAck: allDraftsDirty,
        body: (
          <SettingsChanges
            differences={diffManageSettings(settings, initialManageSettings)}
          />
        ),
        action: async () => {
          const result = await manage.reset({ discardDrafts: allDraftsDirty });
          setError(result.ok ? "" : result.message);
          setNotice(result.ok ? result.message : "");

          return result.ok;
        },
      },
      event,
    );
  }

  function endSession(session: ManageSession, event: MouseEvent<HTMLElement>) {
    requestConfirm(
      {
        title: "End session",
        description: `${session.personName}'s ${session.device} ${session.browser} session in ${session.location} will be removed from this session list. Your current session stays active.`,
        confirmLabel: "Confirm end session",
        action: async () => {
          const result = await manage.revokeSession(session.id);
          setError(result.ok ? "" : result.message);
          setNotice(result.ok ? result.message : "");

          return result.ok;
        },
      },
      event,
    );
  }

  function endAllRemoteSessions(event: MouseEvent<HTMLElement>) {
    requestConfirm(
      {
        title: "End all remote sessions",
        description: `End ${remoteSessions.length} remote sessions? The current session remains active and no account will be signed out.`,
        confirmLabel: "Confirm end all remote sessions",
        action: async () => {
          const result = await manage.revokeAllSessions();
          setError(result.ok ? "" : result.message);
          setNotice(result.ok ? result.message : "");

          return result.ok;
        },
      },
      event,
    );
  }

  function openMfa(event?: MouseEvent<HTMLButtonElement>) {
    setMfaStep(0);
    mfaOpener.current = event?.currentTarget ?? null;
    setMfaOpen(true);
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
        <h1 className="text-2xl font-semibold">Manage</h1>
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
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight sm:text-3xl"
          >
            {pageTitle}
          </h1>
        </div>
        <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
          {pageDescription}
        </p>
        <SampleDataNote className="mt-3">
          {sampleSubject} here are examples.
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
        disabled={manage.pending}
        aria-busy={manage.pending}
        className="min-w-0 space-y-6"
      >
        {manage.pending ? (
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
            />
          ) : null}

          {recoveryView ? (
            <section
              aria-label="Security and recovery workspace"
              className="min-w-0 space-y-5"
            >
              <Alert role="note">
                Preview workspace · Policies and sessions are simulated.
                Snapshots contain saved Manage settings only.
              </Alert>
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="bg-card flex flex-wrap items-center gap-4 rounded-lg border p-5">
                  <LockKeyhole
                    aria-hidden="true"
                    className="text-muted-foreground size-6 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold">Account policy</h2>
                      {manage.dirty("security") ? (
                        <Badge variant="warning">Unsaved changes</Badge>
                      ) : null}
                    </div>
                    <p className="text-muted-foreground mt-1 text-sm">
                      {settings.mfa === "Optional"
                        ? "Optional two-factor"
                        : settings.mfa}{" "}
                      · {settings.timeout} timeout
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
                      <h2 className="font-semibold">Snapshot schedule</h2>
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
                  if (!manage.pending)
                    router.push(
                      `/manage?view=${value === "snapshots" ? "backup" : "security"}`,
                      { scroll: false },
                    );
                }}
              >
                <TabsList aria-label="Security and recovery views">
                  <TabsTrigger value="sessions" className="min-h-11 gap-2 px-4">
                    Sessions <Badge variant="outline">{sessions.length}</Badge>
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
                    sessions={manage.collections.sessions}
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
            <ManageAudit
              entries={manage.collections.activity}
              renderHeader={renderPageHeader}
            />
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
        dismissible={!manage.pending}
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
                disabled={manage.pending}
                onClick={() => setPolicyOpen(false)}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
            <DialogDescription>
              Set account protection preferences. These preview settings are not
              enforced. Closing keeps your unsaved changes.
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
            <SecurityPolicyForm
              form={{
                dirty: manage.dirty("security"),
                current: manage.getDraft("security"),
                errors: manage.errors("security"),
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
      <ManageMfaDialog
        open={mfaOpen}
        step={mfaStep}
        opener={mfaOpener}
        onOpenChange={setMfaOpen}
        onBack={() => setMfaStep((step) => step - 1)}
        onNext={() => setMfaStep((step) => step + 1)}
      />
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
        confirm={confirm}
        pending={manage.pending}
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
