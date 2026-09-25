import {
  createPolicyBundle,
  parsePolicyBundle,
  planPolicyImport,
  type AccessPolicyBundleV1,
} from "./policy-bundle";
import {
  validateAccessIdentity,
  type AccessIdentity,
  type AccessGroup,
  type AccessReview,
} from "./policy";
import type { Role } from "./model";
import {
  activeAdminCount,
  findIdentity,
  getControllerIdentities,
  internalFromPerson,
  personFromInternal,
  type AccessCommand,
  type AccessCommandContext,
  type AccessCommandResult,
  type AccessCommandValue,
  type AccessControllerSnapshot,
  type BulkIdentityImpact,
  type BulkIdentityUpdateInput,
  type ControllerHistoryEntry,
  type ManagedGuestIdentity,
  type UpdateIdentityPatch,
} from "./controller-model";
import {
  updateLegacyProjection,
  validRule,
  validateDefaults,
} from "./controller-policy";

function fail(error: string): AccessCommandResult {
  return { ok: false, error };
}

function policySnapshot(state: AccessControllerSnapshot): AccessPolicyBundleV1 {
  return createPolicyBundle(state);
}

function appendHistory(
  state: AccessControllerSnapshot,
  context: AccessCommandContext,
  summary: string,
  target: string,
  snapshot?: AccessPolicyBundleV1,
  result: ControllerHistoryEntry["result"] = "applied",
): void {
  state.history = [
    ...state.history,
    {
      id: context.id("history"),
      actorId: "sample-mara",
      target,
      occurredAt: context.now,
      summary,
      result,
      restorable: snapshot !== undefined,
      ...(snapshot ? { policySnapshot: snapshot } : {}),
    },
  ].slice(-100);
}

function success(
  state: AccessControllerSnapshot,
  context: AccessCommandContext,
  summary: string,
  target: string,
  value?: AccessCommandValue,
  snapshot?: AccessPolicyBundleV1,
  result: ControllerHistoryEntry["result"] = "applied",
): AccessCommandResult {
  appendHistory(state, context, summary, target, snapshot, result);
  return { ok: true, state, summary, ...(value ? { value } : {}) };
}

function validEmail(
  state: AccessControllerSnapshot,
  email: string,
  exceptId?: string,
): boolean {
  const normalized = email.trim().toLowerCase();
  return (
    normalized.length > 0 &&
    ![
      ...state.people.map((person) => ({ id: person.id, email: person.email })),
      ...state.guests.map((guest) => ({ id: guest.id, email: guest.email })),
    ].some(
      (entry) =>
        entry.id !== exceptId &&
        entry.email.trim().toLowerCase() === normalized,
    )
  );
}

function validateIdentityReferences(
  state: AccessControllerSnapshot,
  identity: AccessIdentity,
): string | null {
  const validation = validateAccessIdentity(identity);
  if (!validation.valid) return validation.issues[0];
  if (!state.roles.some((role) => role.id === identity.roleId))
    return "The selected role is unknown.";
  if (
    identity.groupIds.some(
      (id) => !state.groups.some((group) => group.id === id),
    )
  )
    return "An assigned group is unknown.";
  if (identity.kind === "service" && identity.groupIds.length)
    return "Services cannot belong to groups.";
  if (
    identity.kind !== "service" &&
    !validEmail(state, identity.email, identity.id)
  )
    return "Email addresses must be non-empty and unique.";
  return null;
}

function applyIdentity(
  state: AccessControllerSnapshot,
  identity: AccessIdentity,
): void {
  if (identity.kind === "internal") {
    const index = state.people.findIndex((person) => person.id === identity.id);
    const person = personFromInternal(
      identity,
      index >= 0 ? state.people[index] : undefined,
    );
    if (index >= 0) state.people[index] = person;
    else state.people.push(person);
  } else if (identity.kind === "guest") {
    const index = state.guests.findIndex((guest) => guest.id === identity.id);
    const previous = index >= 0 ? state.guests[index] : undefined;
    const managed: ManagedGuestIdentity = {
      ...identity,
      invitation: previous?.invitation ?? { sentAt: "", resendCount: 0 },
    };
    if (index >= 0) state.guests[index] = managed;
    else state.guests.push(managed);
  } else {
    const index = state.services.findIndex(
      (service) => service.id === identity.id,
    );
    if (index >= 0) state.services[index] = identity;
    else state.services.push(identity);
  }
  state.groups = state.groups.map((group) => ({
    ...group,
    memberIds:
      identity.kind === "service"
        ? group.memberIds.filter((id) => id !== identity.id)
        : identity.groupIds.includes(group.id)
          ? [...new Set([...group.memberIds, identity.id])]
          : group.memberIds.filter((id) => id !== identity.id),
  }));
}

function patchIdentity(
  identity: AccessIdentity,
  patch: UpdateIdentityPatch,
): AccessIdentity {
  if (identity.kind === "internal")
    return {
      ...identity,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.roleId !== undefined ? { roleId: patch.roleId } : {}),
      ...(patch.groupIds !== undefined
        ? { groupIds: [...patch.groupIds] }
        : {}),
      ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
      email: patch.email?.trim() ?? identity.email,
      departmentIds: patch.departmentIds
        ? [...patch.departmentIds]
        : identity.departmentIds,
      primaryDepartmentId:
        patch.primaryDepartmentId ?? identity.primaryDepartmentId,
      title: patch.title ?? identity.title,
    };
  if (identity.kind === "guest")
    return {
      ...identity,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.roleId !== undefined ? { roleId: patch.roleId } : {}),
      ...(patch.groupIds !== undefined
        ? { groupIds: [...patch.groupIds] }
        : {}),
      ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
      email: patch.email?.trim() ?? identity.email,
      sponsorId: patch.sponsorId ?? identity.sponsorId,
    };
  return {
    ...identity,
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.roleId !== undefined ? { roleId: patch.roleId } : {}),
    ...(patch.groupIds !== undefined ? { groupIds: [...patch.groupIds] } : {}),
    ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
    ownerId: patch.ownerId ?? identity.ownerId,
    purpose: patch.purpose ?? identity.purpose,
  };
}

function wouldRemoveLastAdmin(
  state: AccessControllerSnapshot,
  before: AccessIdentity,
  after: AccessIdentity,
  timestamp: number,
): boolean {
  return (
    before.kind === "internal" &&
    before.status === "active" &&
    before.roleId === "sample-admin" &&
    (!before.expiresAt || Date.parse(before.expiresAt) > timestamp) &&
    (after.kind !== "internal" ||
      after.status !== "active" ||
      after.roleId !== "sample-admin") &&
    activeAdminCount(state, "sample-admin", timestamp) === 1
  );
}

export function previewBulkIdentityUpdate(
  state: AccessControllerSnapshot,
  input: BulkIdentityUpdateInput,
  timestamp = Date.now(),
): BulkIdentityImpact {
  const ids = [...new Set(input.identityIds)];
  const identities = ids
    .map((id) => findIdentity(state, id))
    .filter((value): value is AccessIdentity => value !== undefined);
  let blocked = ids.length - identities.length;
  const groupIntentError =
    input.patch.groupIds !== undefined &&
    (input.addGroupId !== undefined || input.removeGroupId !== undefined)
      ? "Choose either replacement memberships or add/remove membership intent."
      : input.addGroupId !== undefined &&
          input.addGroupId === input.removeGroupId
        ? "A bulk group action cannot add and remove the same group."
        : [input.addGroupId, input.removeGroupId].some(
              (id) =>
                id !== undefined &&
                !state.groups.some((group) => group.id === id),
            )
          ? "The bulk group is unknown."
          : undefined;
  if (groupIntentError)
    return {
      ok: false,
      affected: identities.length,
      blocked: Math.max(1, identities.length),
      summary: `${identities.length} identities affected; operation blocked.`,
      error: groupIntentError,
    };
  const projected = structuredClone(state);
  for (const identity of identities) {
    if (
      identity.kind === "service" &&
      (input.addGroupId !== undefined || input.removeGroupId !== undefined)
    ) {
      blocked += 1;
      continue;
    }
    const groupIds = input.patch.groupIds
      ? [...input.patch.groupIds]
      : [
          ...new Set([
            ...identity.groupIds.filter((id) => id !== input.removeGroupId),
            ...(input.addGroupId ? [input.addGroupId] : []),
          ]),
        ];
    const next = patchIdentity(identity, { ...input.patch, groupIds });
    const issue = validateIdentityReferences(projected, next);
    if (issue) blocked += 1;
    else applyIdentity(projected, next);
  }
  if (activeAdminCount(projected, "sample-admin", timestamp) === 0)
    blocked = Math.max(1, blocked);
  const ok = blocked === 0;
  return {
    ok,
    affected: identities.length,
    blocked,
    summary: `${identities.length} identities affected; ${blocked} blocked.`,
    ...(!ok
      ? {
          error:
            activeAdminCount(projected, "sample-admin", timestamp) === 0
              ? "Keep at least one active internal Administrator."
              : "One or more identity updates are invalid.",
        }
      : {}),
  };
}

function uniqueRoleName(
  state: AccessControllerSnapshot,
  name: string,
  exceptId?: string,
): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    normalized.length > 0 &&
    !state.roles.some(
      (role) =>
        role.id !== exceptId && role.name.trim().toLowerCase() === normalized,
    )
  );
}

function uniqueGroupName(
  state: AccessControllerSnapshot,
  name: string,
  exceptId?: string,
): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    normalized.length > 0 &&
    !state.groups.some(
      (group) =>
        group.id !== exceptId && group.name.trim().toLowerCase() === normalized,
    )
  );
}

function applyBundle(
  state: AccessControllerSnapshot,
  bundle: AccessPolicyBundleV1,
  mode: "merge" | "replace",
): string | null {
  if (
    bundle.roles.some((role) =>
      state.roles.some((current) => current.builtin && current.id === role.id),
    )
  )
    return "Policy bundles cannot replace built-in roles.";
  const planned = planPolicyImport(
    policySnapshot(state),
    bundle,
    mode,
    state.roles,
  );
  const customRoles: Role[] = planned.bundle.roles.map((role) => ({
    ...role,
    builtin: false,
  }));
  const roles = [...planned.protectedRoles, ...customRoles];
  if (
    new Set(roles.map((role) => role.name.trim().toLowerCase())).size !==
    roles.length
  )
    return "Role names must be unique.";
  const currentMembers = new Map(
    state.groups.map((group) => [group.id, group.memberIds]),
  );
  const groups = planned.bundle.groups.map((group) => ({
    ...group,
    memberIds: [...(currentMembers.get(group.id) ?? [])],
  }));
  if (
    new Set(groups.map((group) => group.name.trim().toLowerCase())).size !==
      groups.length ||
    groups.some((group) => !group.name.trim())
  )
    return "Group names must be non-empty and unique.";
  const candidate = {
    ...state,
    roles,
    groups,
    defaults: planned.bundle.defaults,
    rules: planned.bundle.rules,
  };
  const defaultsIssue = validateDefaults(candidate, candidate.defaults);
  if (defaultsIssue) return defaultsIssue;
  for (const rule of candidate.rules) {
    const issue = validRule(candidate, rule);
    if (issue) return issue;
    if (rule.subject.kind === "identity")
      return "Policy bundles cannot contain identity rules.";
  }
  for (const identity of getControllerIdentities(candidate)) {
    const issue = validateIdentityReferences(candidate, identity);
    if (issue) return issue;
  }
  state.roles = roles;
  state.groups = groups;
  state.defaults = structuredClone(planned.bundle.defaults);
  state.rules = structuredClone(planned.bundle.rules);
  state.templates = structuredClone(planned.bundle.templates);
  return null;
}

export function executeAccessCommand(
  current: AccessControllerSnapshot,
  command: AccessCommand,
  context: AccessCommandContext,
): AccessCommandResult {
  const state = structuredClone(current);
  if (!Number.isFinite(Date.parse(context.now)))
    return fail("The operation time is invalid.");

  switch (command.type) {
    case "create-identity": {
      const id = command.input.id ?? context.id(command.input.kind);
      if (
        findIdentity(state, id) ||
        state.deletedIdentities.some((item) => item.identity.id === id)
      )
        return fail("That identity identifier is already in use.");
      const input = { ...command.input, id, name: command.input.name.trim() };
      let identity: AccessIdentity;
      if (input.kind === "internal")
        identity = {
          ...input,
          departmentIds: [...input.departmentIds],
          groupIds: [...input.groupIds],
        };
      else if (input.kind === "guest")
        identity = { ...input, groupIds: [...input.groupIds] };
      else identity = { ...input, groupIds: [] };
      const issue = validateIdentityReferences(state, identity);
      if (issue) return fail(issue);
      applyIdentity(state, identity);
      if (identity.kind === "guest") {
        const guest = state.guests.find((item) => item.id === identity.id);
        if (guest) guest.invitation = { sentAt: context.now, resendCount: 0 };
      }
      return success(
        state,
        context,
        "Identity created; no message or secret was generated.",
        identity.id,
        identity,
      );
    }
    case "update-identity":
    case "set-identity-status": {
      const identityId = command.identityId;
      const before = findIdentity(state, identityId);
      if (!before) return fail("Identity not found.");
      const patch =
        command.type === "update-identity"
          ? command.patch
          : { status: command.status };
      const after = patchIdentity(before, patch);
      const issue = validateIdentityReferences(state, after);
      if (issue) return fail(issue);
      if (wouldRemoveLastAdmin(state, before, after, Date.parse(context.now)))
        return fail("Keep at least one active internal Administrator.");
      applyIdentity(state, after);
      return success(state, context, "Identity updated.", identityId, after);
    }
    case "resend-invite": {
      const identity = findIdentity(state, command.identityId);
      if (!identity || identity.kind === "service")
        return fail("Invitable identity not found.");
      if (identity.status !== "pending")
        return fail("Only pending invitations can be resent.");
      if (identity.kind === "guest") {
        const guest = state.guests.find((item) => item.id === identity.id);
        if (guest)
          guest.invitation = {
            sentAt: context.now,
            resendCount: guest.invitation.resendCount + 1,
          };
      } else {
        const person = state.people.find((item) => item.id === identity.id);
        if (person) person.activity.push("Invitation resent; no email sent");
      }
      return success(
        state,
        context,
        "Invitation marked resent; no email was sent.",
        identity.id,
        identity,
      );
    }
    case "revoke-invite": {
      const identity = findIdentity(state, command.identityId);
      if (!identity || identity.kind === "service")
        return fail("Invitable identity not found.");
      if (identity.status !== "pending")
        return fail("Only pending invitations can be revoked.");
      const next = patchIdentity(identity, { status: "revoked" });
      applyIdentity(state, next);
      return success(state, context, "Invitation revoked.", identity.id, next);
    }
    case "delete-identity": {
      const identity = findIdentity(state, command.identityId);
      if (!identity) return fail("Identity not found.");
      if (
        identity.kind === "internal" &&
        identity.status === "active" &&
        identity.roleId === "sample-admin" &&
        (!identity.expiresAt ||
          Date.parse(identity.expiresAt) > Date.parse(context.now)) &&
        activeAdminCount(state, "sample-admin", Date.parse(context.now)) === 1
      )
        return fail("Keep at least one active internal Administrator.");
      if (
        state.rules.some(
          (rule) =>
            rule.subject.kind === "identity" && rule.subject.id === identity.id,
        ) ||
        state.guests.some((guest) => guest.sponsorId === identity.id) ||
        state.services.some((service) => service.ownerId === identity.id)
      )
        return fail(
          "Remove identity policy, sponsor, and owner references before deleting this identity.",
        );
      if (identity.kind === "internal") {
        const person = state.people.find((item) => item.id === identity.id);
        if (!person) return fail("Identity not found.");
        state.deletedIdentities.push({
          identity: { ...identity, status: "deleted" },
          person,
          deletedAt: context.now,
          deletedBy: "sample-mara",
        });
        state.people = state.people.filter((item) => item.id !== identity.id);
      } else if (identity.kind === "guest")
        state.guests = state.guests.filter((item) => item.id !== identity.id);
      else
        state.services = state.services.filter(
          (item) => item.id !== identity.id,
        );
      state.groups = state.groups.map((group) => ({
        ...group,
        memberIds: group.memberIds.filter((id) => id !== identity.id),
      }));
      state.sessions = state.sessions.filter(
        (session) => session.identityId !== identity.id,
      );
      return success(state, context, "Identity deleted.", identity.id);
    }
    case "restore-identity": {
      const deleted = state.deletedIdentities.find(
        (item) => item.identity.id === command.identityId,
      );
      if (deleted) {
        if (!validEmail(state, deleted.identity.email))
          return fail("Email addresses must be non-empty and unique.");
        const restored = { ...deleted.identity, status: "active" as const };
        const issue = validateIdentityReferences(state, restored);
        if (issue) return fail(issue);
        state.people.push(personFromInternal(restored, deleted.person));
        state.groups = state.groups.map((group) => ({
          ...group,
          memberIds: restored.groupIds.includes(group.id)
            ? [...new Set([...group.memberIds, restored.id])]
            : group.memberIds,
        }));
        state.deletedIdentities = state.deletedIdentities.filter(
          (item) => item.identity.id !== command.identityId,
        );
        return success(
          state,
          context,
          "Deleted internal identity restored.",
          restored.id,
          restored,
        );
      }
      const identity = findIdentity(state, command.identityId);
      if (!identity) return fail("Identity not found.");
      const restored = patchIdentity(identity, { status: "active" });
      applyIdentity(state, restored);
      return success(
        state,
        context,
        "Identity restored.",
        restored.id,
        restored,
      );
    }
    case "revoke-session": {
      const session = state.sessions.find(
        (item) =>
          item.id === command.sessionId &&
          item.identityId === command.identityId,
      );
      if (!session) return fail("Session not found.");
      if (session.current)
        return fail("The current session cannot be revoked.");
      session.status = "revoked";
      session.revocation = { kind: "manage-sessions", revokedAt: context.now };
      return success(
        state,
        context,
        "Session revoked through manage-sessions.",
        session.id,
      );
    }
    case "revoke-all-sessions": {
      if (!findIdentity(state, command.identityId))
        return fail("Identity not found.");
      const sessions = state.sessions.filter(
        (item) =>
          item.identityId === command.identityId &&
          !item.current &&
          item.status === "active",
      );
      for (const session of sessions) {
        session.status = "revoked";
        session.revocation = {
          kind: "manage-sessions",
          revokedAt: context.now,
        };
      }
      return success(
        state,
        context,
        `${sessions.length} non-current sessions revoked through manage-sessions.`,
        command.identityId,
      );
    }
    case "bulk-update-identities": {
      const impact = previewBulkIdentityUpdate(
        state,
        command.input,
        Date.parse(context.now),
      );
      if (!impact.ok) return fail(impact.error ?? "Bulk update is not safe.");
      for (const id of [...new Set(command.input.identityIds)]) {
        const identity = findIdentity(state, id);
        if (identity) {
          const groupIds = command.input.patch.groupIds
            ? [...command.input.patch.groupIds]
            : [
                ...new Set([
                  ...identity.groupIds.filter(
                    (groupId) => groupId !== command.input.removeGroupId,
                  ),
                  ...(command.input.addGroupId
                    ? [command.input.addGroupId]
                    : []),
                ]),
              ];
          applyIdentity(
            state,
            patchIdentity(identity, { ...command.input.patch, groupIds }),
          );
        }
      }
      return success(state, context, impact.summary, "bulk-identities", impact);
    }
    case "create-role": {
      const snapshot = policySnapshot(state);
      if (!uniqueRoleName(state, command.input.name))
        return fail("Role names must be non-empty and unique.");
      const role: Role = {
        id: command.input.id ?? context.id("role"),
        name: command.input.name.trim(),
        description: command.input.description?.trim() ?? "",
        builtin: false,
        grants: [...new Set(command.input.grants ?? [])],
      };
      if (state.roles.some((item) => item.id === role.id))
        return fail("That role identifier is already in use.");
      state.roles.push(role);
      return success(state, context, "Role created.", role.id, role, snapshot);
    }
    case "update-role": {
      const snapshot = policySnapshot(state);
      const role = state.roles.find((item) => item.id === command.roleId);
      if (!role) return fail("Role not found.");
      if (role.builtin) return fail("Built-in roles are immutable.");
      if (
        command.expected &&
        JSON.stringify(role) !== JSON.stringify(command.expected)
      )
        return fail(
          "This role changed after review. Review the current values before applying your draft.",
        );
      const name = command.patch.name?.trim() ?? role.name;
      if (!uniqueRoleName(state, name, role.id))
        return fail("Role names must be non-empty and unique.");
      const next: Role = {
        ...role,
        ...command.patch,
        name,
        description: command.patch.description?.trim() ?? role.description,
        grants: command.patch.grants
          ? [...new Set(command.patch.grants)]
          : role.grants,
      };
      state.roles = state.roles.map((item) =>
        item.id === role.id ? next : item,
      );
      return success(state, context, "Role updated.", role.id, next, snapshot);
    }
    case "duplicate-role": {
      const snapshot = policySnapshot(state);
      const source = state.roles.find((item) => item.id === command.roleId);
      if (!source) return fail("Role not found.");
      const name = command.name?.trim() || `${source.name} copy`;
      if (!uniqueRoleName(state, name))
        return fail("Role names must be non-empty and unique.");
      const role: Role = {
        ...source,
        id: context.id("role"),
        name,
        builtin: false,
        grants: [...source.grants],
      };
      state.roles.push(role);
      return success(
        state,
        context,
        "Role duplicated.",
        role.id,
        role,
        snapshot,
      );
    }
    case "delete-role": {
      const snapshot = policySnapshot(state);
      const role = state.roles.find((item) => item.id === command.roleId);
      if (!role) return fail("Role not found.");
      if (role.builtin) return fail("Built-in roles cannot be deleted.");
      if (
        getControllerIdentities(state).some(
          (identity) => identity.roleId === role.id,
        ) ||
        state.defaults.defaultRoleId === role.id ||
        state.rules.some(
          (rule) => rule.subject.kind === "role" && rule.subject.id === role.id,
        )
      )
        return fail("Role is still referenced and cannot be deleted.");
      state.roles = state.roles.filter((item) => item.id !== role.id);
      return success(
        state,
        context,
        "Role deleted.",
        role.id,
        undefined,
        snapshot,
      );
    }
    case "apply-role-template": {
      const snapshot = policySnapshot(state);
      const role = state.roles.find((item) => item.id === command.roleId);
      const template = state.templates.find(
        (item) => item.id === command.templateId,
      );
      if (!role || !template) return fail("Role or template not found.");
      if (role.builtin) return fail("Built-in role grants are protected.");
      role.grants = [...new Set(template.grants)];
      return success(
        state,
        context,
        "Role template applied.",
        role.id,
        role,
        snapshot,
      );
    }
    case "create-group": {
      const snapshot = policySnapshot(state);
      if (!uniqueGroupName(state, command.input.name))
        return fail("Group names must be non-empty and unique.");
      const memberIds = [...new Set(command.input.memberIds ?? [])];
      if (
        memberIds.some((id) =>
          state.services.some((service) => service.id === id),
        )
      )
        return fail("Services cannot belong to groups.");
      if (
        memberIds.some(
          (id) =>
            !state.people.some((person) => person.id === id) &&
            !state.guests.some((guest) => guest.id === id),
        )
      )
        return fail("A group member is unknown.");
      const group: AccessGroup = {
        id: command.input.id ?? context.id("group"),
        name: command.input.name.trim(),
        description: command.input.description?.trim() ?? "",
        memberIds,
      };
      if (state.groups.some((item) => item.id === group.id))
        return fail("That group identifier is already in use.");
      state.groups.push(group);
      state.people = state.people.map((person) =>
        memberIds.includes(person.id)
          ? {
              ...person,
              groupIds: [...new Set([...(person.groupIds ?? []), group.id])],
            }
          : person,
      );
      state.guests = state.guests.map((guest) =>
        memberIds.includes(guest.id)
          ? { ...guest, groupIds: [...new Set([...guest.groupIds, group.id])] }
          : guest,
      );
      return success(
        state,
        context,
        "Group created.",
        group.id,
        group,
        snapshot,
      );
    }
    case "update-group": {
      const snapshot = policySnapshot(state);
      const group = state.groups.find((item) => item.id === command.groupId);
      if (!group) return fail("Group not found.");
      if (
        command.expected &&
        JSON.stringify(group) !== JSON.stringify(command.expected)
      )
        return fail(
          "This group changed after review. Review the current values before applying your draft.",
        );
      const name = command.patch.name?.trim() ?? group.name;
      if (!uniqueGroupName(state, name, group.id))
        return fail("Group names must be non-empty and unique.");
      const memberIds = command.patch.memberIds
        ? [...new Set(command.patch.memberIds)]
        : group.memberIds;
      if (
        memberIds.some((id) =>
          state.services.some((service) => service.id === id),
        )
      )
        return fail("Services cannot belong to groups.");
      if (
        memberIds.some(
          (id) =>
            !state.people.some((person) => person.id === id) &&
            !state.guests.some((guest) => guest.id === id),
        )
      )
        return fail("A group member is unknown.");
      Object.assign(group, command.patch, {
        name,
        description: command.patch.description?.trim() ?? group.description,
        memberIds,
      });
      state.people = state.people.map((person) => ({
        ...person,
        groupIds: memberIds.includes(person.id)
          ? [...new Set([...(person.groupIds ?? []), group.id])]
          : (person.groupIds ?? []).filter((id) => id !== group.id),
      }));
      state.guests = state.guests.map((guest) => ({
        ...guest,
        groupIds: memberIds.includes(guest.id)
          ? [...new Set([...guest.groupIds, group.id])]
          : guest.groupIds.filter((id) => id !== group.id),
      }));
      return success(
        state,
        context,
        "Group updated.",
        group.id,
        group,
        snapshot,
      );
    }
    case "delete-group": {
      const snapshot = policySnapshot(state);
      const group = state.groups.find((item) => item.id === command.groupId);
      if (!group) return fail("Group not found.");
      if (
        group.memberIds.length ||
        state.defaults.defaultGroupIds.includes(group.id) ||
        state.rules.some(
          (rule) =>
            rule.subject.kind === "group" && rule.subject.id === group.id,
        )
      )
        return fail("Group is still referenced and cannot be deleted.");
      state.groups = state.groups.filter((item) => item.id !== group.id);
      return success(
        state,
        context,
        "Group deleted.",
        group.id,
        undefined,
        snapshot,
      );
    }
    case "set-group-members": {
      const group = state.groups.find((item) => item.id === command.groupId);
      if (!group) return fail("Group not found.");
      const memberIds = [...new Set(command.memberIds)];
      if (
        memberIds.some((id) =>
          state.services.some((service) => service.id === id),
        )
      )
        return fail("Services cannot belong to groups.");
      if (
        memberIds.some(
          (id) =>
            !state.people.some((person) => person.id === id) &&
            !state.guests.some((guest) => guest.id === id),
        )
      )
        return fail("A group member is unknown.");
      group.memberIds = memberIds;
      state.people = state.people.map((person) => ({
        ...person,
        groupIds: memberIds.includes(person.id)
          ? [...new Set([...(person.groupIds ?? []), group.id])]
          : (person.groupIds ?? []).filter((id) => id !== group.id),
      }));
      state.guests = state.guests.map((guest) => ({
        ...guest,
        groupIds: memberIds.includes(guest.id)
          ? [...new Set([...guest.groupIds, group.id])]
          : guest.groupIds.filter((id) => id !== group.id),
      }));
      return success(
        state,
        context,
        "Group membership updated.",
        group.id,
        group,
      );
    }
    case "upsert-rule": {
      const snapshot = policySnapshot(state);
      const issue = validRule(state, command.rule);
      if (issue) return fail(issue);
      const index = state.rules.findIndex(
        (rule) => rule.id === command.rule.id,
      );
      if (index >= 0) state.rules[index] = structuredClone(command.rule);
      else state.rules.push(structuredClone(command.rule));
      updateLegacyProjection(state, command.rule);
      return success(
        state,
        context,
        "Policy rule saved and compatible legacy grants projected.",
        command.rule.id,
        undefined,
        snapshot,
      );
    }
    case "upsert-rules": {
      if (!command.rules.length)
        return fail("At least one policy rule is required.");
      if (
        new Set(command.rules.map((rule) => rule.id)).size !==
        command.rules.length
      )
        return fail("Policy rule identifiers must be unique within a batch.");
      for (const rule of command.rules) {
        const issue = validRule(state, rule);
        if (issue) return fail(issue);
      }
      const snapshot = policySnapshot(state);
      for (const rule of command.rules) {
        const index = state.rules.findIndex((item) => item.id === rule.id);
        if (index >= 0) state.rules[index] = structuredClone(rule);
        else state.rules.push(structuredClone(rule));
        updateLegacyProjection(state, rule);
      }
      return success(
        state,
        context,
        `${command.rules.length} policy rules saved atomically and compatible legacy grants projected.`,
        "policy-rules",
        undefined,
        snapshot,
      );
    }
    case "delete-rule": {
      const snapshot = policySnapshot(state);
      const rule = state.rules.find((item) => item.id === command.ruleId);
      if (!rule) return fail("Rule not found.");
      state.rules = state.rules.filter((item) => item.id !== rule.id);
      const roleId = rule.subject.kind === "role" ? rule.subject.id : undefined;
      if (
        roleId !== undefined &&
        !state.rules.some(
          (item) =>
            item.subject.kind === "role" &&
            item.subject.id === roleId &&
            item.scope.id === rule.scope.id &&
            item.permissionId === rule.permissionId &&
            item.decision === "allow",
        )
      )
        updateLegacyProjection(state, { ...rule, decision: "inherit" });
      return success(
        state,
        context,
        "Policy rule deleted.",
        rule.id,
        undefined,
        snapshot,
      );
    }
    case "update-defaults": {
      const snapshot = policySnapshot(state);
      const defaults = { ...state.defaults, ...command.patch };
      const issue = validateDefaults(state, defaults);
      if (issue) return fail(issue);
      state.defaults = defaults;
      return success(
        state,
        context,
        "Access defaults updated.",
        "defaults",
        undefined,
        snapshot,
      );
    }
    case "create-review-campaign": {
      if (!command.input.name.trim() || !command.input.targetIds.length)
        return fail("Review campaigns require a name and at least one target.");
      const reviewer = state.people.find(
        (person) => person.id === command.input.reviewerId,
      );
      if (
        !reviewer ||
        internalFromPerson(reviewer).status !== "active" ||
        reviewer.role !== "sample-admin"
      )
        return fail(
          "Reviews require an active internal Administrator reviewer.",
        );
      const subjectKnown =
        (command.input.subjectKind === "role" &&
          state.roles.some((role) => role.id === command.input.subjectId)) ||
        (command.input.subjectKind === "group" &&
          state.groups.some((group) => group.id === command.input.subjectId)) ||
        (command.input.subjectKind === "identity-kind" &&
          ["internal", "guest", "service"].includes(command.input.subjectId)) ||
        (command.input.subjectKind === "expiry-window" &&
          command.input.subjectId.trim().length > 0);
      if (!subjectKnown) return fail("The review subject is unknown.");
      if (
        command.input.targetIds.some(
          (targetId) => !findIdentity(state, targetId),
        )
      )
        return fail("A review target is unknown.");
      const review: AccessReview = {
        id: command.input.id ?? context.id("review"),
        name: command.input.name.trim(),
        reviewerId: command.input.reviewerId,
        status: "in-progress",
        subjectKind: command.input.subjectKind,
        subjectId: command.input.subjectId,
        decisions: [...new Set(command.input.targetIds)].map((targetId) => ({
          targetId,
          decision: "pending",
        })),
      };
      state.reviews.push(review);
      return success(
        state,
        context,
        "Review campaign created.",
        review.id,
        review,
      );
    }
    case "record-review-decision": {
      const review = state.reviews.find((item) => item.id === command.reviewId);
      if (!review || review.status === "complete")
        return fail("Active review campaign not found.");
      const decision = review.decisions.find(
        (item) => item.targetId === command.targetId,
      );
      if (!decision) return fail("Review target not found.");
      decision.decision = command.decision;
      return success(
        state,
        context,
        "Review decision recorded.",
        review.id,
        review,
      );
    }
    case "complete-review": {
      const review = state.reviews.find((item) => item.id === command.reviewId);
      if (!review) return fail("Review campaign not found.");
      if (review.decisions.some((decision) => decision.decision === "pending"))
        return fail(
          "Resolve every pending decision before completing the review.",
        );
      review.status = "complete";
      return success(
        state,
        context,
        "Review campaign completed.",
        review.id,
        review,
      );
    }
    case "import-policy-bundle": {
      const parsed = parsePolicyBundle(command.text);
      if (!parsed.ok) return fail(parsed.error);
      const snapshot = policySnapshot(state);
      const issue = applyBundle(state, parsed.value, command.mode);
      if (issue) return fail(issue);
      return success(
        state,
        context,
        `${command.mode === "merge" ? "Merge" : "Replace"} policy import applied.`,
        "policy-bundle",
        undefined,
        snapshot,
      );
    }
    case "apply-history-restore": {
      const entry = state.history.find((item) => item.id === command.historyId);
      if (!entry?.restorable || !entry.policySnapshot)
        return fail("This history entry cannot restore policy configuration.");
      const snapshot = policySnapshot(state);
      const issue = applyBundle(state, entry.policySnapshot, "replace");
      if (issue) return fail(issue);
      return success(
        state,
        context,
        "Policy configuration restored from history.",
        entry.id,
        undefined,
        snapshot,
        "restored",
      );
    }
  }
}
