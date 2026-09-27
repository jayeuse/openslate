"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  PublishChangeGroups,
  type PublishReviewDesign,
} from "./publish-change-groups";
import type {
  SandboxPublication,
  SandboxPublicationPreview,
} from "../state/api";

type Props = {
  open: boolean;
  expectedRevision: number;
  disabled: boolean;
  /** The draft being reviewed, so field changes can sit under their module. */
  design: PublishReviewDesign;
  localBlockers: readonly string[];
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
  const noteId = useId();
  // Each open (and each new draft revision) gets one automatic review. The
  // round number also drops a review that finishes after the dialog closed.
  const round = useRef(0);
  const autoReviewed = useRef<number | null>(null);
  const localBlocked = localBlockers.length > 0;

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
    if (!open || disabled || localBlocked || pending) return;
    if (autoReviewed.current === round.current) return;
    autoReviewed.current = round.current;
    void review();
  }, [open, expectedRevision, disabled, localBlocked, pending]);
  async function publish() {
    if (
      !preview ||
      !password ||
      preview.blockers.length ||
      localBlockers.length
    )
      return;
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
  const blockers = [
    ...localBlockers,
    ...(preview?.blockers ?? []).map((blocker) => blocker.message),
  ];
  const blocked = blockers.length > 0;
  const footerHint = publishError
    ? publishError
    : blocked
      ? "Publishing is blocked. See the issues above the changes."
      : !password
        ? "Enter your password to publish."
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
      {/* The body scrolls; the footer stays outside it, so focused controls
          are never hidden behind it. */}
      <DialogContent className="flex flex-col overflow-hidden p-0 sm:max-w-2xl">
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-5">
          <DialogHeader>
            <DialogTitle>Review and publish</DialogTitle>
            <DialogDescription>
              Review what will change before applying this draft to your live
              workspace.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <Alert role="alert" variant="destructive">
              {error}
            </Alert>
          ) : null}
          {localBlockers.length ? (
            <Alert role="alert" variant="destructive">
              <p className="font-medium">Fix these trigger settings first</p>
              <ul className="mt-2 list-inside list-disc">
                {localBlockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
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
          ) : !preview ? (
            <Button
              className="min-h-11 justify-self-start"
              disabled={disabled || localBlocked}
              onClick={() => void review()}
            >
              {error ? "Try again" : "Review changes"}
            </Button>
          ) : (
            <>
              {preview.blockers.length ? (
                <Alert role="alert" variant="destructive">
                  <p className="font-medium">Publishing is blocked</p>
                  <ul className="mt-2 list-inside list-disc">
                    {preview.blockers.map((blocker) => (
                      <li key={blocker.message}>{blocker.message}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
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
              <section className="mt-2">
                <h3 className="font-medium">Changes</h3>
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
              <Field>
                <FieldLabel htmlFor={noteId}>Note (optional)</FieldLabel>
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
        </div>
        <div className="border-border grid gap-2 border-t px-5 py-4">
          {preview ? (
            <>
              <p className="text-muted-foreground text-sm">
                Your team sees these changes as soon as you publish.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <Field className="min-w-48 flex-1">
                  <FieldLabel htmlFor={passwordId}>Your password</FieldLabel>
                  <Input
                    id={passwordId}
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    aria-invalid={passwordRejected || undefined}
                    aria-describedby={footerHint ? passwordHintId : undefined}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setPasswordRejected(false);
                    }}
                    disabled={pending || blocked}
                  />
                </Field>
                <div className="flex gap-2">
                  {cancel}
                  <Button
                    className="min-h-11"
                    disabled={disabled || pending || blocked || !password}
                    onClick={() => void publish()}
                  >
                    {busy === "publish" ? "Publishing…" : "Publish changes"}
                  </Button>
                </div>
              </div>
              {footerHint ? (
                <p
                  id={passwordHintId}
                  role={publishError ? "alert" : undefined}
                  className={
                    publishError || blocked
                      ? "text-danger-text text-sm"
                      : "text-muted-foreground text-sm"
                  }
                >
                  {footerHint}
                </p>
              ) : null}
            </>
          ) : (
            <div className="flex justify-end">{cancel}</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
