"use client";

import { useCallback, useId, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";

import { afterAccessGroupChange } from "../adapters/access-queries";
import {
  groupErrorMessage,
  groupMadeByLostCreate,
  groupNameError,
} from "../helpers/groups";
import { isUnansweredRequest } from "../helpers/people";
import {
  createAccessGroup,
  listAccessGroups,
  type AccessGroup,
} from "../state/api";
import {
  useAccessDraftRegistration,
  useAccessVerifying,
  verifyingReason,
} from "../state/draft-navigation";
import {
  groupCreateDraftJournal,
  type GroupCreateDraft,
} from "../state/form-drafts";
import { ActionError } from "./editor-conflicts";
import { GroupMemberPicker } from "./group-member-picker";
import { DiscardChangesDialog, TextField } from "./people-fields";

type CreateForm = GroupCreateDraft;
const emptyForm: CreateForm = { name: "", description: "", member_ids: [] };

function isEmpty(form: CreateForm): boolean {
  return (
    form.name === "" && form.description === "" && form.member_ids.length === 0
  );
}

/** Whether a new group's unsaved form is kept in this tab's journal. */
export function hasKeptNewGroup(userId: string): boolean {
  return groupCreateDraftJournal.read(userId) !== null;
}

/**
 * Create a group with a name, a description and its first members. Access
 * is set afterwards in the group's panel, which opens on its Access tab.
 */
export function CreateGroupDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (group: AccessGroup) => void;
}) {
  const id = useId();
  const client = useQueryClient();
  const signedInId = useVerifiedWorkspaceUserId();
  // A new group's form comes back from the journal, for example after Back
  // and Forward.
  const [form, setForm] = useState<CreateForm>(
    () => groupCreateDraftJournal.read(signedInId) ?? emptyForm,
  );
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discardError, setDiscardError] = useState("");
  const verifying = useAccessVerifying();
  const dirty = !isEmpty(form);

  const discard = useCallback(() => {
    if (!groupCreateDraftJournal.discard(signedInId)) return false;
    setForm(emptyForm);
    setNameError(null);
    setSubmitError("");
    setDiscardError("");
    setConfirmDiscard(false);
    onOpenChange(false);
    return true;
  }, [onOpenChange, signedInId]);
  useAccessDraftRegistration("group-create", {
    dirty: open && dirty,
    discard,
    pending,
  });

  function update(patch: Partial<CreateForm>) {
    const next = { ...form, ...patch };
    setForm(next);
    setSubmitError("");
    if (isEmpty(next)) groupCreateDraftJournal.discard(signedInId);
    else groupCreateDraftJournal.write(signedInId, next);
  }

  function requestClose() {
    if (pending) return;
    if (dirty) {
      setDiscardError("");
      setConfirmDiscard(true);
    } else discard();
  }

  function finish(
    created: AccessGroup,
    title: string,
    type: "success" | "info",
  ) {
    groupCreateDraftJournal.discard(signedInId);
    toast.add({ title, type });
    setForm(emptyForm);
    onOpenChange(false);
    onCreated(created);
    void afterAccessGroupChange(client);
  }

  /** The same-name groups, newest first; the IDs tell a new group apart. */
  function sameNameGroups(name: string) {
    return listAccessGroups({
      search: name.trim(),
      sort_by: "created_at",
      sort_order: "desc",
      limit: 100,
      offset: 0,
    });
  }

  /**
   * After a lost answer, the group may exist. Opens it when it does, so a
   * retry never makes a second group with the same name. Without the IDs
   * read before the request, or without an answer now, the person checks.
   */
  async function findLostGroup(
    name: string,
    before: ReadonlySet<string> | null,
  ): Promise<string> {
    const unknown =
      "The group may have been created. Check Groups before you try again.";
    if (!before) return unknown;
    try {
      const page = await sameNameGroups(name);
      const made = groupMadeByLostCreate(page.items, name, before);
      if (!made) return unknown;
      finish(
        made,
        "Group found. It was created before the connection dropped.",
        "info",
      );
      return "";
    } catch {
      return unknown;
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || verifying) return;
    const found = groupNameError(form.name);
    setNameError(found);
    if (found) return;
    setPending(true);
    setSubmitError("");
    // The same-name groups before the request; a lost answer compares
    // against them.
    const before = await sameNameGroups(form.name)
      .then((page) => new Set(page.items.map((item) => item.id)))
      .catch(() => null);
    try {
      const created = await createAccessGroup({
        name: form.name.trim(),
        ...(form.description.trim()
          ? { description: form.description.trim() }
          : {}),
        ...(form.member_ids.length ? { member_ids: form.member_ids } : {}),
      });
      finish(created.data, `${created.data.name} is created`, "success");
    } catch (error) {
      if (isUnansweredRequest(error)) {
        setSubmitError(await findLostGroup(form.name, before));
        return;
      }
      setSubmitError(
        groupErrorMessage(error, "The group could not be created. Try again."),
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
        <DialogContent className="access-ui max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create a group</DialogTitle>
            <DialogDescription>You choose its access next.</DialogDescription>
          </DialogHeader>
          <form
            noValidate
            aria-label="New group"
            className="mt-4 flex flex-col gap-5"
            onSubmit={submit}
          >
            <TextField
              id={`${id}-name`}
              label="Name"
              autoComplete="off"
              required
              maxLength={200}
              value={form.name}
              error={nameError}
              onChange={(name) => {
                setNameError(null);
                update({ name });
              }}
            />
            <Field className="min-w-0">
              <FieldLabel htmlFor={`${id}-description`}>Description</FieldLabel>
              <Textarea
                id={`${id}-description`}
                maxLength={2000}
                rows={2}
                value={form.description}
                onChange={(event) =>
                  update({ description: event.target.value })
                }
              />
            </Field>
            <div className="max-h-[50vh] overflow-y-auto rounded-lg">
              <GroupMemberPicker
                selected={form.member_ids}
                disabled={pending}
                creating
                onChange={(member_ids) => update({ member_ids })}
              />
            </div>
            <ActionError message={submitError} />
            <DialogFooter className="mt-0">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={pending}
                onClick={requestClose}
              >
                Cancel
              </Button>
              <DisabledReason reason={verifying ? verifyingReason : null}>
                <Button
                  type="submit"
                  className="min-h-11"
                  pending={pending}
                  pendingLabel="Creating…"
                >
                  Create group
                </Button>
              </DisabledReason>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <DiscardChangesDialog
        open={confirmDiscard}
        title="Discard this group?"
        description="The details you entered will be lost."
        error={discardError}
        onKeep={() => setConfirmDiscard(false)}
        onDiscard={() => {
          if (!discard())
            setDiscardError(
              "Your draft could not be cleared from this browser. Keep editing, or try again.",
            );
        }}
      />
    </>
  );
}
