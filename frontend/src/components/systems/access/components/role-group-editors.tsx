"use client";

import { useState } from "react";
import { AlertCircle, ShieldCheck, Users } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { AccessController } from "../state/controller";
import { useAccessDraftRegistration } from "../state/draft-navigation";
import {
  clearAccessGroupDraft,
  clearAccessRoleDraft,
  writeAccessGroupDraft,
  writeAccessRoleDraft,
  type AccessGroupDraft,
  type AccessRoleDraft,
} from "../state/draft-journal";
import { useVerifiedWorkspaceUserId } from "../../shared/runtime/workspace-identity";
import {
  changedPatch,
  hasThreeWayConflict,
  resolveThreeWayValue,
  sameList,
  type ConflictChoice,
  type EditorIntent,
  type FieldConflict,
} from "../helpers/editor-helpers";
import type { Role } from "../domain/model";
import type { AccessGroup } from "../domain/policy";

type EditorProps<T> = {
  controller: AccessController;
  draft: T | null;
  intent: EditorIntent;
  onClose: () => void;
};

function ConflictDialog({
  open,
  title,
  conflicts,
  choices,
  onChoice,
  onCancel,
  onContinue,
}: {
  open: boolean;
  title: string;
  conflicts: FieldConflict[];
  choices: Record<string, ConflictChoice | undefined>;
  onChoice: (field: string, choice: ConflictChoice) => void;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const resolved = conflicts.every((conflict) => Boolean(choices[conflict.id]));
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            These fields changed after you opened the editor. Choose which value
            to keep for each field.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {conflicts.map((conflict) => {
            const choice = choices[conflict.id];
            return (
              <FieldSet key={conflict.id}>
                <FieldLegend>{conflict.label}</FieldLegend>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-md border p-3 text-sm">
                    <p className="text-muted-foreground text-xs">Current</p>
                    <p className="mt-1 break-words">
                      {conflict.current || "Empty"}
                    </p>
                  </div>
                  <div className="rounded-md border p-3 text-sm">
                    <p className="text-muted-foreground text-xs">Your draft</p>
                    <p className="mt-1 break-words">
                      {conflict.draft || "Empty"}
                    </p>
                  </div>
                </div>
                <ToggleGroup
                  aria-label={`Resolve ${conflict.label}`}
                  value={choice ? [choice] : []}
                  onValueChange={(values) => {
                    const value = values[0];
                    if (value === "current" || value === "draft")
                      onChoice(conflict.id, value);
                  }}
                >
                  <ToggleGroupItem className="min-h-11" value="current">
                    Keep current
                  </ToggleGroupItem>
                  <ToggleGroupItem className="min-h-11" value="draft">
                    Use draft
                  </ToggleGroupItem>
                </ToggleGroup>
              </FieldSet>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" className="min-h-11" onClick={onCancel}>
            Back to editor
          </Button>
          <Button
            className="min-h-11"
            disabled={!resolved}
            onClick={onContinue}
          >
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ActionError({ message }: { message: string }) {
  if (!message) return null;
  return (
    <Alert variant="destructive" role="alert">
      <AlertCircle />
      <div className="mt-2">
        <p className="font-medium">Could not apply the change</p>
        <p className="mt-1">{message}</p>
      </div>
    </Alert>
  );
}

function impactCopy(count: number, subject: string): string {
  if (count === 0) return `No identities currently use this ${subject}.`;
  return `${count} ${count === 1 ? "identity" : "identities"} will be affected.`;
}

function controlId(prefix: string, value: string): string {
  return `${prefix}-${value.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

export function RoleEditor({
  controller,
  draft,
  intent,
  onClose,
  restoredValues,
}: EditorProps<Role> & { restoredValues?: AccessRoleDraft["values"] | null }) {
  const userId = useVerifiedWorkspaceUserId();
  const original =
    intent === "edit" && draft
      ? controller.state.roles.find((role) => role.id === draft.id)
      : undefined;
  const [name, setName] = useState(restoredValues?.name ?? draft?.name ?? "");
  const [description, setDescription] = useState(
    restoredValues?.description ?? draft?.description ?? "",
  );
  const [grants, setGrants] = useState<string[]>(
    restoredValues?.grants ?? draft?.grants ?? [],
  );
  const [error, setError] = useState("");
  const [journalIssue, setJournalIssue] = useState("");
  const [savedButUncleared, setSavedButUncleared] = useState(false);
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [deleteName, setDeleteName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [conflictChoices, setConflictChoices] = useState<
    Record<string, ConflictChoice | undefined>
  >({});
  const isBuiltin = original?.builtin ?? false;
  const permissions = controller.permissionCatalog;
  const dirty = Boolean(
    draft &&
    (!original ||
      name !== draft.name ||
      description !== (draft.description ?? "") ||
      grants.join("\u0000") !== draft.grants.join("\u0000")),
  );
  function closeEditor(): boolean {
    if (!clearAccessRoleDraft(userId)) {
      setJournalIssue(
        "The browser could not clear your saved role draft. Keep editing or clear this site's browser data.",
      );
      return false;
    }
    onClose();
    return true;
  }
  useAccessDraftRegistration(
    "role-editor",
    Boolean(draft && dirty),
    closeEditor,
  );
  const targetMissing =
    (intent === "edit" && !original) ||
    grants.some(
      (grant) => !permissions.some((permission) => permission.id === grant),
    );

  function stageValues(values: AccessRoleDraft["values"]) {
    if (!draft) return;
    const changed =
      values.name !== draft.name ||
      values.description !== (draft.description ?? "") ||
      !sameList(values.grants, draft.grants);
    const preserved = changed
      ? writeAccessRoleDraft(userId, { intent, baseline: draft, values })
      : clearAccessRoleDraft(userId);
    if (!preserved) {
      clearAccessRoleDraft(userId);
      setJournalIssue(
        "The browser could not keep your latest role change for reload. Keep this tab open and save it before leaving.",
      );
    } else setJournalIssue("");
    setName(values.name);
    setDescription(values.description);
    setGrants(values.grants);
  }
  const memberCount = original
    ? controller.state.identities.filter(
        (identity) => identity.roleId === original.id,
      ).length
    : 0;
  const roleConflicts: FieldConflict[] = [];
  if (draft && original) {
    if (hasThreeWayConflict(original.name, draft.name, name))
      roleConflicts.push({
        id: "name",
        label: "Role name",
        current: original.name,
        draft: name,
      });
    const baselineDescription = draft.description ?? "";
    const currentDescription = original.description ?? "";
    if (
      hasThreeWayConflict(currentDescription, baselineDescription, description)
    )
      roleConflicts.push({
        id: "description",
        label: "Description",
        current: currentDescription,
        draft: description,
      });
    if (hasThreeWayConflict(original.grants, draft.grants, grants, sameList))
      roleConflicts.push({
        id: "grants",
        label: "Baseline grants",
        current: original.grants.join(", "),
        draft: grants.join(", "),
      });
  }
  const currentGrants = original?.grants ?? [];
  const pending = controller.isPending();
  const resultingGrants = original
    ? resolveThreeWayValue(
        currentGrants,
        draft?.grants ?? currentGrants,
        grants,
        conflictChoices.grants,
        sameList,
      )
    : grants;
  const addedGrants = resultingGrants.filter(
    (grant) => !currentGrants.includes(grant),
  );
  const removedGrants = currentGrants.filter(
    (grant) => !resultingGrants.includes(grant),
  );

  function requestClose() {
    if (controller.isPending()) {
      setError(
        "Another Access change is already in progress. Try again shortly.",
      );
      return;
    }
    if (dirty) setConfirmDiscard(true);
    else closeEditor();
  }

  function requestRoleSave() {
    if (savedButUncleared) return;
    if (targetMissing) {
      setError(
        "This role draft refers to a role or permission that is no longer available. Discard it and start again.",
      );
      return;
    }
    if (!name.trim()) {
      setError("Enter a role name.");
      return;
    }
    if (roleConflicts.length) {
      setConflictOpen(true);
      return;
    }
    setConfirmSave(true);
  }

  async function saveRole() {
    if (!draft) return;
    if (savedButUncleared) return;
    if (targetMissing) {
      setError(
        "This role draft refers to a role or permission that is no longer available. Discard it and start again.",
      );
      return;
    }
    if (roleConflicts.some((conflict) => !conflictChoices[conflict.id])) {
      setConfirmSave(false);
      setConflictOpen(true);
      return;
    }
    if (pending) {
      setError(
        "Another Access change is already in progress. Try again shortly.",
      );
      return;
    }
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Enter a role name.");
      setConfirmSave(false);
      return;
    }
    if (intent === "create") {
      const result = await controller.actions.createRole({
        name: trimmedName,
        description: description.trim(),
        grants,
      });
      if (!result.ok) {
        setError(result.error);
        setConfirmSave(false);
        return;
      }
      setConfirmSave(false);
      if (!closeEditor()) {
        setSavedButUncleared(true);
        setError(
          "Role created, but its saved browser draft could not be cleared.",
        );
      }
      return;
    }
    if (!original) {
      setError(
        "This role no longer exists. Reload the directory before applying changes.",
      );
      setConfirmSave(false);
      return;
    }
    const patch = changedPatch(
      {
        name: draft.name,
        description: draft.description ?? "",
        grants: draft.grants,
      },
      { name: trimmedName, description: description.trim(), grants },
      ["name", "description", "grants"],
      (left, right) =>
        Array.isArray(left) && Array.isArray(right)
          ? sameList(left, right)
          : Object.is(left, right),
    );
    if (conflictChoices.name === "current") delete patch.name;
    if (conflictChoices.description === "current") delete patch.description;
    if (conflictChoices.grants === "current") delete patch.grants;
    if (Object.keys(patch).length === 0) {
      setConfirmSave(false);
      closeEditor();
      return;
    }
    const result = await controller.actions.updateRole(
      original.id,
      patch,
      original,
    );
    if (!result.ok) {
      setError(result.error);
      setConfirmSave(false);
      return;
    }
    setConfirmSave(false);
    if (!closeEditor()) {
      setSavedButUncleared(true);
      setError(
        "Role updated, but its saved browser draft could not be cleared.",
      );
    }
  }

  async function deleteRole() {
    if (savedButUncleared) return;
    if (pending) {
      setError(
        "Another Access change is already in progress. Try again shortly.",
      );
      return;
    }
    if (!original) {
      setError(
        "This role no longer exists. Reload the directory before deleting it.",
      );
      setConfirmDelete(false);
      return;
    }
    const result = await controller.actions.deleteRole(original.id);
    if (!result.ok) {
      setError(result.error);
      setConfirmDelete(false);
      return;
    }
    setConfirmDelete(false);
    if (!closeEditor()) {
      setSavedButUncleared(true);
      setError(
        "Role deleted, but its saved browser draft could not be cleared.",
      );
    }
  }

  return (
    <>
      <Sheet
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open) requestClose();
        }}
      >
        <SheetContent className="w-[min(92vw,34rem)] gap-0 p-0">
          <SheetHeader className="border-border border-b p-5">
            <div className="flex items-center gap-2">
              <SheetTitle>
                {intent === "create"
                  ? "Create role"
                  : original
                    ? `${isBuiltin ? "View" : "Edit"} ${original.name}`
                    : "Edit role"}
              </SheetTitle>
              {isBuiltin && <Badge variant="secondary">Built-in</Badge>}
            </div>
            <SheetDescription>
              Set the role baseline. More specific policy rules can override
              these grants.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-5">
            <fieldset
              disabled={pending || savedButUncleared}
              className="contents"
            >
              {isBuiltin && (
                <Alert>
                  <ShieldCheck />
                  <div className="mt-2">
                    <p className="font-medium">Protected baseline</p>
                    <p className="mt-1">
                      Built-in roles are immutable. Duplicate this role to
                      create an editable baseline.
                      {original?.name.toLowerCase() === "admin"
                        ? " A copy receives the data permissions shown below, not protected administrator powers."
                        : ""}
                    </p>
                  </div>
                </Alert>
              )}
              <ActionError message={error} />
              {journalIssue ? (
                <Alert role="alert" variant="warning">
                  {journalIssue}
                </Alert>
              ) : null}
              {targetMissing && draft ? (
                <Alert role="alert" variant="warning">
                  This role draft refers to a role or permission that is no
                  longer available. It cannot be saved. Discard it and start
                  again.
                </Alert>
              ) : null}
              <FieldGroup>
                <Field data-disabled={isBuiltin}>
                  <FieldLabel htmlFor="role-name">Role name</FieldLabel>
                  <Input
                    id="role-name"
                    value={name}
                    disabled={isBuiltin}
                    onChange={(event) =>
                      stageValues({
                        name: event.target.value,
                        description,
                        grants,
                      })
                    }
                  />
                </Field>
                <Field data-disabled={isBuiltin}>
                  <FieldLabel htmlFor="role-description">
                    Description
                  </FieldLabel>
                  <Textarea
                    id="role-description"
                    value={description}
                    disabled={isBuiltin}
                    onChange={(event) =>
                      stageValues({
                        name,
                        description: event.target.value,
                        grants,
                      })
                    }
                    placeholder="Explain when this role should be assigned."
                  />
                </Field>
                <FieldSet disabled={isBuiltin}>
                  <FieldLegend>Baseline grants</FieldLegend>
                  <p className="text-muted-foreground text-sm">
                    {original?.name.toLowerCase() === "admin"
                      ? "Administrator always has these data permissions and protected management access, regardless of scoped rules."
                      : "Selected grants apply before scoped allow and deny rules."}
                  </p>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {permissions.map((permission) => (
                      <Field
                        key={permission.id}
                        className="min-h-11 flex-row items-center rounded-md px-2"
                      >
                        <Checkbox
                          id={controlId("role-grant", permission.id)}
                          checked={grants.includes(permission.id)}
                          disabled={isBuiltin}
                          onCheckedChange={(checked) =>
                            stageValues({
                              name,
                              description,
                              grants: checked
                                ? [...grants, permission.id]
                                : grants.filter(
                                    (grant) => grant !== permission.id,
                                  ),
                            })
                          }
                        />
                        <FieldLabel
                          htmlFor={controlId("role-grant", permission.id)}
                          className="min-w-0 flex-1 font-normal"
                        >
                          {permission.name}
                        </FieldLabel>
                      </Field>
                    ))}
                  </div>
                </FieldSet>
              </FieldGroup>
            </fieldset>
          </div>
          <SheetFooter className="border-border mt-0 border-t p-5">
            {original && !isBuiltin && (
              <Button
                variant="destructive"
                className="min-h-11 sm:mr-auto"
                disabled={pending || savedButUncleared}
                onClick={() => setConfirmDelete(true)}
              >
                Delete role
              </Button>
            )}
            <Button
              variant="outline"
              className="min-h-11"
              onClick={requestClose}
            >
              Cancel
            </Button>
            <Button
              className="min-h-11"
              disabled={
                isBuiltin ||
                !dirty ||
                pending ||
                targetMissing ||
                savedButUncleared
              }
              onClick={requestRoleSave}
            >
              Save role
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard role changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your unsaved role draft will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setConfirmDiscard(false)}
            >
              Keep editing
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              disabled={pending}
              onClick={closeEditor}
            >
              Discard changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ConflictDialog
        open={conflictOpen}
        title="Resolve role conflicts"
        conflicts={roleConflicts}
        choices={conflictChoices}
        onChoice={(field, choice) =>
          setConflictChoices((current) => ({ ...current, [field]: choice }))
        }
        onCancel={() => setConflictOpen(false)}
        onContinue={() => {
          setConflictOpen(false);
          setConfirmSave(true);
        }}
      />

      <AlertDialog open={confirmSave} onOpenChange={setConfirmSave}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Apply role changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Review how the role baseline will change before applying it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-3 text-sm">
            <div className="rounded-md border p-3">
              <p className="font-medium">
                {currentGrants.length} → {resultingGrants.length} baseline
                grants
              </p>
              <p className="text-muted-foreground mt-1">
                {impactCopy(memberCount, "role")}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-md border p-3">
                <p className="font-medium">Elevated access</p>
                <p className="text-muted-foreground mt-1 break-words">
                  {addedGrants.join(", ") || "No grants added"}
                </p>
              </div>
              <div className="rounded-md border p-3">
                <p className="font-medium">Removed access</p>
                <p className="text-muted-foreground mt-1 break-words">
                  {removedGrants.join(", ") || "No grants removed"}
                </p>
              </div>
            </div>
            <Alert>
              <ShieldCheck />
              <p className="mt-2">
                Protected Administrator continuity remains enforced.
              </p>
            </Alert>
          </div>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setConfirmSave(false)}
            >
              Review draft
            </Button>
            <Button className="min-h-11" disabled={pending} onClick={saveRole}>
              Apply changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {original?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the role baseline. Enter the exact role name to
              confirm.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Field>
            <FieldLabel htmlFor="confirm-role-name">Role name</FieldLabel>
            <Input
              id="confirm-role-name"
              value={deleteName}
              onChange={(event) => setDeleteName(event.target.value)}
              autoComplete="off"
            />
            <FieldDescription>
              {memberCount > 0 ? impactCopy(memberCount, "role") : undefined}
            </FieldDescription>
          </Field>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              disabled={deleteName !== original?.name || pending}
              onClick={deleteRole}
            >
              Delete role
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function GroupEditor({
  controller,
  draft,
  intent,
  onClose,
  restoredValues,
}: EditorProps<AccessGroup> & {
  restoredValues?: AccessGroupDraft["values"] | null;
}) {
  const userId = useVerifiedWorkspaceUserId();
  const original =
    intent === "edit" && draft
      ? controller.state.groups.find((group) => group.id === draft.id)
      : undefined;
  const [name, setName] = useState(restoredValues?.name ?? draft?.name ?? "");
  const [description, setDescription] = useState(
    restoredValues?.description ?? draft?.description ?? "",
  );
  const [memberIds, setMemberIds] = useState<string[]>(() =>
    restoredValues
      ? [...restoredValues.memberIds]
      : (draft?.memberIds ?? []).filter((id) =>
          controller.state.identities.some(
            (identity) => identity.id === id && identity.kind !== "service",
          ),
        ),
  );
  const [error, setError] = useState("");
  const [journalIssue, setJournalIssue] = useState("");
  const [savedButUncleared, setSavedButUncleared] = useState(false);
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteName, setDeleteName] = useState("");
  const [conflictOpen, setConflictOpen] = useState(false);
  const [conflictChoices, setConflictChoices] = useState<
    Record<string, ConflictChoice | undefined>
  >({});
  const eligibleIdentities = controller.state.identities.filter(
    (identity) =>
      identity.kind !== "service" &&
      (identity.status === "active" || draft?.memberIds.includes(identity.id)),
  );
  const dirty = Boolean(
    draft &&
    (!original ||
      name !== draft.name ||
      description !== draft.description ||
      memberIds.join("\u0000") !== draft.memberIds.join("\u0000")),
  );
  function closeEditor(): boolean {
    if (!clearAccessGroupDraft(userId)) {
      setJournalIssue(
        "The browser could not clear your saved group draft. Keep editing or clear this site's browser data.",
      );
      return false;
    }
    onClose();
    return true;
  }
  useAccessDraftRegistration(
    "group-editor",
    Boolean(draft && dirty),
    closeEditor,
  );
  const targetMissing =
    (intent === "edit" && !original) ||
    memberIds.some(
      (id) =>
        !controller.state.identities.some(
          (identity) => identity.id === id && identity.kind !== "service",
        ),
    );

  function stageValues(values: AccessGroupDraft["values"]) {
    if (!draft) return;
    const changed =
      values.name !== draft.name ||
      values.description !== draft.description ||
      !sameList(values.memberIds, draft.memberIds);
    const preserved = changed
      ? writeAccessGroupDraft(userId, { intent, baseline: draft, values })
      : clearAccessGroupDraft(userId);
    if (!preserved) {
      clearAccessGroupDraft(userId);
      setJournalIssue(
        "The browser could not keep your latest group change for reload. Keep this tab open and save it before leaving.",
      );
    } else setJournalIssue("");
    setName(values.name);
    setDescription(values.description);
    setMemberIds(values.memberIds);
  }
  const groupConflicts: FieldConflict[] = [];
  if (draft && original) {
    if (hasThreeWayConflict(original.name, draft.name, name))
      groupConflicts.push({
        id: "name",
        label: "Group name",
        current: original.name,
        draft: name,
      });
    if (
      hasThreeWayConflict(original.description, draft.description, description)
    )
      groupConflicts.push({
        id: "description",
        label: "Description",
        current: original.description,
        draft: description,
      });
    if (
      hasThreeWayConflict(
        original.memberIds,
        draft.memberIds,
        memberIds,
        sameList,
      )
    )
      groupConflicts.push({
        id: "memberIds",
        label: "Members",
        current: original.memberIds
          .map(
            (id) =>
              controller.state.identities.find((identity) => identity.id === id)
                ?.name ?? id,
          )
          .join(", "),
        draft: memberIds
          .map(
            (id) =>
              controller.state.identities.find((identity) => identity.id === id)
                ?.name ?? id,
          )
          .join(", "),
      });
  }
  const currentMemberIds = original?.memberIds ?? [];
  const resultingMemberIds = original
    ? resolveThreeWayValue(
        currentMemberIds,
        draft?.memberIds ?? currentMemberIds,
        memberIds,
        conflictChoices.memberIds,
        sameList,
      )
    : memberIds;
  const addedMemberIds = resultingMemberIds.filter(
    (id) => !currentMemberIds.includes(id),
  );
  const removedMemberIds = currentMemberIds.filter(
    (id) => !resultingMemberIds.includes(id),
  );
  const affectedMemberCount = new Set([
    ...currentMemberIds,
    ...resultingMemberIds,
  ]).size;
  const identityName = (id: string) =>
    controller.state.identities.find((identity) => identity.id === id)?.name ??
    id;
  const pending = controller.isPending();

  function requestClose() {
    if (controller.isPending()) {
      setError(
        "Another Access change is already in progress. Try again shortly.",
      );
      return;
    }
    if (dirty) setConfirmDiscard(true);
    else closeEditor();
  }

  function requestGroupSave() {
    if (savedButUncleared) return;
    if (targetMissing) {
      setError(
        "This group draft refers to a group or member that is no longer available. Discard it and start again.",
      );
      return;
    }
    if (!name.trim()) {
      setError("Enter a group name.");
      return;
    }
    if (groupConflicts.length) {
      setConflictOpen(true);
      return;
    }
    setConfirmSave(true);
  }

  async function saveGroup() {
    if (!draft) return;
    if (savedButUncleared) return;
    if (targetMissing) {
      setError(
        "This group draft refers to a group or member that is no longer available. Discard it and start again.",
      );
      return;
    }
    if (groupConflicts.some((conflict) => !conflictChoices[conflict.id])) {
      setConfirmSave(false);
      setConflictOpen(true);
      return;
    }
    if (pending) {
      setError(
        "Another Access change is already in progress. Try again shortly.",
      );
      return;
    }
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Enter a group name.");
      setConfirmSave(false);
      return;
    }
    if (intent === "create") {
      const result = await controller.actions.createGroup({
        name: trimmedName,
        description: description.trim(),
        memberIds,
      });
      if (!result.ok) {
        setError(result.error);
        setConfirmSave(false);
        return;
      }
      setConfirmSave(false);
      if (!closeEditor()) {
        setSavedButUncleared(true);
        setError(
          "Group created, but its saved browser draft could not be cleared.",
        );
      }
      return;
    }
    if (!original) {
      setError(
        "This group no longer exists. Reload the directory before applying changes.",
      );
      setConfirmSave(false);
      return;
    }
    const patch = changedPatch(
      {
        name: draft.name,
        description: draft.description,
        memberIds: draft.memberIds,
      },
      { name: trimmedName, description: description.trim(), memberIds },
      ["name", "description", "memberIds"],
      (left, right) =>
        Array.isArray(left) && Array.isArray(right)
          ? sameList(left, right)
          : Object.is(left, right),
    );
    if (conflictChoices.name === "current") delete patch.name;
    if (conflictChoices.description === "current") delete patch.description;
    if (conflictChoices.memberIds === "current") delete patch.memberIds;
    if (Object.keys(patch).length === 0) {
      setConfirmSave(false);
      closeEditor();
      return;
    }
    const result = await controller.actions.updateGroup(
      original.id,
      patch,
      original,
    );
    if (!result.ok) {
      setError(result.error);
      setConfirmSave(false);
      return;
    }
    setConfirmSave(false);
    if (!closeEditor()) {
      setSavedButUncleared(true);
      setError(
        "Group updated, but its saved browser draft could not be cleared.",
      );
    }
  }

  async function deleteGroup() {
    if (savedButUncleared) return;
    if (pending) {
      setError(
        "Another Access change is already in progress. Try again shortly.",
      );
      return;
    }
    if (!original) {
      setError(
        "This group no longer exists. Reload the directory before deleting it.",
      );
      setConfirmDelete(false);
      return;
    }
    const result = await controller.actions.deleteGroup(original.id);
    if (!result.ok) {
      setError(result.error);
      setConfirmDelete(false);
      return;
    }
    setConfirmDelete(false);
    if (!closeEditor()) {
      setSavedButUncleared(true);
      setError(
        "Group deleted, but its saved browser draft could not be cleared.",
      );
    }
  }

  return (
    <>
      <Sheet
        open={draft !== null}
        onOpenChange={(open) => !open && requestClose()}
      >
        <SheetContent className="w-[min(92vw,34rem)] gap-0 p-0">
          <SheetHeader className="border-border border-b p-5">
            <SheetTitle>
              {intent === "create"
                ? "Create group"
                : original
                  ? `Edit ${original.name}`
                  : "Edit group"}
            </SheetTitle>
            <SheetDescription>
              Manual groups do not nest. Add internal people and guests
              directly.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-5">
            <fieldset
              disabled={pending || savedButUncleared}
              className="contents"
            >
              <ActionError message={error} />
              {journalIssue ? (
                <Alert role="alert" variant="warning">
                  {journalIssue}
                </Alert>
              ) : null}
              {targetMissing && draft ? (
                <Alert role="alert" variant="warning">
                  This group draft refers to a group or member that is no longer
                  available. It cannot be saved. Discard it and start again.
                </Alert>
              ) : null}
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="group-name">Group name</FieldLabel>
                  <Input
                    id="group-name"
                    value={name}
                    onChange={(event) =>
                      stageValues({
                        name: event.target.value,
                        description,
                        memberIds,
                      })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="group-description">
                    Description
                  </FieldLabel>
                  <Textarea
                    id="group-description"
                    value={description}
                    onChange={(event) =>
                      stageValues({
                        name,
                        description: event.target.value,
                        memberIds,
                      })
                    }
                    placeholder="Explain the shared responsibility or access need."
                  />
                </Field>
                <FieldSet>
                  <FieldLegend>Members</FieldLegend>
                  <p className="text-muted-foreground text-sm">
                    Service identities cannot join groups.
                  </p>
                  <div className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-md border p-2">
                    {eligibleIdentities.map((identity) => (
                      <Field
                        key={identity.id}
                        className="hover:bg-muted/50 min-h-11 flex-row items-center rounded-md px-2"
                      >
                        <Checkbox
                          id={`group-member-${identity.id}`}
                          checked={memberIds.includes(identity.id)}
                          onCheckedChange={(checked) =>
                            stageValues({
                              name,
                              description,
                              memberIds: checked
                                ? [...memberIds, identity.id]
                                : memberIds.filter((id) => id !== identity.id),
                            })
                          }
                        />
                        <FieldLabel
                          htmlFor={`group-member-${identity.id}`}
                          className="min-w-0 flex-1 font-normal"
                        >
                          <span className="block truncate">
                            {identity.name}
                          </span>
                          <span className="text-muted-foreground block text-xs capitalize">
                            {identity.kind}
                          </span>
                        </FieldLabel>
                      </Field>
                    ))}
                  </div>
                </FieldSet>
                <Alert>
                  <Users />
                  <div className="mt-2">
                    <p className="font-medium">Affected identities</p>
                    <p className="mt-1">
                      {impactCopy(memberIds.length, "group")} Scoped rules
                      assigned to this group will apply to them.
                    </p>
                  </div>
                </Alert>
              </FieldGroup>
            </fieldset>
          </div>
          <SheetFooter className="border-border mt-0 border-t p-5">
            {original && (
              <Button
                variant="destructive"
                className="min-h-11 sm:mr-auto"
                disabled={pending || savedButUncleared}
                onClick={() => setConfirmDelete(true)}
              >
                Delete group
              </Button>
            )}
            <Button
              variant="outline"
              className="min-h-11"
              onClick={requestClose}
            >
              Cancel
            </Button>
            <Button
              className="min-h-11"
              disabled={!dirty || pending || targetMissing || savedButUncleared}
              onClick={requestGroupSave}
            >
              Save group
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard group changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your unsaved group draft will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setConfirmDiscard(false)}
            >
              Keep editing
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              disabled={pending}
              onClick={closeEditor}
            >
              Discard changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ConflictDialog
        open={conflictOpen}
        title="Resolve group conflicts"
        conflicts={groupConflicts}
        choices={conflictChoices}
        onChoice={(field, choice) =>
          setConflictChoices((current) => ({ ...current, [field]: choice }))
        }
        onCancel={() => setConflictOpen(false)}
        onContinue={() => {
          setConflictOpen(false);
          setConfirmSave(true);
        }}
      />

      <AlertDialog open={confirmSave} onOpenChange={setConfirmSave}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Apply group changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Review the membership impact before applying it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-3 text-sm">
            <div className="rounded-md border p-3">
              <p className="font-medium">
                {currentMemberIds.length} → {resultingMemberIds.length} members
              </p>
              <p className="text-muted-foreground mt-1">
                {affectedMemberCount} affected{" "}
                {affectedMemberCount === 1 ? "identity" : "identities"}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-md border p-3">
                <p className="font-medium">Members added</p>
                <p className="text-muted-foreground mt-1 break-words">
                  {addedMemberIds.map(identityName).join(", ") ||
                    "No members added"}
                </p>
              </div>
              <div className="rounded-md border p-3">
                <p className="font-medium">Members removed</p>
                <p className="text-muted-foreground mt-1 break-words">
                  {removedMemberIds.map(identityName).join(", ") ||
                    "No members removed"}
                </p>
              </div>
            </div>
            <Alert>
              <ShieldCheck />
              <p className="mt-2">
                Protected Administrator continuity remains enforced.
              </p>
            </Alert>
          </div>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setConfirmSave(false)}
            >
              Review draft
            </Button>
            <Button className="min-h-11" disabled={pending} onClick={saveGroup}>
              Apply changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {original?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              First remove its members, default assignments, and any rules in
              Detailed rules. Deleting the group will not delete those rules.
              Enter the exact group name to confirm.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Field>
            <FieldLabel htmlFor="confirm-group-name">Group name</FieldLabel>
            <Input
              id="confirm-group-name"
              value={deleteName}
              onChange={(event) => setDeleteName(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              disabled={deleteName !== original?.name || pending}
              onClick={deleteGroup}
            >
              Delete group
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
