"use client";
import { useWorkspaceDisplayRegion } from "@/components/use-display-region";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useQueryClient } from "@tanstack/react-query";

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
import { DisabledReason } from "@/components/ui/disabled-reason";
import { toast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
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
  usernameError,
  type PersonDraft,
  type PersonDraftField,
} from "../helpers/people";
import { getAccessUser, updateAccessUser, type AccessUser } from "../state/api";
import { accessDraftJournalGeneration } from "../state/draft-journal-storage";
import {
  useAccessDraftRegistration,
  useAccessVerifying,
  verifyingReason,
} from "../state/draft-navigation";
import {
  beginPersonSubmission,
  clearPersonDraft,
  discardPersonDraft,
  finishPersonSubmission,
  personSubmissionNeedsReload,
  readPersonDraft,
  writePersonDraft,
  type StoredPersonDraft,
} from "../state/person-draft";
import {
  ActionError,
  ConflictDialog,
  DiscardedNotice,
  UncertainDraftWarning,
  type DraftReviewValues,
} from "./editor-conflicts";
import { SponsorSearchSelect } from "./person-search-select";
import { detailRowClassName, SelectField, TextField } from "./people-fields";

type Edit = { baseline: PersonDraft; draft: PersonDraft };
type Conflict = {
  current: PersonDraft;
  conflicts: FieldConflict[];
  choices: Record<string, ConflictChoice | undefined>;
};
type Errors = Partial<
  Record<"username" | "role" | "sponsor" | "expires", string>
>;

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
  const region = useWorkspaceDisplayRegion();
  const client = useQueryClient();
  const signedInId = useVerifiedWorkspaceUserId();
  const [stored] = useState(() => readPersonDraft(signedInId, person.id));
  const ownRecord = stored.value;
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
      : "",
  );
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [confirmOwnRole, setConfirmOwnRole] = useState(false);
  const [discardIssue, setDiscardIssue] = useState("");
  // The edit the Discard button removed, for its inline Undo.
  const [discardedEdit, setDiscardedEdit] = useState<Edit | null>(null);
  // Where focus goes once the bar under the form changes: the Undo after
  // Discard, Save after Undo, and the last edited field after a save, so
  // focus never falls back to the sheet.
  const saveButton = useRef<HTMLButtonElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const lastField = useRef<string | null>(null);
  const focusNext = useRef<"undo" | "save" | "field" | null>(null);
  useEffect(() => {
    const next = focusNext.current;
    // A save's field focus waits until the save has fully ended.
    if (!next || (next === "field" && pending)) return;
    const element =
      next === "undo"
        ? undoButton.current
        : next === "save"
          ? saveButton.current
          : lastField.current
            ? document.getElementById(lastField.current)
            : null;
    if (!element?.isConnected) return;
    focusNext.current = null;
    element.focus();
  });
  const verifying = useAccessVerifying();
  // After "Change my role", focus returns to Role once the save ends (Role
  // is disabled while it runs).
  const focusRoleAfterSave = useRef(false);
  useEffect(() => {
    if (pending || !focusRoleAfterSave.current) return;
    focusRoleAfterSave.current = false;
    document.getElementById(`${id}-role`)?.focus();
  }, [pending, id]);
  // Advances when the person discards the draft; a save that answers
  // afterwards writes nothing back.
  const discarded = useRef(0);
  // A save that answers after the editor closed (Back, a section switch)
  // keeps its draft in the journal for the return.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const current = draftFromUser(person);
  const values = edit?.draft ?? current;
  const dirty = edit !== null;
  const guest = person.role === "guest";
  const self = person.id === signedInId;
  const peopleById = new Map(people.map((item) => [item.id, item]));

  const discard = useCallback(() => {
    if (!discardPersonDraft(signedInId, person.id)) return false;
    discarded.current += 1;
    setEdit(null);
    setDiscardedEdit(null);
    setErrors({});
    setError("");
    return true;
  }, [signedInId, person.id]);
  useAccessDraftRegistration("person-editor", {
    dirty: dirty && uncertain === null,
    discard,
    pending,
  });

  const fieldIds: Record<PersonDraftField, string> = {
    display_name: `${id}-name`,
    username: `${id}-username`,
    job_title: `${id}-title`,
    role: `${id}-role`,
    sponsor_user_id: `${id}-sponsor`,
    expires_on: `${id}-expires`,
  };

  function update(patch: Partial<PersonDraft>) {
    if (uncertain || pending) return;
    const field = Object.keys(patch)[0] as PersonDraftField | undefined;
    if (field) lastField.current = fieldIds[field];
    const baseline = edit?.baseline ?? current;
    const draft = { ...values, ...patch };
    setError("");
    setDiscardIssue("");
    setDiscardedEdit(null);
    setErrors({});
    if (samePersonDraft(draft, baseline)) {
      clearPersonDraft(signedInId, person.id);
      setEdit(null);
      return;
    }
    setEdit({ baseline, draft });
    if (!writePersonDraft(signedInId, { personId: person.id, baseline, draft }))
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
      return value ? formatDate(endOfDateInput(value), region) : "";
    return value;
  }

  async function send(
    baseline: PersonDraft,
    resolved: PersonDraft,
    retry: boolean,
  ): Promise<void> {
    const patch = personPatch(baseline, resolved);
    if (!Object.keys(patch).length) {
      clearPersonDraft(signedInId, person.id);
      setEdit(null);
      toast.add({ title: "Already up to date", type: "info" });
      void afterAccessUserChange(client);
      return;
    }
    const record = { personId: person.id, baseline, draft: resolved };
    const journaled = beginPersonSubmission(signedInId, record);
    const run = discarded.current;
    const journal = accessDraftJournalGeneration();
    try {
      await updateAccessUser(person.id, patch);
    } catch (caught) {
      if (isUnansweredRequest(caught)) {
        // The journal keeps the unanswered save for review on return.
        if (discarded.current !== run || !mounted.current) return;
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
      finishPersonSubmission(signedInId, person.id, true);
      // A discard, a sign-out or an organization switch since the save began
      // wins; otherwise the draft goes back to the journal.
      if (
        discarded.current !== run ||
        accessDraftJournalGeneration() !== journal
      )
        return;
      writePersonDraft(signedInId, record);
      if (!mounted.current) return;
      setEdit({ baseline, draft: resolved });
      if (caught instanceof ApiError && caught.status === 412 && retry) {
        // Someone changed this person between the check and the save.
        await review({ baseline, draft: resolved }, false);
        return;
      }
      const message =
        caught instanceof ApiError && caught.status === 412
          ? "This person changed while you were saving. Check the details and save again."
          : peopleErrorMessage(
              caught,
              "The changes could not be saved. Try again.",
            );
      // A refused role change (the last administrator, the owner) shows
      // beside Role. A username in use is the other conflict a save meets.
      if (
        caught instanceof ApiError &&
        caught.status === 409 &&
        "role" in patch &&
        !("username" in patch)
      )
        setErrors({ role: message });
      else setError(message);
      void afterAccessUserChange(client);
      return;
    }
    finishPersonSubmission(signedInId, person.id, true);
    if (discarded.current !== run) return;
    setEdit(null);
    if (mounted.current && !focusRoleAfterSave.current)
      focusNext.current = "field";
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
    if (!edit || pending || uncertain || verifying) return;
    const found = validate(edit.draft);
    setErrors(found);
    if (Object.keys(found).length) return;
    // Changing one's own role can end one's own access, so it asks first.
    if (self && edit.draft.role !== current.role) {
      setConfirmOwnRole(true);
      return;
    }
    await save(edit);
  }

  async function save(target: Edit) {
    setPending(true);
    setError("");
    try {
      await review(target, true);
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
            listFresh && !personSubmissionNeedsReload(signedInId, person.id)
          }
          pending={pending}
          onResolve={() => {
            if (finishPersonSubmission(signedInId, person.id, false))
              setUncertain(null);
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
      <div className="flex flex-col gap-4 md:gap-2">
        <TextField
          layout="row"
          id={`${id}-name`}
          label="Name"
          autoComplete="off"
          maxLength={200}
          value={values.display_name}
          disabled={pending}
          onChange={(display_name) => update({ display_name })}
        />
        <TextField
          layout="row"
          id={`${id}-username`}
          label="Username"
          autoComplete="off"
          value={values.username}
          disabled={pending}
          error={errors.username}
          onChange={(username) => update({ username })}
        />
        <TextField
          layout="row"
          id={`${id}-title`}
          label="Job title"
          autoComplete="off"
          maxLength={200}
          value={values.job_title}
          disabled={pending}
          onChange={(job_title) => update({ job_title })}
        />
        {guest ? (
          <div
            className={cn("flex min-w-0 flex-col gap-2", detailRowClassName)}
          >
            {/* Read-only, so plain text; it takes the field-label type hook
                so it reads like the other labels in the column. */}
            <p
              data-slot="field-label"
              className="md:text-muted-foreground text-sm font-medium"
            >
              Role
            </p>
            <p className="flex min-h-11 items-center text-sm md:min-h-10">
              {roleLabels.guest}
            </p>
            <p className="text-muted-foreground text-sm md:col-start-2">
              A guest stays a guest. To give more access, invite them as a
              member.
            </p>
          </div>
        ) : (
          <SelectField
            layout="row"
            id={`${id}-role`}
            label="Role"
            value={values.role}
            disabled={pending}
            error={errors.role}
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
            <SponsorSearchSelect
              layout="row"
              id={`${id}-sponsor`}
              value={values.sponsor_user_id}
              disabled={pending}
              error={errors.sponsor}
              onChange={(sponsor_user_id) => update({ sponsor_user_id })}
            />
            <TextField
              layout="row"
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
      <ActionError message={discardIssue} title={null} />
      {dirty ? (
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={pending}
            onClick={() => {
              const removed = edit;
              if (!discard()) {
                setDiscardIssue(
                  "Your draft could not be cleared from this browser. Keep editing, or try again.",
                );
                return;
              }
              setDiscardIssue("");
              setDiscardedEdit(removed);
              focusNext.current = "undo";
            }}
          >
            Discard changes
          </Button>
          <DisabledReason reason={verifying ? verifyingReason : null}>
            <Button
              ref={saveButton}
              type="submit"
              className="min-h-11"
              pending={pending}
              pendingLabel="Saving…"
            >
              Save changes
            </Button>
          </DisabledReason>
        </div>
      ) : discardedEdit ? (
        <DiscardedNotice
          undoRef={undoButton}
          onUndo={() => {
            const kept = discardedEdit;
            setDiscardedEdit(null);
            if (edit || pending || uncertain) return;
            focusNext.current = "save";
            setEdit(kept);
            if (
              !writePersonDraft(signedInId, {
                personId: person.id,
                ...kept,
              })
            )
              setJournalIssue(
                "This browser cannot keep your draft, so unsaved changes will be lost if the page reloads.",
              );
          }}
        />
      ) : null}
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
      <AlertDialog
        open={confirmOwnRole}
        onOpenChange={(open) => !open && setConfirmOwnRole(false)}
      >
        <AlertDialogContent
          className="access-ui"
          finalFocus={() => !focusRoleAfterSave.current}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Change your own role?</AlertDialogTitle>
            <AlertDialogDescription>
              You will lose access to Access.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setConfirmOwnRole(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              onClick={() => {
                if (!edit || verifying) return;
                focusRoleAfterSave.current = true;
                setConfirmOwnRole(false);
                void save(edit);
              }}
            >
              Change my role
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
