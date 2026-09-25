import { z } from "zod";
import {
  COMMS_PERMISSIONS,
  DEFAULT_COMMS_PREFERENCES,
  DEFAULT_COMMS_SETTINGS,
  createCommsConfiguration,
  emptyCommsScope,
  type CommsConfiguration,
  type CommsLockSnapshot,
  type CommsPermission,
  type CommsPreferences,
  type CommsScopeConfiguration,
  type CommsSettingKey,
  type CommsSettings,
  type PermissionOverride,
} from "./configuration-model";

const strings = z.array(z.string());
const enums: Partial<Record<CommsSettingKey, readonly string[]>> = {
  mode: ["normal", "announcements", "thread-first"],
  threadBranches: ["all", "followed", "none"],
  joinRule: ["open", "request", "invite"],
  dmRule: ["everyone", "shared-channel", "none"],
  notificationMode: ["all", "mentions", "none"],
};
export function normalizeCommsSettings(raw: unknown): Partial<CommsSettings> {
  const result: Partial<CommsSettings> = {};
  if (!isObject(raw)) return result;
  for (const key of Object.keys(DEFAULT_COMMS_SETTINGS) as CommsSettingKey[]) {
    const value = raw[key];
    const fallback = DEFAULT_COMMS_SETTINGS[key];
    const valid = enums[key]
      ? typeof value === "string" && enums[key]!.includes(value)
      : Array.isArray(fallback)
        ? strings.safeParse(value).success
        : typeof fallback === "number"
          ? typeof value === "number" && Number.isFinite(value) && value >= 0
          : typeof value === typeof fallback;
    if (valid) Object.assign(result, { [key]: value });
  }
  return result;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function normalizeCommsScope(raw: unknown): CommsScopeConfiguration {
  const result = emptyCommsScope();
  if (!isObject(raw)) return result;
  result.settings = normalizeCommsSettings(raw.settings);
  if (isObject(raw.permissions))
    for (const [subject, values] of Object.entries(raw.permissions)) {
      if (
        !(
          subject === "everyone" ||
          subject.startsWith("role:") ||
          subject.startsWith("person:")
        ) ||
        !isObject(values)
      )
        continue;
      const permissions: Partial<Record<CommsPermission, PermissionOverride>> =
        {};
      for (const action of COMMS_PERMISSIONS)
        if (
          values[action] === "allow" ||
          values[action] === "deny" ||
          values[action] === "inherit"
        )
          permissions[action] = values[action];
      result.permissions[subject] = permissions;
    }
  return result;
}
const messageSchema = z.object({
  id: z.string(),
  conversation: z.string(),
  author: z.string(),
  authorId: z.string().optional(),
  text: z.string(),
  created: z.number(),
  pinned: z.boolean(),
  attachment: z.string().optional(),
  files: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        size: z.number(),
        type: z.string(),
      }),
    )
    .optional(),
  replyToId: z.string().optional(),
  reactions: z.record(z.string(), strings).optional(),
  recordId: z.string().optional(),
});
function validEntries<T>(raw: unknown, schema: z.ZodType<T>): T[] {
  return Array.isArray(raw)
    ? raw.flatMap((value) => {
        const parsed = schema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
}
function validMap<T>(raw: unknown, schema: z.ZodType<T>): Record<string, T> {
  return isObject(raw)
    ? Object.fromEntries(
        Object.entries(raw).flatMap(([key, value]) => {
          const parsed = schema.safeParse(value);
          return parsed.success ? [[key, parsed.data]] : [];
        }),
      )
    : {};
}
function normalizeLocks(raw: {
  settings: string[];
  permissions: string[];
}): CommsLockSnapshot {
  return {
    settings: raw.settings.filter((key): key is CommsSettingKey =>
      Object.hasOwn(DEFAULT_COMMS_SETTINGS, key),
    ),
    permissions: raw.permissions.filter((key): key is CommsPermission =>
      COMMS_PERMISSIONS.includes(key as CommsPermission),
    ),
  };
}
export function normalizeCommsConfiguration(raw: unknown): CommsConfiguration {
  const result = createCommsConfiguration();
  if (!isObject(raw)) return result;
  result.workspace = normalizeCommsScope(raw.workspace);
  for (const kind of ["categories", "channels"] as const)
    if (isObject(raw[kind]))
      result[kind] = Object.fromEntries(
        Object.entries(raw[kind]).map(([id, value]) => [
          id,
          normalizeCommsScope(value),
        ]),
      );
  result.lockedSettings = Array.isArray(raw.lockedSettings)
    ? raw.lockedSettings.filter(
        (key): key is CommsSettingKey =>
          typeof key === "string" && Object.hasOwn(DEFAULT_COMMS_SETTINGS, key),
      )
    : [];
  result.lockedPermissions = Array.isArray(raw.lockedPermissions)
    ? raw.lockedPermissions.filter((key): key is CommsPermission =>
        COMMS_PERMISSIONS.includes(key as CommsPermission),
      )
    : [];
  if (isObject(raw.preferences))
    for (const [id, pref] of Object.entries(raw.preferences))
      result.preferences[id] = normalizeCommsPreferences(pref);
  result.threadMeta = validMap(
    raw.threadMeta,
    z.object({
      name: z.string().optional(),
      locked: z.boolean().optional(),
      resolved: z.boolean().optional(),
      followedBy: strings.optional(),
      archived: z.boolean().optional(),
    }),
  );
  result.messageHistory = isObject(raw.messageHistory)
    ? Object.fromEntries(
        Object.entries(raw.messageHistory).map(([id, revisions]) => [
          id,
          validEntries(revisions, messageSchema),
        ]),
      )
    : {};
  result.tombstones = validMap(raw.tombstones, messageSchema);
  result.reports = validEntries(
    raw.reports,
    z.object({
      id: z.string(),
      messageId: z.string(),
      reporterId: z.string(),
      reason: z.string(),
      created: z.number(),
      status: z.enum(["open", "resolved"]),
    }),
  );
  result.rules = validEntries(
    raw.rules,
    z.object({
      id: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      event: z.enum([
        "record-change",
        "assignment",
        "message",
        "thread",
        "schedule",
      ]),
      filter: z.string(),
      channelId: z.string(),
      template: z.string(),
      recipientIds: strings,
      delivery: z.enum(["immediate", "digest"]),
    }),
  );
  result.schedules = validEntries(
    raw.schedules,
    z.object({
      id: z.string(),
      channelId: z.string(),
      text: z.string(),
      sendAt: z.number(),
      authorId: z.string(),
      recordId: z.string().optional(),
    }),
  );
  result.invites = validEntries(
    raw.invites,
    z.object({
      id: z.string(),
      channelId: z.string(),
      personId: z.string(),
      type: z.enum(["invite", "request"]),
      status: z.enum(["pending", "accepted", "declined"]),
    }),
  );
  if (Array.isArray(raw.templates))
    result.templates = raw.templates.flatMap((value) =>
      isObject(value) &&
      typeof value.id === "string" &&
      typeof value.name === "string"
        ? [
            {
              id: value.id,
              name: value.name,
              description:
                typeof value.description === "string" ? value.description : "",
              settings: normalizeCommsSettings(value.settings),
              ...(value.permissions
                ? {
                    permissions: normalizeCommsScope({
                      permissions: value.permissions,
                    }).permissions,
                  }
                : {}),
            },
          ]
        : [],
    );
  if (Array.isArray(raw.history))
    result.history = raw.history.flatMap((value) => {
      const base = z
        .object({
          id: z.string(),
          created: z.number(),
          actorId: z.string(),
          label: z.string(),
          scope: z.object({
            kind: z.enum(["workspace", "category", "channel"]),
            id: z.string(),
          }),
          before: z.unknown(),
          after: z.unknown(),
          beforeLocks: z
            .object({
              settings: z.array(z.string()),
              permissions: z.array(z.string()),
            })
            .optional(),
          afterLocks: z
            .object({
              settings: z.array(z.string()),
              permissions: z.array(z.string()),
            })
            .optional(),
        })
        .safeParse(value);
      return base.success
        ? [
            {
              id: base.data.id,
              created: base.data.created,
              actorId: base.data.actorId,
              label: base.data.label,
              scope: base.data.scope,
              before: normalizeCommsScope(base.data.before),
              after: normalizeCommsScope(base.data.after),
              ...(base.data.beforeLocks
                ? { beforeLocks: normalizeLocks(base.data.beforeLocks) }
                : {}),
              ...(base.data.afterLocks
                ? { afterLocks: normalizeLocks(base.data.afterLocks) }
                : {}),
            },
          ]
        : [];
    });
  return result;
}
export function normalizeCommsPreferences(raw: unknown): CommsPreferences {
  const result = structuredClone(DEFAULT_COMMS_PREFERENCES);
  if (!isObject(raw)) return result;
  const schema = z.object({
    density: z.enum(["comfortable", "compact"]),
    textSize: z.enum(["small", "medium", "large"]),
    timestamps: z.enum(["time", "full", "none"]),
    groupMessages: z.boolean(),
    avatars: z.boolean(),
    previews: z.boolean(),
    sendShortcut: z.enum(["enter", "ctrl-enter"]),
    shortcuts: z.record(z.string(), z.string()),
    favorites: strings,
    hiddenChannels: strings,
    mutedUntil: z.record(z.string(), z.number()),
    readAt: z.record(z.string(), z.number()),
    channelWidth: z.number().positive(),
    memberWidth: z.number().positive(),
    threadWidth: z.number().positive(),
  });
  for (const key of Object.keys(
    schema.shape,
  ) as (keyof typeof schema.shape)[]) {
    const parsed = schema.shape[key].safeParse(raw[key]);
    if (parsed.success) Object.assign(result, { [key]: parsed.data });
  }
  result.settings = normalizeCommsSettings(raw.settings);
  return result;
}
