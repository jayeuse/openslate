import type {
  AccountSession,
  SignInEvent,
} from "@/components/systems/platform/adapters/account-api";
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

/**
 * The end-session confirmation names the device it signs out (PD60):
 * "End the session on Safari, macOS?".
 */
export function endSessionTitle(userAgent: string | null): string {
  const device = accountDeviceLabel(userAgent);
  return device === "Unknown device"
    ? "End the session on an unknown device?"
    : `End the session on ${device.replace(" on ", ", ")}?`;
}

const SIGN_IN_SENTENCES: Readonly<
  Record<
    SignInEvent["kind"],
    { sentence: string; tone: "muted" | "danger" | "warn" }
  >
> = {
  signed_in: { sentence: "Signed in", tone: "muted" },
  sign_in_failed: { sentence: "Sign-in failed", tone: "danger" },
  locked_out: {
    sentence: "Sign-in paused after too many failed attempts",
    tone: "warn",
  },
  // The contract stores no ender, so D9.2's fallback words apply to all.
  session_ended: { sentence: "Session ended", tone: "muted" },
};

export type SignInEventWords = {
  /** Unique as `kind:id`: a session's sign-in and its end share the id. */
  key: string;
  kind: SignInEvent["kind"];
  sentence: string;
  tone: "muted" | "danger" | "warn";
  device: string;
  /** The full user agent, as the device name's title. */
  userAgent: string | null;
  address: string;
  time: string;
};

/** One row of Your sign-in history (D9.2). */
export function signInEventWords(
  event: SignInEvent,
  region: WorkspaceRegion | undefined,
): SignInEventWords {
  let time = "Time unavailable";
  if (region && !Number.isNaN(new Date(event.occurred_at).getTime()))
    try {
      time = formatWorkspaceDateTime(event.occurred_at, region);
    } catch {
      // An unsupported zone or locale keeps "Time unavailable".
    }
  return {
    key: `${event.kind}:${event.id}`,
    kind: event.kind,
    ...SIGN_IN_SENTENCES[event.kind],
    device: accountDeviceLabel(event.user_agent),
    userAgent: event.user_agent,
    address: event.ip_address ?? "Unknown address",
    time,
  };
}
