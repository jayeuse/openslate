import type { AccountSession } from "@/components/systems/platform/adapters/account-api";
import {
  formatWorkspaceDateTime,
  type WorkspaceRegion,
} from "@/lib/date-time-display";

/** "Chrome on Windows" from a user agent, or "Unknown device". */
export function accountDeviceLabel(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";

  const browser = /\b(?:Edg|EdgA|EdgiOS|Edge)(?:\/|\b)/i.test(userAgent)
    ? "Edge"
    : /\b(?:Chrome|CriOS)(?:\/|\b)/i.test(userAgent)
      ? "Chrome"
      : /\b(?:Firefox|FxiOS)(?:\/|\b)/i.test(userAgent)
        ? "Firefox"
        : /\bSafari(?:\/|\b)/i.test(userAgent)
          ? "Safari"
          : null;
  const platform = /\bAndroid\b/i.test(userAgent)
    ? "Android"
    : /\biPadOS\b/i.test(userAgent) || /\biPad\b/i.test(userAgent)
      ? "iPadOS"
      : /\b(?:iPhone|iPod|iOS)\b/i.test(userAgent)
        ? "iOS"
        : /\b(?:Macintosh|Mac OS X|macOS)\b/i.test(userAgent)
          ? "macOS"
          : /\bWindows\b/i.test(userAgent)
            ? "Windows"
            : /\bLinux\b/i.test(userAgent)
              ? "Linux"
              : null;

  return browser && platform ? `${browser} on ${platform}` : "Unknown device";
}

export type SessionRowWords = {
  device: string;
  /** The sign-in address, or null when the server has none. */
  address: string | null;
  /** The session of this browser. */
  here: boolean;
  /** When the session was last active, in the person's formats. */
  active: string;
  /** The ⋯ menu trigger and its End session item, named for the device. */
  actionsLabel: string;
  endLabel: string;
};

/** The words of one 40px session row (PD11). */
export function sessionRowWords(
  session: AccountSession,
  region: WorkspaceRegion | undefined,
): SessionRowWords {
  const device = accountDeviceLabel(session.user_agent);
  const named = session.current ? `${device}, this device` : device;
  let active = "Time unavailable";
  if (region && !Number.isNaN(new Date(session.refreshed_at).getTime()))
    try {
      active = formatWorkspaceDateTime(session.refreshed_at, region);
    } catch {
      // An unsupported zone or locale keeps "Time unavailable".
    }
  return {
    device,
    address: session.ip_address,
    here: session.current,
    active,
    actionsLabel: `Session actions, ${named}`,
    endLabel: `End session, ${named}`,
  };
}
