import type { SecuritySettingsFormFields } from "../adapters/security-api";

/**
 * The installation defaults of the rare policy settings, as the form shows
 * them. They mirror the column defaults of the platform settings and the
 * organization (`backend/app/systems/manage/workspace/models.py`).
 */
const advancedDefaults = {
  minimumLength: "12",
  requireMixedCase: true,
  requireNumber: false,
  absoluteLifetime: "Off",
  concurrentLimit: "Off",
  sessionRetention: "365",
  eventRetention: "365",
  loginThreshold: "5",
  loginWindow: "15",
  loginCooldown: "15",
} as const satisfies Partial<SecuritySettingsFormFields>;

/**
 * The settings in the policy's Advanced block whose value differs from the
 * default (the Advanced Last Rule): the address list counts once.
 */
export function advancedPolicySetCount(
  fields: SecuritySettingsFormFields,
): number {
  const changed = (
    Object.keys(advancedDefaults) as (keyof typeof advancedDefaults)[]
  ).filter((key) => fields[key] !== advancedDefaults[key]).length;
  return changed + (fields.ips.length > 0 ? 1 : 0);
}

/** The one-line policy summary on the Security page, part by part. */
export function policySummaryParts(
  fields: SecuritySettingsFormFields,
): string[] {
  const roles = [
    fields.requireMfaAdmin ? "administrators" : null,
    fields.requireMfaMember ? "members" : null,
    fields.requireMfaGuest ? "guests" : null,
  ].filter((role): role is string => role !== null);
  const [amount, unit = ""] = fields.timeout.split(" ");
  return [
    `${fields.minimumLength}-character passwords`,
    roles.length === 0
      ? "Two-step optional"
      : roles.length === 3
        ? "Two-step for everyone"
        : `Two-step for ${roles.join(", ")}`,
    `${amount}-${unit.replace(/s$/, "")} timeout`,
    ...(fields.absoluteLifetime !== "Off" && fields.absoluteLifetime !== ""
      ? [`${fields.absoluteLifetime}-minute lifetime`]
      : []),
    ...(fields.concurrentLimit !== "Off" && fields.concurrentLimit !== ""
      ? [`Up to ${fields.concurrentLimit} sessions`]
      : []),
  ];
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The consequence line of End all remote sessions. `more` means the read
 * held only the first page, so the people are a lower bound.
 */
export function endAllSessionsSentence(
  count: { sessions: number; people: number; more: boolean } | null,
): string {
  const stays = "Your current session stays.";
  if (count === null) return `Signs out every other session. ${stays}`;
  const people = plural(count.people, "person", "people");
  return `Signs out ${plural(count.sessions, "session", "sessions")} on ${
    count.more ? "at least " : ""
  }${people}. ${stays}`;
}

type SessionDevice = {
  device: string;
  browser: string;
  ip_address: string | null;
};

function knownParts(session: SessionDevice) {
  return [session.device, session.browser].filter((part) => part !== "Unknown");
}

/** The device in a sentence or a name ("Mobile Chrome", "unknown device"). */
export function sessionDeviceWords(session: SessionDevice): string {
  const parts = knownParts(session);
  return parts.length ? parts.join(" ") : "unknown device";
}

/** The device line of a session row: known parts only, then the address. */
export function sessionDetail(session: SessionDevice): string {
  const parts = knownParts(session);
  return [
    ...(parts.length ? parts : ["Unknown device"]),
    ...(session.ip_address ? [`Sign-in IP: ${session.ip_address}`] : []),
  ].join(" · ");
}
