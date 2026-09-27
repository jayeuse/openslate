"use client";

import { useCallback, useId, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
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

import { accessKeys, afterAccessGroupChange } from "../adapters/access-queries";
import {
  groupErrorMessage,
  groupNameError,
  type MemberOption,
} from "../helpers/groups";
import { createAccessGroup, type AccessGroup } from "../state/api";
import { useAccessDraftRegistration } from "../state/draft-navigation";
import { ActionError } from "./editor-conflicts";
import { GroupMemberPicker } from "./group-member-picker";
import { DiscardChangesDialog, TextField } from "./people-fields";

type CreateForm = { name: string; description: string; member_ids: string[] };
const emptyForm: CreateForm = { name: "", description: "", member_ids: [] };

/**
 * Create a group with a name, a description and its first members. Access
 * is set afterwards in the group's panel, which opens on its Access tab.
 */
export function CreateGroupDialog({
  open,
  onOpenChange,
  memberOptions,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  memberOptions: readonly MemberOption[];
  onCreated: (group: AccessGroup) => void;
}) {
  const id = useId();
  const client = useQueryClient();
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty =
    form.name !== "" || form.description !== "" || form.member_ids.length > 0;

  const discard = useCallback(() => {
    setForm(emptyForm);
    setNameError(null);
    setSubmitError("");
    setConfirmDiscard(false);
    onOpenChange(false);
  }, [onOpenChange]);
  useAccessDraftRegistration("group-create", open && dirty, discard);

  function update(patch: Partial<CreateForm>) {
    setForm((current) => ({ ...current, ...patch }));
    setSubmitError("");
  }

  function requestClose() {
    if (pending) return;
    if (dirty) setConfirmDiscard(true);
    else discard();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const found = groupNameError(form.name);
    setNameError(found);
    if (found) return;
    setPending(true);
    setSubmitError("");
    try {
      const created = await createAccessGroup({
        name: form.name.trim(),
        ...(form.description.trim()
          ? { description: form.description.trim() }
          : {}),
        ...(form.member_ids.length ? { member_ids: form.member_ids } : {}),
      });
      // The panel opens before the list is read again.
      client.setQueryData<AccessGroup[]>(
        accessKeys.groupList("exclude"),
        (groups) => (groups ? [...groups, created.data] : groups),
      );
      toast.add({ title: `${created.data.name} is created`, type: "success" });
      setForm(emptyForm);
      onOpenChange(false);
      onCreated(created.data);
      void afterAccessGroupChange(client);
    } catch (error) {
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
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create a group</DialogTitle>
            <DialogDescription>
              Add its first members now. You choose its access next.
            </DialogDescription>
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
                options={memberOptions}
                selected={form.member_ids}
                disabled={pending}
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
              <Button type="submit" className="min-h-11" disabled={pending}>
                {pending ? "Creating…" : "Create group"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <DiscardChangesDialog
        open={confirmDiscard}
        title="Discard this group?"
        description="The details you entered will be lost."
        onKeep={() => setConfirmDiscard(false)}
        onDiscard={discard}
      />
    </>
  );
}
