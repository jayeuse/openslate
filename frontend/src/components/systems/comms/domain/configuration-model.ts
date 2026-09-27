import type { Person } from "../../shared/data/sample-people";
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
