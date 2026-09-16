"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Download,
  FileSearch,
  HardDrive,
  History,
  KeyRound,
  Monitor,
  RotateCcw,
  Search,
  Smartphone,
  Sparkles,
  Trash2,
  UsersRound,
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
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectItem } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSampleState } from "@/components/sample/sample-state";
import { initialPeople, type Person } from "../access/model";
import ManageAudit from "./audit";
import {
  decodeManageSettings,
  diffManageSettings,
  downloadManageSnapshot,
  initialManageSettings,
  useManageController,
  type ManageSection,
  type ManageSettings,
  type ManageSnapshot,
  type ManageSnapshotDiff,
} from "./state";
import type { ManageSession } from "./sessions";

type ViewTab =
  "Organization" | "Security" | "Audit" | "Backup" | "Updates" | "Licensing";

type Snapshot = ManageSnapshot;

type ConfirmState = {
  title: string;
  description: string;
  confirmLabel: string;
  requiresDraftAck?: boolean;
  body?: ReactNode;
  action: () => void;
};
type PreviewState = {
  title: string;
  description?: string;
  body?: ReactNode;
};

const manageTabs: readonly ViewTab[] = [
  "Organization",
  "Security",
  "Audit",
  "Backup",
  "Updates",
  "Licensing",
];

function tabId(tab: ViewTab): string {
  return tab.toLowerCase();
}

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

function SettingSelect({
  id,
  label,
  value,
  options,
  optionLabels,
  onChange,
  description,
  error,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly string[];
  optionLabels?: Readonly<Record<string, string>>;
  onChange: (value: string) => void;
  description?: string;
  error?: string;
}) {
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;

  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        id={id}
        value={options.includes(value) ? value : ""}
        placeholder={
          options.includes(value) ? undefined : "Choose a valid option"
        }
        onValueChange={onChange}
        aria-describedby={
          [descriptionId, errorId].filter(Boolean).join(" ") || undefined
        }
        aria-invalid={Boolean(error)}
        className="min-h-11"
      >
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {optionLabels?.[option] ?? option}
          </SelectItem>
        ))}
      </Select>
      {description ? (
        <FieldDescription id={descriptionId} className="md:sr-only">
          {description}
        </FieldDescription>
      ) : null}
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}

function SettingInput({
  id,
  label,
  value,
  onChange,
  description,
  error,
  required = false,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  description?: string;
  error?: string | null;
  required?: boolean;
  placeholder?: string;
}) {
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ");

  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={value}
        required={required}
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy || undefined}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-11"
      />
      {description ? (
        <FieldDescription id={descriptionId} className="md:sr-only">
          {description}
        </FieldDescription>
      ) : null}
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}

function SettingActions({
  dirty,
  onDiscard,
  onSave,
}: {
  dirty: boolean;
  onDiscard: () => void;
  onSave: () => void;
}) {
  return (
    <CardFooter className="flex flex-wrap justify-end gap-2 px-0 pt-4">
      {dirty ? (
        <Badge variant="warning">Unsaved changes</Badge>
      ) : (
        <Badge variant="outline">Saved</Badge>
      )}
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        onClick={onDiscard}
        disabled={!dirty}
      >
        Discard changes
      </Button>
      <Button type="button" className="min-h-11" onClick={onSave}>
        Save settings
      </Button>
    </CardFooter>
  );
}

function SectionHeading({
  title,
  description,
  dirty,
}: {
  title: string;
  description: string;
  dirty?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        <p className="text-muted-foreground mt-1 max-w-3xl text-sm md:sr-only">
          {description}
        </p>
      </div>
      {dirty ? <Badge variant="warning">Unsaved</Badge> : null}
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-3 last:border-0">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="text-right text-sm font-medium">{value}</dd>
    </div>
  );
}

function SettingsChanges({
  differences,
}: {
  differences: ManageSnapshotDiff[];
}) {
  const [page, setPage] = useState(1);
  if (!differences.length)
    return (
      <p className="text-muted-foreground py-3 text-sm">
        No saved settings will change.
      </p>
    );
  const pageCount = Math.ceil(differences.length / 5);
  const safePage = Math.min(page, pageCount);
  const visibleDifferences = differences.slice(
    (safePage - 1) * 5,
    safePage * 5,
  );
  return (
    <div className="mt-3 space-y-3">
      <Table aria-label="Settings changes">
        <TableHeader>
          <TableRow>
            <TableHead>Setting</TableHead>
            <TableHead>Current value</TableHead>
            <TableHead>Replacement</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visibleDifferences.map((difference) => (
            <TableRow key={difference.key}>
              <TableCell className="whitespace-normal">
                {difference.label}
              </TableCell>
              <TableCell className="wrap-anywhere whitespace-normal">
                {difference.before || "Not set"}
              </TableCell>
              <TableCell className="wrap-anywhere whitespace-normal">
                {difference.after || "Not set"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {pageCount > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <p className="text-muted-foreground text-sm">
            Page {safePage} of {pageCount}
          </p>
          <Pagination
            aria-label="Settings change pages"
            className="mx-0 w-auto justify-start sm:justify-end"
          >
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  href="#settings-changes"
                  aria-disabled={safePage === 1}
                  tabIndex={safePage === 1 ? -1 : undefined}
                  className={
                    safePage === 1
                      ? "pointer-events-none opacity-50"
                      : undefined
                  }
                  onClick={(event) => {
                    event.preventDefault();
                    if (safePage > 1) setPage(safePage - 1);
                  }}
                />
              </PaginationItem>
              <PaginationItem>
                <PaginationLink
                  href="#settings-changes"
                  size="default"
                  isActive
                  aria-label={`Settings change page ${safePage} of ${pageCount}`}
                  onClick={(event) => event.preventDefault()}
                >
                  {safePage} / {pageCount}
                </PaginationLink>
              </PaginationItem>
              <PaginationItem>
                <PaginationNext
                  href="#settings-changes"
                  aria-disabled={safePage === pageCount}
                  tabIndex={safePage === pageCount ? -1 : undefined}
                  className={
                    safePage === pageCount
                      ? "pointer-events-none opacity-50"
                      : undefined
                  }
                  onClick={(event) => {
                    event.preventDefault();
                    if (safePage < pageCount) setPage(safePage + 1);
                  }}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      ) : null}
    </div>
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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestedTab = manageTabFromQuery(searchParams.get("view"));
  const [people] = useSampleState<Person[]>("access-people", initialPeople);
  const activeUsers = people.filter((person) => person.active).length;
  const manage = useManageController();
  const {
    settings,
    snapshots: backups,
    sessions,
    history,
    activity,
    storageUnavailable,
    hasDrafts: allDraftsDirty,
  } = manage;
  const seatLimit = settings.tier === "Business" ? 100 : 25;
  const tab = requestedTab;
  const [notice, setNotice] = useState("");
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
  const visibleSessions = sessions.filter((session) => {
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
  });
  const sessionPageCount = Math.max(1, Math.ceil(visibleSessions.length / 2));
  const safeSessionPage = Math.min(sessionPage, sessionPageCount);
  const visibleSessionRows = visibleSessions.slice(
    (safeSessionPage - 1) * 2,
    safeSessionPage * 2,
  );
  const firstVisibleSession =
    visibleSessions.length === 0 ? 0 : (safeSessionPage - 1) * 2 + 1;
  const lastVisibleSession = Math.min(
    safeSessionPage * 2,
    visibleSessions.length,
  );
  const snapshotPageCount = Math.max(1, Math.ceil(backups.length / 2));
  const safeSnapshotPage = Math.min(snapshotPage, snapshotPageCount);
  const visibleBackups = backups.slice(
    (safeSnapshotPage - 1) * 2,
    safeSnapshotPage * 2,
  );
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

  function selectTab(nextTab: ViewTab) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", tabId(nextTab));
    router.push(`${pathname}?${params.toString()}` as Route, { scroll: false });
  }

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
    manage.discard(target);
    setError("");
    setNotice("Unsaved changes discarded.");
  }

  function saveSection(target: ManageSection) {
    const result = manage.save(target);
    if (!result.ok) {
      setError("Check the highlighted settings before saving.");
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
    setConfirm(next);
  }

  function addSnapshot(name: string) {
    const result = manage.createSnapshot(name.trim() || "Manual snapshot");
    setError(result.ok ? "" : result.message);
    setNotice(result.ok ? result.message : "");
    if (result.ok) setSnapshotPage(1);
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
        action: () => {
          const result = manage.restoreSnapshot(snapshot.id, {
            discardDrafts: allDraftsDirty,
          });
          setError(result.ok ? "" : result.message);
          setNotice(result.ok ? result.message : "");
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
        action: () => {
          const result = manage.reset({ discardDrafts: allDraftsDirty });
          setError(result.ok ? "" : result.message);
          setNotice(result.ok ? result.message : "");
        },
      },
      event,
    );
  }

  function endSession(session: ManageSession, event: MouseEvent<HTMLElement>) {
    requestConfirm(
      {
        title: "End session",
        description: `${session.personName}'s ${session.device} ${session.browser} session in ${session.location} will be removed from this local session list. Your current session stays active.`,
        confirmLabel: "Confirm end session",
        action: () => {
          const result = manage.revokeSession(session.id);
          setError(result.ok ? "" : result.message);
          setNotice(result.ok ? result.message : "");
          if (result.ok) setSessionPage(1);
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
        action: () => {
          const result = manage.revokeAllSessions();
          setError(result.ok ? "" : result.message);
          setNotice(result.ok ? result.message : "");
          if (result.ok) setSessionPage(1);
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
      description: `Update local version ${settings.version} to 1.5.0? This updates the visible version and keeps a rollback point. No software is installed.`,
      confirmLabel: "Confirm update",
      action: () => {
        const result = manage.applyUpdate();
        setError(result.ok ? "" : result.message);
        setNotice(result.ok ? result.message : "");
      },
    });
  }

  function rollbackUpdate(event: MouseEvent<HTMLElement>) {
    requestConfirm(
      {
        title: "Roll back update",
        description: `Return the local version to ${settings.previous}? This only changes the displayed version.`,
        confirmLabel: "Confirm rollback",
        action: () => {
          const result = manage.rollbackUpdate();
          setError(result.ok ? "" : result.message);
          setNotice(result.ok ? result.message : "");
        },
      },
      event,
    );
  }

  function activateLicense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    requestConfirm({
      title: "Activate license",
      description: `Activate the bundled ${dummyKey.includes("BUSINESS") ? "Business" : "Team"} license in this local preview? No payment or license service will be contacted.`,
      confirmLabel: "Confirm activation",
      action: () => {
        const result = manage.activateLicense(dummyKey);
        setError(result.ok ? "" : result.message);
        setNotice(result.ok ? result.message : "");
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
        action: () => {
          const result = manage.renewLicense();
          setError(result.ok ? "" : result.message);
          setNotice(result.ok ? result.message : "");
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

  return (
    <div className="min-w-0 space-y-3 md:[&_button]:min-h-8 md:[&_form]:gap-3 md:[&_input]:min-h-8 md:[&_section>div:first-child>p]:sr-only md:[&_select]:h-8 md:[&_td]:py-1 md:[&_th]:h-8 md:[&_th]:py-1">
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
            <Badge variant="outline" className="hidden md:inline-flex">
              Local preview · tab only
            </Badge>
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

      <Alert role="note" className="px-3 py-2.5 text-sm md:hidden">
        Local preview · changes stay in this tab. Policies and maintenance are
        simulated.
      </Alert>
      {storageUnavailable ? (
        <Alert role="note" variant="warning">
          Browser storage is unavailable. Your latest changes exist in memory
          only and may be lost on reload.
        </Alert>
      ) : null}

      <div className="md:hidden">
        <Field>
          <FieldLabel htmlFor="manage-section">Manage section</FieldLabel>
          <NativeSelect
            id="manage-section"
            value={tabId(tab)}
            aria-describedby="manage-section-description"
            onChange={(event) =>
              selectTab(manageTabFromQuery(event.target.value))
            }
            className="w-full [&_select]:min-h-11"
          >
            {manageTabs.map((name) => (
              <NativeSelectOption key={name} value={tabId(name)}>
                {name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldDescription id="manage-section-description">
            Choose a management area.
          </FieldDescription>
        </Field>
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => selectTab(String(value) as ViewTab)}
        className="gap-3"
      >
        <nav
          aria-label="Manage sections"
          className="hidden border-b pb-2 md:block"
        >
          <TabsList className="grid w-full grid-cols-3 gap-1 sm:inline-flex sm:w-fit sm:flex-wrap">
            {manageTabs.map((name) => (
              <TabsTrigger
                key={name}
                value={name}
                type="button"
                className="min-h-11 min-w-11"
              >
                {name}
              </TabsTrigger>
            ))}
          </TabsList>
        </nav>
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
        <TabsContent value={tab} className="contents">
          {tab === "Organization" ? (
            <section
              className="flex flex-col gap-3"
              aria-labelledby="manage-organization-heading"
            >
              <SectionHeading
                title="Organization"
                description="Identity, regional defaults and working hours for your workspace."
                dirty={dirty}
              />
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
                <Card className={panelClass}>
                  <CardHeader>
                    <CardTitle id="manage-organization-heading">
                      Workspace identity and defaults
                    </CardTitle>
                    <CardDescription>
                      Choose a bundled logo style and preview how regional
                      settings appear in the workspace.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <form
                      className="flex flex-col gap-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        saveSection("organization");
                      }}
                    >
                      <div className="grid gap-2 sm:grid-cols-2">
                        <SettingInput
                          id="organization-name"
                          label="Organization name"
                          required
                          value={current.name}
                          onChange={(value) =>
                            changeSetting("organization", "name", value)
                          }
                          error={errors.name ?? null}
                        />
                        <SettingSelect
                          id="organization-logo"
                          label="Organization logo"
                          value={current.logo}
                          error={errors.logo}
                          options={["RS", "R", "Compass"]}
                          onChange={(value) =>
                            changeSetting("organization", "logo", value)
                          }
                        />
                      </div>
                      <FieldSet>
                        <FieldLegend>Regional defaults</FieldLegend>
                        <FieldGroup className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                          <SettingSelect
                            id="locale"
                            label="Locale"
                            value={current.locale}
                            error={errors.locale}
                            options={[
                              "English (Philippines)",
                              "Filipino",
                              "English (US)",
                            ]}
                            onChange={(value) =>
                              changeSetting("organization", "locale", value)
                            }
                          />
                          <SettingSelect
                            id="timezone"
                            label="Timezone"
                            value={current.timezone}
                            error={errors.timezone}
                            options={["Asia/Manila", "UTC", "Asia/Singapore"]}
                            onChange={(value) =>
                              changeSetting("organization", "timezone", value)
                            }
                          />
                          <SettingSelect
                            id="currency"
                            label="Currency"
                            value={current.currency}
                            error={errors.currency}
                            options={["PHP", "USD", "SGD"]}
                            onChange={(value) =>
                              changeSetting("organization", "currency", value)
                            }
                          />
                          <SettingSelect
                            id="week-start"
                            label="Week starts on"
                            value={current.week}
                            error={errors.week}
                            options={["Monday", "Sunday"]}
                            onChange={(value) =>
                              changeSetting("organization", "week", value)
                            }
                          />
                        </FieldGroup>
                      </FieldSet>
                      <SettingInput
                        id="business-hours"
                        label="Business hours"
                        value={current.hours}
                        onChange={(value) =>
                          changeSetting("organization", "hours", value)
                        }
                        description="Use 24-hour time and a dash, for example 09:00–18:00."
                        error={errors.hours ?? null}
                      />
                      <SettingActions
                        dirty={dirty}
                        onDiscard={() => clearDraft("organization")}
                        onSave={() => saveSection("organization")}
                      />
                    </form>
                  </CardContent>
                </Card>
                <div className="flex flex-col gap-3">
                  <Card
                    aria-label="Organization preview"
                    className={panelClass}
                  >
                    <CardHeader>
                      <CardTitle>Organization preview</CardTitle>
                      <CardDescription>
                        Preview uses the current draft until you save it.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-2">
                      <div className="bg-muted flex items-center gap-3 rounded-lg border p-4">
                        <div
                          className="bg-background flex size-12 shrink-0 items-center justify-center rounded-xl border text-lg font-semibold"
                          aria-label={`${current.name} logo`}
                        >
                          {current.logo === "Compass" ? (
                            <Sparkles aria-hidden="true" />
                          ) : (
                            current.logo
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate font-semibold">
                            {current.name || "Unnamed organization"}
                          </p>
                          <p className="text-muted-foreground text-sm">
                            {current.locale} · {current.timezone}
                          </p>
                        </div>
                      </div>
                      <dl className="divide-border divide-y">
                        <SummaryItem
                          label="Regional timestamp"
                          value={regionalDate}
                        />
                        <SummaryItem
                          label="Currency preview"
                          value={regionalCurrency}
                        />
                        <SummaryItem
                          label="Working week"
                          value={`${current.week} · ${current.hours}`}
                        />
                      </dl>
                    </CardContent>
                  </Card>
                  <Card className={panelClass}>
                    <CardHeader>
                      <CardTitle>Related administration</CardTitle>
                      <CardDescription>
                        Use the dedicated surfaces for people, permissions and
                        app design.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
                      <Button
                        asChild
                        variant="outline"
                        className="min-h-11 justify-between"
                      >
                        <Link href="/access?view=identities">
                          People and permissions{" "}
                          <ArrowUpRight data-icon="inline-end" />
                        </Link>
                      </Button>
                      <Button
                        asChild
                        variant="outline"
                        className="min-h-11 justify-between"
                      >
                        <Link href="/sandbox?view=Designer">
                          App design and workflows{" "}
                          <ArrowUpRight data-icon="inline-end" />
                        </Link>
                      </Button>
                    </CardContent>
                  </Card>
                </div>
              </div>
            </section>
          ) : null}

          {tab === "Security" ? (
            <section
              className="flex flex-col gap-3"
              aria-labelledby="manage-security-heading"
            >
              <SectionHeading
                title="Security policies"
                description="Explore account protection settings and local sessions. No passwords, tokens or authentication codes are collected."
                dirty={dirty}
              />
              <div className="grid gap-3 xl:grid-cols-[minmax(320px,0.8fr)_minmax(0,1.2fr)]">
                <Card className={panelClass}>
                  <CardHeader>
                    <CardTitle id="manage-security-heading">
                      Account protection
                    </CardTitle>
                    <CardDescription>
                      These options describe a future policy surface and have no
                      enforcement without a live policy service.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <form
                      className="flex flex-col gap-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        saveSection("security");
                      }}
                    >
                      <SettingSelect
                        id="password-policy"
                        label="Password policy"
                        value={current.password}
                        error={errors.password}
                        options={[
                          "12 characters + mixed case",
                          "16 characters + mixed case + number",
                          "20-character passphrase",
                        ]}
                        onChange={(value) =>
                          changeSetting("security", "password", value)
                        }
                      />
                      <SettingSelect
                        id="session-timeout"
                        label="Session timeout"
                        value={current.timeout}
                        error={errors.timeout}
                        options={[
                          "15 minutes",
                          "30 minutes",
                          "60 minutes",
                          "8 hours",
                        ]}
                        onChange={(value) =>
                          changeSetting("security", "timeout", value)
                        }
                      />
                      <SettingSelect
                        id="mfa-policy"
                        label="Two-factor authentication"
                        value={current.mfa}
                        error={errors.mfa}
                        options={[
                          "Optional",
                          "Required for administrators",
                          "Required for everyone",
                        ]}
                        onChange={(value) =>
                          changeSetting("security", "mfa", value)
                        }
                        description="Use the enrollment preview to understand the local flow."
                      />
                      <SettingInput
                        id="sample-ip-allow-list"
                        label="IP allow list"
                        value={current.ips}
                        onChange={(value) =>
                          changeSetting("security", "ips", value)
                        }
                        placeholder="192.0.2.0/24"
                        error={errors.ips ?? null}
                        description="Comma-separated documentation addresses only. An empty list means unrestricted locally."
                      />
                      <SettingActions
                        dirty={dirty}
                        onDiscard={() => clearDraft("security")}
                        onSave={() => saveSection("security")}
                      />
                    </form>
                  </CardContent>
                </Card>
                <Card className={panelClass}>
                  <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
                    <div>
                      <CardTitle>Active sessions</CardTitle>
                      <CardDescription className="md:sr-only">
                        Inspect devices and end remote sessions while keeping
                        the current session safe.
                      </CardDescription>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{sessions.length} active</Badge>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        onClick={openMfa}
                      >
                        <KeyRound data-icon="inline-start" /> Preview MFA setup
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2">
                    <Field>
                      <FieldLabel htmlFor="search-sessions">
                        Search sessions
                      </FieldLabel>
                      <div className="relative">
                        <Search
                          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
                          aria-hidden="true"
                        />
                        <Input
                          id="search-sessions"
                          value={sessionSearch}
                          onChange={(event) => {
                            setSessionSearch(event.target.value);
                            setSessionPage(1);
                          }}
                          className="min-h-11 pl-10 sm:min-h-9"
                          placeholder="Person, device or location"
                        />
                      </div>
                    </Field>
                    {remoteSessions.length ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11 self-start"
                        onClick={endAllRemoteSessions}
                      >
                        <UsersRound data-icon="inline-start" /> End all remote
                        sessions
                      </Button>
                    ) : null}
                    {visibleSessions.length ? (
                      <>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Session</TableHead>
                              <TableHead>Location</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead className="text-right">
                                Action
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {visibleSessionRows.map((session) => (
                              <TableRow key={session.id}>
                                <TableCell className="whitespace-normal">
                                  <div className="flex min-w-44 items-start gap-3">
                                    <div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-lg">
                                      {session.device === "Mobile" ? (
                                        <Smartphone aria-hidden="true" />
                                      ) : (
                                        <Monitor aria-hidden="true" />
                                      )}
                                    </div>
                                    <div>
                                      <p className="font-medium">
                                        {session.personName} · {session.device}{" "}
                                        · {session.browser}
                                      </p>
                                      <p className="text-muted-foreground mt-1 text-xs">
                                        Last seen {session.lastSeen}
                                      </p>
                                    </div>
                                  </div>
                                </TableCell>
                                <TableCell className="text-sm whitespace-normal">
                                  {session.location}
                                </TableCell>
                                <TableCell>
                                  {session.current ? (
                                    <Badge variant="success">
                                      Current session
                                    </Badge>
                                  ) : (
                                    <Badge variant="outline">Remote</Badge>
                                  )}
                                </TableCell>
                                <TableCell className="text-right">
                                  {!session.current ? (
                                    <Button
                                      type="button"
                                      variant="outline"
                                      className="min-h-11"
                                      aria-label={`End session · ${session.personName}`}
                                      onClick={(event) =>
                                        endSession(session, event)
                                      }
                                    >
                                      End
                                    </Button>
                                  ) : null}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
                          <p className="text-muted-foreground text-sm">
                            Showing {firstVisibleSession}–{lastVisibleSession}{" "}
                            of {visibleSessions.length} sessions
                          </p>
                          {sessionPageCount > 1 ? (
                            <Pagination
                              aria-label="Session pages"
                              className="mx-0 w-auto justify-start sm:justify-end"
                            >
                              <PaginationContent>
                                <PaginationItem>
                                  <PaginationPrevious
                                    href="#active-sessions"
                                    aria-disabled={safeSessionPage === 1}
                                    tabIndex={
                                      safeSessionPage === 1 ? -1 : undefined
                                    }
                                    className={
                                      safeSessionPage === 1
                                        ? "pointer-events-none opacity-50"
                                        : undefined
                                    }
                                    onClick={(event) => {
                                      event.preventDefault();
                                      if (safeSessionPage > 1)
                                        setSessionPage(safeSessionPage - 1);
                                    }}
                                  />
                                </PaginationItem>
                                <PaginationItem>
                                  <PaginationLink
                                    href="#active-sessions"
                                    size="default"
                                    isActive
                                    aria-label={`Session page ${safeSessionPage} of ${sessionPageCount}`}
                                    onClick={(event) => event.preventDefault()}
                                  >
                                    {safeSessionPage} / {sessionPageCount}
                                  </PaginationLink>
                                </PaginationItem>
                                <PaginationItem>
                                  <PaginationNext
                                    href="#active-sessions"
                                    aria-disabled={
                                      safeSessionPage === sessionPageCount
                                    }
                                    tabIndex={
                                      safeSessionPage === sessionPageCount
                                        ? -1
                                        : undefined
                                    }
                                    className={
                                      safeSessionPage === sessionPageCount
                                        ? "pointer-events-none opacity-50"
                                        : undefined
                                    }
                                    onClick={(event) => {
                                      event.preventDefault();
                                      if (safeSessionPage < sessionPageCount)
                                        setSessionPage(safeSessionPage + 1);
                                    }}
                                  />
                                </PaginationItem>
                              </PaginationContent>
                            </Pagination>
                          ) : null}
                        </div>
                      </>
                    ) : (
                      <Empty>
                        <EmptyHeader>
                          <EmptyMedia variant="icon">
                            <Monitor aria-hidden="true" />
                          </EmptyMedia>
                          <EmptyTitle>No sessions match this search</EmptyTitle>
                          <EmptyDescription>
                            Clear the search to view all active sessions.
                          </EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    )}
                  </CardContent>
                </Card>
              </div>
            </section>
          ) : null}

          {tab === "Audit" ? <ManageAudit entries={activity} /> : null}

          {tab === "Backup" ? (
            <section
              className="flex flex-col gap-3"
              aria-labelledby="manage-backup-heading"
            >
              <SectionHeading
                title="Backup & recovery"
                description="Create and restore configuration snapshots. Application records, people, sessions and database files are outside this local settings boundary."
                dirty={dirty}
              />
              <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
                <Card className={panelClass}>
                  <CardHeader className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <CardTitle id="manage-backup-heading">
                        Configuration snapshots
                      </CardTitle>
                      <CardDescription className="md:sr-only">
                        Snapshots contain saved Manage settings only. Unsaved
                        drafts are never included.
                      </CardDescription>
                    </div>
                    <Badge variant="outline">{backups.length} saved</Badge>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2">
                    <Field>
                      <FieldLabel htmlFor="snapshot-name">
                        Snapshot name
                      </FieldLabel>
                      <Input
                        id="snapshot-name"
                        value={snapshotName}
                        aria-describedby="snapshot-name-description"
                        onChange={(event) =>
                          setSnapshotName(event.target.value)
                        }
                        className="min-h-11"
                        placeholder="Manual snapshot"
                      />
                      <FieldDescription
                        id="snapshot-name-description"
                        className="md:sr-only"
                      >
                        Use a name that explains the configuration checkpoint.
                      </FieldDescription>
                    </Field>
                    <Button
                      type="button"
                      className="min-h-11 self-start"
                      onClick={() => {
                        addSnapshot(snapshotName);
                        setSnapshotName("");
                      }}
                    >
                      <HardDrive data-icon="inline-start" /> Create backup
                    </Button>
                    {backups.length ? (
                      <>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Snapshot</TableHead>
                              <TableHead>Scope</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead className="text-right">
                                Actions
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {visibleBackups.map((backup) => {
                              const recovery =
                                backup.name.startsWith("Before ");
                              return (
                                <TableRow key={backup.id}>
                                  <TableCell className="whitespace-normal">
                                    <div className="flex min-w-44 flex-col gap-1 md:min-w-36">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <p className="font-medium">
                                          {backup.name}
                                        </p>
                                        <Badge
                                          variant={
                                            recovery ? "warning" : "secondary"
                                          }
                                        >
                                          {recovery
                                            ? "Recovery"
                                            : "Configuration"}
                                        </Badge>
                                      </div>
                                      <p className="text-muted-foreground text-xs">
                                        {backup.date}
                                      </p>
                                    </div>
                                  </TableCell>
                                  <TableCell className="text-sm whitespace-normal">
                                    Saved Manage settings only
                                  </TableCell>
                                  <TableCell>
                                    <Badge variant="success">Complete</Badge>
                                  </TableCell>
                                  <TableCell className="text-right">
                                    <div className="flex min-w-max flex-wrap justify-end gap-2">
                                      <Button
                                        type="button"
                                        size="icon"
                                        variant="outline"
                                        className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                                        aria-label={`Restore ${backup.name}`}
                                        title={`Restore ${backup.name}`}
                                        onClick={(event) =>
                                          requestRestore(backup, event)
                                        }
                                      >
                                        <RotateCcw aria-hidden="true" />
                                      </Button>
                                      <Button
                                        type="button"
                                        size="icon"
                                        variant="outline"
                                        className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                                        aria-label={`Compare ${backup.name}`}
                                        title={`Compare ${backup.name}`}
                                        onClick={() => setCompareTarget(backup)}
                                      >
                                        <FileSearch aria-hidden="true" />
                                      </Button>
                                      <Button
                                        type="button"
                                        size="icon"
                                        variant="ghost"
                                        className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                                        aria-label={`Download ${backup.name}`}
                                        title={`Download ${backup.name}`}
                                        onClick={() => downloadSnapshot(backup)}
                                      >
                                        <Download aria-hidden="true" />
                                      </Button>
                                      <Button
                                        type="button"
                                        size="icon"
                                        variant="ghost"
                                        className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                                        aria-label={`Rename ${backup.name}`}
                                        title={`Rename ${backup.name}`}
                                        onClick={(event) => {
                                          renameOpener.current =
                                            event.currentTarget;
                                          setRenameTarget(backup);
                                          setRenameError("");
                                          setRenameValue(backup.name);
                                        }}
                                      >
                                        <History aria-hidden="true" />
                                      </Button>
                                      <Button
                                        type="button"
                                        size="icon"
                                        variant="ghost"
                                        className="text-destructive min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                                        aria-label={`Delete ${backup.name}`}
                                        title={`Delete ${backup.name}`}
                                        onClick={(event) =>
                                          requestConfirm(
                                            {
                                              title: "Delete snapshot",
                                              description: `Delete ${backup.name}? This removes only this local configuration snapshot.`,
                                              confirmLabel: `Delete ${backup.name}`,
                                              action: () => {
                                                const result =
                                                  manage.deleteSnapshot(
                                                    backup.id,
                                                  );
                                                setError(
                                                  result.ok
                                                    ? ""
                                                    : result.message,
                                                );
                                                setNotice(
                                                  result.ok
                                                    ? result.message
                                                    : "",
                                                );
                                                if (result.ok)
                                                  setSnapshotPage(
                                                    (currentPage) =>
                                                      Math.min(
                                                        currentPage,
                                                        Math.max(
                                                          1,
                                                          Math.ceil(
                                                            (backups.length -
                                                              1) /
                                                              2,
                                                          ),
                                                        ),
                                                      ),
                                                  );
                                              },
                                            },
                                            event,
                                          )
                                        }
                                      >
                                        <Trash2 aria-hidden="true" />
                                      </Button>
                                    </div>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
                          <p className="text-muted-foreground text-sm">
                            Showing {firstVisibleSnapshot}–{lastVisibleSnapshot}{" "}
                            of {backups.length} snapshots
                          </p>
                          {snapshotPageCount > 1 ? (
                            <Pagination
                              aria-label="Snapshot pages"
                              className="mx-0 w-auto justify-start sm:justify-end"
                            >
                              <PaginationContent>
                                <PaginationItem>
                                  <PaginationPrevious
                                    href="#configuration-snapshots"
                                    aria-disabled={safeSnapshotPage === 1}
                                    tabIndex={
                                      safeSnapshotPage === 1 ? -1 : undefined
                                    }
                                    className={
                                      safeSnapshotPage === 1
                                        ? "pointer-events-none opacity-50"
                                        : undefined
                                    }
                                    onClick={(event) => {
                                      event.preventDefault();
                                      if (safeSnapshotPage > 1)
                                        setSnapshotPage(safeSnapshotPage - 1);
                                    }}
                                  />
                                </PaginationItem>
                                <PaginationItem>
                                  <PaginationLink
                                    href="#configuration-snapshots"
                                    size="default"
                                    isActive
                                    aria-label={`Snapshot page ${safeSnapshotPage} of ${snapshotPageCount}`}
                                    onClick={(event) => event.preventDefault()}
                                  >
                                    {safeSnapshotPage} / {snapshotPageCount}
                                  </PaginationLink>
                                </PaginationItem>
                                <PaginationItem>
                                  <PaginationNext
                                    href="#configuration-snapshots"
                                    aria-disabled={
                                      safeSnapshotPage === snapshotPageCount
                                    }
                                    tabIndex={
                                      safeSnapshotPage === snapshotPageCount
                                        ? -1
                                        : undefined
                                    }
                                    className={
                                      safeSnapshotPage === snapshotPageCount
                                        ? "pointer-events-none opacity-50"
                                        : undefined
                                    }
                                    onClick={(event) => {
                                      event.preventDefault();
                                      if (safeSnapshotPage < snapshotPageCount)
                                        setSnapshotPage(safeSnapshotPage + 1);
                                    }}
                                  />
                                </PaginationItem>
                              </PaginationContent>
                            </Pagination>
                          ) : null}
                        </div>
                      </>
                    ) : (
                      <Empty>
                        <EmptyHeader>
                          <EmptyMedia variant="icon">
                            <HardDrive aria-hidden="true" />
                          </EmptyMedia>
                          <EmptyTitle>
                            No configuration snapshots yet
                          </EmptyTitle>
                          <EmptyDescription>
                            Create a backup to keep a saved Manage configuration
                            checkpoint.
                          </EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    )}
                  </CardContent>
                </Card>
                <Card className={panelClass}>
                  <CardHeader>
                    <CardTitle>Automatic backups</CardTitle>
                    <CardDescription>
                      Schedule and retention settings are saved as local
                      configuration. Nothing runs in the background.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <form
                      className="flex flex-col gap-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        saveSection("backup");
                      }}
                    >
                      <SettingSelect
                        id="backup-schedule"
                        label="Backup schedule"
                        value={current.schedule}
                        error={errors.schedule}
                        options={[
                          "Disabled",
                          "Daily at 02:00",
                          "Weekly on Sunday at 02:00",
                        ]}
                        onChange={(value) =>
                          changeSetting("backup", "schedule", value)
                        }
                      />
                      <SettingSelect
                        id="retention-period"
                        label="Retention period"
                        value={current.retention}
                        error={errors.retention}
                        options={["7 days", "30 days", "90 days"]}
                        onChange={(value) =>
                          changeSetting("backup", "retention", value)
                        }
                      />
                      <SettingActions
                        dirty={dirty}
                        onDiscard={() => clearDraft("backup")}
                        onSave={() => saveSection("backup")}
                      />
                    </form>
                    <Separator className="my-3" />
                    <div className="flex flex-col gap-3">
                      <p className="text-sm font-medium">Maintenance preview</p>
                      <p className="text-muted-foreground text-sm md:sr-only">
                        {settings.schedule === "Disabled"
                          ? "The saved automatic-backup preference is disabled."
                          : `Saved schedule: ${settings.schedule} (${settings.timezone}). No background job runs.`}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11 self-start"
                        disabled={settings.schedule === "Disabled"}
                        onClick={() =>
                          addSnapshot(
                            `Scheduled snapshot · ${new Date().toLocaleDateString()}`,
                          )
                        }
                      >
                        <Clock3 data-icon="inline-start" /> Simulate scheduled
                        backup
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        className="min-h-11 self-start"
                        onClick={() =>
                          setPreview({
                            title: "Retention preview",
                            description:
                              "This preview uses saved retention settings. It never deletes snapshots automatically.",
                            body: (
                              <div className="flex flex-col gap-3">
                                <p>
                                  {retention.candidates.length
                                    ? `${retention.candidates.length} snapshot(s) would be candidates after ${retention.days} days.`
                                    : `No snapshots are currently older than ${retention.days} days.`}
                                </p>
                                {retention.candidates.map((candidate) => (
                                  <Badge key={candidate.id} variant="outline">
                                    {candidate.name} · review manually
                                  </Badge>
                                ))}
                              </div>
                            ),
                          })
                        }
                      >
                        Preview retention candidates
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </section>
          ) : null}

          {tab === "Updates" ? (
            <section
              className="flex flex-col gap-3"
              aria-labelledby="manage-updates-heading"
            >
              <SectionHeading
                title="Updates"
                description="Review a release before making a local version change."
              />
              <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
                <Card className={panelClass}>
                  <CardHeader>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">Stable channel</Badge>
                      {settings.version === "1.5.0" ? (
                        <Badge variant="success">Up to date</Badge>
                      ) : null}
                    </div>
                    <CardTitle id="manage-updates-heading">
                      Current version · {settings.version}
                    </CardTitle>
                    <CardDescription>
                      Updates are simulated locally and never install software.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 self-start"
                      onClick={() => {
                        const available = manage.checkForUpdate();
                        setNotice(
                          available
                            ? "Release 1.5.0 is available."
                            : "Version is up to date.",
                        );
                      }}
                    >
                      <Search data-icon="inline-start" /> Check for updates
                    </Button>
                    {updateAvailable && settings.version !== "1.5.0" ? (
                      <div className="bg-muted flex flex-col gap-3 rounded-lg p-4">
                        <h3 className="font-semibold">1.5.0 · Available</h3>
                        <p className="text-muted-foreground text-sm">
                          Refined navigation, improved report layouts and
                          clearer session controls.
                        </p>
                        <Button
                          type="button"
                          className="min-h-11 self-start"
                          onClick={startUpdate}
                        >
                          <ArrowDownToLine data-icon="inline-start" /> Apply
                          update
                        </Button>
                      </div>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      className="min-h-11 self-start"
                      onClick={() => setShowChangelog((value) => !value)}
                    >
                      {showChangelog ? "Hide changelog" : "View changelog"}
                    </Button>
                    {showChangelog ? (
                      <div className="border-t pt-4">
                        <h3 className="font-semibold">1.5.0 release notes</h3>
                        <ul className="text-muted-foreground mt-3 list-inside list-disc space-y-2 text-sm">
                          <li>Six-pillar workspace navigation</li>
                          <li>Mobile-friendly report inspectors</li>
                          <li>Improved session management clarity</li>
                        </ul>
                      </div>
                    ) : null}
                    {settings.previous ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11 self-start"
                        onClick={rollbackUpdate}
                      >
                        <RotateCcw data-icon="inline-start" /> Roll back update
                      </Button>
                    ) : null}
                  </CardContent>
                </Card>
                <Card className={panelClass}>
                  <CardHeader>
                    <CardTitle>Release history</CardTitle>
                    <CardDescription>
                      Local maintenance actions performed in this tab.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ol className="flex flex-col gap-2">
                      {history.map((item, index) => (
                        <li
                          key={`${item}-${index}`}
                          className="flex gap-3 text-sm"
                        >
                          <CheckCircle2
                            className="text-muted-foreground mt-0.5 shrink-0"
                            aria-hidden="true"
                          />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ol>
                  </CardContent>
                </Card>
              </div>
            </section>
          ) : null}

          {tab === "Licensing" ? (
            <section
              className="flex flex-col gap-3"
              aria-labelledby="manage-licensing-heading"
            >
              <SectionHeading
                title="License & usage"
                description="Compare bundled tiers and capacity. No payment, subscription or license service is connected."
              />
              <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <Card className={panelClass}>
                  <CardHeader>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">Current plan</Badge>
                      <Badge variant="success">Active</Badge>
                    </div>
                    <CardTitle
                      id="manage-licensing-heading"
                      className="text-3xl"
                    >
                      {settings.tier}
                    </CardTitle>
                    <CardDescription>Expires {settings.expiry}</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <div>
                      <div className="mb-2 flex justify-between text-sm">
                        <span>Active users</span>
                        <span>
                          {activeUsers} / {seatLimit}
                        </span>
                      </div>
                      <Progress
                        aria-label="User license usage"
                        aria-valuetext={`${activeUsers} active users; ${seatLimit} seats`}
                        value={activeUsers}
                        max={seatLimit}
                      />
                    </div>
                    {activeUsers > seatLimit ? (
                      <Alert variant="warning" role="status">
                        <p className="font-medium">User limit exceeded</p>
                        <p>
                          {activeUsers} active users exceed the {settings.tier}{" "}
                          plan limit of {seatLimit}. This preview does not
                          restrict access.
                        </p>
                      </Alert>
                    ) : null}
                    <div>
                      <div className="mb-2 flex justify-between text-sm">
                        <span>Illustrative storage</span>
                        <span>
                          1.2 / {settings.tier === "Business" ? "100" : "10"} GB
                        </span>
                      </div>
                      <Progress
                        aria-label="Storage license usage"
                        value={1.2}
                        max={settings.tier === "Business" ? 100 : 10}
                      />
                    </div>
                    <Alert>
                      <p className="font-medium">Capacity is illustrative</p>
                      <p className="mt-1 text-sm">
                        User usage is derived from the local Access directory.
                        Storage values demonstrate the interface and are not
                        measured workspace data.
                      </p>
                    </Alert>
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 self-start"
                      onClick={renewLicense}
                    >
                      <Clock3 data-icon="inline-start" /> Renew license
                    </Button>
                  </CardContent>
                </Card>
                <div className="flex flex-col gap-3">
                  <Card className={panelClass}>
                    <CardHeader>
                      <CardTitle>Activate a license</CardTitle>
                      <CardDescription>
                        Choose a bundled placeholder key. Never enter a real
                        license key here.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <form
                        className="flex flex-col gap-3"
                        onSubmit={activateLicense}
                      >
                        <SettingSelect
                          id="bundled-dummy-license-key"
                          label="Bundled license key"
                          value={dummyKey}
                          options={["SAMPLE-TEAM-2026", "SAMPLE-BUSINESS-2026"]}
                          optionLabels={{
                            "SAMPLE-TEAM-2026": "Team key · 2026",
                            "SAMPLE-BUSINESS-2026": "Business key · 2026",
                          }}
                          onChange={setDummyKey}
                        />
                        <Button type="submit" className="min-h-11 self-start">
                          Activate license
                        </Button>
                      </form>
                    </CardContent>
                  </Card>
                  <Card className={panelClass}>
                    <CardHeader>
                      <CardTitle>Compare tiers</CardTitle>
                      <CardDescription>
                        Use this comparison to understand the bundled
                        demonstration limits.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-3 sm:grid-cols-2">
                      <div
                        className={`rounded-lg border p-4 ${settings.tier === "Team" ? "border-primary ring-ring/30 ring-2" : ""}`}
                      >
                        <div className="flex items-center justify-between">
                          <h3 className="font-semibold">Team</h3>
                          {settings.tier === "Team" ? (
                            <Badge variant="success">Current</Badge>
                          ) : null}
                        </div>
                        <p className="text-muted-foreground mt-2 text-sm">
                          25 users · 10 GB illustrative storage
                        </p>
                      </div>
                      <div
                        className={`rounded-lg border p-4 ${settings.tier === "Business" ? "border-primary ring-ring/30 ring-2" : ""}`}
                      >
                        <div className="flex items-center justify-between">
                          <h3 className="font-semibold">Business tier</h3>
                          {settings.tier === "Business" ? (
                            <Badge variant="success">Current</Badge>
                          ) : null}
                        </div>
                        <p className="text-muted-foreground mt-2 text-sm">
                          100 users · 100 GB illustrative storage
                        </p>
                      </div>
                    </CardContent>
                    <CardFooter>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        onClick={() =>
                          setPreview({
                            title: "License terms preview",
                            description: "Illustrative terms only.",
                            body: (
                              <div className="flex flex-col gap-3 text-sm">
                                <p>
                                  Team: 25 users and 10 GB illustrative storage.
                                </p>
                                <p>
                                  Business: 100 users and 100 GB illustrative
                                  storage.
                                </p>
                                <p className="text-muted-foreground">
                                  These figures demonstrate the interface and
                                  are not an offer or a published OpenSlate
                                  plan.
                                </p>
                              </div>
                            ),
                          })
                        }
                      >
                        View license terms
                      </Button>
                    </CardFooter>
                  </Card>
                </div>
              </div>
            </section>
          ) : null}
        </TabsContent>
      </Tabs>

      <Dialog open={mfaOpen} onOpenChange={setMfaOpen}>
        <DialogContent
          className="max-w-lg"
          finalFocus={() =>
            mfaOpener.current?.isConnected ? mfaOpener.current : false
          }
        >
          <DialogHeader>
            <DialogTitle>MFA enrollment preview</DialogTitle>
            <DialogDescription>
              Step {mfaStep + 1} of 3 · This preview does not enroll a real
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
                  A real workspace would offer an authenticator app or security
                  key.
                </p>
              </div>
            ) : null}
            {mfaStep === 1 ? (
              <div className="flex flex-col gap-2">
                <h3 className="font-semibold">Verify the factor</h3>
                <p className="text-muted-foreground text-sm">
                  This preview stops before any code or credential is entered.
                </p>
              </div>
            ) : null}
            {mfaStep === 2 ? (
              <div className="flex flex-col gap-2">
                <h3 className="font-semibold">Review recovery options</h3>
                <p className="text-muted-foreground text-sm">
                  Recovery options would be stored securely by the real account
                  system.
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
          if (!open) setRenameTarget(null);
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
              Give this local configuration snapshot a recognizable name.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!renameTarget || !renameValue.trim()) return;
              const result = manage.renameSnapshot(
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
                onClick={() => setRenameTarget(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="min-h-11"
                disabled={!renameValue.trim()}
              >
                Rename snapshot
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
            <DialogTitle>{preview?.title ?? "Preview"}</DialogTitle>
            <DialogDescription>
              {preview?.description ?? "Preview details"}
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
              Close preview
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
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
          {confirm?.body}
          {confirm?.requiresDraftAck ? (
            <Field className="mt-4 flex-row items-center gap-3">
              <Checkbox
                id="discard-affected-drafts"
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
              onClick={() => setConfirm(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              disabled={Boolean(
                confirm?.requiresDraftAck && !draftAcknowledged,
              )}
              onClick={() => {
                if (!confirm) return;
                confirm.action();
                setConfirm(null);
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
