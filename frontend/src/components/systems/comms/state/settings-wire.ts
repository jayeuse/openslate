import * as S from "../contract/schemas";
import type * as C from "../contract/types";
import type {
  CommsPreferences,
  CommsScope,
  CommsSettings,
} from "../domain/configuration-model";

export function wireScope(scope: CommsScope): C.SettingsScope {
  return scope.kind === "workspace" ? { kind: "workspace" } : scope;
}

export function wireSettingKey(key: string): C.SettingKey {
  return S.settingKeySchema.parse(
    key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
  );
}

export function wireSettings(values: Partial<CommsSettings>): C.SettingsPatch {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      wireSettingKey(key),
      key === "restrictionUntil"
        ? value
          ? new Date(Number(value)).toISOString()
          : null
        : key === "pinnedRecordId"
          ? value || null
          : value,
    ]),
  );
}

export function wirePreferences(
  preferences: CommsPreferences,
): C.PersonalPreferencesRequest {
  return {
    density: preferences.density,
    text_size: preferences.textSize,
    timestamps: preferences.timestamps,
    group_messages: preferences.groupMessages,
    avatars: preferences.avatars,
    previews: preferences.previews,
    send_shortcut: preferences.sendShortcut,
    shortcuts: {
      search: preferences.shortcuts.search ?? "",
      new_message: preferences.shortcuts.newMessage ?? "",
    },
    channel_width: preferences.channelWidth,
    member_width: preferences.memberWidth,
    thread_width: preferences.threadWidth,
    notifications: wireSettings(preferences.settings),
  };
}
