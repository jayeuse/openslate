"use client";

import { useId, type ComponentProps, type FormEvent, type Ref } from "react";
import { Download, Eye, EyeOff } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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

import { formatFileSize } from "../../shared/adapters/files-api";
import {
  failureLabel,
  manageBackupExportContentUrl,
} from "../adapters/backup-api";
import type { useManageMaintenance } from "../state/controller";
import { formatBackupTime, useWorkspaceRegion } from "./backup-time";

// The encrypted backup flow: the routed export's panel, the passphrase
// dialog that prepares one, and the password dialog that admits a download.
// The Backup panel owns the drafts and their openers; these render them.

type Maintenance = ReturnType<typeof useManageMaintenance>;

/** A secret field with a visibility toggle that keeps its own label. */
function SecretInput({
  revealed,
  onRevealedChange,
  revealLabel,
  ...props
}: Omit<ComponentProps<typeof Input>, "type"> & {
  revealed: boolean;
  onRevealedChange: (revealed: boolean) => void;
  revealLabel: string;
}) {
  return (
    <div className="relative min-w-0">
      <Input
        {...props}
        type={revealed ? "text" : "password"}
        className="min-h-11 pr-12"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute top-0 right-0 size-11"
        aria-label={revealLabel}
        aria-pressed={revealed}
        onClick={() => onRevealedChange(!revealed)}
      >
        {revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </Button>
    </div>
  );
}

/** The routed encrypted backup: its state, facts, and the download steps. */
export function BackupExportPanel({
  maintenance,
  passwordOpener,
  downloadLink,
  onConfirmPassword,
}: {
  maintenance: Maintenance;
  passwordOpener: Ref<HTMLButtonElement>;
  downloadLink: Ref<HTMLAnchorElement>;
  onConfirmPassword: (exportId: string) => void;
}) {
  const region = useWorkspaceRegion();
  const operation = maintenance.acceptedExport;
  return (
    <section
      aria-label="Encrypted backup"
      className="border-border min-w-0 overflow-hidden rounded-[var(--radius)] border"
    >
      <header className="border-border border-b px-4 py-3">
        <h3 data-slot="section-title" className="font-semibold">
          Encrypted backup
        </h3>
        {maintenance.acceptedExportSource ? (
          <p className="text-muted-foreground mt-0.5 text-sm break-words">
            {maintenance.acceptedExportSource.name}
          </p>
        ) : null}
      </header>
      <div className="min-w-0 space-y-3 p-4">
        {maintenance.invalidExportId ? (
          <Alert role="alert" variant="destructive">
            This link doesn’t match an encrypted backup. Select a backup to
            prepare one.
          </Alert>
        ) : maintenance.exportQuery.isError || maintenance.exportRefused ? (
          <Alert role="alert" variant="destructive">
            <p>
              {maintenance.exportRefused
                ? "You don’t have access to this encrypted backup."
                : "Couldn’t load the encrypted backup details."}
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-2 min-h-11"
              onClick={() => void maintenance.retryExport()}
            >
              Try again
            </Button>
          </Alert>
        ) : operation ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={
                  operation.state === "ready"
                    ? "success"
                    : operation.state === "failed" ||
                        operation.state === "interrupted"
                      ? "warning"
                      : "secondary"
                }
              >
                {operation.state[0]!.toUpperCase() + operation.state.slice(1)}
              </Badge>
              <p className="text-muted-foreground text-sm">
                {operation.state === "queued"
                  ? "Queued. The encrypted backup is not ready yet."
                  : operation.state === "preparing"
                    ? "Preparing the encrypted backup."
                    : operation.state === "ready"
                      ? maintenance.acceptedDownloadAdmission
                        ? "The encrypted backup is ready. Your password is confirmed."
                        : "The encrypted backup is ready. Confirm your password before downloading."
                      : operation.state === "expired"
                        ? "This encrypted backup has expired. Prepare a new one from an eligible backup."
                        : "The encrypted backup did not finish. Review the source backup before you try again."}
              </p>
            </div>
            <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm @min-[26rem]/detail:grid-cols-[10rem_minmax(0,1fr)]">
              {[
                ["Requested", formatBackupTime(operation.requested_at, region)],
                ["Ready", formatBackupTime(operation.ready_at, region)],
                [
                  "Available until",
                  formatBackupTime(operation.expires_at, region),
                ],
                [
                  "Size",
                  operation.size_bytes === null
                    ? "Not recorded"
                    : formatFileSize(operation.size_bytes),
                ],
                ["Checksum", operation.sha256 ?? "Not recorded"],
                [
                  "Failure",
                  operation.failure_code
                    ? failureLabel(operation.failure_code)
                    : "None recorded",
                ],
              ].map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="min-w-0 break-all tabular-nums">
                    {value}
                    {label === "Available until" ? (
                      <span className="text-muted-foreground block text-xs break-words">
                        Downloads stop when the encrypted backup expires. The
                        server then deletes its copy.
                      </span>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
            {operation.state === "ready" ? (
              <div className="min-w-0 space-y-3">
                {maintenance.acceptedDownloadAdmission ? (
                  <>
                    <Button
                      asChild
                      variant="outline"
                      className="min-h-11 w-full"
                    >
                      <a
                        ref={downloadLink}
                        href={manageBackupExportContentUrl(operation.id)}
                        onClick={maintenance.clearExportDownloadAdmission}
                      >
                        <Download data-icon="inline-start" />
                        Download encrypted backup
                      </a>
                    </Button>
                    <p className="text-muted-foreground text-sm">
                      Password confirmation expires{" "}
                      {formatBackupTime(
                        maintenance.acceptedDownloadAdmission.expiresAt,
                        region,
                      )}
                      .
                    </p>
                  </>
                ) : (
                  <Button
                    ref={passwordOpener}
                    type="button"
                    variant="outline"
                    className="min-h-11 w-full"
                    disabled={maintenance.pending}
                    onClick={() => onConfirmPassword(operation.id)}
                  >
                    Confirm password
                  </Button>
                )}
                <p className="text-muted-foreground text-sm">
                  Your browser handles the download. If it fails, confirm your
                  password again to start over.
                </p>
              </div>
            ) : null}
          </>
        ) : (
          <p role="status" className="text-muted-foreground text-sm">
            Loading export details…
          </p>
        )}
      </div>
    </section>
  );
}

/** Prepare encrypted backup: a passphrase and its local confirmation. */
export function PrepareExportDialog({
  open,
  pending,
  sourceName,
  passphrase,
  passphraseError,
  onPassphraseChange,
  confirmation,
  onConfirmationChange,
  showPassphrase,
  onShowPassphrase,
  showConfirmation,
  onShowConfirmation,
  error,
  onSubmit,
  onCancel,
  finalFocus,
}: {
  open: boolean;
  pending: boolean;
  sourceName: string | undefined;
  passphrase: string;
  passphraseError: string | null;
  onPassphraseChange: (value: string) => void;
  confirmation: string;
  onConfirmationChange: (value: string) => void;
  showPassphrase: boolean;
  onShowPassphrase: (revealed: boolean) => void;
  showConfirmation: boolean;
  onShowConfirmation: (revealed: boolean) => void;
  error: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  finalFocus: () => HTMLElement | null;
}) {
  const id = useId();
  const passphrasesMatch = passphrase.length > 0 && confirmation === passphrase;
  // Wait until the confirmation can no longer become a match by typing on.
  const confirmationMismatch =
    confirmation.length > 0 &&
    confirmation !== passphrase &&
    !passphrase.startsWith(confirmation);
  return (
    <Dialog
      open={open}
      dismissible={!pending}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="slim-ui" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>Prepare encrypted backup</DialogTitle>
          <DialogDescription>
            Prepare an encrypted copy of {sourceName ?? "the selected backup"}.
            The installation stays online. Keep this passphrase with your
            offline recovery records; you need it to restore the backup.
          </DialogDescription>
        </DialogHeader>
        <form className="mt-4 flex min-w-0 flex-col gap-4" onSubmit={onSubmit}>
          <fieldset disabled={pending} className="flex min-w-0 flex-col gap-4">
            <Field data-invalid={Boolean(passphraseError)}>
              <FieldLabel htmlFor={id + "-export-passphrase"}>
                Passphrase
              </FieldLabel>
              <SecretInput
                id={id + "-export-passphrase"}
                revealed={showPassphrase}
                onRevealedChange={onShowPassphrase}
                revealLabel="Show passphrase"
                autoComplete="new-password"
                value={passphrase}
                aria-invalid={Boolean(passphraseError)}
                aria-describedby={
                  passphraseError
                    ? id + "-passphrase-error"
                    : id + "-passphrase-help"
                }
                onChange={(event) =>
                  onPassphraseChange(event.currentTarget.value)
                }
              />
              <p
                id={id + "-passphrase-help"}
                className="text-muted-foreground mt-1 text-sm"
              >
                Use 16–128 printable characters, with no spaces at either end.
              </p>
              <FieldError id={id + "-passphrase-error"}>
                {passphraseError}
              </FieldError>
            </Field>
            <Field data-invalid={confirmationMismatch}>
              <FieldLabel htmlFor={id + "-export-passphrase-confirm"}>
                Confirm passphrase
              </FieldLabel>
              <SecretInput
                id={id + "-export-passphrase-confirm"}
                revealed={showConfirmation}
                onRevealedChange={onShowConfirmation}
                revealLabel="Show confirmed passphrase"
                autoComplete="new-password"
                value={confirmation}
                aria-invalid={confirmationMismatch}
                aria-describedby={
                  confirmationMismatch ? id + "-passphrase-mismatch" : undefined
                }
                onChange={(event) =>
                  onConfirmationChange(event.currentTarget.value)
                }
              />
              <FieldError id={id + "-passphrase-mismatch"}>
                {confirmationMismatch ? "The passphrases don’t match." : null}
              </FieldError>
            </Field>
          </fieldset>
          {error ? (
            <Alert role="alert" variant="destructive">
              {error}
            </Alert>
          ) : null}
          <DialogFooter className="mt-0">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={pending}
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="min-h-11"
              disabled={pending || !passphrasesMatch}
            >
              {pending ? "Preparing…" : "Prepare encrypted backup"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Confirm password before a download. */
export function ConfirmPasswordDialog({
  open,
  pending,
  password,
  passwordError,
  onPasswordChange,
  error,
  onSubmit,
  onCancel,
  finalFocus,
}: {
  open: boolean;
  pending: boolean;
  password: string;
  passwordError: string | null;
  onPasswordChange: (value: string) => void;
  error: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  finalFocus: () => HTMLElement | null;
}) {
  const id = useId();
  return (
    <Dialog
      open={open}
      dismissible={!pending}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="slim-ui" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>Confirm password</DialogTitle>
          <DialogDescription>
            Enter your current password to download this encrypted backup.
          </DialogDescription>
        </DialogHeader>
        <form className="mt-4 flex min-w-0 flex-col gap-4" onSubmit={onSubmit}>
          <fieldset disabled={pending} className="min-w-0">
            <Field data-invalid={Boolean(passwordError)}>
              <FieldLabel htmlFor={id + "-export-password"}>
                Current password
              </FieldLabel>
              <Input
                id={id + "-export-password"}
                type="password"
                autoComplete="current-password"
                value={password}
                aria-invalid={Boolean(passwordError)}
                aria-describedby={
                  passwordError ? id + "-password-error" : undefined
                }
                onChange={(event) =>
                  onPasswordChange(event.currentTarget.value)
                }
                className="min-h-11"
              />
              <FieldError id={id + "-password-error"}>
                {passwordError}
              </FieldError>
            </Field>
          </fieldset>
          {error ? (
            <Alert role="alert" variant="destructive">
              {error}
            </Alert>
          ) : null}
          <DialogFooter className="mt-0">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={pending}
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button type="submit" className="min-h-11" disabled={pending}>
              {pending ? "Confirming…" : "Confirm password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
