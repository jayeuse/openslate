import {
  capabilityConfigurationSchema,
  capabilityDefaults,
  capabilityGroupScopes,
  capabilitySchema,
  everyoneCapabilitySchema,
} from "@/components/systems/comms/contract/schemas";
import type {
  Capability,
  CapabilityCheck,
  CapabilityDecision,
  ChannelCreationCheck,
  ChannelCreationScope,
  CommsContext,
  SettingsScope,
} from "@/components/systems/comms/contract/types";
import type { MemoryPolicyWorld } from "../memory/model";
import {
  activePerson,
  conversationAccess,
  notFound,
  ownedConversation,
  policyFailure,
} from "./access";
import { scopeChain, scopeKey } from "./policy-scope";
import { invalidInput } from "./settings";

/** Settings/grant commands authorize the named scope, never a child conversation. */
export function scopeManagementDecision(
  world: MemoryPolicyWorld,
  context: CommsContext,
  scope: SettingsScope,
): CapabilityDecision {
  const person = activePerson(world, context);
  const chain = scopeChain(world, scope);
  if (scope.kind === "channel") {
    const check = capabilityCheck(world, context, scope.id);
    if (check.conversation_level === "none") return notFound();
    return check.capabilities.manageChannel;
  }
  if (person.role === "admin")
    return { allowed: true, source: { kind: "admin" } };
  if (person.role === "guest")
    return { allowed: false, source: { kind: "guest_cap" } };
  if (scope.kind === "workspace")
    return { allowed: false, source: { kind: "default", basis: "org_admin" } };
  const departmentId = world.categories[scope.id].department_id;
  if (
    departmentId &&
    world.departments[departmentId]?.org_id === context.org_id &&
    person.department_levels[departmentId] === "manage"
  )
    return {
      allowed: true,
      source: { kind: "manager", reason: "department_manager" },
    };
  return scopedDecision(world, context, "manageChannel", chain, false);
}

export function validateCapabilityConfiguration(
  world: MemoryPolicyWorld,
  scope: SettingsScope,
  input: unknown,
) {
  scopeChain(world, scope);
  const parsed = capabilityConfigurationSchema.safeParse(input);
  if (!parsed.success || scopeKey(parsed.data.scope) !== scopeKey(scope))
    return invalidInput();
  const config = parsed.data;
  if (
    config.group_grants.some(
      (g) => world.groups[g.group_id]?.org_id !== world.org_id,
    )
  )
    return invalidInput();
  if (scope.kind !== "workspace") {
    const current = world.configuration[scopeKey(scope)]?.capabilities;
    for (const key of world.capability_locks) {
      const groups = (value: typeof current) =>
        value?.group_grants
          .filter((g) => g.capability === key)
          .map((g) => g.group_id)
          .sort() ?? [];
      const everyoneKey = everyoneCapabilitySchema.safeParse(key);
      const switchChanged =
        everyoneKey.success &&
        current?.everyone[everyoneKey.data] !==
          config.everyone[everyoneKey.data];
      if (
        switchChanged ||
        JSON.stringify(groups(current)) !== JSON.stringify(groups(config))
      )
        return policyFailure({
          status: 403,
          body: {
            detail: {
              code: "comms_capability_denied",
              message: "Workspace capability is locked",
            },
          },
        });
    }
  }
  return config;
}

function scopedDecision(
  world: MemoryPolicyWorld,
  context: CommsContext,
  key: Capability,
  scopes: SettingsScope[],
  poster: boolean,
): CapabilityDecision {
  const person = activePerson(world, context);
  const locked =
    key !== "manageWorkspace" && world.capability_locks.includes(key);
  const layers = locked ? scopes.slice(0, 1) : scopes;
  let decision: CapabilityDecision = {
    allowed: capabilityDefaults[key] === "poster" && poster,
    source: { kind: "default", basis: capabilityDefaults[key] },
  };
  let grant: CapabilityDecision | undefined;
  for (const scope of layers) {
    const parsed = capabilityConfigurationSchema.safeParse(
      world.configuration[scopeKey(scope)]?.capabilities,
    );
    if (!parsed.success || scopeKey(parsed.data.scope) !== scopeKey(scope))
      continue;
    const config = parsed.data;
    const everyoneKey = everyoneCapabilitySchema.safeParse(key);
    if (everyoneKey.success) {
      const enabled = config.everyone[everyoneKey.data];
      if (enabled !== undefined)
        decision = {
          allowed: enabled && poster,
          source: { kind: "everyone", scope, enabled },
        };
    }
    const row = config.group_grants
      .filter(
        (g) =>
          g.capability === key &&
          capabilityGroupScopes[key].includes(scope.kind) &&
          person.group_ids.includes(g.group_id) &&
          world.groups[g.group_id]?.org_id === context.org_id,
      )
      .sort((a, b) =>
        a.group_id < b.group_id ? -1 : a.group_id > b.group_id ? 1 : 0,
      )[0];
    if (!grant && row)
      grant = {
        allowed: true,
        source: {
          kind: "group_grant",
          scope,
          group_id: row.group_id,
          group_name: world.groups[row.group_id].name,
        },
      };
  }
  // A grant explains an override only if the normal/default decision needs it.
  if (!decision.allowed && grant) decision = grant;
  return locked
    ? {
        allowed: decision.allowed,
        source: { kind: "workspace_lock", enabled: decision.allowed },
      }
    : decision;
}

/** The inspected subject may lack access, but the caller must currently read. */
export function inspectCapabilities(
  world: MemoryPolicyWorld,
  context: CommsContext,
  id: string,
  userId = context.user_id,
) {
  const own = capabilityCheck(world, context, id);
  if (own.conversation_level === "none") return notFound();
  if (userId !== context.user_id && !own.capabilities.manageChannel.allowed)
    return policyFailure({
      status: 403,
      body: {
        detail: {
          code: "comms_capability_denied",
          message: "Capability required",
        },
      },
    });
  return userId === context.user_id
    ? own
    : capabilityCheck(world, { ...context, user_id: userId }, id);
}

export function channelCreationCheck(
  world: MemoryPolicyWorld,
  context: CommsContext,
  scope: ChannelCreationScope,
): ChannelCreationCheck {
  const person = activePerson(world, context);
  const category =
    scope.kind === "category" ? world.categories[scope.id] : null;
  if (
    scope.kind === "category" &&
    (!category || category.org_id !== context.org_id)
  )
    return notFound();
  let decision = scopedDecision(
    world,
    context,
    "createChannel",
    scopeChain(world, scope),
    false,
  );
  if (person.role === "admin")
    decision = { allowed: true, source: { kind: "admin" } };
  else if (person.role === "guest")
    decision = { allowed: false, source: { kind: "guest_cap" } };
  else if (
    !world.capability_locks.includes("createChannel") &&
    category?.department_id &&
    world.departments[category.department_id]?.org_id === context.org_id &&
    person.department_levels[category.department_id] === "manage"
  )
    decision = {
      allowed: true,
      source: {
        kind: "department_manager",
        category_id: category.id,
        department_id: category.department_id,
      },
    };
  return {
    org_id: context.org_id,
    user_id: context.user_id,
    scope,
    membership_role: person.role,
    decision,
  };
}

/** Internal evaluator. Public check-person reads must use inspectCapabilities. */
export function capabilityCheck(
  world: MemoryPolicyWorld,
  context: CommsContext,
  id: string,
): CapabilityCheck {
  const person = activePerson(world, context);
  const conversation = ownedConversation(world, context, id);
  const access = conversationAccess(world, context, id);
  const category_id =
    conversation.kind === "channel" ? conversation.category_id : null;
  const capabilities = Object.fromEntries(
    capabilitySchema.options.map((key) => {
      let decision: CapabilityDecision;
      if (person.role === "admin")
        decision = { allowed: true, source: { kind: "admin" } };
      else if (person.role === "guest")
        decision = { allowed: false, source: { kind: "guest_cap" } };
      else if (key === "createChannel")
        decision = channelCreationCheck(
          world,
          context,
          category_id
            ? { kind: "category", id: category_id }
            : { kind: "workspace" },
        ).decision;
      else if (key === "manageWorkspace")
        decision = {
          allowed: false,
          source: { kind: "default", basis: "org_admin" },
        };
      else if (access.level === "none")
        decision = {
          allowed: false,
          source: { kind: "access", reason: "no_read_access" },
        };
      else if (access.manager_source)
        decision = {
          allowed: true,
          source: { kind: "manager", reason: access.manager_source },
        };
      else
        decision = scopedDecision(
          world,
          context,
          key,
          conversation.kind === "channel"
            ? scopeChain(world, { kind: "channel", id })
            : [{ kind: "workspace" }],
          access.level === "post",
        );
      return [key, decision];
    }),
  ) as CapabilityCheck["capabilities"];
  return {
    org_id: context.org_id,
    user_id: context.user_id,
    conversation_id: id,
    category_id,
    membership_role: person.role,
    conversation_level: access.level,
    manager_source: access.manager_source,
    access_source: access.source,
    capabilities,
  };
}
