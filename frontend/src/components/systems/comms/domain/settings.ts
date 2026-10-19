import type {
  PersonalPreferences,
  SettingKey,
  SettingMetadata,
  Settings,
  SettingsResponse,
  SettingsScope,
} from "../contract/types";
import type { MemoryPolicyWorld } from "../memory/model";
import { scopeChain, scopeKey } from "./policy-scope";
import {
  settingsPatchSchema,
  settingsResetSchema,
  settingsSchema,
} from "../contract/schemas";
import { policyFailure } from "./access";

export const DEFAULT_SETTINGS: Settings = {
  mode: "normal",
  edit_window_minutes: 0,
  delete_window_minutes: 0,
  slow_mode_seconds: 0,
  formatting: true,
  link_previews: false,
  allowed_reactions: ["👍", "❤️", "😂", "🔥", "🎉", "👀", "🙏", "✅"],
  mention_limit: 0,
  auto_archive_days: 0,
  default_thread_subscription: true,
  thread_branches: "all",
  join_rule: "open",
  default_member_ids: [],
  notification_mode: "all",
  keywords: [],
  notify_followed_threads: true,
  quiet_hours_start: "",
  quiet_hours_end: "",
  notification_sound: true,
  notification_badges: true,
  notification_preview: true,
  desktop_notifications: true,
  allowed_file_types: [],
  max_file_size_mb: 0,
  file_previews: true,
  file_downloads: true,
  allowed_record_modules: [],
  require_record_link: false,
  record_card_fields: [],
  locked: false,
  restricted_person_ids: [],
  restriction_until: null,
  allow_export: true,
  pinned_record_id: null,
};
export const DEFAULT_PERSONAL_PREFERENCES: PersonalPreferences = {
  density: "comfortable",
  text_size: "medium",
  timestamps: "time",
  group_messages: true,
  avatars: true,
  previews: true,
  send_shortcut: "enter",
  shortcuts: { search: "Alt+F", new_message: "Alt+N" },
  channel_width: 240,
  member_width: 220,
  thread_width: 380,
  notifications: {},
};
const sections: Record<SettingKey, SettingMetadata["section"]> = {
  mode: "overview",
  pinned_record_id: "overview",
  edit_window_minutes: "messaging",
  delete_window_minutes: "messaging",
  slow_mode_seconds: "messaging",
  formatting: "messaging",
  link_previews: "messaging",
  allowed_reactions: "messaging",
  mention_limit: "messaging",
  auto_archive_days: "threads",
  default_thread_subscription: "threads",
  thread_branches: "threads",
  join_rule: "members",
  default_member_ids: "members",
  notification_mode: "notifications",
  keywords: "notifications",
  notify_followed_threads: "notifications",
  quiet_hours_start: "notifications",
  quiet_hours_end: "notifications",
  notification_sound: "notifications",
  notification_badges: "notifications",
  notification_preview: "notifications",
  desktop_notifications: "notifications",
  allowed_file_types: "files",
  max_file_size_mb: "files",
  file_previews: "files",
  file_downloads: "files",
  allowed_record_modules: "files",
  require_record_link: "files",
  record_card_fields: "files",
  locked: "history",
  restricted_person_ids: "history",
  restriction_until: "history",
  allow_export: "history",
};
const common = new Set<SettingKey>([
  "mode",
  "edit_window_minutes",
  "delete_window_minutes",
  "notification_mode",
  "allowed_file_types",
  "max_file_size_mb",
]);
export const SETTINGS_METADATA: SettingMetadata[] = (
  Object.keys(sections) as SettingKey[]
).map((key) => ({
  key,
  section: sections[key],
  tier: common.has(key) ? "common" : "advanced",
}));

export function invalidInput(): never {
  return policyFailure({
    status: 422,
    body: { detail: { code: "comms_invalid_input", message: "Invalid input" } },
  });
}

/** Recover compatible stored fields independently; this is never write admission. */
function storedSettings(value: unknown): Partial<Settings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Partial<Settings> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as SettingKey[]) {
    const parsed = settingsSchema.shape[key].safeParse(
      (value as Record<string, unknown>)[key],
    );
    if (parsed.success) Object.assign(result, { [key]: parsed.data });
  }
  if (
    (result.quiet_hours_start === undefined) !==
      (result.quiet_hours_end === undefined) ||
    (result.quiet_hours_start === "") !== (result.quiet_hours_end === "")
  ) {
    delete result.quiet_hours_start;
    delete result.quiet_hours_end;
  }
  return result;
}

function validateReferences(
  world: MemoryPolicyWorld,
  settings: Partial<Settings>,
) {
  for (const id of [
    ...(settings.default_member_ids ?? []),
    ...(settings.restricted_person_ids ?? []),
  ])
    if (!world.people[id]?.active || world.people[id].org_id !== world.org_id)
      invalidInput();
  for (const id of settings.allowed_record_modules ?? [])
    if (world.modules[id]?.org_id !== world.org_id) invalidInput();
  for (const id of settings.record_card_fields ?? [])
    if (
      world.fields[id]?.org_id !== world.org_id ||
      world.modules[world.fields[id].module_id]?.org_id !== world.org_id
    )
      invalidInput();
  if (
    settings.pinned_record_id &&
    world.records[settings.pinned_record_id]?.org_id !== world.org_id
  )
    invalidInput();
}

/** Pure validated next scope; the command owner authorizes and commits it once. */
export function updateSettings(
  world: MemoryPolicyWorld,
  scope: SettingsScope,
  input: unknown,
) {
  scopeChain(world, scope);
  const parsed = settingsPatchSchema.safeParse(input);
  if (!parsed.success) return invalidInput();
  validateReferences(world, parsed.data);
  if (
    scope.kind !== "workspace" &&
    Object.keys(parsed.data).some((key) =>
      world.setting_locks.includes(key as SettingKey),
    )
  )
    return policyFailure({
      status: 403,
      body: {
        detail: {
          code: "comms_capability_denied",
          message: "Workspace setting is locked",
        },
      },
    });
  const current = world.configuration[scopeKey(scope)];
  return {
    settings: { ...storedSettings(current?.settings), ...parsed.data },
    capabilities: structuredClone(
      current?.capabilities ?? { scope, everyone: {}, group_grants: [] },
    ),
  };
}

export function resetSettings(
  world: MemoryPolicyWorld,
  scope: SettingsScope,
  input: unknown,
) {
  scopeChain(world, scope);
  const parsed = settingsResetSchema.safeParse(input);
  if (!parsed.success) return invalidInput();
  const current = world.configuration[scopeKey(scope)];
  const settings = storedSettings(current?.settings);
  for (const key of parsed.data.keys) delete settings[key];
  if (
    (settings.quiet_hours_start === undefined) !==
    (settings.quiet_hours_end === undefined)
  )
    return invalidInput();
  return {
    settings,
    capabilities: structuredClone(
      current?.capabilities ?? { scope, everyone: {}, group_grants: [] },
    ),
  };
}

export function resolveSettings(
  world: MemoryPolicyWorld,
  scope: SettingsScope,
): SettingsResponse {
  const effective = structuredClone(DEFAULT_SETTINGS);
  const sources = Object.fromEntries(
    Object.keys(effective).map((key) => [key, { kind: "default" }]),
  ) as SettingsResponse["sources"];
  for (const layer of scopeChain(world, scope)) {
    const settings = storedSettings(
      world.configuration[scopeKey(layer)]?.settings,
    );
    for (const key of Object.keys(settings) as SettingKey[]) {
      if (layer.kind !== "workspace" && world.setting_locks.includes(key))
        continue;
      Object.assign(effective, { [key]: structuredClone(settings[key]) });
      sources[key] = layer;
    }
  }
  const result = {
    org_id: world.org_id,
    overrides: storedSettings(world.configuration[scopeKey(scope)]?.settings),
    effective,
    sources,
    locked_keys: [...world.setting_locks],
    metadata: structuredClone(SETTINGS_METADATA),
  };
  return scope.kind === "workspace"
    ? { ...result, scope, dm_rule: world.dm_rule }
    : { ...result, scope };
}
