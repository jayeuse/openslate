import { z } from "zod";
import type { Person } from "../../access/domain/model";
import type { Category, Channel, Message } from "./model";

export const COMMS_PERMISSIONS = [
  "viewChannel",
  "viewHistory",
  "post",
  "reply",
  "createThread",
  "manageThreads",
  "react",
  "mentionPeople",
  "mentionRoles",
  "mentionEveryone",
  "attachFiles",
  "downloadFiles",
  "linkRecords",
  "pin",
  "editMessages",
  "deleteMessages",
  "deleteOthersMessages",
  "invite",
  "manageChannel",
  "managePermissions",
  "createChannel",
  "manageWorkspace",
  "exportHistory",
  "moderate",
] as const;
export type CommsPermission = (typeof COMMS_PERMISSIONS)[number];
export type PermissionOverride = "inherit" | "allow" | "deny";
export type CommsScope = {
  kind: "workspace" | "category" | "channel";
  id: string;
};
export interface CommsSettings {
  mode: "normal" | "announcements" | "thread-first";
  ownerId: string;
  moderatorIds: string[];
  order: number;
  editWindowMinutes: number;
  deleteWindowMinutes: number;
  slowModeSeconds: number;
  formatting: boolean;
  linkPreviews: boolean;
  allowedReactions: string[];
  mentionLimit: number;
  autoArchiveDays: number;
  defaultThreadSubscription: boolean;
  threadBranches: "all" | "followed" | "none";
  joinRule: "open" | "request" | "invite";
  defaultMemberIds: string[];
  dmRule: "everyone" | "shared-channel" | "none";
  notificationMode: "all" | "mentions" | "none";
  keywords: string[];
  notifyFollowedThreads: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  notificationSound: boolean;
  notificationBadges: boolean;
  notificationPreview: boolean;
  desktopNotifications: boolean;
  mobileNotifications: boolean;
  allowedFileTypes: string[];
  maxFileSizeMb: number;
  filePreviews: boolean;
  fileDownloads: boolean;
  allowedRecordModules: string[];
  requireRecordLink: boolean;
  recordCardFields: string[];
  locked: boolean;
  restrictedPersonIds: string[];
  restrictionUntil: number;
  retentionDays: number;
  allowExport: boolean;
  systemMessages: boolean;
  pinnedRecordId: string;
}
export type CommsSettingKey = keyof CommsSettings;
export interface CommsScopeConfiguration {
  settings: Partial<CommsSettings>;
  permissions: Record<
    string,
    Partial<Record<CommsPermission, PermissionOverride>>
  >;
}
export interface CommsPreferences {
  density: "comfortable" | "compact";
  textSize: "small" | "medium" | "large";
  timestamps: "time" | "full" | "none";
  groupMessages: boolean;
  avatars: boolean;
  previews: boolean;
  sendShortcut: "enter" | "ctrl-enter";
  shortcuts: Record<string, string>;
  favorites: string[];
  hiddenChannels: string[];
  mutedUntil: Record<string, number>;
  readAt: Record<string, number>;
  channelWidth: number;
  memberWidth: number;
  threadWidth: number;
  settings: Partial<CommsSettings>;
}
export interface CommsThreadMeta {
  name?: string;
  locked?: boolean;
  resolved?: boolean;
  followedBy?: string[];
  archived?: boolean;
}
export interface CommsTemplate {
  id: string;
  name: string;
  description: string;
  settings: Partial<CommsSettings>;
  permissions?: CommsScopeConfiguration["permissions"];
}
export interface CommsAutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  event: "record-change" | "assignment" | "message" | "thread" | "schedule";
  filter: string;
  channelId: string;
  template: string;
  recipientIds: string[];
  delivery: "immediate" | "digest";
}
export interface CommsScheduledMessage {
  id: string;
  channelId: string;
  text: string;
  sendAt: number;
  authorId: string;
  recordId?: string;
}
export interface CommsHistoryEntry {
  id: string;
  created: number;
  actorId: string;
  label: string;
  scope: CommsScope;
  before: CommsScopeConfiguration;
  after: CommsScopeConfiguration;
  beforeLocks?: CommsLockSnapshot;
  afterLocks?: CommsLockSnapshot;
}
export interface CommsLockSnapshot {
  settings: CommsSettingKey[];
  permissions: CommsPermission[];
}
export interface CommsReport {
  id: string;
  messageId: string;
  reporterId: string;
  reason: string;
  created: number;
  status: "open" | "resolved";
}
export interface CommsInvite {
  id: string;
  channelId: string;
  personId: string;
  type: "invite" | "request";
  status: "pending" | "accepted" | "declined";
}
export interface CommsConfiguration {
  version: 1;
  workspace: CommsScopeConfiguration;
  categories: Record<string, CommsScopeConfiguration>;
  channels: Record<string, CommsScopeConfiguration>;
  lockedSettings: CommsSettingKey[];
  lockedPermissions: CommsPermission[];
  preferences: Record<string, CommsPreferences>;
  threadMeta: Record<string, CommsThreadMeta>;
  messageHistory: Record<string, Message[]>;
  tombstones: Record<string, Message>;
  reports: CommsReport[];
  templates: CommsTemplate[];
  rules: CommsAutomationRule[];
  schedules: CommsScheduledMessage[];
  history: CommsHistoryEntry[];
  invites: CommsInvite[];
}
export interface CommsPermissionContext {
  person?: Person;
  channel?: Channel;
  categories?: Category[];
}
export interface CommsPermissionResult {
  allowed: boolean;
  source: string;
  reason: string;
}
export interface ResolvedCommsSettings {
  values: CommsSettings;
  sources: Record<CommsSettingKey, string>;
  locked: CommsSettingKey[];
}
export const DEFAULT_COMMS_SETTINGS: CommsSettings = {
  mode: "normal",
  ownerId: "",
  moderatorIds: [],
  order: 0,
  editWindowMinutes: 15,
  deleteWindowMinutes: 0,
  slowModeSeconds: 0,
  formatting: true,
  linkPreviews: true,
  allowedReactions: ["👍", "❤️", "😂", "🔥", "🎉", "👀", "🙏", "✅"],
  mentionLimit: 0,
  autoArchiveDays: 0,
  defaultThreadSubscription: true,
  threadBranches: "all",
  joinRule: "open",
  defaultMemberIds: [],
  dmRule: "everyone",
  notificationMode: "all",
  keywords: [],
  notifyFollowedThreads: true,
  quietHoursStart: "",
  quietHoursEnd: "",
  notificationSound: true,
  notificationBadges: true,
  notificationPreview: true,
  desktopNotifications: true,
  mobileNotifications: true,
  allowedFileTypes: [],
  maxFileSizeMb: 0,
  filePreviews: true,
  fileDownloads: true,
  allowedRecordModules: [],
  requireRecordLink: false,
  recordCardFields: ["title", "status", "assignee"],
  locked: false,
  restrictedPersonIds: [],
  restrictionUntil: 0,
  retentionDays: 0,
  allowExport: true,
  systemMessages: true,
  pinnedRecordId: "",
};
export const DEFAULT_COMMS_PREFERENCES: CommsPreferences = {
  density: "comfortable",
  textSize: "medium",
  timestamps: "time",
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
export const COMMS_SETTING_META = Object.fromEntries(
  Object.keys(DEFAULT_COMMS_SETTINGS).map((key) => [
    key,
    {
      label: key
        .replace(/([A-Z])/g, " $1")
        .replace(/^./, (s) => s.toUpperCase()),
    },
  ]),
) as Record<CommsSettingKey, { label: string }>;
export const emptyCommsScope = (): CommsScopeConfiguration => ({
  settings: {},
  permissions: {},
});
export function createCommsConfiguration(): CommsConfiguration {
  return {
    version: 1,
    workspace: emptyCommsScope(),
    categories: {},
    channels: {},
    lockedSettings: [],
    lockedPermissions: [],
    preferences: {},
    threadMeta: {},
    messageHistory: {},
    tombstones: {},
    reports: [],
    templates: [
      {
        id: "team-chat",
        name: "Team Chat",
        description: "Everyday team conversations.",
        settings: { mode: "normal" },
      },
      {
        id: "announcements",
        name: "Announcements",
        description: "Managers announce; members participate in threads.",
        settings: { mode: "announcements" },
      },
      {
        id: "service-desk",
        name: "Service Desk",
        description: "Record-linked, thread-first requests.",
        settings: { mode: "thread-first", requireRecordLink: true },
      },
      {
        id: "incident-room",
        name: "Incident Room",
        description:
          "Choose incident moderators and a pinned record when applying.",
        settings: { moderatorIds: [], pinnedRecordId: "" },
      },
    ],
    rules: [],
    schedules: [],
    history: [],
    invites: [],
  };
}
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
export function getCommsScope(
  config: CommsConfiguration,
  scope: CommsScope,
): CommsScopeConfiguration {
  return scope.kind === "workspace"
    ? config.workspace
    : ((scope.kind === "category"
        ? config.categories[scope.id]
        : config.channels[scope.id]) ?? emptyCommsScope());
}
export function patchCommsScope(
  config: CommsConfiguration,
  scope: CommsScope,
  value: CommsScopeConfiguration,
): CommsConfiguration {
  return scope.kind === "workspace"
    ? { ...config, workspace: value }
    : {
        ...config,
        [scope.kind === "category" ? "categories" : "channels"]: {
          ...(scope.kind === "category" ? config.categories : config.channels),
          [scope.id]: value,
        },
      };
}
export function resolveCommsSettings(
  config: CommsConfiguration,
  channel?: Channel,
  categories: Category[] = [],
): ResolvedCommsSettings {
  const values = structuredClone(DEFAULT_COMMS_SETTINGS);
  const sources = Object.fromEntries(
    Object.keys(values).map((key) => [key, "Default"]),
  ) as Record<CommsSettingKey, string>;
  if (channel) values.systemMessages = channel.system;
  const layers: [string, CommsScopeConfiguration | undefined][] = [
    ["Workspace", config.workspace],
  ];
  if (channel)
    layers.push(
      [
        `Category: ${categories.find((c) => c.id === channel.categoryId)?.name ?? channel.categoryId}`,
        config.categories[channel.categoryId],
      ],
      [`Channel: ${channel.name}`, config.channels[channel.id]],
    );
  for (const [source, scope] of layers)
    if (scope)
      for (const key of Object.keys(scope.settings) as CommsSettingKey[]) {
        if (source !== "Workspace" && config.lockedSettings.includes(key))
          continue;
        Object.assign(values, { [key]: scope.settings[key] });
        sources[key] = source;
      }
  return { values, sources, locked: config.lockedSettings };
}
export function resolveCommsPermission(
  config: CommsConfiguration,
  context: CommsPermissionContext,
  permission: CommsPermission,
): CommsPermissionResult {
  const { person, channel, categories = [] } = context;
  if (!person?.active)
    return {
      allowed: false,
      source: "Identity",
      reason: "An active person is required",
    };
  if (person.id === "sample-eli")
    return {
      allowed: true,
      source: "OpenComms owner",
      reason:
        "Active Eli has protected OpenComms owner access. Channel and messaging policies still apply.",
    };
  if (permission !== "viewChannel" && channel) {
    const visibility = resolveCommsPermission(config, context, "viewChannel");
    if (!visibility.allowed)
      return {
        allowed: false,
        source: visibility.source,
        reason: "Channel visibility is required",
      };
  }
  const settings = resolveCommsSettings(config, channel, categories).values;
  const manager =
    person.role === "sample-admin" ||
    settings.ownerId === person.id ||
    settings.moderatorIds.includes(person.id);
  let allowed =
    ![
      "pin",
      "manageThreads",
      "manageChannel",
      "managePermissions",
      "createChannel",
      "manageWorkspace",
      "moderate",
      "deleteOthersMessages",
    ].includes(permission) || manager;
  if (permission === "manageWorkspace" || permission === "createChannel")
    allowed = person.role === "sample-admin";
  let source = "Default";
  let reason = allowed ? "Allowed by default" : "Requires a channel manager";
  const adaptedScope = (
    scope: CommsScopeConfiguration | undefined,
    legacy?: Category | Channel,
  ): CommsScopeConfiguration => {
    const permissions: CommsScopeConfiguration["permissions"] = {};
    if (legacy) {
      const restricted =
        permission === "viewChannel"
          ? legacy.access === "roles"
          : permission === "post"
            ? legacy.posting === "roles"
            : false;
      if (restricted) {
        permissions.everyone = { [permission]: "deny" };
        for (const role of permission === "viewChannel"
          ? legacy.roles
          : legacy.postRoles)
          permissions[`role:${role}`] = { [permission]: "allow" };
      }
    }
    for (const [subject, overrides] of Object.entries(scope?.permissions ?? {}))
      permissions[subject] = { ...permissions[subject], ...overrides };
    return { settings: scope?.settings ?? {}, permissions };
  };
  const layers: [string, CommsScopeConfiguration | undefined][] = [
    ["Workspace", config.workspace],
  ];
  if (channel) {
    const category = categories.find((c) => c.id === channel.categoryId);
    layers.push(
      [
        `Category: ${channel.categoryId}`,
        adaptedScope(
          config.categories[channel.categoryId],
          channel.inherit ? category : undefined,
        ),
      ],
      [
        `Channel: ${channel.id}`,
        adaptedScope(
          config.channels[channel.id],
          !channel.inherit || !category ? channel : undefined,
        ),
      ],
    );
  }
  for (const [label, scope] of layers) {
    if (
      !scope ||
      (label !== "Workspace" && config.lockedPermissions.includes(permission))
    )
      continue;
    for (const subject of [
      "everyone",
      `role:${person.role}`,
      `person:${person.id}`,
    ]) {
      const value = scope.permissions[subject]?.[permission];
      if (value === "allow" || value === "deny") {
        allowed = value === "allow";
        source = `${label} · ${subject}`;
        reason = `${value === "allow" ? "Allowed" : "Denied"} explicitly for ${subject}`;
      }
    }
  }
  return { allowed, source, reason };
}
