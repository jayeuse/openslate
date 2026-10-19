import type {
  CapabilityCheck,
  CommsClientError,
  CommsContext,
  HttpFailure,
} from "../contract/types";
import type { MemoryConversation, MemoryPolicyWorld } from "../memory/model";

export function policyFailure(failure: HttpFailure): never {
  throw Object.assign(new Error("OpenComms request refused"), {
    kind: "http" as const,
    failure,
  }) satisfies CommsClientError;
}
export function notFound(): never {
  return policyFailure({
    status: 404,
    body: { detail: { code: "comms_not_found", message: "Not found" } },
  });
}
export function activePerson(world: MemoryPolicyWorld, context: CommsContext) {
  const person = world.people[context.user_id];
  if (
    world.org_id !== context.org_id ||
    !person?.active ||
    person.org_id !== context.org_id
  )
    return notFound();
  return person;
}
/** Organization lookup only; callers still require conversationAccess for reads. */
export function ownedConversation(
  world: MemoryPolicyWorld,
  context: CommsContext,
  id: string,
) {
  activePerson(world, context);
  const conversation = world.conversations[id];
  if (!conversation || conversation.org_id !== context.org_id)
    return notFound();
  return conversation;
}
export type ConversationAccess = {
  level: CapabilityCheck["conversation_level"];
  source: CapabilityCheck["access_source"];
  manager_source: CapabilityCheck["manager_source"];
};

export function linkedDepartment(
  world: MemoryPolicyWorld,
  conversation: MemoryConversation,
) {
  if (conversation.kind !== "channel") return null;
  const category = conversation.category_id
    ? world.categories[conversation.category_id]
    : undefined;
  const id =
    conversation.scope === "department"
      ? conversation.department_id
      : category?.org_id === world.org_id
        ? category.department_id
        : null;
  return id && world.departments[id]?.org_id === world.org_id ? id : null;
}

export function conversationAccess(
  world: MemoryPolicyWorld,
  context: CommsContext,
  id: string,
): ConversationAccess {
  const person = activePerson(world, context);
  const conversation = ownedConversation(world, context, id);
  if (person.role === "admin")
    return { level: "manage", source: { kind: "admin" }, manager_source: null };
  const membership = world.members[id]?.[context.user_id];
  const department = linkedDepartment(world, conversation);
  const departmentLevel = department
    ? person.department_levels[department]
    : undefined;
  const manager =
    conversation.creator_id === person.user_id
      ? "creator"
      : membership?.member_role === "manager"
        ? "membership_manager"
        : departmentLevel === "manage"
          ? "department_manager"
          : null;
  if (manager && person.role !== "guest")
    return {
      level: "manage",
      source: { kind: "manager", reason: manager },
      manager_source: manager,
    };
  let result: ConversationAccess = {
    level: "none",
    source: { kind: "none", reason: "no_access" },
    manager_source: null,
  };
  const rank = { none: 0, read: 1, post: 2, manage: 3 };
  const offer = (
    level: "read" | "post",
    source: ConversationAccess["source"],
  ) => {
    if (rank[level] > rank[result.level])
      result = { level, source, manager_source: null };
  };
  if (conversation.kind === "channel") {
    if (conversation.scope === "organization")
      offer("post", { kind: "organization" });
    if (conversation.scope === "department" && department && departmentLevel)
      offer(departmentLevel === "read" ? "read" : "post", {
        kind: "department",
        department_id: department,
      });
    if (conversation.scope === "groups") {
      // Highest access wins. UUID order makes equal grants explain consistently.
      const rows = [...conversation.access].sort((a, b) => {
        const left = a.subject === "everyone" ? "" : a.group_id;
        const right = b.subject === "everyone" ? "" : b.group_id;
        return left < right ? -1 : left > right ? 1 : 0;
      });
      for (const row of rows) {
        if (row.subject === "everyone")
          offer(row.level, { kind: "organization" });
        else if (
          person.group_ids.includes(row.group_id) &&
          world.groups[row.group_id]?.org_id === context.org_id
        )
          offer(row.level, {
            kind: "group",
            group_id: row.group_id,
            group_name: world.groups[row.group_id].name,
          });
      }
    }
    if (conversation.scope === "members" && membership)
      offer("post", { kind: "membership" });
  } else if (membership) offer("post", { kind: "membership" });
  if (person.role === "guest" && result.level !== "none")
    return {
      level: "read",
      source: { kind: "guest_cap" },
      manager_source: null,
    };
  return result;
}

function sharesConversation(
  world: MemoryPolicyWorld,
  context: CommsContext,
  userId: string,
  channelsOnly = false,
) {
  return Object.values(world.conversations).some(
    (c) =>
      c.org_id === context.org_id &&
      (!channelsOnly || c.kind === "channel") &&
      conversationAccess(world, context, c.id).level !== "none" &&
      conversationAccess(world, { ...context, user_id: userId }, c.id).level !==
        "none",
  );
}

/** Bounded synthetic-world D36 projection, never a real directory lookup. */
export function eligiblePersonIds(
  world: MemoryPolicyWorld,
  context: CommsContext,
): string[] {
  const person = activePerson(world, context);
  return Object.values(world.people)
    .filter(
      (p) =>
        p.active &&
        p.org_id === context.org_id &&
        (p.user_id === context.user_id ||
          person.role === "admin" ||
          sharesConversation(world, context, p.user_id)),
    )
    .map((p) => p.user_id)
    .sort();
}

export function directBlocked(
  world: MemoryPolicyWorld,
  left: string,
  right: string,
) {
  return Boolean(
    world.blocks[left]?.some((b) => b.blocked_user_id === right) ||
    world.blocks[right]?.some((b) => b.blocked_user_id === left),
  );
}

export function canStartDirect(
  world: MemoryPolicyWorld,
  context: CommsContext,
  userId: string,
): boolean {
  const actor = activePerson(world, context);
  const target = world.people[userId];
  return (
    actor.role !== "guest" &&
    Boolean(target?.active) &&
    target.org_id === context.org_id &&
    target.role !== "guest" &&
    userId !== context.user_id &&
    world.dm_rule !== "none" &&
    !directBlocked(world, context.user_id, userId) &&
    eligiblePersonIds(world, context).includes(userId) &&
    (world.dm_rule !== "shared-channel" ||
      sharesConversation(world, context, userId, true))
  );
}
