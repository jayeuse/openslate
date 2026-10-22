import { z } from "zod";
import type { CommsClient } from "@/components/systems/comms/contract/client";
import * as S from "@/components/systems/comms/contract/schemas";
import type * as C from "@/components/systems/comms/contract/types";
import { activePerson, notFound, policyFailure } from "../domain/access";
import { scopeManagementDecision } from "../domain/capabilities";
import { invalidInput } from "../domain/settings";
import {
  assertRequestActive,
  requireAvailable,
  type MemoryClientBinding,
} from "./availability";
import { structurePublications } from "./configuration-mutation";
import {
  categoryKey,
  compare,
  conversationKey,
  ownedCategory,
  projectConversation,
  requireConversationManagement,
} from "./conversation-structure";
import {
  accessGrantKey,
  type MemoryAccessGrant,
  type MemoryPolicyWorld,
} from "./model";

const targetKey = (target: C.AccessGrantTarget) =>
  target.kind === "channel"
    ? conversationKey(target.id)
    : categoryKey(target.id);

const invalid = (message: string): never =>
  policyFailure({
    status: 422,
    body: { detail: { code: "comms_invalid", message } },
  });

/**
 * Like the backend: 404 when unreadable, 422 for a direct or group message,
 * 403 without manage. A write also refuses an organization channel (422) and,
 * on a category, anyone but an admin or a manager of its department (403).
 */
function requireTargetManagement(
  binding: MemoryClientBinding,
  world: MemoryPolicyWorld,
  context: C.CommsContext,
  target: C.AccessGrantTarget,
  write = false,
) {
  if (target.kind === "category") {
    const departmentId = ownedCategory(world, context, target.id).department_id;
    const scope = { kind: "category", id: target.id } as const;
    requireAvailable(
      binding,
      context,
      { scope, capability: "manageChannel" },
      scopeManagementDecision(world, context, scope),
    );
    if (!write) return;
    const person = activePerson(world, context);
    if (
      person.role === "admin" ||
      (person.role !== "guest" &&
        departmentId !== null &&
        person.department_levels[departmentId] === "manage")
    )
      return;
    policyFailure({
      status: 403,
      body: {
        detail: {
          code: "comms_capability_denied",
          message: "Category grants need a department manager",
        },
      },
    });
  }
  if (projectConversation(world, context, target.id).kind !== "channel")
    invalid("A channel is required");
  requireConversationManagement(binding, world, context, target.id);
  const room = world.conversations[target.id];
  if (write && room?.kind === "channel" && room.scope === "organization")
    invalid("An organization channel needs no access grants");
}

/** A grant's subject name, or null when the group or person grants nothing now. */
function subjectName(world: MemoryPolicyWorld, grant: MemoryAccessGrant) {
  if (grant.subject === "group") {
    const group = world.groups[grant.subject_id];
    return group?.org_id === world.org_id ? group.name : null;
  }
  const person = world.people[grant.subject_id];
  return person?.active && person.org_id === world.org_id
    ? person.display_name
    : null;
}

function project(
  world: MemoryPolicyWorld,
  grant: MemoryAccessGrant,
): C.AccessGrant | null {
  const name = subjectName(world, grant);
  return name === null
    ? null
    : {
        subject: grant.subject,
        subject_id: grant.subject_id,
        display_name: name,
        level: grant.level,
        source: grant.target.kind,
        created_at: grant.created_at,
        updated_at: grant.updated_at,
      };
}

/** One target's live grants: groups before people, then name, then id. */
function grantsOf(world: MemoryPolicyWorld, target: C.AccessGrantTarget) {
  return Object.values(world.access_grants)
    .filter(
      (grant) =>
        grant.org_id === world.org_id &&
        grant.target.kind === target.kind &&
        grant.target.id === target.id,
    )
    .map((grant) => project(world, grant))
    .filter((grant): grant is C.AccessGrant => grant !== null)
    .sort(
      (a, b) =>
        compare(a.subject === "group" ? 0 : 1, b.subject === "group" ? 0 : 1) ||
        compare(a.display_name, b.display_name) ||
        compare(a.subject_id, b.subject_id),
    );
}

function requireSubject(
  world: MemoryPolicyWorld,
  subject: C.AccessGrantSubject,
  subjectId: string,
) {
  const live =
    subject === "group"
      ? world.groups[subjectId]?.org_id === world.org_id
      : world.people[subjectId]?.active &&
        world.people[subjectId].org_id === world.org_id;
  if (!live) notFound();
}

type AccessGrantOperations = Pick<
  CommsClient,
  | "listAccessGrants"
  | "setAccessGrant"
  | "removeAccessGrant"
  | "listAccessCandidates"
>;

/** D45 grants in the synthetic world, with the backend's routes' authority. */
export function createAccessGrantOperations(
  binding: MemoryClientBinding,
): AccessGrantOperations {
  const { handle } = binding;
  function parseTarget(input: C.AccessGrantTarget) {
    const parsed = S.accessGrantTargetSchema.safeParse(input);
    return parsed.success ? parsed.data : invalidInput();
  }
  return {
    async listAccessGrants(input, options) {
      assertRequestActive(options);
      const target = parseTarget(input);
      return handle.read((world, context) => {
        requireTargetManagement(binding, world, context, target);
        const room =
          target.kind === "channel" ? world.conversations[target.id] : null;
        const categoryId = room?.kind === "channel" ? room.category_id : null;
        const items = [
          ...grantsOf(world, target),
          ...(categoryId
            ? grantsOf(world, { kind: "category", id: categoryId })
            : []),
        ];
        assertRequestActive(options);
        return { data: { items }, etag: handle.version(targetKey(target)) };
      });
    },
    async setAccessGrant(input, subject, subjectId, request, options) {
      const target = parseTarget(input);
      const kind = S.accessGrantSubjectSchema.safeParse(subject);
      const parsed = S.accessGrantRequestSchema.safeParse(request);
      if (
        !kind.success ||
        !parsed.success ||
        !z.uuid().safeParse(subjectId).success
      )
        return invalidInput();
      const key = targetKey(target);
      const id = accessGrantKey(target, kind.data, subjectId);
      const result = await handle.command({
        signal: options?.signal,
        conditions: [{ key, if_match: options?.if_match }],
        authorize(world, execution) {
          requireTargetManagement(
            binding,
            world,
            execution.context,
            target,
            true,
          );
          requireSubject(world, kind.data, subjectId);
        },
        apply(draft, execution) {
          const existing = draft.access_grants[id];
          if (existing?.level === parsed.data.level)
            return {
              kind: "unchanged",
              value: project(draft, existing)!,
              version_keys: [key],
            };
          const timestamp = new Date(execution.now).toISOString();
          const grant: MemoryAccessGrant = {
            org_id: draft.org_id,
            target,
            subject: kind.data,
            subject_id: subjectId,
            level: parsed.data.level,
            created_at: existing?.created_at ?? timestamp,
            updated_at: timestamp,
          };
          draft.access_grants[id] = grant;
          return {
            kind: "commit",
            value: project(draft, grant)!,
            version_keys: [key],
            // Like the backend: every active member refetches structure and grants.
            publications: [
              ...structurePublications(draft),
              ...structurePublications(draft, "grants"),
            ],
          };
        },
      });
      return { data: result.value, etag: result.versions[key] };
    },
    async removeAccessGrant(input, subject, subjectId, options) {
      const target = parseTarget(input);
      const kind = S.accessGrantSubjectSchema.safeParse(subject);
      if (!kind.success) return invalidInput();
      const key = targetKey(target);
      const id = accessGrantKey(target, kind.data, subjectId);
      await handle.command({
        signal: options?.signal,
        conditions: [{ key, if_match: options?.if_match }],
        authorize(world, execution) {
          requireTargetManagement(
            binding,
            world,
            execution.context,
            target,
            true,
          );
          if (!world.access_grants[id]) notFound();
        },
        apply(draft) {
          delete draft.access_grants[id];
          return {
            kind: "commit",
            value: undefined,
            version_keys: [key],
            publications: [
              ...structurePublications(draft),
              ...structurePublications(draft, "grants"),
            ],
          };
        },
      });
    },
    async listAccessCandidates(input, request, options) {
      assertRequestActive(options);
      const target = parseTarget(input);
      const parsed = S.accessCandidatesRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const { q, limit, kind } = parsed.data;
      const search = q.toLocaleLowerCase("en-US");
      return handle.read((world, context) => {
        requireTargetManagement(binding, world, context, target);
        const people =
          kind === "group"
            ? []
            : Object.values(world.people)
                .filter(
                  (person) =>
                    person.active &&
                    person.org_id === world.org_id &&
                    person.display_name
                      .toLocaleLowerCase("en-US")
                      .includes(search),
                )
                .sort(
                  (a, b) =>
                    compare(a.display_name, b.display_name) ||
                    compare(a.user_id, b.user_id),
                )
                .slice(0, limit)
                .map((person) => ({
                  user_id: person.user_id,
                  display_name: person.display_name,
                  departments: Object.keys(person.department_levels)
                    .filter(
                      (id) => world.departments[id]?.org_id === world.org_id,
                    )
                    .map((id) => ({ id, name: world.departments[id].name }))
                    .sort(
                      (a, b) => compare(a.name, b.name) || compare(a.id, b.id),
                    ),
                }));
        const groups =
          kind === "user"
            ? []
            : Object.values(world.groups)
                .filter(
                  (group) =>
                    group.org_id === world.org_id &&
                    group.name.toLocaleLowerCase("en-US").includes(search),
                )
                .sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id))
                .slice(0, limit)
                .map(({ id, name }) => ({ id, name }));
        assertRequestActive(options);
        return { people, groups };
      });
    },
  };
}
