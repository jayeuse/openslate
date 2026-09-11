import type { Person } from "../access/model";
import {
  resolveCommsPermission,
  resolveCommsSettings,
  type CommsConfiguration,
  type CommsSettingKey,
} from "./configuration";
import type { Category, Channel } from "./model";
export interface PlatformNotificationPreferences {
  threads: boolean;
  records: boolean;
  digest: boolean;
}
export interface CommsNotificationInput {
  config: CommsConfiguration;
  platformPreferences: PlatformNotificationPreferences;
  person?: Person;
  channel?: Channel;
  categories?: Category[];
  event: {
    kind: "message" | "thread" | "record";
    text: string;
    mentioned?: boolean;
    followedThread?: boolean;
  };
  device?: "desktop" | "mobile";
  now?: number;
}
const notificationKeys: CommsSettingKey[] = [
  "notificationMode",
  "keywords",
  "notifyFollowedThreads",
  "quietHoursStart",
  "quietHoursEnd",
  "notificationSound",
  "notificationBadges",
  "notificationPreview",
  "desktopNotifications",
  "mobileNotifications",
];
export function resolveCommsNotification(input: CommsNotificationInput) {
  const { config, person, channel, categories, event, platformPreferences } =
    input;
  const now = input.now ?? Date.now();
  const settings = resolveCommsSettings(config, channel, categories).values;
  const shared = structuredClone(settings);
  const preferences = person ? config.preferences[person.id] : undefined;
  for (const key of notificationKeys) {
    const value = preferences?.settings[key];
    if (value !== undefined && !config.lockedSettings.includes(key))
      Object.assign(settings, { [key]: value });
  }
  const access = resolveCommsPermission(
    config,
    { person, channel, categories },
    "viewChannel",
  );
  let reason = "";
  if (!access.allowed) reason = access.reason;
  else if (event.kind === "thread" && !platformPreferences.threads)
    reason = "Thread notifications are off in Platform";
  else if (event.kind === "record" && !platformPreferences.records)
    reason = "Record notifications are off in Platform";
  else if (
    [shared, settings].some((policy) => policy.notificationMode === "none")
  )
    reason = "Notifications are off";
  else if (channel && (preferences?.mutedUntil[channel.id] ?? 0) > now)
    reason = "Channel is muted";
  else if (
    (input.device ?? "desktop") === "desktop"
      ? !shared.desktopNotifications || !settings.desktopNotifications
      : !shared.mobileNotifications || !settings.mobileNotifications
  )
    reason = "Notifications are off for this device";
  else if (
    event.kind === "thread" &&
    event.followedThread &&
    (!shared.notifyFollowedThreads || !settings.notifyFollowedThreads)
  )
    reason = "Followed-thread notifications are off";
  else if (
    [shared, settings].some(
      (policy) =>
        policy.notificationMode === "mentions" &&
        !event.mentioned &&
        !policy.keywords.some(
          (word) =>
            word.trim() &&
            event.text.toLowerCase().includes(word.trim().toLowerCase()),
        ),
    )
  )
    reason = "Only mentions and matching keywords notify";
  const time = (value: string) =>
    /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
      ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
      : null;
  const date = new Date(now);
  const minute = date.getHours() * 60 + date.getMinutes();
  if (
    !reason &&
    [shared, settings].some((policy) => {
      const start = time(policy.quietHoursStart),
        end = time(policy.quietHoursEnd);
      return (
        start !== null &&
        end !== null &&
        start !== end &&
        (start < end
          ? minute >= start && minute < end
          : minute >= start || minute < end)
      );
    })
  )
    reason = "Quiet hours are active";
  return {
    allowed: !reason,
    reason: reason || "Notification allowed",
    sound: !reason && shared.notificationSound && settings.notificationSound,
    badge: !reason && shared.notificationBadges && settings.notificationBadges,
    preview: shared.notificationPreview && settings.notificationPreview,
    digest: platformPreferences.digest,
  };
}
export function previewCommsNotification(input: CommsNotificationInput) {
  const result = resolveCommsNotification(input);
  return {
    ...result,
    title: result.preview ? input.event.text : "New OpenComms activity",
  };
}
