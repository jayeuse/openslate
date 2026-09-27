"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  CircleAlert,
  KeyRound,
  Laptop,
  LogOut,
  Mail,
  RotateCcw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import {
  applyPatch,
  closedDepartmentMemberships,
  sameList,
  updateDepartmentSelection,
} from "../helpers/editor-helpers";
import {
  accessImpact,
  changedIdentityPatch,
  comparisonFields,
  comparisonValue,
  copyIdentity,
  createDraft,
  datetimeLocal,
  fieldLabels,
  identityToCreateInput,
  identityValue,
  isoDate,
  membershipLabels,
  reviewedActionImpact,
  reviewedActionLabels,
  sameValue,
  statusLabels,
  type ConfirmationMode,
  type EditableField,
  type PendingReview,
  type ReviewedAction,
} from "../helpers/identity-editor";
import type {
  AccessController,
  ControllerMutationResult,
  UpdateIdentityPatch,
} from "../state/controller";
import { useAccessDraftRegistration } from "../state/draft-navigation";
import {
  accessDraftSubmissionNeedsReload,
  beginAccessIdentityDraftSubmission,
  clearAccessIdentityDraft,
  completeAccessIdentityDraftSubmission,
  discardUncertainAccessIdentityDraft,
  editableAccessIdentity,
  readAccessIdentityDraft,
  writeAccessIdentityDraft,
} from "../state/draft-journal";
import { useVerifiedWorkspaceUserId } from "../../shared/runtime/workspace-identity";
import {
  displayIdentityStatus,
  validateAccessIdentity,
  type AccessIdentity,
} from "../domain/policy";

type IdentityEditorProps = {
  controller: AccessController;
  identityId: string | null;
  createKind: AccessIdentity["kind"] | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const EDITOR_KIND_LABELS: Record<AccessIdentity["kind"], string> = {
  internal: "Internal",
  guest: "Guest",
  service: "Service",
};
export function IdentityEditor({
  controller,
  identityId,
  createKind,
  open,
  onOpenChange,
}: IdentityEditorProps) {
  const userId = useVerifiedWorkspaceUserId();
  const existing = identityId
    ? (controller.state.identities.find((item) => item.id === identityId) ??
      controller.state.deletedIdentities.find(
        (item) => item.identity.id === identityId,
      )?.identity ??
      null)
    : null;
  const [draft, setDraft] = useState<AccessIdentity | null>(null);
  const [baseline, setBaseline] = useState<AccessIdentity | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [journalIssue, setJournalIssue] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [confirmUncertainDiscard, setConfirmUncertainDiscard] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmationMode, setConfirmationMode] =
    useState<ConfirmationMode>(null);
  const [confirmationName, setConfirmationName] = useState("");
  const [conflictFields, setConflictFields] = useState<EditableField[]>([]);
  const [pendingPatch, setPendingPatch] = useState<UpdateIdentityPatch | null>(
    null,
  );
  const [pendingReview, setPendingReview] = useState<PendingReview | null>(
    null,
  );
  const [pendingDestructiveAction, setPendingDestructiveAction] =
    useState<ReviewedAction | null>(null);
  const [pendingCreateIdentity, setPendingCreateIdentity] =
    useState<AccessIdentity | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const nameId = useId();
  const errorId = useId();

  useEffect(() => {
    if (!open) {
      setLoadedKey(null);
      return;
    }
    const key = existing?.id ?? (createKind ? `create:${createKind}` : null);
    const effectiveKey = key ?? identityId;
    if (!effectiveKey || loadedKey === effectiveKey) return;
    const stored = readAccessIdentityDraft(userId);
    const restored =
      stored.value &&
      ((stored.value.mode === "edit" && identityId === stored.value.draft.id) ||
        (stored.value.mode === "create" &&
          createKind === stored.value.draft.kind))
        ? stored.value
        : null;
    const next =
      restored?.draft ??
      (existing
        ? copyIdentity(existing)
        : createKind
          ? createDraft(createKind, controller)
          : null);
    setDraft(next);
    setBaseline(restored?.baseline ?? (next ? copyIdentity(next) : null));
    setLoadedKey(effectiveKey);
    setUncertain(stored.status === "uncertain");
    setConfirmUncertainDiscard(false);
    if (stored.status === "uncertain") setJournalIssue("");
    else if (stored.status === "unavailable")
      setJournalIssue(
        "Browser draft storage is unavailable. Identity changes may not survive reload.",
      );
    else if (stored.status === "invalid")
      setJournalIssue(
        "A saved identity draft could not be safely restored. It was not applied.",
      );
    setErrors([]);
    setConfirmationMode(null);
    setConfirmationName("");
    setConflictFields([]);
    setPendingPatch(null);
    setPendingReview(null);
    setPendingDestructiveAction(null);
    setPendingCreateIdentity(null);
  }, [controller, createKind, existing, identityId, loadedKey, open, userId]);

  const dirty =
    draft !== null && baseline !== null && !sameValue(draft, baseline);
  const freshAccessState =
    controller.resource.status === "ready" &&
    controller.resource.error === null &&
    !controller.resource.refreshing;
  const needsReload =
    uncertain && accessDraftSubmissionNeedsReload(userId, "identity");
  const comparisonFresh = freshAccessState && !needsReload;
  const currentMatches = draft
    ? draft.id !== "draft"
      ? [
          ...controller.state.identities,
          ...controller.state.deletedIdentities.map((item) => item.identity),
        ].filter((identity) => identity.id === draft.id)
      : controller.state.identities.filter(
          (identity) =>
            identity.kind === draft.kind &&
            (identity.kind === "service" && draft.kind === "service"
              ? identity.name === draft.name &&
                identity.ownerId === draft.ownerId
              : (identity.kind === "internal" || identity.kind === "guest") &&
                (draft.kind === "internal" || draft.kind === "guest") &&
                identity.email.toLowerCase() === draft.email.toLowerCase()),
        )
    : [];
  function closeAfterClearing() {
    setConfirmUncertainDiscard(false);
    setUncertain(false);
    setJournalIssue("");
    setConfirmClose(false);
    setConfirmationMode(null);
    setConfirmationName("");
    setPendingReview(null);
    setPendingPatch(null);
    setPendingCreateIdentity(null);
    setPendingDestructiveAction(null);
    setDraft(null);
    setBaseline(null);
    setLoadedKey(null);
    onOpenChange(false);
  }

  function closeEditor(): boolean {
    if (uncertain || !clearAccessIdentityDraft(userId)) {
      setJournalIssue(
        uncertain
          ? "Review the current Access state before discarding this uncertain identity change."
          : "The browser could not clear your saved identity draft. Keep editing or clear this site's browser data.",
      );
      return false;
    }
    closeAfterClearing();
    return true;
  }
  useAccessDraftRegistration(
    "identity-editor",
    open && dirty && !uncertain,
    closeEditor,
  );

  function completeSubmission(): boolean {
    if (!completeAccessIdentityDraftSubmission(userId)) {
      setJournalIssue(
        "The browser could not clear the saved identity change. Review the current Access state, then discard it when browser storage works again.",
      );
      return false;
    }
    closeAfterClearing();
    return true;
  }

  function discardUncertainDraft() {
    if (needsReload || !freshAccessState) return;
    if (!discardUncertainAccessIdentityDraft(userId)) {
      setJournalIssue(
        "The browser could not discard this uncertain identity change. It remains locked; try again when browser storage works.",
      );
      setConfirmUncertainDiscard(false);
      return;
    }
    closeAfterClearing();
  }
  const targetMissing =
    (identityId !== null && !existing) ||
    (draft !== null &&
      (!controller.state.roles.some((role) => role.id === draft.roleId) ||
        draft.groupIds.some(
          (id) => !controller.state.groups.some((group) => group.id === id),
        ) ||
        (draft.kind === "internal" &&
          draft.departmentIds.some(
            (id) =>
              !controller.departmentCatalog.some(
                (department) => department.id === id,
              ),
          )) ||
        (draft.kind === "guest" &&
          Boolean(draft.sponsorId) &&
          !controller.state.identities.some(
            (identity) => identity.id === draft.sponsorId,
          )) ||
        (draft.kind === "service" &&
          Boolean(draft.ownerId) &&
          !controller.state.identities.some(
            (identity) => identity.id === draft.ownerId,
          ))));
  const roles = controller.state.roles.filter(
    (role) => draft?.kind === "internal" || role.id !== controller.adminRoleId,
  );
  const activeDepartmentIds = new Set(
    controller.departmentCatalog.map((department) => department.id),
  );
  const historicalPerson =
    baseline?.kind === "internal"
      ? controller.state.people.find((person) => person.id === baseline.id)
      : undefined;
  const historicalDepartmentNames = new Map(
    (historicalPerson?.departmentIds ?? []).map((id, index) => [
      id,
      historicalPerson?.departments[index] ?? "Closed department",
    ]),
  );
  const closedDepartments =
    draft?.kind === "internal"
      ? closedDepartmentMemberships(
          draft.departmentIds,
          activeDepartmentIds,
          historicalDepartmentNames,
        )
      : [];
  const internalIdentities = controller.state.identities.filter(
    (identity) =>
      identity.kind === "internal" &&
      displayIdentityStatus(identity) === "active",
  );
  const sessions = existing
    ? controller.sessionResource.identityId === existing.id
      ? controller.state.sessions.filter(
          (session) =>
            session.identityId === existing.id && session.status === "active",
        )
      : []
    : [];
  const sessionResource = controller.sessionResource;
  const sessionStatus =
    sessionResource.identityId === existing?.id
      ? sessionResource.status
      : "idle";
  useEffect(() => {
    if (!open || !existing || existing.kind === "service") return;
    void sessionResource.load(existing.id);
  }, [existing?.id, existing?.kind, open, sessionResource.load]);
  const guestInvitation =
    existing?.kind === "guest"
      ? controller.state.guests.find((guest) => guest.id === existing.id)
          ?.invitation
      : undefined;
  const pending = controller.isPending();

  function requestClose() {
    if (controller.isPending()) {
      showError(
        "Another Access change is already in progress. Try again shortly.",
      );
      return;
    }
    if (uncertain) {
      setJournalIssue(
        "Review the current Access state, then discard this uncertain identity change to continue.",
      );
      return;
    }
    if (dirty) {
      setConfirmClose(true);
      return;
    }
    closeEditor();
  }

  function update(patch: Partial<AccessIdentity>) {
    if (!draft || !baseline || uncertain) return;
    const next = { ...draft, ...patch } as AccessIdentity;
    const changed = !sameValue(
      editableAccessIdentity(next),
      editableAccessIdentity(baseline),
    );
    const preserved = changed
      ? writeAccessIdentityDraft(userId, {
          mode: identityId === null ? "create" : "edit",
          baseline,
          draft: next,
        })
      : clearAccessIdentityDraft(userId);
    if (!preserved) {
      clearAccessIdentityDraft(userId);
      setJournalIssue(
        "The browser could not keep your latest identity change for reload. Keep this tab open and save it before leaving.",
      );
    } else setJournalIssue("");
    setDraft(next);
  }

  function updateDepartment(id: string, checked: boolean) {
    if (draft?.kind !== "internal") return;
    update(updateDepartmentSelection(draft, id, checked, activeDepartmentIds));
  }

  function showError(message: string) {
    setErrors([message]);
    requestAnimationFrame(() => errorRef.current?.focus());
  }

  async function report(
    result: Promise<ControllerMutationResult>,
  ): Promise<boolean> {
    const resolved = await result;
    if (!resolved.ok) {
      showError(resolved.error);
      return false;
    }
    toast.add({ title: resolved.summary, type: "success" });
    return true;
  }

  async function submitDraftMutation(
    action: () => Promise<ControllerMutationResult>,
  ) {
    if (!draft || !baseline || uncertain) return;
    if (
      !beginAccessIdentityDraftSubmission(userId, {
        mode: identityId === null ? "create" : "edit",
        baseline,
        draft,
      })
    ) {
      setPendingReview(null);
      setConfirmationMode(null);
      if (readAccessIdentityDraft(userId).status === "uncertain")
        setUncertain(true);
      showError(
        "The browser cannot safely submit this identity change because it could not save its safety state. Try again when browser draft storage works.",
      );
      return;
    }
    setUncertain(true);
    setPendingReview(null);
    setConfirmationMode(null);
    const accepted = await report(action());
    if (accepted) completeSubmission();
  }

  function stageUpdate(patch: UpdateIdentityPatch) {
    if (!existing) return;
    setPendingReview({
      kind: "update",
      before: copyIdentity(existing),
      after: applyPatch(existing, patch) as AccessIdentity,
      patch,
    });
  }

  function persist() {
    if (!draft) return;
    if (uncertain) {
      showError(
        "This identity change may have completed. Review the current Access state before discarding the saved draft.",
      );
      return;
    }
    if (targetMissing) {
      showError(
        "This identity draft refers to a person, role, group, department, sponsor, or owner that is no longer available. Discard it and start again.",
      );
      return;
    }
    if (controller.isPending()) {
      showError(
        "Another Access change is already in progress. Try again shortly.",
      );
      return;
    }
    if (existing?.status === "deleted") {
      showError("Restore this deleted identity before editing it.");
      return;
    }
    const normalized: AccessIdentity = {
      ...draft,
      name: draft.name.trim(),
      ...(draft.kind === "internal" || draft.kind === "guest"
        ? { email: draft.email.trim().toLowerCase() }
        : { purpose: draft.purpose.trim() }),
    };
    const validation = validateAccessIdentity(normalized);
    const nextErrors = [...validation.issues];
    if (!normalized.name) nextErrors.unshift("Enter a name.");
    if (
      (normalized.kind === "internal" || normalized.kind === "guest") &&
      !/^\S+@\S+\.\S+$/.test(normalized.email)
    )
      nextErrors.push("Enter a valid email address.");
    if (
      normalized.kind === "internal" &&
      baseline?.kind === "internal" &&
      (!sameList(normalized.departmentIds, baseline.departmentIds) ||
        normalized.primaryDepartmentId !== baseline.primaryDepartmentId) &&
      normalized.departmentIds.some((id) => !activeDepartmentIds.has(id))
    )
      nextErrors.push(
        "Remove closed departments before saving department changes.",
      );
    if (nextErrors.length) {
      setErrors([...new Set(nextErrors)]);
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    if (!existing) {
      setPendingReview({ kind: "create", identity: normalized });
      return;
    }
    if (!baseline) return;
    const patch = changedIdentityPatch(baseline, normalized);
    const fields = Object.keys(patch) as EditableField[];
    if (fields.length === 0) {
      closeEditor();
      return;
    }
    const conflicts = fields.filter(
      (field) =>
        !sameValue(
          identityValue(existing, field),
          identityValue(baseline, field),
        ) && !sameValue(identityValue(existing, field), patch[field]),
    );
    if (conflicts.length > 0) {
      update(normalized);
      setPendingPatch(patch);
      setConflictFields(conflicts);
      return;
    }
    stageUpdate(patch);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    persist();
  }

  async function confirmReview() {
    if (!pendingReview || uncertain) return;
    if (controller.isPending()) {
      showError(
        "Another Access change is already in progress. Try again shortly.",
      );
      return;
    }
    if (pendingReview.kind === "action") {
      const action = pendingReview.action;
      if (action.type === "revoke-session") {
        if (
          await report(
            controller.actions.revokeSession(
              action.identity.id,
              action.sessionId,
            ),
          )
        )
          setPendingReview(null);
        return;
      }
      if (action.type === "revoke-all-sessions") {
        if (
          await report(controller.actions.revokeAllSessions(action.identity.id))
        )
          setPendingReview(null);
        return;
      }
      setPendingReview(null);
      setPendingDestructiveAction(action);
      setConfirmationMode(
        action.type === "delete" ? "delete" : "destructive-action",
      );
      setConfirmationName("");
      return;
    }
    if (pendingReview.kind === "create") {
      if (pendingReview.identity.roleId === controller.adminRoleId) {
        setPendingCreateIdentity(pendingReview.identity);
        setPendingReview(null);
        setConfirmationMode("admin-change");
        setConfirmationName("");
        return;
      }
      await submitDraftMutation(() =>
        controller.actions.createIdentity(
          identityToCreateInput(pendingReview.identity),
        ),
      );
      return;
    }
    const changesAdministratorAccess =
      (pendingReview.before.roleId === controller.adminRoleId ||
        pendingReview.after.roleId === controller.adminRoleId) &&
      (pendingReview.before.roleId !== pendingReview.after.roleId ||
        pendingReview.before.status !== pendingReview.after.status);
    if (changesAdministratorAccess) {
      setPendingReview(null);
      setPendingPatch(pendingReview.patch);
      setConfirmationMode("admin-change");
      setConfirmationName("");
      return;
    }
    await submitDraftMutation(() =>
      controller.actions.updateIdentity(
        pendingReview.before.id,
        pendingReview.patch,
      ),
    );
  }

  async function confirmSensitiveAction() {
    if (uncertain) return;
    const confirmationTarget = existing ?? pendingCreateIdentity;
    if (!confirmationTarget || confirmationName !== confirmationTarget.name)
      return;
    if (controller.isPending()) {
      showError(
        "Another Access change is already in progress. Try again shortly.",
      );
      return;
    }
    if (confirmationMode === "admin-change") {
      await submitDraftMutation(() =>
        pendingCreateIdentity
          ? controller.actions.createIdentity(
              identityToCreateInput(pendingCreateIdentity),
            )
          : controller.actions.updateIdentity(
              existing?.id ?? "",
              pendingPatch ?? {},
            ),
      );
      return;
    }
    if (!existing) return;
    await submitDraftMutation(() =>
      pendingDestructiveAction?.type === "disable"
        ? controller.actions.disableIdentity(existing.id)
        : pendingDestructiveAction?.type === "enable"
          ? controller.actions.setIdentityStatus(existing.id, "active")
          : pendingDestructiveAction?.type === "revoke-invite"
            ? controller.actions.revokeInvite(existing.id)
            : controller.actions.deleteIdentity(existing.id),
    );
  }

  function disableExistingIdentity() {
    if (!existing) return;
    setPendingReview({
      kind: "action",
      action: { type: "disable", identity: copyIdentity(existing) },
    });
  }

  const reviewBefore =
    pendingReview?.kind === "update" ? pendingReview.before : null;
  const reviewAfter =
    pendingReview?.kind === "create"
      ? pendingReview.identity
      : pendingReview?.kind === "update"
        ? pendingReview.after
        : pendingReview?.kind === "action"
          ? pendingReview.action.identity
          : null;
  const beforeMemberships = reviewBefore
    ? membershipLabels(reviewBefore, controller)
    : [];
  const afterMemberships = reviewAfter
    ? membershipLabels(reviewAfter, controller)
    : [];
  const addedMemberships = afterMemberships.filter(
    (item) => !beforeMemberships.includes(item),
  );
  const removedMemberships = beforeMemberships.filter(
    (item) => !afterMemberships.includes(item),
  );
  const confirmationTargetName = existing?.name ?? pendingCreateIdentity?.name;

  if (!draft) return null;

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) requestClose();
        }}
      >
        <SheetContent className="w-full max-w-xl gap-0 p-0 sm:w-[min(92vw,38rem)]">
          <SheetHeader className="border-b p-5 pr-14">
            <div className="flex flex-wrap items-center gap-2">
              <SheetTitle>
                {existing
                  ? draft.name
                  : identityId
                    ? "Identity no longer available"
                    : draft.kind === "internal"
                      ? "Add internal person"
                      : draft.kind === "guest"
                        ? "Add guest"
                        : "Add service"}
              </SheetTitle>
              <Badge variant="outline">{EDITOR_KIND_LABELS[draft.kind]}</Badge>
              <Badge
                variant={
                  draft.status === "active"
                    ? "success"
                    : draft.status === "pending"
                      ? "warning"
                      : "secondary"
                }
              >
                {statusLabels[draft.status]}
              </Badge>
            </div>
            <SheetDescription>
              {draft.kind === "service"
                ? "Metadata only. Credentials are never displayed or generated."
                : existing
                  ? "Profile changes do not send credentials. Resending an invitation sends email."
                  : "Saving sends an email invitation. Passwords are never shown here."}
            </SheetDescription>
          </SheetHeader>

          <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
            {uncertain && (
              <div className="mx-5 mt-4 max-h-[55vh] space-y-3 overflow-y-auto overscroll-contain">
                <Alert role="alert" variant="warning">
                  <p className="font-medium">
                    This identity change may have completed.
                  </p>
                  <p className="mt-1">
                    {needsReload
                      ? "Reload Access before reviewing the current state and discarding this saved draft."
                      : freshAccessState
                        ? "Compare the saved values below with the current Access state. Editing and submission are locked until you discard this saved draft."
                        : "Access has not finished a fresh read. Retry the refresh before discarding this saved draft."}
                  </p>
                </Alert>
                <section
                  aria-label="Identity recovery comparison"
                  className="rounded-md border p-3 text-sm"
                >
                  <p className="font-medium">
                    {comparisonFresh
                      ? "Current Access directory"
                      : "Last available Access directory"}
                  </p>
                  {currentMatches.length > 1 && (
                    <p className="mt-1">
                      Several possible matches are visible. Compare each entry
                      before discarding the saved draft.
                    </p>
                  )}
                  {(currentMatches.length ? currentMatches : [null]).map(
                    (current, index) => (
                      <div key={current?.id ?? "no-match"} className="mt-2">
                        {currentMatches.length > 1 && (
                          <p className="font-medium">
                            Possible match {index + 1}: {current?.name}
                          </p>
                        )}
                        <Table className="min-w-[27rem] border-collapse text-left text-xs">
                          <TableCaption className="sr-only">
                            Saved and current identity values
                          </TableCaption>
                          <TableHeader>
                            <TableRow>
                              <TableHead
                                scope="col"
                                className="h-auto py-2 pr-2 pl-0 whitespace-normal"
                              >
                                Field
                              </TableHead>
                              <TableHead
                                scope="col"
                                className="h-auto px-2 py-2 whitespace-normal"
                              >
                                Saved draft
                              </TableHead>
                              <TableHead
                                scope="col"
                                className="h-auto py-2 pr-0 pl-2 whitespace-normal"
                              >
                                {comparisonFresh
                                  ? "Current Access"
                                  : "Last available Access"}
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {comparisonFields(draft.kind).map((field) => (
                              <TableRow key={field}>
                                <TableHead
                                  scope="row"
                                  className="h-auto py-2 pr-2 pl-0 align-top font-medium whitespace-normal"
                                >
                                  {fieldLabels[field]}
                                </TableHead>
                                <TableCell className="px-2 py-2 align-top break-words whitespace-normal">
                                  {comparisonValue(draft, field, controller)}
                                </TableCell>
                                <TableCell className="py-2 pr-0 pl-2 align-top break-words whitespace-normal">
                                  {comparisonValue(current, field, controller)}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    ),
                  )}
                </section>
                {needsReload ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-3 min-h-11"
                    onClick={() => window.location.reload()}
                  >
                    Reload Access
                  </Button>
                ) : !freshAccessState ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-3 min-h-11"
                    disabled={pending || controller.resource.refreshing}
                    onClick={() => void controller.resource.reload()}
                  >
                    Retry Access refresh
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-3 min-h-11"
                    disabled={pending || !freshAccessState}
                    onClick={() => setConfirmUncertainDiscard(true)}
                  >
                    Discard saved draft
                  </Button>
                )}
              </div>
            )}
            <fieldset disabled={pending || uncertain} className="contents">
              <div className="flex-1 space-y-6 overflow-y-auto p-5">
                {journalIssue ? (
                  <Alert role="alert" variant="warning">
                    {journalIssue}
                  </Alert>
                ) : null}
                {targetMissing ? (
                  <Alert role="alert" variant="warning">
                    This identity draft refers to a person, role, group,
                    department, sponsor, or owner that is no longer available.
                    It cannot be saved. Discard it and start again.
                  </Alert>
                ) : null}
                {errors.length > 0 && (
                  <div ref={errorRef} id={errorId} tabIndex={-1}>
                    <Alert variant="destructive">
                      <CircleAlert className="size-4" />
                      <p className="font-medium">Check this identity</p>
                      <ul className="mt-1 list-disc pl-4">
                        {errors.map((error) => (
                          <li key={error}>{error}</li>
                        ))}
                      </ul>
                    </Alert>
                  </div>
                )}

                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor={nameId}>Name</FieldLabel>
                    <Input
                      id={nameId}
                      autoFocus
                      className="min-h-11"
                      value={draft.name}
                      aria-describedby={errors.length ? errorId : undefined}
                      aria-invalid={!draft.name.trim() || undefined}
                      onChange={(event) => update({ name: event.target.value })}
                    />
                    {!draft.name.trim() && errors.length > 0 && (
                      <FieldError>Enter a name.</FieldError>
                    )}
                  </Field>

                  {(draft.kind === "internal" || draft.kind === "guest") && (
                    <Field>
                      <FieldLabel htmlFor={`${nameId}-email`}>Email</FieldLabel>
                      <Input
                        id={`${nameId}-email`}
                        type="email"
                        className="min-h-11"
                        value={draft.email}
                        disabled={Boolean(existing)}
                        onChange={(event) =>
                          update({ email: event.target.value })
                        }
                      />
                      <FieldDescription>
                        {existing
                          ? "Email addresses cannot be changed here."
                          : "An email invitation will be sent. No password is shown here."}
                      </FieldDescription>
                    </Field>
                  )}

                  {draft.kind === "internal" && (
                    <Field>
                      <FieldLabel htmlFor={`${nameId}-title`}>
                        Job title
                      </FieldLabel>
                      <Input
                        id={`${nameId}-title`}
                        className="min-h-11"
                        value={draft.title}
                        onChange={(event) =>
                          update({ title: event.target.value })
                        }
                      />
                    </Field>
                  )}

                  <Field>
                    <FieldLabel htmlFor={`${nameId}-role`}>Role</FieldLabel>
                    <NativeSelect
                      id={`${nameId}-role`}
                      className="w-full [&_select]:min-h-11"
                      value={draft.roleId}
                      onChange={(event) =>
                        update({ roleId: event.target.value })
                      }
                    >
                      {roles.map((role) => (
                        <NativeSelectOption key={role.id} value={role.id}>
                          {role.name}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    <FieldDescription>
                      Each person or service has one role.
                    </FieldDescription>
                  </Field>
                  {draft.kind === "internal" && (
                    <ExpiryField
                      id={`${nameId}-internal-expiry`}
                      value={draft.expiresAt ?? ""}
                      required={false}
                      onChange={(expiresAt) =>
                        update({ expiresAt: expiresAt || undefined })
                      }
                    />
                  )}
                </FieldGroup>

                {draft.kind === "internal" && (
                  <FieldSet>
                    <FieldLegend>Departments</FieldLegend>
                    <div className="grid gap-1 sm:grid-cols-2">
                      {controller.departmentCatalog.map((department) => {
                        const { id, name } = department;
                        return (
                          <label
                            key={id}
                            className="hover:bg-muted flex min-h-11 items-center gap-3 rounded-md px-3 text-sm"
                          >
                            <Checkbox
                              checked={draft.departmentIds.includes(id)}
                              onCheckedChange={(checked) =>
                                updateDepartment(id, checked === true)
                              }
                            />
                            {name}
                          </label>
                        );
                      })}
                      {closedDepartments.map(({ id, name }) => (
                        <label
                          key={id}
                          className="hover:bg-muted flex min-h-11 items-center gap-3 rounded-md px-3 text-sm"
                        >
                          <Checkbox
                            checked
                            onCheckedChange={(checked) =>
                              updateDepartment(id, checked === true)
                            }
                          />
                          {name} (closed — remove to change departments)
                        </label>
                      ))}
                    </div>
                    {closedDepartments.length > 0 && (
                      <p className="text-muted-foreground text-sm">
                        Closed departments cannot be added again. Remove all
                        closed departments before saving department changes.
                      </p>
                    )}
                    <Field>
                      <FieldLabel htmlFor={`${nameId}-primary`}>
                        Primary department
                      </FieldLabel>
                      <NativeSelect
                        id={`${nameId}-primary`}
                        className="w-full [&_select]:min-h-11"
                        value={draft.primaryDepartmentId}
                        onChange={(event) =>
                          update({ primaryDepartmentId: event.target.value })
                        }
                      >
                        <NativeSelectOption value="">
                          No primary department
                        </NativeSelectOption>
                        {draft.departmentIds.map((id) => (
                          <NativeSelectOption
                            key={id}
                            value={id}
                            disabled={!activeDepartmentIds.has(id)}
                          >
                            {controller.departmentCatalog.find(
                              (department) => department.id === id,
                            )?.name ??
                              `${closedDepartments.find((department) => department.id === id)?.name ?? "Closed department"} (closed)`}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </Field>
                  </FieldSet>
                )}

                {draft.kind !== "service" && (
                  <FieldSet>
                    <FieldLegend>Group membership</FieldLegend>
                    <p className="text-muted-foreground text-sm">
                      To change membership, close this editor and open
                      Permissions. Choose a group, then Manage members.
                    </p>
                    {draft.groupIds.length === 0 ? (
                      <p className="text-muted-foreground text-sm">
                        No groups assigned.
                      </p>
                    ) : (
                      <ul className="list-disc space-y-1 pl-5 text-sm">
                        {draft.groupIds.map((groupId) => (
                          <li key={groupId}>
                            {controller.state.groups.find(
                              (group) => group.id === groupId,
                            )?.name ?? "Group no longer available"}
                          </li>
                        ))}
                      </ul>
                    )}
                  </FieldSet>
                )}

                {draft.kind === "guest" && (
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor={`${nameId}-sponsor`}>
                        Sponsor (required)
                      </FieldLabel>
                      <NativeSelect
                        id={`${nameId}-sponsor`}
                        aria-describedby={`${nameId}-sponsor-help`}
                        className="w-full [&_select]:min-h-11"
                        value={draft.sponsorId}
                        onChange={(event) =>
                          update({ sponsorId: event.target.value })
                        }
                      >
                        <NativeSelectOption value="">
                          Choose a sponsor
                        </NativeSelectOption>
                        {internalIdentities.map((identity) => (
                          <NativeSelectOption
                            key={identity.id}
                            value={identity.id}
                          >
                            {identity.name}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      <FieldDescription id={`${nameId}-sponsor-help`}>
                        A sponsor is required for guest access. Choose an
                        internal person responsible for this guest.
                      </FieldDescription>
                    </Field>
                    <ExpiryField
                      id={`${nameId}-guest-expiry`}
                      value={draft.expiresAt}
                      onChange={(expiresAt) => update({ expiresAt })}
                    />
                    {guestInvitation && (
                      <p className="text-muted-foreground text-xs">
                        {draft.status === "revoked" ? (
                          "Invitation revoked. Resend it to issue a new link."
                        ) : (
                          <>
                            Invitation marked sent{" "}
                            {guestInvitation.sentAt
                              ? new Date(
                                  guestInvitation.sentAt,
                                ).toLocaleString()
                              : "without a recorded timestamp"}
                            {guestInvitation.resendCount > 0
                              ? ` · Resent ${guestInvitation.resendCount} ${guestInvitation.resendCount === 1 ? "time" : "times"}`
                              : ""}
                          </>
                        )}
                      </p>
                    )}
                  </FieldGroup>
                )}

                {draft.kind === "service" && (
                  <FieldGroup>
                    <Alert>
                      <KeyRound className="size-4" />
                      <p className="font-medium">No credentials are shown</p>
                      <div className="text-muted-foreground mt-1">
                        Only owner, purpose, expiry, and review state are
                        represented.
                      </div>
                    </Alert>
                    <Field>
                      <FieldLabel htmlFor={`${nameId}-owner`}>
                        Owner (required)
                      </FieldLabel>
                      <NativeSelect
                        id={`${nameId}-owner`}
                        aria-describedby={`${nameId}-owner-help`}
                        className="w-full [&_select]:min-h-11"
                        value={draft.ownerId}
                        onChange={(event) =>
                          update({ ownerId: event.target.value })
                        }
                      >
                        <NativeSelectOption value="">
                          Choose an owner
                        </NativeSelectOption>
                        {internalIdentities.map((identity) => (
                          <NativeSelectOption
                            key={identity.id}
                            value={identity.id}
                          >
                            {identity.name}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      <FieldDescription id={`${nameId}-owner-help`}>
                        An owner is required for service access. Choose an
                        internal person accountable for this service.
                      </FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`${nameId}-purpose`}>
                        Purpose
                      </FieldLabel>
                      <Input
                        id={`${nameId}-purpose`}
                        className="min-h-11"
                        value={draft.purpose}
                        onChange={(event) =>
                          update({ purpose: event.target.value })
                        }
                      />
                      <FieldDescription>
                        Describe the integration or automation this represents.
                      </FieldDescription>
                    </Field>
                    <ExpiryField
                      id={`${nameId}-service-expiry`}
                      value={draft.expiresAt}
                      onChange={(expiresAt) => update({ expiresAt })}
                    />
                  </FieldGroup>
                )}

                {existing && (
                  <section
                    aria-labelledby={`${nameId}-access-actions`}
                    className="space-y-3 border-t pt-5"
                  >
                    <h3
                      data-slot="section-title"
                      id={`${nameId}-access-actions`}
                      className="text-sm font-semibold"
                    >
                      Identity actions
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {(existing.kind === "internal" ||
                        existing.kind === "guest") &&
                        (existing.status === "pending" ||
                          existing.status === "revoked") && (
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11"
                            disabled={pending}
                            onClick={() =>
                              void report(
                                controller.actions.resendInvite(existing.id),
                              )
                            }
                          >
                            <Mail /> Resend invitation
                          </Button>
                        )}
                      {(existing.kind === "internal" ||
                        existing.kind === "guest") &&
                        existing.status === "pending" && (
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11"
                            disabled={
                              pending ||
                              !controller.availability.invitationRevocation
                            }
                            onClick={() =>
                              setPendingReview({
                                kind: "action",
                                action: {
                                  type: "revoke-invite",
                                  identity: copyIdentity(existing),
                                },
                              })
                            }
                          >
                            Revoke invitation
                          </Button>
                        )}
                      {existing.status === "disabled" ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          disabled={pending}
                          onClick={() =>
                            setPendingReview({
                              kind: "action",
                              action: {
                                type: "enable",
                                identity: copyIdentity(existing),
                              },
                            })
                          }
                        >
                          <RotateCcw /> Enable identity
                        </Button>
                      ) : existing.status === "active" ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          disabled={pending}
                          onClick={disableExistingIdentity}
                        >
                          {draft.kind === "service"
                            ? "Disable service"
                            : "Disable person"}
                        </Button>
                      ) : null}
                    </div>
                  </section>
                )}

                {existing && existing.kind !== "service" && (
                  <section
                    aria-labelledby={`${nameId}-sessions`}
                    className="space-y-3 border-t pt-5"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <h3
                        data-slot="section-title"
                        id={`${nameId}-sessions`}
                        className="text-sm font-semibold"
                      >
                        Sessions
                      </h3>
                      {sessionStatus === "ready" && sessions.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          className="min-h-11"
                          disabled={pending}
                          onClick={() =>
                            setPendingReview({
                              kind: "action",
                              action: {
                                type: "revoke-all-sessions",
                                identity: copyIdentity(existing),
                                count: sessions.filter(
                                  (session) => !session.current,
                                ).length,
                              },
                            })
                          }
                        >
                          <LogOut /> Revoke all
                        </Button>
                      )}
                    </div>
                    {sessionStatus === "loading" ? (
                      <p className="text-muted-foreground text-sm">
                        Loading active sessions…
                      </p>
                    ) : sessionStatus === "error" ? (
                      <Alert variant="warning">
                        <p>{sessionResource.error}</p>
                        <Button
                          type="button"
                          variant="outline"
                          className="mt-2 min-h-11"
                          onClick={() => void sessionResource.load(existing.id)}
                        >
                          Retry sessions
                        </Button>
                      </Alert>
                    ) : sessionStatus === "ready" && sessions.length === 0 ? (
                      <p className="text-muted-foreground text-sm">
                        No active sessions.
                      </p>
                    ) : sessionStatus === "ready" ? (
                      <ul className="divide-y rounded-md border">
                        {sessions.map((session) => (
                          <li
                            key={session.id}
                            className="flex items-start gap-3 p-3"
                          >
                            <Laptop className="text-muted-foreground mt-1 size-4 shrink-0" />
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium">
                                {session.label}
                              </p>
                              <p className="text-muted-foreground mt-0.5 text-xs">
                                {session.current
                                  ? "Current session"
                                  : "Remote session"}
                                {session.lastActiveAt
                                  ? ` · Active ${new Date(session.lastActiveAt).toLocaleString()}`
                                  : ""}
                              </p>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-11 shrink-0"
                              disabled={session.current || pending}
                              aria-label={`Revoke ${session.label}`}
                              onClick={() =>
                                setPendingReview({
                                  kind: "action",
                                  action: {
                                    type: "revoke-session",
                                    identity: copyIdentity(existing),
                                    sessionId: session.id,
                                    sessionLabel: session.label,
                                  },
                                })
                              }
                            >
                              <LogOut />
                            </Button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </section>
                )}

                {existing && existing.status !== "deleted" && (
                  <section
                    aria-labelledby={`${nameId}-danger`}
                    className="space-y-3 border-t pt-5"
                  >
                    <h3
                      data-slot="section-title"
                      id={`${nameId}-danger`}
                      className="text-destructive text-sm font-semibold"
                    >
                      Danger zone
                    </h3>
                    <Button
                      type="button"
                      variant="destructive"
                      className="min-h-11"
                      disabled={pending}
                      onClick={() =>
                        setPendingReview({
                          kind: "action",
                          action: {
                            type: "delete",
                            identity: copyIdentity(existing),
                          },
                        })
                      }
                    >
                      <Trash2 /> Delete identity
                    </Button>
                    <p className="text-muted-foreground text-xs">
                      The last active administrator cannot be disabled, demoted,
                      or deleted. Exact-name confirmation is required.
                    </p>
                  </section>
                )}
              </div>
            </fieldset>

            <SheetFooter className="border-t p-4">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={requestClose}
              >
                Cancel
              </Button>
              {existing?.status !== "deleted" && (
                <Button
                  type="submit"
                  className="min-h-11"
                  disabled={pending || uncertain || targetMissing}
                >
                  {identityId
                    ? "Save changes"
                    : draft?.kind === "service"
                      ? "Add service"
                      : "Add person"}
                </Button>
              )}
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={confirmUncertainDiscard}
        onOpenChange={setConfirmUncertainDiscard}
      >
        <AlertDialogContent>
          <AlertDialogTitle>
            Discard uncertain identity change?
          </AlertDialogTitle>
          <AlertDialogDescription>
            The earlier change may have completed. Review the current Access
            state before discarding these saved values. Discarding starts a new
            draft; it does not undo a server change.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel
              render={<Button variant="outline" className="min-h-11" />}
            >
              Keep reviewing
            </AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              disabled={pending || needsReload || !freshAccessState}
              onClick={discardUncertainDraft}
            >
              Discard saved draft
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={pendingReview !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setPendingReview(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {pendingReview?.kind === "action"
                ? "Review lifecycle impact"
                : "Review identity changes"}
            </DialogTitle>
            <DialogDescription>
              Nothing is applied until you confirm this review.
            </DialogDescription>
          </DialogHeader>
          {pendingReview && reviewAfter && (
            <div className="space-y-4">
              {pendingReview.kind === "action" ? (
                <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-3 text-sm">
                  <dt className="text-muted-foreground">Action</dt>
                  <dd className="font-medium">
                    {reviewedActionLabels[pendingReview.action.type]}
                  </dd>
                  <dt className="text-muted-foreground">Identity</dt>
                  <dd>{pendingReview.action.identity.name}</dd>
                  <dt className="text-muted-foreground">Impact</dt>
                  <dd>{reviewedActionImpact(pendingReview.action)}</dd>
                </dl>
              ) : (
                <>
                  <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-3 text-sm">
                    <dt className="text-muted-foreground">Identity</dt>
                    <dd className="font-medium">
                      {reviewAfter.name} · {reviewAfter.kind}
                    </dd>
                    <dt className="text-muted-foreground">Status</dt>
                    <dd>
                      {reviewBefore
                        ? `${statusLabels[reviewBefore.status]} → `
                        : "New → "}
                      {statusLabels[reviewAfter.status]}
                    </dd>
                    <dt className="text-muted-foreground">Role</dt>
                    <dd>
                      {reviewBefore
                        ? (controller.state.roles.find(
                            (role) => role.id === reviewBefore.roleId,
                          )?.name ?? "Unknown role")
                        : "None"}
                      {" → "}
                      {controller.state.roles.find(
                        (role) => role.id === reviewAfter.roleId,
                      )?.name ?? "Unknown role"}
                    </dd>
                    <dt className="text-muted-foreground">Expiry</dt>
                    <dd>
                      {reviewAfter.expiresAt
                        ? new Date(reviewAfter.expiresAt).toLocaleString()
                        : "No expiry"}
                    </dd>
                    <dt className="text-muted-foreground">Memberships</dt>
                    <dd className="space-y-1">
                      {addedMemberships.length === 0 &&
                      removedMemberships.length === 0
                        ? "No membership changes"
                        : null}
                      {addedMemberships.length > 0 && (
                        <p>Added: {addedMemberships.join(", ")}</p>
                      )}
                      {removedMemberships.length > 0 && (
                        <p>Removed: {removedMemberships.join(", ")}</p>
                      )}
                    </dd>
                  </dl>
                  <Alert
                    variant={
                      accessImpact(
                        reviewBefore,
                        reviewAfter,
                        controller,
                      ).startsWith("Removed")
                        ? "warning"
                        : "default"
                    }
                  >
                    <ShieldAlert className="size-4" />
                    <p className="font-medium">Access effect</p>
                    <p className="mt-1">
                      {accessImpact(reviewBefore, reviewAfter, controller)}
                    </p>
                  </Alert>
                </>
              )}
            </div>
          )}
          <DialogFooter>
            <DialogClose
              render={<Button variant="outline" className="min-h-11" />}
            >
              Back to edit
            </DialogClose>
            <Button
              className="min-h-11"
              disabled={pending}
              onClick={confirmReview}
            >
              {pendingReview?.kind === "action"
                ? pendingReview.action.type === "revoke-session" ||
                  pendingReview.action.type === "revoke-all-sessions"
                  ? "Confirm session revocation"
                  : "Continue to name confirmation"
                : pendingReview?.kind === "create"
                  ? "Create identity"
                  : "Apply changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={conflictFields.length > 0}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setConflictFields([]);
            setPendingPatch(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Resolve updated fields</AlertDialogTitle>
          <AlertDialogDescription>
            This identity changed after you opened it. Unrelated current changes
            will be preserved. Choose how to resolve the fields changed in both
            places.
          </AlertDialogDescription>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {conflictFields.map((field) => (
              <li key={field}>{fieldLabels[field]}</li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel
              render={<Button variant="outline" className="min-h-11" />}
            >
              Keep editing
            </AlertDialogCancel>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => {
                const next = { ...(pendingPatch ?? {}) };
                for (const field of conflictFields) delete next[field];
                setConflictFields([]);
                setPendingPatch(null);
                if (Object.keys(next).length === 0) {
                  toast.add({
                    title: "Kept current values",
                    description: "No draft-only changes remained to save.",
                    type: "info",
                  });
                  closeEditor();
                } else stageUpdate(next);
              }}
            >
              Keep current values
            </Button>
            <Button
              className="min-h-11"
              onClick={() => {
                const next = pendingPatch;
                setConflictFields([]);
                setPendingPatch(null);
                if (next) stageUpdate(next);
              }}
            >
              Use my draft values
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>
            Your changes to this identity have not been saved.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel
              render={<Button variant="outline" className="min-h-11" />}
            >
              Keep editing
            </AlertDialogCancel>
            <Button
              variant="destructive"
              className="min-h-11"
              disabled={pending}
              onClick={() => {
                setConfirmClose(false);
                closeEditor();
              }}
            >
              Discard changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={confirmationMode !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setConfirmationMode(null);
            setPendingDestructiveAction(null);
            setPendingCreateIdentity(null);
            setPendingPatch(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmationMode === "delete"
                ? "Delete identity?"
                : confirmationMode === "destructive-action"
                  ? pendingDestructiveAction?.type === "enable"
                    ? "Enable identity?"
                    : pendingDestructiveAction?.type === "disable"
                      ? "Disable identity?"
                      : "Revoke invitation?"
                  : "Change administrator access?"}
            </DialogTitle>
            <DialogDescription>
              Type <strong>{confirmationTargetName}</strong> to confirm.
              Protected last-administrator rules still apply.
            </DialogDescription>
          </DialogHeader>
          <Alert variant="warning">
            <ShieldAlert className="size-4" />
            <p className="font-medium">This access change is sensitive</p>
            <div className="mt-1">
              {confirmationMode === "delete"
                ? "Deletion removes this identity from the active directory."
                : confirmationMode === "destructive-action"
                  ? reviewedActionImpact(
                      pendingDestructiveAction ?? {
                        type: "disable",
                        identity: draft,
                      },
                    )
                  : "Changing Administrator access can affect workspace recovery."}
            </div>
          </Alert>
          <Field>
            <FieldLabel htmlFor={`${nameId}-confirm`}>
              Type the name to confirm
            </FieldLabel>
            <Input
              id={`${nameId}-confirm`}
              autoComplete="off"
              className="min-h-11"
              value={confirmationName}
              onChange={(event) => setConfirmationName(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <DialogClose
              render={<Button variant="outline" className="min-h-11" />}
            >
              Cancel
            </DialogClose>
            <Button
              variant={
                pendingDestructiveAction?.type === "enable"
                  ? "default"
                  : "destructive"
              }
              className="min-h-11"
              disabled={confirmationName !== confirmationTargetName || pending}
              onClick={confirmSensitiveAction}
            >
              {confirmationMode === "delete"
                ? "Delete identity"
                : confirmationMode === "destructive-action"
                  ? pendingDestructiveAction?.type === "enable"
                    ? "Enable identity"
                    : pendingDestructiveAction?.type === "disable"
                      ? "Disable identity"
                      : "Revoke invitation"
                  : "Confirm access change"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ExpiryField({
  id,
  value,
  required = true,
  onChange,
}: {
  id: string;
  value: string;
  required?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>
        Access expires{required ? "" : " (optional)"}
      </FieldLabel>
      <Input
        id={id}
        type="datetime-local"
        className="min-h-11"
        value={datetimeLocal(value)}
        onChange={(event) => onChange(isoDate(event.target.value))}
      />
      <FieldDescription>
        {required
          ? "Expiry is required for guest and service access."
          : "Leave blank for ongoing internal access."}
      </FieldDescription>
    </Field>
  );
}
