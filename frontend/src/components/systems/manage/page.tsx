"use client";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, CheckCircle2, RotateCcw } from "lucide-react";
import {
  Suspense,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspaceNavigationGuard } from "@/components/workspace-navigation-guard";
import {
  completeCollection,
  pageCollection,
} from "../shared/helpers/sample-collections";
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
import { SecurityPanel } from "./components/security-panel";
import { BackupPanel } from "./components/backup-panel";
import { UpdatesPanel } from "./components/updates-panel";
import { LicensingPanel } from "./components/licensing-panel";

type ViewTab =
  "Organization" | "Security" | "Audit" | "Backup" | "Updates" | "Licensing";

type Snapshot = ManageSnapshot;

const manageTabs: readonly ViewTab[] = [
  "Organization",
  "Security",
  "Audit",
  "Backup",
  "Updates",
  "Licensing",
];

function manageTabFromQuery(value: string | null): ViewTab {
  const normalized = value?.toLowerCase();
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
  const [sessionSearch, setSessionSearch] = useState("");
  const [sessionPage, setSessionPage] = useState(1);
  const [snapshotName, setSnapshotName] = useState("Manual snapshot");
  const [snapshotPage, setSnapshotPage] = useState(1);
  const [renameTarget, setRenameTarget] = useState<Snapshot | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState("");
  const [compareTarget, setCompareTarget] = useState<Snapshot | null>(null);
  const confirmOpener = useRef<HTMLElement | null>(null);
  const renameOpener = useRef<HTMLElement | null>(null);
  const mfaOpener = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

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
  const visibleSessions = manage.collections.sessions.items.filter(
    (session) => {
      const query = sessionSearch.trim().toLowerCase();
      return (
        !query ||
        [
          session.personName,
          session.device,
          session.browser,
          session.location,
        ].some((value) => value.toLowerCase().includes(query))
      );
    },
  );
  const sessionPageCount = Math.max(1, Math.ceil(visibleSessions.length / 2));
  const sessionResult = pageCollection(
    completeCollection(visibleSessions, `manage:sessions:${sessionSearch}`),
    (sessionPage - 1) * 2,
    2,
  );
  const safeSessionPage = sessionResult.offset / sessionResult.limit + 1;
  const visibleSessionRows = sessionResult.items;
  const firstVisibleSession =
    visibleSessions.length === 0 ? 0 : (safeSessionPage - 1) * 2 + 1;
  const lastVisibleSession = Math.min(
    safeSessionPage * 2,
    visibleSessions.length,
  );
  const snapshotPageCount = Math.max(1, Math.ceil(backups.length / 2));
  const snapshotResult = pageCollection(
    manage.collections.snapshots,
    (snapshotPage - 1) * 2,
    2,
  );
  const safeSnapshotPage = snapshotResult.offset / snapshotResult.limit + 1;
  const visibleBackups = snapshotResult.items;
  const firstVisibleSnapshot =
    backups.length === 0 ? 0 : (safeSnapshotPage - 1) * 2 + 1;
  const lastVisibleSnapshot = Math.min(safeSnapshotPage * 2, backups.length);
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
    if (result.ok) setSnapshotPage(1);
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
          if (result.ok) setSessionPage(1);

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
          if (result.ok) setSessionPage(1);

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
    "min-w-0 w-full rounded-[var(--radius)] border-border bg-card md:[&>div]:gap-1 md:[&>div]:p-3";

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

  return (
    <div className="min-w-0 space-y-3 md:[&_button]:min-h-8 md:[&_form]:gap-3 md:[&_input]:min-h-8 md:[&_section>div:first-child>p]:sr-only md:[&_select]:h-8 md:[&_td]:py-1 md:[&_th]:h-8 md:[&_th]:py-1">
      <fieldset
        disabled={manage.pending}
        aria-busy={manage.pending}
        className="contents"
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
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1
                ref={headingRef}
                tabIndex={-1}
                className="text-2xl font-semibold tracking-tight sm:text-3xl"
              >
                Manage
              </h1>
            </div>
            <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
              Configure organization, security, recovery, updates and licensing.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            onClick={requestReset}
          >
            <RotateCcw data-icon="inline-start" /> Reset Manage
          </Button>
        </header>

        {storageUnavailable ? (
          <Alert role="note" variant="warning">
            Browser storage is unavailable. Your latest changes exist in memory
            only and may be lost on reload.
          </Alert>
        ) : null}

        <div className="flex flex-col gap-3">
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

          {tab === "Security" ? (
            <SecurityPanel
              form={{
                dirty,
                saveSection,
                current,
                errors,
                changeSetting,
                clearDraft,
              }}
              panelClass={panelClass}
              sessionList={{
                sessions,
                sessionSearch,
                setSessionSearch,
                setSessionPage,
                remoteSessions,
                visibleSessions,
                visibleSessionRows,
                firstVisibleSession,
                lastVisibleSession,
                sessionPageCount,
                safeSessionPage,
              }}
              actions={{ openMfa, endAllRemoteSessions, endSession }}
            />
          ) : null}

          {tab === "Audit" ? (
            <ManageAudit entries={manage.collections.activity} />
          ) : null}

          {tab === "Backup" ? (
            <BackupPanel
              form={{
                dirty,
                saveSection,
                current,
                errors,
                changeSetting,
                clearDraft,
              }}
              panelClass={panelClass}
              snapshotList={{
                backups,
                snapshotName,
                setSnapshotName,
                visibleBackups,
                setSnapshotPage,
                firstVisibleSnapshot,
                lastVisibleSnapshot,
                snapshotPageCount,
                safeSnapshotPage,
              }}
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
                setPreview,
              }}
              settings={settings}
              retention={retention}
            />
          ) : null}

          {tab === "Updates" ? (
            <UpdatesPanel
              panelClass={panelClass}
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
          ) : null}

          {tab === "Licensing" ? (
            <LicensingPanel
              panelClass={panelClass}
              settings={settings}
              activeUsers={activeUsers}
              seatLimit={seatLimit}
              actions={{ renewLicense, setPreview }}
              licenseForm={{ activateLicense, dummyKey, setDummyKey }}
            />
          ) : null}
        </div>
      </fieldset>
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
