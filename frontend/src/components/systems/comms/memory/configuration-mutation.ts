import * as S from "../contract/schemas";
import type * as C from "../contract/types";
import { activePerson, conversationAccess, notFound } from "../domain/access";
import { validateCapabilityConfiguration } from "../domain/capabilities";
import { scopeChain, scopeKey } from "../domain/policy-scope";
import {
  invalidInput,
  resetSettings,
  updateSettings,
} from "../domain/settings";
import type { MemoryCommsState, MemoryPolicyWorld } from "./model";
import type { MemoryExecution, MemoryPublication } from "./store-types";

export const configurationKey = (scope: C.SettingsScope) =>
  `configuration:${scopeKey(scope)}`;
export const capabilityKey = (scope: C.SettingsScope) =>
  `capabilities:${scopeKey(scope)}`;
export const capabilityLocksKey = "capability-locks:workspace";

export function requireScopeRead(
  world: MemoryPolicyWorld,
  context: C.CommsContext,
  scope: C.SettingsScope,
) {
  activePerson(world, context);
  scopeChain(world, scope);
  if (
    scope.kind === "channel" &&
    conversationAccess(world, context, scope.id).level === "none"
  )
    notFound();
}

export function configurationSnapshot(
  world: MemoryPolicyWorld,
  scope: C.SettingsScope,
): C.ConfigurationSnapshot {
  scopeChain(world, scope);
  const current = world.configuration[scopeKey(scope)];
  return structuredClone({
    settings: current?.settings ?? {},
    capabilities: current?.capabilities ?? {
      scope,
      everyone: {},
      group_grants: [],
    },
    ...(scope.kind === "workspace"
      ? {
          dm_rule: world.dm_rule,
          setting_locks: world.setting_locks,
          capability_locks: world.capability_locks,
        }
      : {}),
  });
}

/** Inherited projections and duplicate-source ETags share these invalidations. */
export function conversationVersionKeys(
  world: MemoryCommsState,
  ids: string[],
): string[] {
  const affected = new Set(ids);
  return [
    ...ids.map((id) => `conversation:${id}`),
    ...Object.values(world.schedules)
      .filter(
        (s) =>
          (s.status === "pending" || s.status === "running") &&
          affected.has(s.request.conversation_id),
      )
      .map((s) => `schedule:${s.id}`),
  ];
}

export function configurationVersionKeys(
  world: MemoryCommsState,
  scope: C.SettingsScope,
): string[] {
  const scopes: C.SettingsScope[] = [scope];
  if (scope.kind === "workspace")
    scopes.push(
      ...Object.keys(world.categories).map((id) => ({
        kind: "category" as const,
        id,
      })),
    );
  const channels = Object.values(world.conversations).filter(
    (c) =>
      c.kind === "channel" &&
      scopeChain(world, { kind: "channel", id: c.id }).some(
        (s) => scopeKey(s) === scopeKey(scope),
      ),
  );
  scopes.push(...channels.map((c) => ({ kind: "channel" as const, id: c.id })));
  return [
    ...new Set([
      ...scopes.flatMap((s) => [configurationKey(s), capabilityKey(s)]),
      ...conversationVersionKeys(
        world,
        scope.kind === "workspace"
          ? Object.keys(world.conversations)
          : channels.map((c) => c.id),
      ),
    ]),
  ];
}

export function structurePublications(
  world: MemoryPolicyWorld,
): MemoryPublication[] {
  return Object.values(world.people)
    .filter((p) => p.active && p.org_id === world.org_id)
    .map((p) => ({
      recipient_ids: [p.user_id],
      event: {
        private: true,
        topic: `org:${world.org_id}:user:${p.user_id}`,
        event: "structure",
        payload: {},
      },
    }));
}

/** Synchronous staging only: caller owns authorization, conditions and ONE commit. */
export function stageConfigurationChange(
  draft: MemoryCommsState,
  execution: MemoryExecution,
  scope: C.SettingsScope,
  input: C.ConfigurationSnapshot,
) {
  const parsed = S.configurationSnapshotSchema.safeParse(input);
  if (
    !parsed.success ||
    scopeKey(parsed.data.capabilities.scope) !== scopeKey(scope)
  )
    return invalidInput();
  const before = configurationSnapshot(draft, scope);
  const next = parsed.data;
  const removed = S.settingKeySchema.options.filter(
    (key) =>
      Object.hasOwn(before.settings, key) && !Object.hasOwn(next.settings, key),
  );
  const changed = S.settingKeySchema.options.filter(
    (key) =>
      Object.hasOwn(next.settings, key) &&
      JSON.stringify(next.settings[key]) !==
        JSON.stringify(before.settings[key]),
  );
  if (removed.length) resetSettings(draft, scope, { keys: removed });
  // Validate the complete value so paired fields are never torn into a partial
  // patch. Only changed keys are writes: an unchanged locked override may remain
  // in a snapshot, but the core must still reject every changed locked key.
  if (Object.keys(next.settings).length) {
    updateSettings(
      {
        ...draft,
        setting_locks: draft.setting_locks.filter((key) =>
          changed.includes(key),
        ),
      },
      scope,
      next.settings,
    );
  }
  const capabilities = validateCapabilityConfiguration(
    draft,
    scope,
    next.capabilities,
  );
  draft.configuration[scopeKey(scope)] = {
    settings: structuredClone(next.settings),
    capabilities,
  };
  if (scope.kind === "workspace") {
    draft.dm_rule = next.dm_rule ?? draft.dm_rule;
    draft.setting_locks = next.setting_locks ?? draft.setting_locks;
    draft.capability_locks = next.capability_locks ?? draft.capability_locks;
  }
  const after = configurationSnapshot(draft, scope);
  const timestamp = new Date(execution.now).toISOString();
  const history: C.ConfigurationHistory = {
    id: execution.uuid(),
    org_id: execution.context.org_id,
    actor_id: execution.context.user_id,
    scope: structuredClone(scope),
    created_at: timestamp,
    updated_at: timestamp,
    before,
    after,
  };
  draft.history[history.id] = structuredClone(history);
  return {
    history,
    version_keys: [
      ...configurationVersionKeys(draft, scope),
      ...(scope.kind === "workspace" &&
      JSON.stringify(before.capability_locks) !==
        JSON.stringify(after.capability_locks)
        ? [capabilityLocksKey]
        : []),
    ],
    publications: structurePublications(draft),
  };
}
