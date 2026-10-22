import type {
  CategoryPreferences,
  CommsContext,
  MemberPreferences,
  PersonalPreferences,
  Settings,
} from "@/components/systems/comms/contract/types";
import type { MemoryPolicyWorld } from "../memory/model";
import { conversationAccess } from "./access";

export interface NotificationInput {
  world: MemoryPolicyWorld;
  context: CommsContext;
  conversation_id: string;
  shared: Settings;
  personal: PersonalPreferences["notifications"];
  now: number;
  time_zone: string;
  text: string;
  mentioned: boolean;
  followed_thread: boolean;
  preferences?: MemberPreferences;
  category_preferences?: CategoryPreferences;
}

function muted(mute: MemberPreferences["mute"] | undefined, now: number) {
  return (
    mute?.kind === "indefinite" ||
    (mute?.kind === "until" && Date.parse(mute.until) > now)
  );
}

function quiet(
  start: string | undefined,
  end: string | undefined,
  minute: number,
) {
  const time = (value: string | undefined) =>
    value && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
      ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
      : null;
  const a = time(start),
    b = time(end);
  return (
    a !== null &&
    b !== null &&
    a !== b &&
    (a < b ? minute >= a && minute < b : minute >= a || minute < b)
  );
}

export function notificationDecision(input: NotificationInput) {
  const { world, context, shared, personal, preferences, now } = input;
  const person = world.people[context.user_id];
  const conversation = world.conversations[input.conversation_id];
  let reason = "allowed";
  const policies = [shared, { ...shared, ...personal }];
  if (
    world.org_id !== context.org_id ||
    !person?.active ||
    person.org_id !== context.org_id ||
    conversation?.org_id !== context.org_id ||
    conversationAccess(world, context, input.conversation_id).level === "none"
  )
    reason = "no_access";
  else if (
    preferences?.notify === "mute" ||
    muted(preferences?.mute, now) ||
    muted(input.category_preferences?.mute, now)
  )
    reason = "muted";
  else if (policies.some((p) => p.notification_mode === "none"))
    reason = "disabled";
  else if (
    input.followed_thread &&
    policies.some((p) => !p.notify_followed_threads)
  )
    reason = "follow_disabled";
  else if (
    !input.mentioned &&
    (preferences?.notify === "mentions" ||
      policies.some(
        (p) =>
          p.notification_mode === "mentions" &&
          !p.keywords.some(
            (word) =>
              word.trim() &&
              input.text.toLowerCase().includes(word.trim().toLowerCase()),
          ),
      ))
  )
    reason = "mentions_only";
  if (reason === "allowed") {
    try {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: input.time_zone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(now);
      const minute =
        Number(parts.find((p) => p.type === "hour")?.value) * 60 +
        Number(parts.find((p) => p.type === "minute")?.value);
      if (
        policies.some((p) =>
          quiet(p.quiet_hours_start, p.quiet_hours_end, minute),
        )
      )
        reason = "quiet_hours";
    } catch {
      reason = "invalid_time_zone";
    }
  }
  const alertsAllowed = reason === "allowed";
  const allowed = alertsAllowed || reason === "quiet_hours";
  return {
    allowed,
    reason,
    sound: alertsAllowed && policies.every((p) => p.notification_sound),
    badge: allowed && policies.every((p) => p.notification_badges),
    preview:
      reason !== "no_access" && policies.every((p) => p.notification_preview),
    desktop: alertsAllowed && policies.every((p) => p.desktop_notifications),
  };
}
