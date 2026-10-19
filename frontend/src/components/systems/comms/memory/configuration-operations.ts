import type { CommsClient } from "../contract/client";
import * as S from "../contract/schemas";
import type * as C from "../contract/types";
import {
  inspectCapabilities,
  channelCreationCheck,
  scopeManagementDecision,
  validateCapabilityConfiguration,
} from "../domain/capabilities";
import {
  invalidInput,
  resolveSettings,
  updateSettings,
  resetSettings,
} from "../domain/settings";
import {
  assertRequestActive,
  requireAvailable,
  type MemoryClientBinding,
} from "./availability";
import {
  capabilityKey,
  capabilityLocksKey,
  configurationKey,
  configurationSnapshot,
  requireScopeRead,
  stageConfigurationChange,
} from "./configuration-mutation";
import type { MemoryCommsState } from "./model";

type ConfigurationOperations = Pick<
  CommsClient,
  | "getCapabilityConfiguration"
  | "setCapabilityConfiguration"
  | "getCapabilities"
  | "getSettings"
  | "updateSettings"
  | "resetSettings"
  | "setSettingsLocks"
  | "getDirectPolicy"
  | "setDirectPolicy"
  | "getCapabilityLocks"
  | "setCapabilityLocks"
  | "getChannelCreationCheck"
  | "checkPerson"
>;
const workspace = { kind: "workspace" } as const;

export function createConfigurationOperations(
  binding: MemoryClientBinding,
): ConfigurationOperations {
  const { handle, authority } = binding;
  async function changeSettings(
    scope: C.SettingsScope,
    options: C.ConditionalOptions,
    change: (
      world: MemoryCommsState,
      scope: C.SettingsScope,
    ) => C.ConfigurationSnapshot,
  ) {
    const parsed = S.settingsScopeSchema.safeParse(scope);
    if (!parsed.success) return invalidInput();
    const target = parsed.data;
    const key = configurationKey(target);
    const result = await handle.command({
      signal: options?.signal,
      conditions: [{ key, if_match: options?.if_match }],
      authorize(world, execution) {
        requireAvailable(
          binding,
          execution.context,
          {
            scope: target,
            capability:
              target.kind === "workspace" ? "manageWorkspace" : "manageChannel",
          },
          scopeManagementDecision(world, execution.context, target),
        );
      },
      apply(draft, execution) {
        const staged = stageConfigurationChange(
          draft,
          execution,
          target,
          change(draft, target),
        );
        return {
          kind: "commit",
          value: resolveSettings(draft, target),
          version_keys: staged.version_keys,
          publications: staged.publications,
        };
      },
    });
    return { data: result.value, etag: result.versions[key] };
  }
  return {
    async setSettingsLocks(request, options) {
      const parsed = S.settingsLocksSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      return changeSettings(workspace, options, (world) => ({
        ...configurationSnapshot(world, workspace),
        setting_locks: parsed.data.keys,
      }));
    },
    async getDirectPolicy(options) {
      assertRequestActive(options);
      return handle.read((world) => ({
        data: { dm_rule: world.dm_rule },
        etag: handle.version(configurationKey(workspace)),
      }));
    },
    async setDirectPolicy(request, options) {
      const parsed = S.directPolicySchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const result = await changeSettings(workspace, options, (world) => ({
        ...configurationSnapshot(world, workspace),
        dm_rule: parsed.data.dm_rule,
      }));
      // The accepted workspace result, not a later read that can race another write.
      if (result.data.scope.kind !== "workspace" || !("dm_rule" in result.data))
        return invalidInput();
      return { data: { dm_rule: result.data.dm_rule }, etag: result.etag };
    },
    async getCapabilityLocks(options) {
      assertRequestActive(options);
      return handle.read((world) => ({
        data: { capabilities: world.capability_locks },
        etag: handle.version(capabilityLocksKey),
      }));
    },
    async setCapabilityLocks(request, options) {
      const parsed = S.capabilityLocksSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const result = await handle.command({
        signal: options?.signal,
        conditions: [{ key: capabilityLocksKey, if_match: options?.if_match }],
        authorize(world, execution) {
          requireAvailable(
            binding,
            execution.context,
            { scope: workspace, capability: "manageWorkspace" },
            scopeManagementDecision(world, execution.context, workspace),
          );
        },
        apply(draft, execution) {
          const next = {
            ...configurationSnapshot(draft, workspace),
            capability_locks: parsed.data.capabilities,
          };
          const staged = stageConfigurationChange(
            draft,
            execution,
            workspace,
            next,
          );
          return {
            kind: "commit",
            value: parsed.data,
            version_keys: [...staged.version_keys, capabilityLocksKey],
            publications: staged.publications,
          };
        },
      });
      return { data: result.value, etag: result.versions[capabilityLocksKey] };
    },
    async getChannelCreationCheck(scope, options) {
      assertRequestActive(options);
      const parsed = S.channelCreationScopeSchema.safeParse(scope);
      if (!parsed.success) return invalidInput();
      return handle.read((world, context) => {
        const check = channelCreationCheck(world, context, parsed.data);
        authority.assertInspectionAvailable(context, parsed.data);
        return check;
      });
    },
    async checkPerson(id, userId, options) {
      assertRequestActive(options);
      return handle.read((world, context) => {
        const check = inspectCapabilities(world, context, id, userId);
        if (userId !== context.user_id)
          authority.assertCapabilityAvailable(context, {
            scope: { kind: "channel", id },
            capability: "manageChannel",
          });
        authority.assertInspectionAvailable(context, { kind: "channel", id });
        return check;
      });
    },
    async getSettings(scope, options) {
      assertRequestActive(options);
      const parsed = S.settingsScopeSchema.safeParse(scope);
      if (!parsed.success) return invalidInput();
      return handle.read((world, context) => {
        requireScopeRead(world, context, parsed.data);
        return {
          data: resolveSettings(world, parsed.data),
          etag: handle.version(configurationKey(parsed.data)),
        };
      });
    },
    async updateSettings(scope, request, options) {
      const parsed = S.settingsPatchSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      return changeSettings(scope, options, (world, target) => ({
        ...configurationSnapshot(world, target),
        ...updateSettings(world, target, parsed.data),
      }));
    },
    async resetSettings(scope, request, options) {
      const parsed = S.settingsResetSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      return changeSettings(scope, options, (world, target) => ({
        ...configurationSnapshot(world, target),
        ...resetSettings(world, target, parsed.data),
      }));
    },
    async getCapabilityConfiguration(scope, options) {
      assertRequestActive(options);
      const parsed = S.settingsScopeSchema.safeParse(scope);
      if (!parsed.success) return invalidInput();
      return handle.read((world, context) => {
        requireScopeRead(world, context, parsed.data);
        return {
          data: configurationSnapshot(world, parsed.data).capabilities,
          etag: handle.version(capabilityKey(parsed.data)),
        };
      });
    },
    async setCapabilityConfiguration(request, options) {
      const parsed = S.capabilityConfigurationSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const scope = parsed.data.scope;
      const key = capabilityKey(scope);
      const result = await handle.command({
        signal: options?.signal,
        conditions: [{ key, if_match: options?.if_match }],
        authorize(world, execution) {
          requireAvailable(
            binding,
            execution.context,
            {
              scope,
              capability:
                scope.kind === "workspace"
                  ? "manageWorkspace"
                  : "manageChannel",
            },
            scopeManagementDecision(world, execution.context, scope),
          );
        },
        apply(draft, execution) {
          const next = configurationSnapshot(draft, scope);
          next.capabilities = validateCapabilityConfiguration(
            draft,
            scope,
            parsed.data,
          );
          const staged = stageConfigurationChange(
            draft,
            execution,
            scope,
            next,
          );
          return {
            kind: "commit",
            value: next.capabilities,
            version_keys: staged.version_keys,
            publications: staged.publications,
          };
        },
      });
      return { data: result.value, etag: result.versions[key] };
    },
    async getCapabilities(id, options) {
      assertRequestActive(options);
      return handle.read((world, context): C.CapabilityCheck => {
        const check = inspectCapabilities(world, context, id);
        authority.assertInspectionAvailable(context, { kind: "channel", id });
        return check;
      });
    },
  };
}
