"use client";
import { useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  RotateCcw,
} from "lucide-react";
import {
  Suspense,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
import { Alert } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
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
import {
  SettingsChanges,
  type ConfirmState,
  type PreviewState,
} from "./components/panel-ui";
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
      <Dialog open={mfaOpen} onOpenChange={setMfaOpen}>
        <DialogContent
          className="max-w-lg"
          finalFocus={() =>
            mfaOpener.current?.isConnected ? mfaOpener.current : false
          }
        >
          <DialogHeader>
            <DialogTitle>MFA enrollment</DialogTitle>
            <DialogDescription>
              Step {mfaStep + 1} of 3 · This walkthrough does not enroll a
              factor or generate recovery codes.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <Progress
              value={mfaStep + 1}
              max={3}
              aria-label="MFA walkthrough progress"
            />
            {mfaStep === 0 ? (
              <div className="flex flex-col gap-2">
                <h3 className="font-semibold">Choose a factor</h3>
                <p className="text-muted-foreground text-sm">
                  Choose an authenticator app or security key.
                </p>
              </div>
            ) : null}
            {mfaStep === 1 ? (
              <div className="flex flex-col gap-2">
                <h3 className="font-semibold">Verify the factor</h3>
                <p className="text-muted-foreground text-sm">
                  This walkthrough stops before any code or credential is
                  entered.
                </p>
              </div>
            ) : null}
            {mfaStep === 2 ? (
              <div className="flex flex-col gap-2">
                <h3 className="font-semibold">Review recovery options</h3>
                <p className="text-muted-foreground text-sm">
                  Recovery options are stored securely by the account system.
                </p>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setMfaOpen(false)}
            >
              Close
            </Button>
            {mfaStep > 0 ? (
              <Button
                type="button"
                variant="ghost"
                className="min-h-11"
                onClick={() => setMfaStep((step) => step - 1)}
              >
                Back
              </Button>
            ) : null}
            {mfaStep < 2 ? (
              <Button
                type="button"
                className="min-h-11"
                onClick={() => setMfaStep((step) => step + 1)}
              >
                Continue <ChevronRight data-icon="inline-end" />
              </Button>
            ) : (
              <Button
                type="button"
                className="min-h-11"
                onClick={() => setMfaOpen(false)}
              >
                Done <Check data-icon="inline-end" />
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open && !manage.pending) setRenameTarget(null);
        }}
      >
        <DialogContent
          finalFocus={() =>
            renameOpener.current?.isConnected
              ? renameOpener.current
              : headingRef.current
          }
        >
          <DialogHeader>
            <DialogTitle>Rename snapshot</DialogTitle>
            <DialogDescription>
              Give this configuration snapshot a recognizable name.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!renameTarget || !renameValue.trim() || manage.pending)
                return;
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
            }}
          >
            <Field data-invalid={Boolean(renameError)}>
              <FieldLabel htmlFor="rename-snapshot">Snapshot name</FieldLabel>
              <Input
                id="rename-snapshot"
                disabled={manage.pending}
                value={renameValue}
                onChange={(event) => {
                  setRenameValue(event.target.value);
                  setRenameError("");
                }}
                aria-invalid={Boolean(renameError)}
                aria-describedby={
                  renameError ? "rename-snapshot-error" : undefined
                }
                className="min-h-11"
                autoFocus
              />
              <FieldError id="rename-snapshot-error">{renameError}</FieldError>
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={manage.pending}
                onClick={() => setRenameTarget(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="min-h-11"
                disabled={manage.pending || !renameValue.trim()}
              >
                {manage.pending ? "Renaming…" : "Rename snapshot"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={compareTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCompareTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Compare snapshot</DialogTitle>
            <DialogDescription>
              {compareTarget?.name} · saved Manage settings only
            </DialogDescription>
          </DialogHeader>
          {compareTarget ? (
            <SettingsChanges
              differences={manage.snapshotDiff(compareTarget.id)}
            />
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setCompareTarget(null)}
            >
              Close comparison
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{preview?.title ?? "Details"}</DialogTitle>
            <DialogDescription>
              {preview?.description ?? "Details"}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[55dvh] overflow-y-auto py-2">
            {preview?.body}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setPreview(null)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !manage.pending) setConfirm(null);
        }}
      >
        <AlertDialogContent
          finalFocus={() =>
            confirmOpener.current?.isConnected
              ? confirmOpener.current
              : headingRef.current
          }
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.title ?? "Confirm action"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <Alert role="alert" variant="destructive">
              {error}
            </Alert>
          ) : null}
          {manage.pending ? <p role="status">Saving changes…</p> : null}
          {confirm?.body}
          {confirm?.requiresDraftAck ? (
            <Field className="mt-4 flex-row items-center gap-3">
              <Checkbox
                id="discard-affected-drafts"
                disabled={manage.pending}
                checked={draftAcknowledged}
                onCheckedChange={(checked) =>
                  setDraftAcknowledged(checked === true)
                }
              />
              <FieldLabel
                htmlFor="discard-affected-drafts"
                className="font-normal"
              >
                Discard affected unsaved drafts
              </FieldLabel>
            </Field>
          ) : null}
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={manage.pending}
              onClick={() => setConfirm(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              disabled={Boolean(
                manage.pending ||
                (confirm?.requiresDraftAck && !draftAcknowledged),
              )}
              onClick={async () => {
                if (!confirm || manage.pending) return;
                if (await confirm.action()) setConfirm(null);
              }}
            >
              {confirm?.confirmLabel ?? "Confirm"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
