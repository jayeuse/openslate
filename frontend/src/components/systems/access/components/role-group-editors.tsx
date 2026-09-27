"use client";

import { useState } from "react";
import { AlertCircle, Search, ShieldCheck, Users } from "lucide-react";
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
  accessDraftSubmissionNeedsReload,
  beginAccessGroupDraftSubmission,
  beginAccessRoleDraftSubmission,
  clearAccessGroupDraft,
  clearAccessRoleDraft,
  completeAccessGroupDraftSubmission,
  completeAccessRoleDraftSubmission,
  discardUncertainAccessGroupDraft,
  discardUncertainAccessRoleDraft,
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
  restoredUncertain?: boolean;
};

type DraftReviewValues = {
  name: string;
  description: string;
  entries: readonly { id: string; label: string }[];
};

function DraftReviewDetails({
  label,
  values,
  entriesLabel,
}: {
  label: string;
  values: DraftReviewValues;
  entriesLabel: string;
}) {
  return (
    <section aria-label={label} className="rounded-md border p-3 text-sm">
      <h4 className="font-medium">{label}</h4>
      <dl className="mt-2 space-y-2">
        <div>
          <dt className="text-muted-foreground">Name</dt>
          <dd className="break-words whitespace-pre-wrap">{values.name}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Description</dt>
          <dd className="break-words whitespace-pre-wrap">
            {values.description || "None"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{entriesLabel}</dt>
          <dd>
            {values.entries.length ? (
              <ul className="list-inside list-disc">
                {values.entries.map((entry) => (
                  <li key={entry.id} className="break-words">
                    {entry.label}
                  </li>
                ))}
              </ul>
            ) : (
              "None"
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function UncertainDraftWarning({
  subject,
  currentSummary,
  savedValues,
  currentValues,
  entriesLabel,
  canResolve,
  pending,
  onResolve,
}: {
  subject: "role" | "group";
  currentSummary: string;
  savedValues: DraftReviewValues;
  currentValues: DraftReviewValues | null;
  entriesLabel: string;
  canResolve: boolean;
  pending: boolean;
  onResolve: () => void;
}) {
  return (
    <Alert role="alert">
      <ShieldCheck aria-hidden />
      <div className="mt-2 space-y-2">
        <p className="font-medium">This {subject} change may have completed.</p>
        <p>
          The saved values are read-only. Review the current Access state before
          starting a new draft.
        </p>
        {canResolve && <p>{currentSummary}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <DraftReviewDetails
            label={`Saved ${subject} draft`}
            values={savedValues}
            entriesLabel={entriesLabel}
          />
          {canResolve && currentValues ? (
            <DraftReviewDetails
              label={`Current Access ${subject}`}
              values={currentValues}
              entriesLabel={entriesLabel}
            />
          ) : (
            <section
              aria-label={`Current Access ${subject}`}
              className="rounded-md border p-3 text-sm"
            >
              <h4 className="font-medium">Current Access {subject}</h4>
              <p className="mt-2">
                {canResolve
                  ? `No matching ${subject} is present in current Access.`
                  : "Reload Access to compare the current values."}
              </p>
            </section>
          )}
        </div>
        <Button
          variant="outline"
          className="min-h-11"
          disabled={pending}
          onClick={canResolve ? onResolve : () => window.location.reload()}
        >
          {canResolve ? "Discard after review" : "Reload Access to review"}
        </Button>
      </div>
    </Alert>
  );
}

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
  if (count === 0) return `No people or services use this ${subject} yet.`;
  return `${count} ${count === 1 ? "person or service" : "people or services"} will be affected.`;
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
  restoredUncertain = false,
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
  const [submissionUncertain, setSubmissionUncertain] =
    useState(restoredUncertain);
  const [confirmUncertainDiscard, setConfirmUncertainDiscard] = useState(false);
  const canResolveAfterReview =
    restoredUncertain &&
    !accessDraftSubmissionNeedsReload(userId, "role") &&
    controller.resource.status === "ready" &&
    controller.resource.error === null &&
    !controller.resource.refreshing;
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [deleteName, setDeleteName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [conflictChoices, setConflictChoices] = useState<
    Record<string, ConflictChoice | undefined>
  >({});
  const isBuiltin = original?.builtin ?? false;
  const currentRole =
    intent === "edit"
      ? original
      : controller.state.roles.find((role) => role.name === name.trim());
  const permissions = controller.permissionCatalog;
  const dirty = Boolean(
    draft &&
    (!original ||
      name !== draft.name ||
      description !== (draft.description ?? "") ||
      grants.join("\u0000") !== draft.grants.join("\u0000")),
  );
  function finishEditor(afterSubmission: boolean): boolean {
    if (
      !(afterSubmission
        ? completeAccessRoleDraftSubmission(userId)
        : clearAccessRoleDraft(userId))
    ) {
      setJournalIssue(
        "The browser could not clear your saved role draft. Keep editing or clear this site's browser data.",
      );
      return false;
    }
    onClose();
    return true;
  }
  function closeEditor(): boolean {
    return finishEditor(false);
  }
  function completeEditor(): boolean {
    return finishEditor(true);
  }
  useAccessDraftRegistration(
    "role-editor",
    Boolean(draft && dirty && !submissionUncertain),
    closeEditor,
  );
  const targetMissing =
    (intent === "edit" && !original) ||
    grants.some(
      (grant) => !permissions.some((permission) => permission.id === grant),
    );

  function stageValues(values: AccessRoleDraft["values"]) {
    if (!draft || submissionUncertain) return;
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
  function beginSubmission(): boolean {
    if (!draft || submissionUncertain) return false;
    if (
      !beginAccessRoleDraftSubmission(userId, {
        intent,
        baseline: draft,
        values: { name, description, grants },
      })
    ) {
      setError("Browser draft storage is unavailable. Save was not sent.");
      setConfirmSave(false);
      setConfirmDelete(false);
      return false;
    }
    setSubmissionUncertain(true);
    return true;
  }
  function discardAfterReview() {
    if (!canResolveAfterReview) {
      setConfirmUncertainDiscard(false);
      setError("Reload Access before discarding this uncertain role draft.");
      return;
    }
    if (!discardUncertainAccessRoleDraft(userId)) {
      setError(
        "The browser could not discard this role draft. It remains locked.",
      );
      setConfirmUncertainDiscard(false);
      return;
    }
    setConfirmUncertainDiscard(false);
    setSubmissionUncertain(false);
    onClose();
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
        label: "Standard permissions",
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
    if (submissionUncertain) {
      setError("Review this role change before discarding its saved draft.");
      return;
    }
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
    if (savedButUncleared || submissionUncertain) return;
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
    if (savedButUncleared || submissionUncertain) return;
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
      if (!beginSubmission()) return;
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
      if (!completeEditor()) {
        setSavedButUncleared(true);
        setError(
          "Role created, but its saved browser draft could not be cleared. Reload Access to review it.",
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
    if (!beginSubmission()) return;
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
    if (!completeEditor()) {
      setSavedButUncleared(true);
      setError(
        "Role updated, but its saved browser draft could not be cleared. Reload Access to review it.",
      );
    }
  }

  async function deleteRole() {
    if (savedButUncleared || submissionUncertain) return;
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
    if (!beginSubmission()) return;
    const result = await controller.actions.deleteRole(original.id);
    if (!result.ok) {
      setError(result.error);
      setConfirmDelete(false);
      return;
    }
    setConfirmDelete(false);
    if (!completeEditor()) {
      setSavedButUncleared(true);
      setError(
        "Role deleted, but its saved browser draft could not be cleared. Reload Access to review it.",
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
              Choose the standard permissions for this role. Custom rules can
              change them for specific people or places.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-5">
            {submissionUncertain && (
              <UncertainDraftWarning
                subject="role"
                savedValues={{
                  name,
                  description,
                  entries: grants.map((grant) => ({
                    id: grant,
                    label:
                      permissions.find((permission) => permission.id === grant)
                        ?.name ?? grant,
                  })),
                }}
                currentValues={
                  currentRole
                    ? {
                        name: currentRole.name,
                        description: currentRole.description ?? "",
                        entries: currentRole.grants.map((grant) => ({
                          id: grant,
                          label:
                            permissions.find(
                              (permission) => permission.id === grant,
                            )?.name ?? grant,
                        })),
                      }
                    : null
                }
                entriesLabel="Standard permissions"
                currentSummary={
                  currentRole
                    ? `Current role: ${currentRole.name}, with ${currentRole.grants.length} standard ${currentRole.grants.length === 1 ? "permission" : "permissions"}.`
                    : `Current Access has no role named ${name || "this draft"}.`
                }
                canResolve={canResolveAfterReview}
                pending={pending}
                onResolve={() => setConfirmUncertainDiscard(true)}
              />
            )}
            <fieldset
              disabled={pending || savedButUncleared || submissionUncertain}
              className="contents"
            >
              {isBuiltin && (
                <Alert>
                  <ShieldCheck />
                  <div className="mt-2">
                    <p className="font-medium">Protected role</p>
                    <p className="mt-1">
                      Built-in roles cannot be changed. Duplicate this role to
                      create an editable copy.
                      {original?.system === "admin"
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
                  <FieldLegend>Standard permissions</FieldLegend>
                  <p className="text-muted-foreground text-sm">
                    {original?.system === "admin"
                      ? "Administrator always has these data permissions and protected management access, whatever custom rules say."
                      : "Selected permissions apply first. Custom rules can then allow or deny access for specific people or places."}
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
                disabled={pending || savedButUncleared || submissionUncertain}
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
                savedButUncleared ||
                submissionUncertain
              }
              onClick={requestRoleSave}
            >
              Save role
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={confirmUncertainDiscard}
        onOpenChange={setConfirmUncertainDiscard}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Discard this uncertain role draft?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Confirm that you reviewed the current Access roles. The saved
              values will be removed and you can start a new draft.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmUncertainDiscard(false)}
            >
              Keep for review
            </Button>
            <Button variant="destructive" onClick={discardAfterReview}>
              Discard and start fresh
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
              Review how the standard permissions will change before applying
              them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-3 text-sm">
            <div className="rounded-md border p-3">
              <p className="font-medium">
                {currentGrants.length} → {resultingGrants.length} standard
                permissions
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
              This removes the role and its standard permissions. Enter the
              exact role name to confirm.
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
  restoredUncertain = false,
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
  const [memberSearch, setMemberSearch] = useState("");
  const [error, setError] = useState("");
  const [journalIssue, setJournalIssue] = useState("");
  const [savedButUncleared, setSavedButUncleared] = useState(false);
  const [submissionUncertain, setSubmissionUncertain] =
    useState(restoredUncertain);
  const [confirmUncertainDiscard, setConfirmUncertainDiscard] = useState(false);
  const canResolveAfterReview =
    restoredUncertain &&
    !accessDraftSubmissionNeedsReload(userId, "group") &&
    controller.resource.status === "ready" &&
    controller.resource.error === null &&
    !controller.resource.refreshing;
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteName, setDeleteName] = useState("");
  const [conflictOpen, setConflictOpen] = useState(false);
  const [conflictChoices, setConflictChoices] = useState<
    Record<string, ConflictChoice | undefined>
  >({});
  const eligibleIdentities = controller.state.identities
    .filter(
      (identity) =>
        identity.kind !== "service" &&
        (identity.status === "active" ||
          draft?.memberIds.includes(identity.id)),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const visibleIdentities = eligibleIdentities.filter((identity) =>
    `${identity.name} ${identity.kind === "service" ? "" : identity.email}`
      .toLowerCase()
      .includes(memberSearch.trim().toLowerCase()),
  );
  const currentGroup =
    intent === "edit"
      ? original
      : controller.state.groups.find((group) => group.name === name.trim());
  const dirty = Boolean(
    draft &&
    (!original ||
      name !== draft.name ||
      description !== draft.description ||
      memberIds.join("\u0000") !== draft.memberIds.join("\u0000")),
  );
  function finishEditor(afterSubmission: boolean): boolean {
    if (
      !(afterSubmission
        ? completeAccessGroupDraftSubmission(userId)
        : clearAccessGroupDraft(userId))
    ) {
      setJournalIssue(
        "The browser could not clear your saved group draft. Keep editing or clear this site's browser data.",
      );
      return false;
    }
    onClose();
    return true;
  }
  function closeEditor(): boolean {
    return finishEditor(false);
  }
  function completeEditor(): boolean {
    return finishEditor(true);
  }
  useAccessDraftRegistration(
    "group-editor",
    Boolean(draft && dirty && !submissionUncertain),
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
    if (!draft || submissionUncertain) return;
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
  function beginSubmission(): boolean {
    if (!draft || submissionUncertain) return false;
    if (
      !beginAccessGroupDraftSubmission(userId, {
        intent,
        baseline: draft,
        values: { name, description, memberIds },
      })
    ) {
      setError("Browser draft storage is unavailable. Save was not sent.");
      setConfirmSave(false);
      setConfirmDelete(false);
      return false;
    }
    setSubmissionUncertain(true);
    return true;
  }
  function discardAfterReview() {
    if (!canResolveAfterReview) {
      setConfirmUncertainDiscard(false);
      setError("Reload Access before discarding this uncertain group draft.");
      return;
    }
    if (!discardUncertainAccessGroupDraft(userId)) {
      setError(
        "The browser could not discard this group draft. It remains locked.",
      );
      setConfirmUncertainDiscard(false);
      return;
    }
    setConfirmUncertainDiscard(false);
    setSubmissionUncertain(false);
    onClose();
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
    if (submissionUncertain) {
      setError("Review this group change before discarding its saved draft.");
      return;
    }
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
    if (savedButUncleared || submissionUncertain) return;
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
    if (savedButUncleared || submissionUncertain) return;
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
      if (!beginSubmission()) return;
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
      if (!completeEditor()) {
        setSavedButUncleared(true);
        setError(
          "Group created, but its saved browser draft could not be cleared. Reload Access to review it.",
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
    if (!beginSubmission()) return;
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
    if (!completeEditor()) {
      setSavedButUncleared(true);
      setError(
        "Group updated, but its saved browser draft could not be cleared. Reload Access to review it.",
      );
    }
  }

  async function deleteGroup() {
    if (savedButUncleared || submissionUncertain) return;
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
    if (!beginSubmission()) return;
    const result = await controller.actions.deleteGroup(original.id);
    if (!result.ok) {
      setError(result.error);
      setConfirmDelete(false);
      return;
    }
    setConfirmDelete(false);
    if (!completeEditor()) {
      setSavedButUncleared(true);
      setError(
        "Group deleted, but its saved browser draft could not be cleared. Reload Access to review it.",
      );
    }
  }

  return (
    <>
      <Dialog
        open={draft !== null}
        onOpenChange={(open) => !open && requestClose()}
      >
        <DialogContent className="flex max-h-[90dvh] max-w-2xl flex-col overflow-hidden p-0">
          <DialogHeader className="border-border border-b p-5">
            <DialogTitle>
              {intent === "create"
                ? "Create group"
                : original
                  ? `Edit ${original.name}`
                  : "Edit group"}
            </DialogTitle>
            <DialogDescription>
              Update the group details and choose who belongs to it.
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
            {submissionUncertain && (
              <UncertainDraftWarning
                subject="group"
                savedValues={{
                  name,
                  description,
                  entries: memberIds.map((id) => ({
                    id,
                    label: identityName(id),
                  })),
                }}
                currentValues={
                  currentGroup
                    ? {
                        name: currentGroup.name,
                        description: currentGroup.description,
                        entries: currentGroup.memberIds.map((id) => ({
                          id,
                          label: identityName(id),
                        })),
                      }
                    : null
                }
                entriesLabel="Members"
                currentSummary={
                  currentGroup
                    ? `Current Access group: ${currentGroup.name}; ${currentGroup.memberIds.length} members.`
                    : `Current Access has no group named ${name || "this draft"}.`
                }
                canResolve={canResolveAfterReview}
                pending={pending}
                onResolve={() => setConfirmUncertainDiscard(true)}
              />
            )}
            <fieldset
              disabled={pending || savedButUncleared || submissionUncertain}
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
                <FieldSet className="min-w-0">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-3">
                        <FieldLegend>Members</FieldLegend>
                        <span
                          className="text-muted-foreground text-sm"
                          aria-live="polite"
                        >
                          {memberIds.length} selected
                        </span>
                      </div>
                      <p className="text-muted-foreground mt-1 text-sm">
                        Manual groups do not nest. Service identities cannot
                        join.
                      </p>
                    </div>
                    <Field className="w-full sm:max-w-64">
                      <FieldLabel htmlFor="group-member-search">
                        Search members
                      </FieldLabel>
                      <div className="relative">
                        <Search
                          aria-hidden="true"
                          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
                        />
                        <Input
                          id="group-member-search"
                          type="search"
                          className="min-h-11 pl-9"
                          value={memberSearch}
                          placeholder="Name or email"
                          onChange={(event) =>
                            setMemberSearch(event.target.value)
                          }
                        />
                      </div>
                    </Field>
                  </div>
                  <div className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-md border p-2">
                    {visibleIdentities.length ? (
                      visibleIdentities.map((identity) => (
                        <Field
                          key={identity.id}
                          className="hover:bg-muted/50 min-h-14 flex-row items-center rounded-md px-2 py-2"
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
                                  : memberIds.filter(
                                      (id) => id !== identity.id,
                                    ),
                              })
                            }
                          />
                          <FieldLabel
                            htmlFor={`group-member-${identity.id}`}
                            className="min-w-0 flex-1 font-normal"
                          >
                            <span className="block font-medium break-words">
                              {identity.name}
                            </span>
                            <span className="text-muted-foreground block text-xs break-words">
                              {identity.kind === "service"
                                ? ""
                                : identity.email}
                              {identity.kind !== "service" && (
                                <span className="capitalize">
                                  {` · ${identity.kind}`}
                                </span>
                              )}
                            </span>
                          </FieldLabel>
                        </Field>
                      ))
                    ) : (
                      <p className="text-muted-foreground p-3 text-sm">
                        {eligibleIdentities.length
                          ? "No eligible people match this search."
                          : "No eligible people are available yet."}
                      </p>
                    )}
                  </div>
                </FieldSet>
                <Alert>
                  <Users />
                  <div className="mt-2">
                    <p className="font-medium">Membership impact</p>
                    <p className="mt-1">
                      {memberIds.length
                        ? `${memberIds.length} ${memberIds.length === 1 ? "person is" : "people are"} selected.`
                        : "No people are selected yet."}{" "}
                      Group-scoped rules apply to selected members.
                    </p>
                  </div>
                </Alert>
              </FieldGroup>
            </fieldset>
          </div>
          <DialogFooter className="border-border mt-0 border-t p-5 sm:items-center sm:justify-between">
            {original && (
              <Button
                variant="destructive"
                className="min-h-11 sm:mr-auto"
                disabled={pending || savedButUncleared || submissionUncertain}
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
              disabled={
                !dirty ||
                pending ||
                targetMissing ||
                savedButUncleared ||
                submissionUncertain
              }
              onClick={requestGroupSave}
            >
              Save group
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmUncertainDiscard}
        onOpenChange={setConfirmUncertainDiscard}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Discard this uncertain group draft?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Confirm that you reviewed the current Access groups. The saved
              values will be removed and you can start a new draft.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmUncertainDiscard(false)}
            >
              Keep for review
            </Button>
            <Button variant="destructive" onClick={discardAfterReview}>
              Discard and start fresh
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
              Permissions. Deleting the group will not delete those rules. Enter
              the exact group name to confirm.
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
