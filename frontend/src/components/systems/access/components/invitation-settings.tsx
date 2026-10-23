"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import {
  Dialog,
  DialogCloseButton,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion } from "@/components/ui/loading-region";
import { toast } from "@/components/ui/toast";
import { reportUndoable } from "@/lib/feedback";
import { ApiError } from "@/lib/api";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";

import {
  afterInvitationSettingsChange,
  invitationSettingsOptions,
} from "../adapters/access-queries";
import {
  invitationSettingsErrors,
  invitationSettingsPatch,
  settingsFormFrom,
  SETTINGS_DAYS_MAX,
  SETTINGS_DAYS_MIN,
  type InvitationSettingsErrors,
  type InvitationSettingsForm,
} from "../helpers/overview";
import { updateAccessInvitationSettings } from "../state/api";
import { useAccessDraftRegistration } from "../state/draft-navigation";
import { invitationSettingsDraftJournal } from "../state/form-drafts";
import { ActionError } from "./editor-conflicts";
import { TextField } from "./people-fields";
import { ReadError } from "./read-error";

function isStaleRevision(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  const details: unknown = error.details;
  return (
    typeof details === "object" &&
    details !== null &&
    "code" in details &&
    details.code === "stale_revision"
  );
}

function days(count: number) {
  return `${count} ${count === 1 ? "day" : "days"}`;
}

/** Unsaved invitation settings wait in the journal, for example after Back. */
export function hasKeptInvitationSettings(userId: string): boolean {
  return invitationSettingsDraftJournal.read(userId) !== null;
}

/**
 * Invitation settings in a small dialog beside Invite person (A4): they
 * apply to the invitations sent from People. Closing keeps unsaved values
 * in the journal; the next open shows them again.
 */
export function InvitationSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const titleId = useId();
  // A save in progress keeps the dialog open: its answer lands here.
  // The request starts before the next render, so close reads a ref.
  const [saving, setSaving] = useState(false);
  const savingNow = useRef(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && savingNow.current) return;
        onOpenChange(next);
      }}
    >
      <DialogContent aria-labelledby={titleId} className="access-ui max-w-lg">
        <DialogCloseButton disabled={saving} />
        <DialogHeader>
          <DialogTitle id={titleId}>Invitation settings</DialogTitle>
          <DialogDescription>
            These apply to the invitations you send from now on.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4">
          <InvitationSettings
            titleId={titleId}
            onPendingChange={(pending) => {
              savingNow.current = pending;
              setSaving(pending);
            }}
            onDiscarded={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
            onRestored={() => onOpenChange(true)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * How long an invitation link works and the starting access length of a new
 * guest. The workspace revision travels with a save; a stale revision shows
 * the newer values and keeps the draft for a second save.
 */
export function InvitationSettings({
  titleId,
  onPendingChange,
  onDiscarded,
  onRestored,
  onCancel,
}: {
  titleId: string;
  /** Told when a save starts and ends. */
  onPendingChange?: (pending: boolean) => void;
  /** Discard ends the edit; a dialog closes. */
  onDiscarded?: () => void;
  /** Undo brought the edits back after the form closed; a dialog reopens. */
  onRestored?: () => void;
  /** A dialog's Cancel: closes and keeps unsaved values for the next open. */
  onCancel?: () => void;
}) {
  const id = useId();
  const client = useQueryClient();
  const signedInId = useVerifiedWorkspaceUserId();
  const settings = useQuery(invitationSettingsOptions());
  // Only the fields the person edited; the others follow the saved settings,
  // so a newer save by someone else is kept for them. Edits come back from
  // the journal, for example after Back and Forward.
  const [form, setForm] = useState<Partial<InvitationSettingsForm>>(
    () => invitationSettingsDraftJournal.read(signedInId) ?? {},
  );
  const [errors, setErrors] = useState<InvitationSettingsErrors>({});
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [pending, setPending] = useState(false);
  const [discardIssue, setDiscardIssue] = useState("");
  // Undo runs from a notice after later renders, so it reads the newest form.
  const latestForm = useRef(form);
  const mounted = useRef(false);
  useEffect(() => {
    latestForm.current = form;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const saved = settings.data;
  const values = saved ? { ...settingsFormFrom(saved), ...form } : null;
  const dirty =
    values !== null &&
    saved !== undefined &&
    (values.invitationExpiryDays !== String(saved.invitation_expiry_days) ||
      values.guestDurationDays !== String(saved.guest_duration_days));

  const discard = useCallback(() => {
    if (!invitationSettingsDraftJournal.discard(signedInId)) return false;
    setForm({});
    setErrors({});
    setError("");
    setStale(false);
    return true;
  }, [signedInId]);
  useAccessDraftRegistration("invitation-settings", {
    dirty,
    discard,
    pending,
  });

  /**
   * Undo for Discard: brings the edits back unless newer ones exist. When
   * the form has closed, the journal keeps them and the form opens again.
   */
  function restore(removed: Partial<InvitationSettingsForm>) {
    if (!mounted.current) {
      if (invitationSettingsDraftJournal.read(signedInId) !== null) return;
      invitationSettingsDraftJournal.write(signedInId, removed);
      onRestored?.();
      return;
    }
    if (Object.keys(latestForm.current).length) return;
    setForm(removed);
    invitationSettingsDraftJournal.write(signedInId, removed);
  }

  function update(patch: Partial<InvitationSettingsForm>) {
    const next = { ...form, ...patch };
    setForm(next);
    setErrors({});
    setError("");
    const unchanged =
      saved !== undefined &&
      (next.invitationExpiryDays ?? String(saved.invitation_expiry_days)) ===
        String(saved.invitation_expiry_days) &&
      (next.guestDurationDays ?? String(saved.guest_duration_days)) ===
        String(saved.guest_duration_days);
    if (unchanged) invitationSettingsDraftJournal.discard(signedInId);
    else invitationSettingsDraftJournal.write(signedInId, next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Save at rest is aria-disabled (it says why), so Enter in a field
    // still submits; with no change there is nothing to send.
    if (!saved || !values || pending || !dirty) return;
    const found = invitationSettingsErrors(values);
    setErrors(found);
    if (Object.keys(found).length) return;
    const patch = invitationSettingsPatch(saved, values);
    if (!patch) {
      discard();
      return;
    }
    setPending(true);
    onPendingChange?.(true);
    setError("");
    try {
      const result = await updateAccessInvitationSettings(patch);
      afterInvitationSettingsChange(client, result);
      invitationSettingsDraftJournal.discard(signedInId);
      setForm({});
      setStale(false);
      toast.add({ title: "Invitation settings saved", type: "success" });
    } catch (caught) {
      if (isStaleRevision(caught)) {
        // Read the newer settings; the next save carries their revision.
        await settings.refetch();
        setStale(true);
        return;
      }
      setError(
        caught instanceof ApiError && caught.status === 403
          ? "Only administrators can change these settings. Reload the page to check your access."
          : "The settings could not be saved. Try again.",
      );
    } finally {
      setPending(false);
      onPendingChange?.(false);
    }
  }

  if (settings.isError && !saved)
    return (
      <ReadError
        message="The invitation settings could not be loaded."
        retry={() => void settings.refetch()}
      />
    );

  return (
    <LoadingRegion
      loading={!values}
      label="Loading invitation settings…"
      skeleton={
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-[4.5rem] w-full" />
          <Skeleton className="h-[4.5rem] w-full" />
        </div>
      }
    >
      {values && saved ? (
        <form
          noValidate
          aria-labelledby={titleId}
          className="flex flex-col gap-4"
          onSubmit={submit}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              id={`${id}-expiry`}
              label="Invitation link works for (days)"
              type="number"
              inputMode="numeric"
              min={SETTINGS_DAYS_MIN}
              max={SETTINGS_DAYS_MAX}
              step={1}
              value={values.invitationExpiryDays}
              disabled={pending}
              description="After this, the person needs a new invitation."
              error={errors.invitationExpiryDays}
              onChange={(invitationExpiryDays) =>
                update({ invitationExpiryDays })
              }
            />
            <TextField
              id={`${id}-guest`}
              label="Guest access length (days)"
              type="number"
              inputMode="numeric"
              min={SETTINGS_DAYS_MIN}
              max={SETTINGS_DAYS_MAX}
              step={1}
              value={values.guestDurationDays}
              disabled={pending}
              description="The starting length when you invite a guest."
              error={errors.guestDurationDays}
              onChange={(guestDurationDays) => update({ guestDurationDays })}
            />
          </div>
          {stale ? (
            <Alert variant="destructive">
              <div className="space-y-1">
                <p className="font-medium">
                  Someone else changed these settings
                </p>
                <p>
                  Now saved: invitation links work for{" "}
                  {days(saved.invitation_expiry_days)}, and guests start with{" "}
                  {days(saved.guest_duration_days)}. Save again to use your
                  values, or discard them.
                </p>
              </div>
            </Alert>
          ) : null}
          <ActionError message={error} />
          <ActionError message={discardIssue} title={null} />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {onCancel ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={pending}
                onClick={onCancel}
              >
                Cancel
              </Button>
            ) : null}
            {dirty || stale ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={pending}
                onClick={() => {
                  const removed = form;
                  if (!discard()) {
                    setDiscardIssue(
                      "Your draft could not be cleared from this browser. Keep editing, or try again.",
                    );
                    return;
                  }
                  setDiscardIssue("");
                  reportUndoable("Changes discarded", () => restore(removed));
                  onDiscarded?.();
                }}
              >
                Discard changes
              </Button>
            ) : null}
            <DisabledReason
              reason={!dirty && !pending ? "No changes to save." : null}
            >
              <Button
                type="submit"
                className="min-h-11"
                disabled={!dirty}
                pending={pending}
                pendingLabel="Saving…"
              >
                {stale ? "Save again" : "Save settings"}
              </Button>
            </DisabledReason>
          </div>
        </form>
      ) : null}
    </LoadingRegion>
  );
}
