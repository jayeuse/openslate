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
import { toast } from "@/components/ui/toast";
import { departments } from "./model";
import type {
  AccessController,
  CreateIdentityInput,
  UpdateIdentityPatch,
} from "./controller";
import {
  validateAccessIdentity,
  type AccessIdentity,
  type AccessIdentityStatus,
} from "./policy";

type IdentityEditorProps = {
  controller: AccessController;
  identityId: string | null;
  createKind: AccessIdentity["kind"] | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type ConfirmationMode = "delete" | "admin-change" | "destructive-action" | null;
type EditableField = keyof UpdateIdentityPatch;
type ReviewedAction =
  | { type: "disable" | "revoke-invite" | "delete"; identity: AccessIdentity }
  | {
      type: "revoke-session";
      identity: AccessIdentity;
      sessionId: string;
      sessionLabel: string;
    }
  | { type: "revoke-all-sessions"; identity: AccessIdentity; count: number };
type PendingReview =
  | { kind: "create"; identity: AccessIdentity }
  | {
      kind: "update";
      before: AccessIdentity;
      after: AccessIdentity;
      patch: UpdateIdentityPatch;
    }
  | { kind: "action"; action: ReviewedAction };

const statusLabels: Record<AccessIdentityStatus, string> = {
  active: "Active",
  pending: "Invitation pending",
  disabled: "Disabled",
  deleted: "Deleted",
  revoked: "Invitation revoked",
  suspended: "Suspended",
};

function departmentId(name: string): string {
  return `department:${name.toLowerCase().replaceAll(" ", "-")}`;
}

function datetimeLocal(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.valueOf() - offset).toISOString().slice(0, 16);
}

function isoDate(value: string): string {
  return value ? new Date(value).toISOString() : "";
}

function createDraft(
  kind: AccessIdentity["kind"],
  controller: AccessController,
): AccessIdentity {
  const { defaults } = controller.state;
  const expiry = new Date();
  expiry.setDate(
    expiry.getDate() +
      (kind === "guest"
        ? defaults.guestDurationDays
        : defaults.serviceDurationDays),
  );
  const base = {
    id: "draft",
    name: "",
    status: kind === "service" ? ("active" as const) : ("pending" as const),
    roleId: defaults.defaultRoleId,
    groupIds: kind === "service" ? [] : [...defaults.defaultGroupIds],
  };
  if (kind === "internal") {
    return {
      ...base,
      kind,
      email: "",
      departmentIds: [...defaults.defaultDepartmentIds],
      primaryDepartmentId: defaults.defaultDepartmentIds[0] ?? "",
      title: "",
    };
  }
  if (kind === "guest") {
    return {
      ...base,
      kind,
      email: "",
      sponsorId: "",
      expiresAt: expiry.toISOString(),
    };
  }
  return {
    ...base,
    kind,
    ownerId: "",
    purpose: "",
    expiresAt: expiry.toISOString(),
    credentialState: "not-created",
  };
}

function copyIdentity(identity: AccessIdentity): AccessIdentity {
  return {
    ...identity,
    groupIds: [...identity.groupIds],
    ...(identity.kind === "internal"
      ? { departmentIds: [...identity.departmentIds] }
      : {}),
  };
}

function identityToCreateInput(identity: AccessIdentity): CreateIdentityInput {
  const base = {
    name: identity.name,
    status: identity.status,
    roleId: identity.roleId,
    groupIds: identity.groupIds,
  };
  if (identity.kind === "internal")
    return {
      ...base,
      kind: "internal",
      email: identity.email,
      departmentIds: identity.departmentIds,
      primaryDepartmentId: identity.primaryDepartmentId,
      title: identity.title,
      ...(identity.expiresAt ? { expiresAt: identity.expiresAt } : {}),
    };
  if (identity.kind === "guest")
    return {
      ...base,
      kind: "guest",
      email: identity.email,
      sponsorId: identity.sponsorId,
      expiresAt: identity.expiresAt,
    };
  return {
    ...base,
    kind: "service",
    ownerId: identity.ownerId,
    purpose: identity.purpose,
    expiresAt: identity.expiresAt,
    ...(identity.credentialState
      ? { credentialState: identity.credentialState }
      : {}),
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function identityValue(
  identity: AccessIdentity,
  field: EditableField,
): unknown {
  if (field in identity) return identity[field as keyof AccessIdentity];
  return undefined;
}

function changedIdentityPatch(
  baseline: AccessIdentity,
  draft: AccessIdentity,
): UpdateIdentityPatch {
  const patch: UpdateIdentityPatch = {};
  if (baseline.name !== draft.name) patch.name = draft.name;
  if (baseline.status !== draft.status) patch.status = draft.status;
  if (baseline.roleId !== draft.roleId) patch.roleId = draft.roleId;
  if (!sameValue(baseline.groupIds, draft.groupIds))
    patch.groupIds = draft.groupIds;
  if (baseline.expiresAt !== draft.expiresAt) patch.expiresAt = draft.expiresAt;
  if (baseline.kind === "internal" && draft.kind === "internal") {
    if (baseline.email !== draft.email) patch.email = draft.email;
    if (!sameValue(baseline.departmentIds, draft.departmentIds))
      patch.departmentIds = draft.departmentIds;
    if (baseline.primaryDepartmentId !== draft.primaryDepartmentId)
      patch.primaryDepartmentId = draft.primaryDepartmentId;
    if (baseline.title !== draft.title) patch.title = draft.title;
  } else if (baseline.kind === "guest" && draft.kind === "guest") {
    if (baseline.email !== draft.email) patch.email = draft.email;
    if (baseline.sponsorId !== draft.sponsorId)
      patch.sponsorId = draft.sponsorId;
  } else if (baseline.kind === "service" && draft.kind === "service") {
    if (baseline.ownerId !== draft.ownerId) patch.ownerId = draft.ownerId;
    if (baseline.purpose !== draft.purpose) patch.purpose = draft.purpose;
  }
  return patch;
}

function applyPatchForReview(
  identity: AccessIdentity,
  patch: UpdateIdentityPatch,
): AccessIdentity {
  return { ...identity, ...patch } as AccessIdentity;
}

const fieldLabels: Record<EditableField, string> = {
  name: "Name",
  status: "Status",
  roleId: "Role",
  groupIds: "Groups",
  expiresAt: "Expiry",
  email: "Email",
  departmentIds: "Departments",
  primaryDepartmentId: "Primary department",
  title: "Job title",
  sponsorId: "Sponsor",
  ownerId: "Owner",
  purpose: "Purpose",
};

const reviewedActionLabels: Record<ReviewedAction["type"], string> = {
  disable: "Disable identity",
  "revoke-invite": "Revoke invitation",
  delete: "Delete identity",
  "revoke-session": "Revoke one session",
  "revoke-all-sessions": "Revoke all remote sessions",
};

function reviewedActionImpact(action: ReviewedAction): string {
  if (action.type === "disable")
    return "Removed: this identity will lose active access until restored.";
  if (action.type === "revoke-invite")
    return "Removed: the pending invitation will no longer grant access.";
  if (action.type === "delete")
    return "Removed: the identity, memberships, and sessions leave the active directory.";
  if (action.type === "revoke-session")
    return `Removed: ${action.sessionLabel} will end; other identity access remains.`;
  if (action.type === "revoke-all-sessions")
    return `Removed: ${action.count} remote ${action.count === 1 ? "session" : "sessions"} will end; the current session remains protected.`;
  return "Removed: access will be reduced.";
}

function membershipLabels(
  identity: AccessIdentity,
  controller: AccessController,
): string[] {
  const groups = identity.groupIds.map(
    (id) =>
      controller.state.groups.find((group) => group.id === id)?.name ?? id,
  );
  if (identity.kind !== "internal") return groups;
  return [
    ...identity.departmentIds.map(
      (id) =>
        departments.find((name) => departmentId(name) === id) ??
        id.replace(/^department:/, "").replaceAll("-", " "),
    ),
    ...groups,
  ];
}

function accessImpact(
  before: AccessIdentity | null,
  after: AccessIdentity,
  controller: AccessController,
): string {
  if (!before && after.roleId === "sample-admin")
    return "Elevated: new Administrator access is prepared and remains pending until active.";
  if (!before)
    return after.status === "active"
      ? "Elevated: a new active identity will receive access."
      : "Prepared: access remains unavailable until the invitation is active.";
  if (before.status !== "active" && after.status === "active")
    return "Elevated: inactive access will become active.";
  if (before.status === "active" && after.status !== "active")
    return "Removed: active access will be unavailable.";
  if (before.roleId !== after.roleId) {
    if (after.roleId === "sample-admin")
      return "Elevated: the identity will become an Administrator.";
    if (before.roleId === "sample-admin")
      return "Removed: Administrator access will be removed.";
    const beforeCount =
      controller.state.roles.find((role) => role.id === before.roleId)?.grants
        .length ?? 0;
    const afterCount =
      controller.state.roles.find((role) => role.id === after.roleId)?.grants
        .length ?? 0;
    if (afterCount > beforeCount)
      return "Elevated: the selected role has more explicit grants.";
    if (afterCount < beforeCount)
      return "Removed: the selected role has fewer explicit grants.";
    return "Changed: the role changes without a clear grant-count increase.";
  }
  if (before.expiresAt !== after.expiresAt) {
    if (!before.expiresAt && after.expiresAt)
      return "Removed: access now has an expiry boundary.";
    if (before.expiresAt && !after.expiresAt)
      return "Elevated: the previous expiry boundary is removed.";
    const beforeExpiry = Date.parse(before.expiresAt ?? "");
    const afterExpiry = Date.parse(after.expiresAt ?? "");
    if (afterExpiry > beforeExpiry)
      return "Elevated: the access period is extended.";
    if (afterExpiry < beforeExpiry)
      return "Removed: the access period is shortened.";
  }
  const beforeMembership = new Set(membershipLabels(before, controller));
  const afterMembership = new Set(membershipLabels(after, controller));
  const added = [...afterMembership].some(
    (item) => !beforeMembership.has(item),
  );
  const removed = [...beforeMembership].some(
    (item) => !afterMembership.has(item),
  );
  if (added && removed)
    return "Changed: memberships are both added and removed.";
  if (added) return "Elevated: one or more memberships are added.";
  if (removed) return "Removed: one or more memberships are removed.";
  return "Unchanged: no direct role, status, or membership access change.";
}

export function IdentityEditor({
  controller,
  identityId,
  createKind,
  open,
  onOpenChange,
}: IdentityEditorProps) {
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
  const [resetPreview, setResetPreview] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const nameId = useId();
  const errorId = useId();

  useEffect(() => {
    if (!open) {
      setLoadedKey(null);
      return;
    }
    const key = existing?.id ?? (createKind ? `create:${createKind}` : null);
    if (!key || loadedKey === key) return;
    const next = existing
      ? copyIdentity(existing)
      : createKind
        ? createDraft(createKind, controller)
        : null;
    setDraft(next);
    setBaseline(next ? copyIdentity(next) : null);
    setLoadedKey(key);
    setErrors([]);
    setConfirmationMode(null);
    setConfirmationName("");
    setConflictFields([]);
    setPendingPatch(null);
    setPendingReview(null);
    setPendingDestructiveAction(null);
    setPendingCreateIdentity(null);
  }, [controller, createKind, existing, loadedKey, open]);

  const dirty =
    draft !== null && baseline !== null && !sameValue(draft, baseline);
  const roles = controller.state.roles.filter(
    (role) => draft?.kind === "internal" || role.id !== "sample-admin",
  );
  const internalIdentities = controller.state.identities.filter(
    (identity) => identity.kind === "internal" && identity.status === "active",
  );
  const sessions = existing
    ? controller.state.sessions.filter(
        (session) =>
          session.identityId === existing.id && session.status === "active",
      )
    : [];
  const guestInvitation =
    existing?.kind === "guest"
      ? controller.state.guests.find((guest) => guest.id === existing.id)
          ?.invitation
      : undefined;

  function requestClose() {
    if (dirty) {
      setConfirmClose(true);
      return;
    }
    onOpenChange(false);
  }

  function update(patch: Partial<AccessIdentity>) {
    setDraft((current) =>
      current ? ({ ...current, ...patch } as AccessIdentity) : null,
    );
  }

  function showError(message: string) {
    setErrors([message]);
    requestAnimationFrame(() => errorRef.current?.focus());
  }

  function report(
    result: ReturnType<typeof controller.actions.updateIdentity>,
  ) {
    if (!result.ok) {
      showError(result.error);
      return false;
    }
    toast.add({ title: result.summary, type: "success" });
    return true;
  }

  function stageUpdate(patch: UpdateIdentityPatch) {
    if (!existing) return;
    setPendingReview({
      kind: "update",
      before: copyIdentity(existing),
      after: applyPatchForReview(existing, patch),
      patch,
    });
  }

  function persist() {
    if (!draft) return;
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
      onOpenChange(false);
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
      setDraft(normalized);
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

  function confirmReview() {
    if (!pendingReview) return;
    if (pendingReview.kind === "action") {
      const action = pendingReview.action;
      setPendingReview(null);
      if (action.type === "revoke-session") {
        report(
          controller.actions.revokeSession(
            action.identity.id,
            action.sessionId,
          ),
        );
        return;
      }
      if (action.type === "revoke-all-sessions") {
        report(controller.actions.revokeAllSessions(action.identity.id));
        return;
      }
      setPendingDestructiveAction(action);
      setConfirmationMode(
        action.type === "delete" ? "delete" : "destructive-action",
      );
      setConfirmationName("");
      return;
    }
    if (pendingReview.kind === "create") {
      if (pendingReview.identity.roleId === "sample-admin") {
        setPendingCreateIdentity(pendingReview.identity);
        setPendingReview(null);
        setConfirmationMode("admin-change");
        setConfirmationName("");
        return;
      }
      const result = controller.actions.createIdentity(
        identityToCreateInput(pendingReview.identity),
      );
      setPendingReview(null);
      if (report(result)) onOpenChange(false);
      return;
    }
    const changesAdministratorAccess =
      (pendingReview.before.roleId === "sample-admin" ||
        pendingReview.after.roleId === "sample-admin") &&
      (pendingReview.before.roleId !== pendingReview.after.roleId ||
        pendingReview.before.status !== pendingReview.after.status);
    setPendingReview(null);
    if (changesAdministratorAccess) {
      setPendingPatch(pendingReview.patch);
      setConfirmationMode("admin-change");
      setConfirmationName("");
      return;
    }
    if (
      report(
        controller.actions.updateIdentity(
          pendingReview.before.id,
          pendingReview.patch,
        ),
      )
    )
      onOpenChange(false);
  }

  function confirmSensitiveAction() {
    const confirmationTarget = existing ?? pendingCreateIdentity;
    if (!confirmationTarget || confirmationName !== confirmationTarget.name)
      return;
    if (confirmationMode === "admin-change") {
      setConfirmationMode(null);
      const result = pendingCreateIdentity
        ? controller.actions.createIdentity(
            identityToCreateInput(pendingCreateIdentity),
          )
        : controller.actions.updateIdentity(
            existing?.id ?? "",
            pendingPatch ?? {},
          );
      setPendingCreateIdentity(null);
      if (report(result)) onOpenChange(false);
      return;
    }
    if (!existing) return;
    const result =
      pendingDestructiveAction?.type === "disable"
        ? controller.actions.disableIdentity(existing.id)
        : pendingDestructiveAction?.type === "revoke-invite"
          ? controller.actions.revokeInvite(existing.id)
          : controller.actions.deleteIdentity(existing.id);
    setConfirmationMode(null);
    setConfirmationName("");
    setPendingDestructiveAction(null);
    if (report(result)) onOpenChange(false);
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
                {existing ? draft.name : `Add ${draft.kind} identity`}
              </SheetTitle>
              <Badge variant="outline">{draft.kind}</Badge>
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
                : "No messages or credentials are sent from this editor."}
            </SheetDescription>
          </SheetHeader>

          <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
            <div className="flex-1 space-y-6 overflow-y-auto p-5">
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
                      onChange={(event) =>
                        update({ email: event.target.value })
                      }
                    />
                    <FieldDescription>
                      Used only to represent invitation state.
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
                    onChange={(event) => update({ roleId: event.target.value })}
                  >
                    {roles.map((role) => (
                      <NativeSelectOption key={role.id} value={role.id}>
                        {role.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <FieldDescription>
                    Every identity has exactly one role.
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
                    {departments.map((name) => {
                      const id = departmentId(name);
                      return (
                        <label
                          key={id}
                          className="hover:bg-muted flex min-h-11 items-center gap-3 rounded-md px-3 text-sm"
                        >
                          <Checkbox
                            checked={draft.departmentIds.includes(id)}
                            onCheckedChange={(checked) => {
                              const departmentIds = checked
                                ? [...draft.departmentIds, id]
                                : draft.departmentIds.filter(
                                    (item) => item !== id,
                                  );
                              update({
                                departmentIds,
                                primaryDepartmentId: departmentIds.includes(
                                  draft.primaryDepartmentId,
                                )
                                  ? draft.primaryDepartmentId
                                  : (departmentIds[0] ?? ""),
                              });
                            }}
                          />
                          {name}
                        </label>
                      );
                    })}
                  </div>
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
                        <NativeSelectOption key={id} value={id}>
                          {departments.find(
                            (name) => departmentId(name) === id,
                          ) ?? id}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                </FieldSet>
              )}

              {draft.kind !== "service" && (
                <FieldSet>
                  <FieldLegend>Group membership</FieldLegend>
                  {controller.state.groups.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                      No groups are available.
                    </p>
                  ) : (
                    <div className="grid gap-1 sm:grid-cols-2">
                      {controller.state.groups.map((group) => (
                        <label
                          key={group.id}
                          className="hover:bg-muted flex min-h-11 items-center gap-3 rounded-md px-3 text-sm"
                        >
                          <Checkbox
                            checked={draft.groupIds.includes(group.id)}
                            onCheckedChange={(checked) =>
                              update({
                                groupIds: checked
                                  ? [...draft.groupIds, group.id]
                                  : draft.groupIds.filter(
                                      (id) => id !== group.id,
                                    ),
                              })
                            }
                          />
                          {group.name}
                        </label>
                      ))}
                    </div>
                  )}
                </FieldSet>
              )}

              {draft.kind === "guest" && (
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor={`${nameId}-sponsor`}>
                      Sponsor
                    </FieldLabel>
                    <NativeSelect
                      id={`${nameId}-sponsor`}
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
                  </Field>
                  <ExpiryField
                    id={`${nameId}-guest-expiry`}
                    value={draft.expiresAt}
                    onChange={(expiresAt) => update({ expiresAt })}
                  />
                  {guestInvitation && (
                    <p className="text-muted-foreground text-xs">
                      Invitation marked sent{" "}
                      {guestInvitation.sentAt
                        ? new Date(guestInvitation.sentAt).toLocaleString()
                        : "without a recorded timestamp"}
                      {guestInvitation.resendCount > 0
                        ? ` · Resent ${guestInvitation.resendCount} ${guestInvitation.resendCount === 1 ? "time" : "times"}`
                        : ""}
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
                    <FieldLabel htmlFor={`${nameId}-owner`}>Owner</FieldLabel>
                    <NativeSelect
                      id={`${nameId}-owner`}
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
                    id={`${nameId}-access-actions`}
                    className="text-sm font-semibold"
                  >
                    Identity actions
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {(existing.kind === "internal" ||
                      existing.kind === "guest") &&
                      existing.status === "pending" && (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11"
                            onClick={() =>
                              report(
                                controller.actions.resendInvite(existing.id),
                              )
                            }
                          >
                            <Mail /> Resend invitation
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11"
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
                        </>
                      )}
                    {existing.kind === "internal" &&
                      existing.status === "active" && (
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          onClick={() => setResetPreview(true)}
                        >
                          <KeyRound /> Preview password reset
                        </Button>
                      )}
                    {existing.status === "disabled" ||
                    existing.status === "revoked" ||
                    existing.status === "deleted" ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        onClick={() =>
                          report(
                            controller.actions.restoreIdentity(existing.id),
                          )
                        }
                      >
                        <RotateCcw /> Restore identity
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        onClick={disableExistingIdentity}
                      >
                        Disable identity
                      </Button>
                    )}
                  </div>
                </section>
              )}

              {existing && (
                <section
                  aria-labelledby={`${nameId}-sessions`}
                  className="space-y-3 border-t pt-5"
                >
                  <div className="flex items-center justify-between gap-3">
                    <h3
                      id={`${nameId}-sessions`}
                      className="text-sm font-semibold"
                    >
                      Sessions
                    </h3>
                    {sessions.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        className="min-h-11"
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
                  {sessions.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                      No active sessions.
                    </p>
                  ) : (
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
                            disabled={session.current}
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
                  )}
                </section>
              )}

              {existing && existing.status !== "deleted" && (
                <section
                  aria-labelledby={`${nameId}-danger`}
                  className="space-y-3 border-t pt-5"
                >
                  <h3
                    id={`${nameId}-danger`}
                    className="text-destructive text-sm font-semibold"
                  >
                    Danger zone
                  </h3>
                  <Button
                    type="button"
                    variant="destructive"
                    className="min-h-11"
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
                <Button type="submit" className="min-h-11">
                  {existing ? "Save changes" : "Add identity"}
                </Button>
              )}
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>

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
            <Button className="min-h-11" onClick={confirmReview}>
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
                  onOpenChange(false);
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
              onClick={() => {
                setConfirmClose(false);
                onOpenChange(false);
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
                  ? pendingDestructiveAction?.type === "disable"
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
            <FieldLabel htmlFor={`${nameId}-confirm`}>Identity name</FieldLabel>
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
              variant="destructive"
              className="min-h-11"
              disabled={confirmationName !== confirmationTargetName}
              onClick={confirmSensitiveAction}
            >
              {confirmationMode === "delete"
                ? "Delete identity"
                : confirmationMode === "destructive-action"
                  ? pendingDestructiveAction?.type === "disable"
                    ? "Disable identity"
                    : "Revoke invitation"
                  : "Confirm access change"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resetPreview} onOpenChange={setResetPreview}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Password reset preview</DialogTitle>
            <DialogDescription>
              No email is sent and no password or reset token is generated.
            </DialogDescription>
          </DialogHeader>
          <Alert>
            <Mail className="size-4" />
            <p className="font-medium">Preview only</p>
            <div className="text-muted-foreground mt-1">
              A live system would send reset instructions to the internal
              identity’s verified email address.
            </div>
          </Alert>
          <DialogFooter>
            <DialogClose render={<Button className="min-h-11" />}>
              Done
            </DialogClose>
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
