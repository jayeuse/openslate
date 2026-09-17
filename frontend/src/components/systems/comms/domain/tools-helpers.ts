import { threadMessages, type Message, type Thread } from "./model";
import {
  DEFAULT_COMMS_SETTINGS,
  normalizeCommsSettings,
  getCommsScope,
  patchCommsScope,
  type CommsConfiguration,
  type CommsHistoryEntry,
  type CommsSettings,
  type CommsSettingKey,
  type CommsScope,
  type CommsScopeConfiguration,
} from "./configuration";
export function parseSettingsImport(text: string): Partial<CommsSettings> {
  if (text.length > 65536)
    throw new Error("Settings JSON must be under 64 KB.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Enter valid settings JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Enter a settings object.");
  const normalized = normalizeCommsSettings(raw);
  for (const key of Object.keys(raw)) {
    if (key === "dmRule")
      throw new Error(
        "Direct message access is a workspace-only setting. Configure it in Workspace settings.",
      );
    if (!Object.hasOwn(DEFAULT_COMMS_SETTINGS, key))
      throw new Error(
        `Unknown setting: ${key}. Only settings may be imported.`,
      );
    if (!Object.hasOwn(normalized, key))
      throw new Error(`Invalid value for ${key}.`);
  }
  return normalized;
}
export function selectedSettings(
  settings: Partial<CommsSettings>,
  keys: CommsSettingKey[],
): Partial<CommsSettings> {
  return Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(settings, key))
      .map((key) => [key, settings[key]]),
  );
}
export function recordScopeChange(
  config: CommsConfiguration,
  scope: CommsScope,
  after: CommsScopeConfiguration,
  label: string,
): CommsConfiguration {
  const before = getCommsScope(config, scope);
  return {
    ...patchCommsScope(config, scope, after),
    history: [
      {
        id: crypto.randomUUID(),
        created: Date.now(),
        actorId: "sample-eli",
        label,
        scope,
        before: structuredClone(before),
        after: structuredClone(after),
      },
      ...config.history,
    ],
  };
}
export function templateText(
  template: string,
  fields: Record<string, string>,
): string {
  return template.replace(
    /\{\{\s*([\w]+)\s*\}\}/g,
    (_, key: string) => fields[key] ?? `{{${key}}}`,
  );
}

export function restoreConfigurationEntry(
  config: CommsConfiguration,
  entry: CommsHistoryEntry,
): CommsConfiguration {
  const restored = recordScopeChange(
    config,
    entry.scope,
    entry.before,
    `Restored: ${entry.label}`,
  );
  if (entry.scope.kind !== "workspace" || !entry.beforeLocks) return restored;
  const beforeLocks = {
    settings: [...config.lockedSettings],
    permissions: [...config.lockedPermissions],
  };
  const afterLocks = structuredClone(entry.beforeLocks);
  return {
    ...restored,
    lockedSettings: afterLocks.settings,
    lockedPermissions: afterLocks.permissions,
    history: [
      { ...restored.history[0], beforeLocks, afterLocks },
      ...restored.history.slice(1),
    ],
  };
}

export function toolChannelMessages(
  messages: Message[],
  threads: Thread[],
  channelId: string,
): Message[] {
  return [
    ...messages.filter((message) => message.conversation === channelId),
    ...threads
      .filter(
        (thread) =>
          (thread.conversation ??
            messages.find((message) => message.id === thread.messageId)
              ?.conversation) === channelId,
      )
      .flatMap(threadMessages),
  ];
}
