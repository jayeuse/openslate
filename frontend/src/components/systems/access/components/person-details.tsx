"use client";

import { useCallback, useId, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";

import { afterAccessUserChange } from "../adapters/access-queries";
import type { ConflictChoice, FieldConflict } from "../helpers/editor-helpers";
import {
  dateInputValue,
  draftFromUser,
  formatDate,
  endOfDateInput,
  isUnansweredRequest,
  peopleErrorMessage,
  personConflicts,
  personName,
  personPatch,
  resolvePersonDraft,
  roleLabels,
  samePersonDraft,
  sponsorOptions,
  usernameError,
  usernameHint,
  type PersonDraft,
  type PersonDraftField,
} from "../helpers/people";
import { getAccessUser, updateAccessUser, type AccessUser } from "../state/api";
import { accessDraftSubmissionNeedsReload } from "../state/draft-journal-storage";
import { useAccessDraftRegistration } from "../state/draft-navigation";
import {
  beginPersonSubmission,
  clearPersonDraft,
  finishPersonSubmission,
  readPersonDraft,
  writePersonDraft,
  type StoredPersonDraft,
} from "../state/person-draft";
import {
  ActionError,
  ConflictDialog,
  UncertainDraftWarning,
  type DraftReviewValues,
} from "./editor-conflicts";
import { SelectField, TextField } from "./people-fields";

type Edit = { baseline: PersonDraft; draft: PersonDraft };
type Conflict = {
  current: PersonDraft;
  conflicts: FieldConflict[];
  choices: Record<string, ConflictChoice | undefined>;
};
type Errors = Partial<Record<"username" | "sponsor" | "expires", string>>;

function today(): string {
  return dateInputValue(new Date().toISOString());
}

function validate(draft: PersonDraft): Errors {
  const errors: Errors = {};
  const username = usernameError(draft.username);
  if (username) errors.username = username;
  if (draft.role === "guest") {
    if (!draft.sponsor_user_id) errors.sponsor = "Choose a sponsor.";
    const ends = endOfDateInput(draft.expires_on);
    if (!ends || Date.parse(ends) <= Date.now())
      errors.expires = "Choose today or a later date.";
  }
  return errors;
}

/**
 * The editable details of one person. It owns the draft: unsaved changes
 * live in the tab's journal, a save first re-reads the person and asks about
 * fields someone else changed, and a save that got no answer is held for
 * review instead of being sent again.
 */
export function PersonDetails({
  person,
  people,
  listFresh,
}: {
  person: AccessUser;
  people: readonly AccessUser[];
  /** The directory holds a read that finished after any earlier save. */
  listFresh: boolean;
}) {
  const id = useId();
  const client = useQueryClient();
  const signedInId = useVerifiedWorkspaceUserId();
  const [stored] = useState(() => readPersonDraft(signedInId));
  const ownRecord = stored.value?.personId === person.id ? stored.value : null;
  const [edit, setEdit] = useState<Edit | null>(() =>
    ownRecord && stored.status === "ready"
      ? { baseline: ownRecord.baseline, draft: ownRecord.draft }
      : null,
  );
  const [uncertain, setUncertain] = useState<StoredPersonDraft | null>(() =>
    ownRecord && stored.status === "uncertain" ? ownRecord : null,
  );
  const [journalIssue, setJournalIssue] = useState(() =>
    stored.status === "invalid"
      ? "A saved draft could not be restored safely, so it was not used."
      : stored.status === "uncertain" && !ownRecord
        ? "A change to another person may not have been saved. Open that person to review it before you edit here."
        : "",
  );
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [now] = useState(() => Date.now());

  const current = draftFromUser(person);
  const values = edit?.draft ?? current;
  const dirty = edit !== null;
  const guest = person.role === "guest";
  const peopleById = new Map(people.map((item) => [item.id, item]));
  const sponsors = sponsorOptions(people, now);
  const sponsorListed = sponsors.some(
    (option) => option.value === values.sponsor_user_id,
  );
  const sponsor = peopleById.get(values.sponsor_user_id);

  const discard = useCallback(() => {
    clearPersonDraft(signedInId);
    setEdit(null);
    setErrors({});
    setError("");
    return true;
  }, [signedInId]);
  useAccessDraftRegistration(
    "person-editor",
    dirty && uncertain === null,
    discard,
  );

  function update(patch: Partial<PersonDraft>) {
    if (uncertain || pending) return;
    const baseline = edit?.baseline ?? current;
    const draft = { ...values, ...patch };
    setError("");
    setErrors({});
    if (samePersonDraft(draft, baseline)) {
      clearPersonDraft(signedInId);
      setEdit(null);
      return;
    }
    setEdit({ baseline, draft });
    // An unresolved save of another person blocks the journal; keep that
    // notice rather than replacing it.
    if (
      !writePersonDraft(signedInId, { personId: person.id, baseline, draft }) &&
      stored.status !== "uncertain"
    )
      setJournalIssue(
        "This browser cannot keep your draft, so unsaved changes will be lost if the page reloads.",
      );
  }

  function describe(field: PersonDraftField, value: string): string {
    if (field === "role")
      return value === "admin" || value === "member" || value === "guest"
        ? roleLabels[value]
        : value;
    if (field === "sponsor_user_id") {
      const match = peopleById.get(value);
      return match ? personName(match) : value ? "Unavailable" : "";
    }
    if (field === "expires_on")
      return value ? formatDate(endOfDateInput(value)) : "";
    return value;
  }

  async function send(
    baseline: PersonDraft,
    resolved: PersonDraft,
    retry: boolean,
  ): Promise<void> {
    const patch = personPatch(baseline, resolved);
    if (!Object.keys(patch).length) {
      clearPersonDraft(signedInId);
      setEdit(null);
      toast.add({ title: "Already up to date", type: "info" });
      void afterAccessUserChange(client);
      return;
    }
    const record = { personId: person.id, baseline, draft: resolved };
    const journaled = beginPersonSubmission(signedInId, record);
    try {
      await updateAccessUser(person.id, patch);
    } catch (caught) {
      if (isUnansweredRequest(caught)) {
        if (journaled) {
          setEdit(null);
          setUncertain(record);
        } else {
          // Without a journal there is nothing to hold; keep the draft and
          // ask for a check before another save.
          setError(
            "The save got no answer, so it may have completed. Check this person before you save again.",
          );
          void afterAccessUserChange(client);
        }
        return;
      }
      finishPersonSubmission(signedInId, true);
      writePersonDraft(signedInId, record);
      setEdit({ baseline, draft: resolved });
      if (caught instanceof ApiError && caught.status === 412 && retry) {
        // Someone changed this person between the check and the save.
        await review({ baseline, draft: resolved }, false);
        return;
      }
      setError(
        caught instanceof ApiError && caught.status === 412
          ? "This person changed while you were saving. Check the details and save again."
          : peopleErrorMessage(
              caught,
              "The changes could not be saved. Try again.",
            ),
      );
      void afterAccessUserChange(client);
      return;
    }
    finishPersonSubmission(signedInId, true);
    setEdit(null);
    toast.add({ title: "Changes saved", type: "success" });
    void afterAccessUserChange(client);
  }

  /** Re-read the person, then save or ask about fields both sides changed. */
  async function review(target: Edit, retry: boolean): Promise<void> {
    const fresh = await getAccessUser(person.id);
    const saved = draftFromUser(fresh);
    const conflicts = personConflicts(
      saved,
      target.baseline,
      target.draft,
      describe,
    );
    if (conflicts.length) {
      setConflict({ current: saved, conflicts, choices: {} });
      return;
    }
    await send(
      saved,
      resolvePersonDraft(saved, target.baseline, target.draft, {}),
      retry,
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!edit || pending || uncertain) return;
    const found = validate(edit.draft);
    setErrors(found);
    if (Object.keys(found).length) return;
    setPending(true);
    setError("");
    try {
      await review(edit, true);
    } catch (caught) {
      setError(
        peopleErrorMessage(
          caught,
          "The changes could not be saved. Try again.",
        ),
      );
    } finally {
      setPending(false);
    }
  }

  async function continueAfterConflict() {
    if (!conflict || !edit) return;
    const resolved = resolvePersonDraft(
      conflict.current,
      edit.baseline,
      edit.draft,
      conflict.choices,
    );
    const baseline = conflict.current;
    setConflict(null);
    setPending(true);
    try {
      await send(baseline, resolved, false);
    } finally {
      setPending(false);
    }
  }

  function reviewValues(draft: PersonDraft): DraftReviewValues {
    return {
      name: draft.display_name || draft.username,
      description: draft.job_title,
      entries: [
        { id: "username", label: `Username: ${draft.username}` },
        { id: "role", label: `Role: ${describe("role", draft.role)}` },
        ...(draft.role === "guest"
          ? [
              {
                id: "sponsor",
                label: `Sponsor: ${describe("sponsor_user_id", draft.sponsor_user_id) || "None"}`,
              },
              {
                id: "expires",
                label: `Access ends: ${describe("expires_on", draft.expires_on) || "None"}`,
              },
            ]
          : []),
      ],
    };
  }

  if (uncertain)
    return (
      <div className="flex flex-col gap-4">
        {journalIssue ? (
          <Alert variant="warning" role="status">
            {journalIssue}
          </Alert>
        ) : null}
        <UncertainDraftWarning
          subject="person"
          currentSummary="Compare your saved change with this person now. If it is not there, discard it and make the change again."
          savedValues={reviewValues(uncertain.draft)}
          currentValues={reviewValues(current)}
          entriesLabel="Details"
          canResolve={
            listFresh &&
            !accessDraftSubmissionNeedsReload(signedInId, "identity")
          }
          pending={pending}
          onResolve={() => {
            if (finishPersonSubmission(signedInId, false)) setUncertain(null);
            else
              setJournalIssue(
                "The saved change could not be cleared from this browser. Try again.",
              );
          }}
        />
      </div>
    );

  return (
    <form
      noValidate
      aria-label="Details"
      className="flex flex-col gap-4"
      onSubmit={submit}
    >
      {journalIssue ? (
        <Alert variant="warning" role="status">
          {journalIssue}
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          id={`${id}-name`}
          label="Name"
          autoComplete="off"
          maxLength={200}
          value={values.display_name}
          disabled={pending}
          onChange={(display_name) => update({ display_name })}
        />
        <TextField
          id={`${id}-username`}
          label="Username"
          autoComplete="off"
          value={values.username}
          disabled={pending}
          description={usernameHint}
          error={errors.username}
          onChange={(username) => update({ username })}
        />
        <TextField
          id={`${id}-title`}
          label="Job title"
          autoComplete="off"
          maxLength={200}
          value={values.job_title}
          disabled={pending}
          onChange={(job_title) => update({ job_title })}
        />
        {guest ? (
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-sm font-medium">Role</p>
            <p className="flex min-h-11 items-center text-sm">
              {roleLabels.guest}
            </p>
            <p className="text-muted-foreground text-sm">
              A guest stays a guest. To give more access, invite them as a
              member.
            </p>
          </div>
        ) : (
          <SelectField
            id={`${id}-role`}
            label="Role"
            value={values.role}
            disabled={pending}
            options={[
              { value: "member", label: roleLabels.member },
              { value: "admin", label: roleLabels.admin },
            ]}
            description={
              values.role === "admin" && current.role !== "admin"
                ? "Administrators have full access everywhere and are not group members."
                : values.role === "member" && current.role === "admin"
                  ? "This person will have only the access their groups give."
                  : undefined
            }
            onChange={(role) => {
              if (role === "admin" || role === "member") update({ role });
            }}
          />
        )}
        {guest ? (
          <>
            <SelectField
              id={`${id}-sponsor`}
              label="Sponsor"
              value={values.sponsor_user_id}
              disabled={pending}
              options={[
                ...(sponsorListed
                  ? []
                  : [
                      {
                        value: values.sponsor_user_id,
                        label: sponsor
                          ? `${personName(sponsor)} (not active)`
                          : "Choose a sponsor",
                      },
                    ]),
                ...sponsors,
              ]}
              error={errors.sponsor}
              onChange={(sponsor_user_id) => update({ sponsor_user_id })}
            />
            <TextField
              id={`${id}-expires`}
              label="Access ends"
              type="date"
              min={today()}
              value={values.expires_on}
              disabled={pending}
              error={errors.expires}
              onChange={(expires_on) => update({ expires_on })}
            />
          </>
        ) : null}
      </div>
      <ActionError message={error} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {dirty ? (
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
        <Button type="submit" className="min-h-11" disabled={!dirty || pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>
      <ConflictDialog
        open={conflict !== null}
        title="This person changed"
        conflicts={conflict?.conflicts ?? []}
        choices={conflict?.choices ?? {}}
        onChoice={(field, choice) =>
          setConflict((value) =>
            value
              ? { ...value, choices: { ...value.choices, [field]: choice } }
              : value,
          )
        }
        onCancel={() => setConflict(null)}
        onContinue={() => void continueAfterConflict()}
      />
    </form>
  );
}
