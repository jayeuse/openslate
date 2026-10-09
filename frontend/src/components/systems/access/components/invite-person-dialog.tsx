"use client";
import { useWorkspaceDisplayRegion } from "@/components/use-display-region";

import { useCallback, useId, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";

import { Alert } from "@/components/ui/alert";
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
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";

import {
  afterAccessUserChange,
  invitationSettingsOptions,
} from "../adapters/access-queries";
import {
  defaultGuestDays,
  emailError,
  formatDate,
  GUEST_DAYS_MAX,
  GUEST_DAYS_MIN,
  guestDaysError,
  guestExpiryFromDays,
  peopleErrorMessage,
  roleLabels,
  usernameError,
  usernameFromEmail,
  usernameHint,
} from "../helpers/people";
import { ApiError } from "@/lib/api";
import {
  inviteAccessUser,
  type AccessInvitationCreate,
  type AccessUserRole,
} from "../state/api";
import { useAccessDraftRegistration } from "../state/draft-navigation";
import { SponsorSearchSelect } from "./person-search-select";
import { useAccessCatalog, catalogGroups } from "../hooks/use-access-catalog";
import { Input } from "@/components/ui/input";
import { ActionError } from "./editor-conflicts";
import { DiscardChangesDialog, SelectField, TextField } from "./people-fields";

type InviteForm = {
  email: string;
  /** Null until edited: the username follows the email address. */
  username: string | null;
  display_name: string;
  job_title: string;
  role: AccessUserRole;
  group_ids: string[];
  sponsor_user_id: string;
  /** Null until edited: the days follow the invitation settings. */
  days: string | null;
};

const emptyForm: InviteForm = {
  email: "",
  username: null,
  display_name: "",
  job_title: "",
  role: "member",
  group_ids: [],
  sponsor_user_id: "",
  days: null,
};

type FieldErrors = Partial<
  Record<"email" | "username" | "sponsor" | "days", string>
>;

const roleDescriptions: Record<AccessUserRole, string> = {
  member: "Gets the access of the groups you choose.",
  guest: "Can only read, for a limited time, with a sponsor.",
  admin: "Has full access everywhere and can change people and groups.",
};

export function InvitePersonDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const region = useWorkspaceDisplayRegion();
  const client = useQueryClient();
  const settings = useQuery({ ...invitationSettingsOptions(), enabled: open });
  const [form, setForm] = useState<InviteForm>(emptyForm);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [now] = useState(() => Date.now());

  const username = form.username ?? usernameFromEmail(form.email);
  const days = form.days ?? defaultGuestDays(settings.data);
  const dirty =
    form.email !== "" ||
    form.username !== null ||
    form.display_name !== "" ||
    form.job_title !== "" ||
    form.role !== "member" ||
    form.group_ids.length > 0 ||
    form.sponsor_user_id !== "" ||
    form.days !== null;
  const groupSearch = useAccessCatalog({
    kind: "groups",
    selectedIds: form.group_ids,
    enabled: open && form.role !== "admin",
  });
  const groups = catalogGroups(groupSearch.combined);
  const guestEnds = guestExpiryFromDays(days, new Date(now));

  const reset = useCallback(() => {
    setForm(emptyForm);
    setErrors({});
    setSubmitError("");
    setConfirmDiscard(false);
  }, []);
  const discard = useCallback(() => {
    reset();
    onOpenChange(false);
  }, [onOpenChange, reset]);
  useAccessDraftRegistration("person-invite", open && dirty, discard);

  function update(patch: Partial<InviteForm>) {
    setForm((current) => ({ ...current, ...patch }));
    setSubmitError("");
  }

  function requestClose() {
    if (pending) return;
    if (dirty) setConfirmDiscard(true);
    else discard();
  }

  function validate(): FieldErrors {
    const next: FieldErrors = {};
    const email = emailError(form.email);
    if (email) next.email = email;
    const name = usernameError(username);
    if (name) next.username = name;
    if (form.role === "guest") {
      if (!form.sponsor_user_id) next.sponsor = "Choose a sponsor.";
      const length = guestDaysError(days);
      if (length) next.days = length;
    }
    return next;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;
    const request: AccessInvitationCreate = {
      email: form.email.trim(),
      username: username.trim(),
      role: form.role,
      ...(form.display_name.trim()
        ? { display_name: form.display_name.trim() }
        : {}),
      ...(form.job_title.trim() ? { job_title: form.job_title.trim() } : {}),
      ...(form.role !== "admin" && form.group_ids.length
        ? { group_ids: form.group_ids }
        : {}),
      ...(form.role === "guest"
        ? {
            sponsor_user_id: form.sponsor_user_id,
            expires_at: guestExpiryFromDays(days, new Date()),
          }
        : {}),
    };
    setPending(true);
    setSubmitError("");
    try {
      const response = await inviteAccessUser(request);
      toast.add({
        title: "Invitation sent",
        description: `An invitation email is on its way to ${response.user.email}.`,
        type: "success",
      });
      reset();
      onOpenChange(false);
      void afterAccessUserChange(client);
    } catch (error) {
      setSubmitError(
        error instanceof ApiError && error.status === 502
          ? "The invitation email could not be sent. Try again."
          : peopleErrorMessage(
              error,
              "The invitation could not be sent. Try again.",
            ),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Invite a person</DialogTitle>
            <DialogDescription>
              They get an email with a link to set up their account.
            </DialogDescription>
          </DialogHeader>
          <form
            noValidate
            aria-label="Invitation"
            className="mt-4 flex flex-col gap-5"
            onSubmit={submit}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                id={`${id}-email`}
                label="Email"
                type="email"
                autoComplete="off"
                required
                value={form.email}
                error={errors.email}
                onChange={(email) => update({ email })}
              />
              <TextField
                id={`${id}-username`}
                label="Username"
                autoComplete="off"
                required
                value={username}
                description={usernameHint}
                error={errors.username}
                onChange={(value) => update({ username: value })}
              />
              <TextField
                id={`${id}-name`}
                label="Name"
                autoComplete="off"
                maxLength={200}
                value={form.display_name}
                onChange={(display_name) => update({ display_name })}
              />
              <TextField
                id={`${id}-title`}
                label="Job title"
                autoComplete="off"
                maxLength={200}
                value={form.job_title}
                onChange={(job_title) => update({ job_title })}
              />
            </div>

            <SelectField
              id={`${id}-role`}
              label="Role"
              value={form.role}
              options={(["member", "guest", "admin"] as const).map((role) => ({
                value: role,
                label: roleLabels[role],
              }))}
              description={roleDescriptions[form.role]}
              onChange={(value) => {
                if (
                  value === "member" ||
                  value === "guest" ||
                  value === "admin"
                )
                  update({ role: value });
              }}
            />

            {form.role === "guest" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <SponsorSearchSelect
                  id={`${id}-sponsor`}
                  value={form.sponsor_user_id}
                  error={errors.sponsor}
                  onChange={(sponsor_user_id) => update({ sponsor_user_id })}
                />
                <TextField
                  id={`${id}-days`}
                  label="Access length in days"
                  type="number"
                  inputMode="numeric"
                  min={GUEST_DAYS_MIN}
                  max={GUEST_DAYS_MAX}
                  step={1}
                  value={days}
                  description={
                    guestEnds
                      ? `Access ends ${formatDate(guestEnds, region)}.`
                      : settings.isPending
                        ? "Loading the default length…"
                        : `From ${GUEST_DAYS_MIN} to ${GUEST_DAYS_MAX} days.`
                  }
                  error={errors.days}
                  onChange={(value) => update({ days: value })}
                />
              </div>
            ) : null}

            <FieldSet className="gap-2">
              <FieldLegend className="mb-0">Groups</FieldLegend>
              {form.role === "admin" ? (
                <p className="text-muted-foreground text-sm">
                  Administrators have full access everywhere, so they are not
                  added to groups.
                </p>
              ) : groups.length === 0 && !groupSearch.search ? (
                <p className="text-muted-foreground text-sm">
                  There are no groups yet. Create groups on the Groups tab, then
                  add this person to them.
                </p>
              ) : (
                <>
                  <p className="text-muted-foreground text-sm">
                    Groups give access to departments and modules.
                    {form.role === "guest" ? " Guests can only read." : ""}
                  </p>
                  <Input
                    type="search"
                    aria-label="Search invitation groups"
                    className="min-h-11"
                    value={groupSearch.search}
                    onChange={(event) =>
                      groupSearch.onSearchChange(event.target.value)
                    }
                  />
                  <ul className="grid gap-1 rounded-lg border p-2 sm:max-h-56 sm:grid-cols-2 sm:overflow-y-auto">
                    {groups.map((group) => {
                      const checked = form.group_ids.includes(group.id);
                      return (
                        <li key={group.id} className="min-w-0">
                          <label className="hover:bg-muted flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 text-sm">
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(next) =>
                                update({
                                  group_ids: next
                                    ? [...form.group_ids, group.id]
                                    : form.group_ids.filter(
                                        (item) => item !== group.id,
                                      ),
                                })
                              }
                            />
                            <span className="min-w-0 truncate">
                              {group.name}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
              {groupSearch.loading ? (
                <p role="status">Loading groups…</p>
              ) : null}
              {groupSearch.error ? (
                <div role="alert">
                  <p>{groupSearch.error}</p>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={() => void groupSearch.retry()}
                  >
                    Retry groups
                  </Button>
                </div>
              ) : null}
              {groupSearch.hasMore ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={groupSearch.loadingMore}
                  onClick={() => void groupSearch.loadMore()}
                >
                  Load more groups
                </Button>
              ) : null}
            </FieldSet>

            {settings.isError && form.role === "guest" && form.days === null ? (
              <Alert variant="destructive">
                The default access length could not be loaded. Enter the number
                of days.
              </Alert>
            ) : null}
            <ActionError message={submitError} />

            <DialogFooter className="bg-card sticky -bottom-5 z-10 -mx-5 mt-0 -mb-5 border-t px-5 pt-3 pb-8">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={pending}
                onClick={requestClose}
              >
                Cancel
              </Button>
              <Button type="submit" className="min-h-11" disabled={pending}>
                <Send aria-hidden="true" />
                {pending ? "Sending…" : "Send invitation"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <DiscardChangesDialog
        open={confirmDiscard}
        title="Discard this invitation?"
        description="The details you entered will be lost."
        onKeep={() => setConfirmDiscard(false)}
        onDiscard={discard}
      />
    </>
  );
}
