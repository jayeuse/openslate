import type {
  Bootstrap,
  PersonalPreferences,
  Settings,
} from "../contract/types";

type Mute = Bootstrap["conversations"][number]["preferences"]["mute"];
type NotificationPolicy = Pick<
  Settings,
  | "quiet_hours_start"
  | "quiet_hours_end"
  | "notification_sound"
  | "notification_badges"
  | "notification_preview"
  | "desktop_notifications"
>;

const muteActive = (mute: Mute | undefined, now: number) =>
  mute?.kind === "indefinite" ||
  (mute?.kind === "until" && Date.parse(mute.until) > now);

/** Unread messages the sidebar would badge: muted rows count mentions only. */
export function unreadTotal(bootstrap: Bootstrap, now: number): number {
  let total = 0;
  for (const row of bootstrap.conversations) {
    if (row.preferences.hidden) continue;
    const conversation = row.conversation;
    const category =
      conversation.kind === "channel"
        ? bootstrap.categories.find(
            (item) => item.category.id === conversation.category_id,
          )
        : undefined;
    const muted =
      row.preferences.notify === "mute" ||
      muteActive(row.preferences.mute, now) ||
      muteActive(category?.preferences.mute, now);
    total += muted ? row.mention_count : row.unread_count;
  }
  return total;
}

const clock = (value: string) =>
  /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
    ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
    : null;

function quiet(policy: NotificationPolicy, minute: number) {
  const start = clock(policy.quiet_hours_start),
    end = clock(policy.quiet_hours_end);
  if (start === null || end === null || start === end) return false;
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

/** Minutes since local midnight in the person's regional time zone. */
export function minuteIn(timeZone: string, now: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const part = (type: string) =>
      Number(parts.find((item) => item.type === type)?.value);
    return part("hour") * 60 + part("minute");
  } catch {
    return null;
  }
}

/**
 * Presentation only; the server already wrote no row for muted, disabled,
 * mentions-only or own messages. A personal value never widens the shared one.
 */
export function attentionPolicy(
  shared: NotificationPolicy,
  personal: PersonalPreferences["notifications"],
  minute: number | null,
) {
  const policies = [shared, { ...shared, ...personal }];
  // An unknown regional clock cannot prove that configured quiet hours ended.
  const silent = policies.some((policy) =>
    minute === null
      ? quiet(policy, clock(policy.quiet_hours_start) ?? -1)
      : quiet(policy, minute),
  );
  return {
    desktop:
      !silent && policies.every((policy) => policy.desktop_notifications),
    sound: !silent && policies.every((policy) => policy.notification_sound),
    preview: policies.every((policy) => policy.notification_preview),
    badges: policies.every((policy) => policy.notification_badges),
  };
}
