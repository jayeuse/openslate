"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  SandboxDialogFooter,
  SandboxDialogHeader,
  sandboxDialogContentClass,
} from "./sandbox-dialog-frame";
import {
  PublishChangeGroups,
  type PublishReviewDesign,
} from "./publish-change-groups";
import type {
  SandboxPublication,
  SandboxPublicationBlocker,
  SandboxPublicationPreview,
} from "../state/api";

type Props = {
  open: boolean;
  expectedRevision: number;
  disabled: boolean;
  /** The draft being reviewed, so field changes can sit under their module. */
  design: PublishReviewDesign;
  /** Trigger settings the server cannot publish, found before the review. */
  localBlockers: readonly SandboxPublicationBlocker[];
  /** Closes the review and opens the thing that blocks publishing. */
  onOpenBlocker: (blocker: SandboxPublicationBlocker) => void;
  onOpenChange: (open: boolean) => void;
  onPendingChange?: (pending: boolean) => void;
  onPreview: () => Promise<SandboxPublicationPreview>;
  onPublish: (input: {
    preview: SandboxPublicationPreview;
    password: string;
    note: string;
    idempotencyKey: string;
  }) => Promise<SandboxPublication>;
  onPublished: (publication: SandboxPublication) => void;
};

export function publicationIdempotencyKey(
  current: string,
  create: () => string,
): string {
  return current || create();
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
}

function errorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code === "stale_revision" || code === "live_state_changed")
    return "The draft changed while you were reviewing it. Close this window, refresh the review, and try again.";
  if (code === "preview_expired" || code === "preview_mismatch")
    return "This review has expired. Refresh the review and confirm again.";
  if (code === "invalid_password")
    return "That password was not accepted. Check it and try again.";
  if (code === "idempotency_mismatch")
    return "This publish attempt no longer matches the original request. Refresh the review and try again.";
  return "We could not confirm this change. Your password and note are still here so you can try again.";
}

export function ReviewPublishDialog({
  open,
  expectedRevision,
  disabled,
  design,
  localBlockers,
  onOpenBlocker,
  onOpenChange,
  onPendingChange,
  onPreview,
  onPublish,
  onPublished,
}: Props) {
  const [preview, setPreview] = useState<SandboxPublicationPreview | null>(
    null,
  );
  const [password, setPassword] = useState("");
  const [note, setNote] = useState("");
  // One request at a time: loading the review, or publishing it.
  const [busy, setBusy] = useState<"review" | "publish" | null>(null);
  const pending = busy !== null;
  const [idempotencyKey, setIdempotencyKey] = useState("");
  // Review errors show above the list; publish errors show in the footer,
  // next to the password and Publish that caused them.
  const [error, setError] = useState("");
  const [publishError, setPublishError] = useState("");
  const [passwordRejected, setPasswordRejected] = useState(false);
  const passwordId = useId();
  const passwordHintId = useId();
  const teamHintId = useId();
  const noteId = useId();
  const blockerId = useId();
  // Each open (and each new draft revision) gets one automatic review. The
  // round number also drops a review that finishes after the dialog closed.
  const round = useRef(0);
  const autoReviewed = useRef<number | null>(null);

  useEffect(() => {
    round.current += 1;
    autoReviewed.current = null;
    if (!open) return;
    setPreview(null);
    setError("");
    setPublishError("");
    setPasswordRejected(false);
    setIdempotencyKey("");
  }, [open, expectedRevision]);
  useEffect(() => onPendingChange?.(pending), [onPendingChange, pending]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);

  async function review() {
    const current = round.current;
    setBusy("review");
    setError("");
    try {
      const next = await onPreview();
      if (round.current === current) setPreview(next);
    } catch (reason) {
      if (round.current === current) setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  }
  useEffect(() => {
    if (!open || disabled || pending) return;
    if (autoReviewed.current === round.current) return;
    autoReviewed.current = round.current;
    void review();
  }, [open, expectedRevision, disabled, pending]);
  async function publish() {
    if (!preview || !password || blockers.length) return;
    setBusy("publish");
    setPublishError("");
    setPasswordRejected(false);
    try {
      const key = publicationIdempotencyKey(idempotencyKey, () =>
        crypto.randomUUID(),
      );
      setIdempotencyKey(key);
      const publication = await onPublish({
        preview,
        password,
        note,
        idempotencyKey: key,
      });
      onPublished(publication);
      setPassword("");
      setNote("");
      onOpenChange(false);
    } catch (reason) {
      setPublishError(errorMessage(reason));
      setPasswordRejected(errorCode(reason) === "invalid_password");
    } finally {
      setBusy(null);
    }
  }
  // The local check names the trigger, so it replaces the server's
  // message for the same trigger.
  const locallyBlocked = new Set(
    localBlockers.map((blocker) => blocker.targetId),
  );
  const blockers = [
    ...localBlockers,
    ...(preview?.blockers ?? []).filter(
      (blocker) => !blocker.targetId || !locallyBlocked.has(blocker.targetId),
    ),
  ];
  const blocked = blockers.length > 0;
  // The password's hint is the team line; a refusal or a blocked review
  // adds its reason beside it.
  const footerHint = publishError
    ? publishError
    : blocked
      ? "Fix the blocked items, then reopen this review."
      : "";
  // Cancel stays available while the review loads; only a publish in flight
  // holds the dialog open.
  const cancel = (
    <Button
      variant="outline"
      className="min-h-11"
      disabled={busy === "publish"}
      onClick={() => onOpenChange(false)}
    >
      Cancel
    </Button>
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => busy !== "publish" && onOpenChange(next)}
    >
      {/* One scroller: the header and footer stay in view (Dialogs in
          Access), so focused controls are never hidden behind them. */}
      <DialogContent className={`${sandboxDialogContentClass} sm:max-w-2xl`}>
        <SandboxDialogHeader
          title={<DialogTitle>Review &amp; Publish</DialogTitle>}
          closeLabel="Close review"
          closeDisabled={busy === "publish"}
          onClose={() => onOpenChange(false)}
        />
        {error ? (
          <Alert role="alert" variant="destructive">
            {error}
          </Alert>
        ) : null}
        {blocked ? (
          <Alert role="alert" variant="destructive">
            <p className="font-medium">Publishing is blocked</p>
            <ul className="mt-2 grid gap-2">
              {blockers.map((blocker, index) => (
                <li
                  key={`${blocker.code}:${blocker.targetId ?? ""}:${blocker.message}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1"
                >
                  <span id={`${blockerId}-${index}`}>{blocker.message}</span>
                  {blocker.targetId ? (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-describedby={`${blockerId}-${index}`}
                      onClick={() => onOpenBlocker(blocker)}
                    >
                      {blocker.code.startsWith("trigger")
                        ? "Open trigger"
                        : "Show in Build"}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}
        {busy === "review" ? (
          <div role="status" className="grid gap-3">
            <p className="text-muted-foreground text-sm">
              Preparing your review…
            </p>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : !preview ? null : (
          <>
            {preview.warnings.length ? (
              <Alert>
                <p className="font-medium">Please note</p>
                <ul className="mt-2 list-inside list-disc">
                  {preview.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            <section>
              <h3 data-slot="section-title" className="font-medium">
                Changes
              </h3>
              {preview.changes.length ? (
                <div className="mt-2">
                  <PublishChangeGroups
                    changes={preview.changes}
                    design={design}
                  />
                </div>
              ) : (
                <p className="text-muted-foreground mt-2 text-sm">
                  No structural changes are waiting to be applied.
                </p>
              )}
            </section>
            {blocked ? null : (
              <>
                {/* Label-left, like the password row below. */}
                <Field className="grid gap-1.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-start sm:gap-3">
                  <FieldLabel htmlFor={noteId} className="sm:pt-2">
                    Note (optional)
                  </FieldLabel>
                  <Textarea
                    id={noteId}
                    value={note}
                    maxLength={1000}
                    onChange={(event) => setNote(event.target.value)}
                    disabled={pending || blocked}
                  />
                </Field>
              </>
            )}
          </>
        )}
        <SandboxDialogFooter>
          {preview ? (
            <>
              {/* The password is its own label-left row (stacked on a
                  phone), pinned above Cancel and Publish. */}
              <Field className="grid gap-1.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-center sm:gap-3">
                <FieldLabel htmlFor={passwordId}>Your password</FieldLabel>
                <Input
                  id={passwordId}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  aria-invalid={passwordRejected || undefined}
                  aria-describedby={
                    footerHint ? `${teamHintId} ${passwordHintId}` : teamHintId
                  }
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setPasswordRejected(false);
                  }}
                  disabled={pending || blocked}
                />
              </Field>
              {/* Hints sit under the field, in its column from 640px. */}
              <div className="-mt-1.5 grid gap-1 text-sm sm:pl-[8.75rem]">
                <p id={teamHintId} className="text-muted-foreground">
                  Your team sees these changes as soon as you publish.
                </p>
                {footerHint ? (
                  <p
                    id={passwordHintId}
                    role={publishError ? "alert" : undefined}
                    className={
                      publishError
                        ? "text-danger-text"
                        : "text-muted-foreground"
                    }
                  >
                    {footerHint}
                  </p>
                ) : null}
              </div>
              <DialogFooter className="mt-0 flex-row justify-end">
                {cancel}
                {/* Waiting only for the password, Publish says so (S26). */}
                <DisabledReason
                  reason={
                    !password && !(disabled || pending || blocked)
                      ? "Enter your password to publish."
                      : null
                  }
                >
                  <Button
                    className="min-h-11"
                    disabled={disabled || pending || blocked || !password}
                    onClick={() => void publish()}
                  >
                    {busy === "publish" ? "Publishing…" : "Publish changes"}
                  </Button>
                </DisabledReason>
              </DialogFooter>
            </>
          ) : (
            <DialogFooter className="mt-0 flex-row justify-end">
              {cancel}
              {busy === "review" ? null : (
                <DisabledReason
                  reason={disabled ? "Finish the current change first." : null}
                >
                  <Button
                    className="min-h-11"
                    disabled={disabled}
                    onClick={() => void review()}
                  >
                    {error ? "Try again" : "Review changes"}
                  </Button>
                </DisabledReason>
              )}
            </DialogFooter>
          )}
        </SandboxDialogFooter>
      </DialogContent>
    </Dialog>
  );
}
