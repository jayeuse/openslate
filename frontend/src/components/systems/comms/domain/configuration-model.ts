import type * as C from "../contract/types";
import { DEFAULT_SETTINGS, DEFAULT_PERSONAL_PREFERENCES } from "./settings";
import type { Channel } from "./view-model";

type Camel<T extends string> = T extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<Camel<Tail>>}`
  : T;
export type CommsSettings = {
  [Key in keyof C.Settings as Camel<Key>]: Key extends "restriction_until"
    ? number
    : Key extends "pinned_record_id"
      ? string
      : C.Settings[Key];
} & { dmRule: C.DirectPolicy["dm_rule"] };
export type CommsSettingKey = keyof CommsSettings;
export type CommsScope = {
  kind: "workspace" | "category" | "channel";
  id: string;
};
export type CommsScopeConfiguration = {
  settings: Partial<CommsSettings>;
  capabilities: C.CapabilityConfiguration;
};
export type CommsPreferences = {
  density: C.PersonalPreferences["density"];
  textSize: C.PersonalPreferences["text_size"];
  timestamps: C.PersonalPreferences["timestamps"];
  groupMessages: boolean;
  avatars: boolean;
  previews: boolean;
  sendShortcut: C.PersonalPreferences["send_shortcut"];
  shortcuts: Record<string, string>;
  favorites: string[];
  hiddenChannels: string[];
  mutedUntil: Record<string, number>;
  readAt: Record<string, number>;
  channelWidth: number;
  memberWidth: number;
  threadWidth: number;
  settings: Partial<CommsSettings>;
};
export type ResolvedCommsSettings = {
  values: CommsSettings;
  sources: Record<string, string>;
  locked: CommsSettingKey[];
};
export type CommsConfiguration = {
  workspace: CommsScopeConfiguration;
  categories: Record<string, CommsScopeConfiguration>;
  channels: Record<string, CommsScopeConfiguration>;
  lockedSettings: CommsSettingKey[];
  lockedCapabilities: C.Capability[];
  preferences: Record<string, CommsPreferences>;
  resolved: Record<string, ResolvedCommsSettings>;
};
export function settingsView(
  settings: Partial<C.Settings>,
): Partial<CommsSettings> {
  return Object.fromEntries(
    Object.entries(settings).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      key === "restriction_until"
        ? value
          ? Date.parse(String(value))
          : 0
        : key === "pinned_record_id"
          ? (value ?? "")
          : value,
    ]),
  );
}
export const DEFAULT_COMMS_SETTINGS = {
  ...settingsView(DEFAULT_SETTINGS),
  dmRule: "everyone",
} as CommsSettings;
export const DEFAULT_COMMS_PREFERENCES: CommsPreferences = {
  density: DEFAULT_PERSONAL_PREFERENCES.density,
  textSize: DEFAULT_PERSONAL_PREFERENCES.text_size,
  timestamps: DEFAULT_PERSONAL_PREFERENCES.timestamps,
  groupMessages: true,
  avatars: true,
  previews: true,
  sendShortcut: "enter",
  shortcuts: { search: "Alt+F", newMessage: "Alt+N" },
  favorites: [],
  hiddenChannels: [],
  mutedUntil: {},
  readAt: {},
  channelWidth: 240,
  memberWidth: 220,
  threadWidth: 380,
  settings: {},
};
export function emptyCommsScope(
  scope: C.SettingsScope = { kind: "workspace" },
): CommsScopeConfiguration {
  return {
    settings: {},
    capabilities: { scope, everyone: {}, group_grants: [] },
  };
}
export function createCommsConfiguration(): CommsConfiguration {
  return {
    workspace: emptyCommsScope(),
    categories: {},
    channels: {},
    lockedSettings: [],
    lockedCapabilities: [],
    preferences: {},
    resolved: {},
  };
}
export function getCommsScope(config: CommsConfiguration, scope: CommsScope) {
  return scope.kind === "workspace"
    ? config.workspace
    : ((scope.kind === "category"
        ? config.categories[scope.id]
        : config.channels[scope.id]) ?? emptyCommsScope(scope));
}
/** Select a client-resolved display value. This does not evaluate policy. */
export function resolveCommsSettings(
  config: CommsConfiguration,
  channel?: Pick<Channel, "id" | "categoryId">,
): ResolvedCommsSettings {
  return (
    config.resolved[
      channel?.id ||
        (channel?.categoryId ? `category:${channel.categoryId}` : "workspace")
    ] ?? { values: DEFAULT_COMMS_SETTINGS, sources: {}, locked: [] }
  );
}
