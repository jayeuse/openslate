"use client";

import { useCallback, useId, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion } from "@/components/ui/loading-region";
import { toast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";

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
import { ActionError } from "./editor-conflicts";
import { TextField } from "./people-fields";

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

/**
 * How long an invitation link works and the starting access length of a new
 * guest. The workspace revision travels with a save; a stale revision shows
 * the newer values and keeps the draft for a second save.
 */
export function InvitationSettings({ titleId }: { titleId: string }) {
  const id = useId();
  const client = useQueryClient();
  const settings = useQuery(invitationSettingsOptions());
  // Only the fields the person edited; the others follow the saved settings,
  // so a newer save by someone else is kept for them.
  const [form, setForm] = useState<Partial<InvitationSettingsForm>>({});
  const [errors, setErrors] = useState<InvitationSettingsErrors>({});
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [pending, setPending] = useState(false);

  const saved = settings.data;
  const values = saved ? { ...settingsFormFrom(saved), ...form } : null;
  const dirty =
    values !== null &&
    saved !== undefined &&
    (values.invitationExpiryDays !== String(saved.invitation_expiry_days) ||
      values.guestDurationDays !== String(saved.guest_duration_days));

  const discard = useCallback(() => {
    setForm({});
    setErrors({});
    setError("");
    setStale(false);
    return true;
  }, []);
  useAccessDraftRegistration("invitation-settings", dirty, discard);

  function update(patch: Partial<InvitationSettingsForm>) {
    setForm((current) => ({ ...current, ...patch }));
    setErrors({});
    setError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!saved || !values || pending) return;
    const found = invitationSettingsErrors(values);
    setErrors(found);
    if (Object.keys(found).length) return;
    const patch = invitationSettingsPatch(saved, values);
    if (!patch) {
      discard();
      return;
    }
    setPending(true);
    setError("");
    try {
      const result = await updateAccessInvitationSettings(patch);
      afterInvitationSettingsChange(client, result);
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
    }
  }

  if (settings.isError && !saved)
    return (
      <div role="alert" className="space-y-3">
        <p className="text-muted-foreground text-sm">
          The invitation settings could not be loaded.
        </p>
        <Button
          variant="outline"
          className="min-h-11"
          onClick={() => void settings.refetch()}
        >
          Retry
        </Button>
      </div>
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
            <Alert variant="warning" role="status">
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
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {dirty || stale ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={pending}
                onClick={discard}
              >
                Discard changes
              </Button>
            ) : null}
            <Button
              type="submit"
              className="min-h-11"
              disabled={!dirty || pending}
            >
              {pending ? "Saving…" : stale ? "Save again" : "Save settings"}
            </Button>
          </div>
        </form>
      ) : null}
    </LoadingRegion>
  );
}
