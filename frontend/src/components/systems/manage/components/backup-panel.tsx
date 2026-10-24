"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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

import {
  backupNameError,
  exportPassphraseError,
  type ManageBackupRun,
  type ManageBackupsRequest,
} from "../adapters/backup-api";
import type { useManageMaintenance } from "../state/controller";
import { BackupDetail } from "./backup-detail";
import {
  BackupExportPanel,
  ConfirmPasswordDialog,
  PrepareExportDialog,
} from "./backup-export";
import { BackupHistoryList, type BackupListBody } from "./backup-history-list";
import { BackupScheduleDialog } from "./backup-schedule-dialog";
import { BackupStatusPanel } from "./backup-status-panel";

// Backup (MD8, docs/specs/manage-relayout.md): the status panel first, then
// History as a list and one backup's detail, after Sandbox History. This
// component owns the selection, the phone view, and the drafts of the Back
// up now, encrypted backup and password dialogs; the panes only render them.

type Maintenance = ReturnType<typeof useManageMaintenance>;

const PHONE_QUERY = "(max-width: 39.99rem)";

function subscribePhone(onChange: () => void) {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Phones show the list or one backup's detail, with Back. */
function usePhone(): boolean {
  return useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );
}

export function BackupPanel({
  maintenance,
  onOpenSchedule,
}: {
  maintenance: Maintenance;
  /** The page clears its own notices when the schedule opens. */
  onOpenSchedule?: () => void;
}) {
  const id = useId();
  const phone = usePhone();
  const [selectedId, setSelectedId] = useState<string | null | undefined>(
    undefined,
  );
  const routedExport = Boolean(
    maintenance.exportId || maintenance.invalidExportId,
  );
  // A routed encrypted backup opens on its detail, also on a phone.
  const [phoneView, setPhoneView] = useState<"list" | "detail">(
    routedExport ? "detail" : "list",
  );
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const scheduleOpener = useRef<HTMLButtonElement | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("Manual backup");
  const [nameError, setNameError] = useState<string | null>(null);
  const createOpener = useRef<HTMLButtonElement | null>(null);
  const [exportDraft, setExportDraft] = useState<{
    actorId: string;
    source: ManageBackupRun;
    passphrase: string;
    key: string;
  } | null>(null);
  const [passphraseError, setPassphraseError] = useState<string | null>(null);
  // The confirmation is checked locally and never sent.
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const exportOpener = useRef<HTMLButtonElement | null>(null);
  const [passwordDraft, setPasswordDraft] = useState<{
    actorId: string;
    exportId: string;
    password: string;
  } | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const passwordOpener = useRef<HTMLButtonElement | null>(null);
  const downloadLink = useRef<HTMLAnchorElement | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const listHeading = useRef<HTMLHeadingElement | null>(null);
  const detailHeading = useRef<HTMLHeadingElement | null>(null);
  const { acceptedHistory: page, request, setRequest } = maintenance;
  useEffect(() => {
    if (
      !page ||
      page.pagination.offset !== request.offset ||
      page.pagination.limit !== request.limit ||
      request.offset === 0 ||
      request.offset < page.pagination.total
    )
      return;
    const offset =
      page.pagination.total > 0
        ? Math.floor((page.pagination.total - 1) / request.limit) *
          request.limit
        : 0;
    setSelectedId(null);
    setRequest((value) => (value === request ? { ...value, offset } : value));
  }, [page, request, setRequest]);
  const runs = page?.items ?? [];
  const selected =
    selectedId === undefined
      ? routedExport
        ? maintenance.acceptedExportSource
        : runs[0]
      : runs.find((run) => run.id === selectedId);
  const visibleExportDraft =
    exportDraft?.actorId === maintenance.exportActorId ? exportDraft : null;
  const visiblePasswordDraft =
    passwordDraft?.actorId === maintenance.exportActorId &&
    passwordDraft.exportId === maintenance.acceptedExport?.id
      ? passwordDraft
      : null;
  const total = page?.pagination.total ?? 0;
  const filtered =
    request.search !== "" ||
    request.state !== "all" ||
    request.provenance !== "all" ||
    request.installation !== "all";
  const failure: "denied" | "unavailable" | null = maintenance.historyRefused
    ? "denied"
    : maintenance.history.isError
      ? "unavailable"
      : null;
  const body: BackupListBody =
    failure || !page
      ? "none"
      : runs.length
        ? "rows"
        : filtered
          ? "no-match"
          : total > 0
            ? "no-page"
            : "empty";

  function changeRequest(next: Partial<ManageBackupsRequest>) {
    maintenance.setRequest((value) => ({ ...value, offset: 0, ...next }));
    setSelectedId(null);
  }
  function openRun(runId: string) {
    setSelectedId(runId);
    if (!phone) return;
    setPhoneView("detail");
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0 });
      detailHeading.current?.focus({ preventScroll: true });
    });
  }
  function backToList() {
    setPhoneView("list");
    requestAnimationFrame(() =>
      (
        listRef.current?.querySelector<HTMLElement>("[aria-current=true]") ??
        listHeading.current
      )?.focus(),
    );
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const invalid = backupNameError(createName);
    setNameError(invalid);
    if (invalid || maintenance.pending) return;
    if (await maintenance.queueBackup(createName)) {
      setCreateOpen(false);
      setSelectedId(null);
      setCreateName("Manual backup");
    }
  }
  async function submitExport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const draft = visibleExportDraft;
    if (!draft || maintenance.pending || confirmPassphrase !== draft.passphrase)
      return;
    const invalid = exportPassphraseError(draft.passphrase);
    setPassphraseError(invalid);
    if (invalid) return;
    if (
      await maintenance.queueExport(draft.source, draft.passphrase, draft.key)
    ) {
      setExportDraft((current) => (current === draft ? null : current));
      resetPassphraseConfirmation();
    }
  }
  function resetPassphraseConfirmation() {
    setConfirmPassphrase("");
    setShowPassphrase(false);
    setShowConfirmation(false);
  }
  function cancelExport() {
    if (maintenance.pending) return;
    setExportDraft(null);
    setPassphraseError(null);
    resetPassphraseConfirmation();
    maintenance.clearExportError();
  }
  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const draft = visiblePasswordDraft;
    if (!draft || maintenance.pending) return;
    const length = Array.from(draft.password).length;
    const invalid =
      length < 1 || length > 128 ? "Enter your current password." : null;
    setPasswordError(invalid);
    if (invalid) return;
    if (await maintenance.confirmExportDownload(draft.password))
      setPasswordDraft((current) => (current === draft ? null : current));
  }
  function cancelPassword() {
    if (maintenance.pending) return;
    setPasswordDraft(null);
    setPasswordError(null);
    maintenance.clearExportError();
  }

  return (
    // From 1280px the panes fill the section; when notices leave too little
    // room, the section scrolls instead of squeezing the list (Still Page).
    <div className="flex min-w-0 flex-col gap-4 xl:h-full">
      <BackupStatusPanel
        maintenance={maintenance}
        backUpRef={createOpener}
        scheduleRef={scheduleOpener}
        onBackUp={() => {
          maintenance.clearCommandMessage();
          setNameError(null);
          setCreateOpen(true);
        }}
        onEditSchedule={() => {
          onOpenSchedule?.();
          setScheduleOpen(true);
        }}
      />
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,28rem)] xl:min-h-[23rem] xl:flex-1 xl:grid-rows-[minmax(0,1fr)]">
        <BackupHistoryList
          listRef={listRef}
          headingRef={listHeading}
          hidden={phone && phoneView === "detail"}
          phone={phone}
          runs={runs}
          total={total}
          body={body}
          loading={maintenance.history.isPending && !failure}
          failure={failure}
          onRetry={() => void maintenance.retryHistory()}
          selectedId={selected?.id}
          request={request}
          onRequestChange={changeRequest}
          paged={Boolean(page)}
          onOpen={openRun}
        />
        <BackupDetail
          run={selected}
          hidden={phone && phoneView === "list"}
          phone={phone}
          headingRef={detailHeading}
          onBack={backToList}
          exportButtonRef={exportOpener}
          exportPending={maintenance.pending}
          onPrepareExport={
            maintenance.exportAllowed
              ? (source) => {
                  setPassphraseError(null);
                  resetPassphraseConfirmation();
                  maintenance.clearExportError();
                  setExportDraft({
                    actorId: maintenance.exportActorId,
                    source,
                    passphrase: "",
                    key: crypto.randomUUID(),
                  });
                }
              : null
          }
        >
          {routedExport && maintenance.exportAllowed ? (
            <BackupExportPanel
              maintenance={maintenance}
              passwordOpener={passwordOpener}
              downloadLink={downloadLink}
              onConfirmPassword={(exportId) => {
                maintenance.clearExportError();
                maintenance.clearExportDownloadAdmission();
                setPasswordError(null);
                setPasswordDraft({
                  actorId: maintenance.exportActorId,
                  exportId,
                  password: "",
                });
              }}
            />
          ) : null}
        </BackupDetail>
      </div>
      <BackupScheduleDialog
        maintenance={maintenance}
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        finalFocus={() => scheduleOpener.current}
      />
      <PrepareExportDialog
        open={Boolean(visibleExportDraft) && maintenance.exportAllowed}
        pending={maintenance.pending}
        sourceName={visibleExportDraft?.source.name}
        passphrase={visibleExportDraft?.passphrase ?? ""}
        passphraseError={passphraseError}
        onPassphraseChange={(passphrase) => {
          setPassphraseError(null);
          maintenance.clearExportError();
          setExportDraft((current) =>
            current
              ? {
                  ...current,
                  passphrase,
                  key:
                    current.passphrase === passphrase
                      ? current.key
                      : crypto.randomUUID(),
                }
              : current,
          );
        }}
        confirmation={confirmPassphrase}
        onConfirmationChange={(value) => {
          setConfirmPassphrase(value);
          maintenance.clearExportError();
        }}
        showPassphrase={showPassphrase}
        onShowPassphrase={setShowPassphrase}
        showConfirmation={showConfirmation}
        onShowConfirmation={setShowConfirmation}
        error={maintenance.exportError}
        onSubmit={submitExport}
        onCancel={cancelExport}
        finalFocus={() => exportOpener.current}
      />
      <ConfirmPasswordDialog
        open={Boolean(visiblePasswordDraft) && maintenance.exportAllowed}
        pending={maintenance.pending}
        password={visiblePasswordDraft?.password ?? ""}
        passwordError={passwordError}
        onPasswordChange={(password) => {
          setPasswordError(null);
          maintenance.clearExportError();
          setPasswordDraft((current) =>
            current ? { ...current, password } : current,
          );
        }}
        error={maintenance.exportError}
        onSubmit={submitPassword}
        onCancel={cancelPassword}
        finalFocus={() => passwordOpener.current ?? downloadLink.current}
      />
      <Dialog
        open={createOpen}
        dismissible={!maintenance.pending}
        onOpenChange={(open) => {
          if (!maintenance.pending) setCreateOpen(open);
        }}
      >
        <DialogContent
          className="slim-ui"
          finalFocus={() => createOpener.current}
        >
          <DialogHeader>
            <DialogTitle>Back up now</DialogTitle>
            <DialogDescription>
              Add a named backup request to the queue. The installation goes
              offline while this backup runs.
            </DialogDescription>
          </DialogHeader>
          <form className="mt-4 flex flex-col gap-4" onSubmit={submit}>
            <fieldset disabled={maintenance.pending} className="min-w-0">
              <Field data-invalid={Boolean(nameError)}>
                <FieldLabel htmlFor={`${id}-backup-name`}>
                  Backup name
                </FieldLabel>
                <Input
                  id={`${id}-backup-name`}
                  value={createName}
                  aria-invalid={Boolean(nameError)}
                  aria-describedby={nameError ? `${id}-name-error` : undefined}
                  onChange={(event) => {
                    setCreateName(event.target.value);
                    setNameError(null);
                  }}
                  className="min-h-11"
                />
                <FieldError id={`${id}-name-error`}>{nameError}</FieldError>
              </Field>
            </fieldset>
            {maintenance.error ? (
              <Alert role="alert" variant="destructive">
                {maintenance.error}
              </Alert>
            ) : null}
            <DialogFooter className="mt-0">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={maintenance.pending}
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="min-h-11"
                disabled={maintenance.pending}
              >
                {maintenance.pending ? "Queueing…" : "Back up now"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
