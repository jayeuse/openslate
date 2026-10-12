import { ApiError } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";
import type { personSecurityPartial } from "../adapters/security-api";

// The feedback copy of the person security actions. Each message states only
// what the server confirmed; an unconfirmed email is never offered for resend.

export type PersonSecurityAction = "email" | "revoke" | "reset";
export type PersonSecurityPartial = NonNullable<
  ReturnType<typeof personSecurityPartial>
>;

const unconfirmed =
  "This change may be only partly saved. Check the person's settings, then try again.";

export const sessionsNotReloaded =
  "The change is done, but sessions could not reload. Reload before you do anything else.";

export function personSecuritySuccess(
  action: PersonSecurityAction,
  email: string,
): string {
  return action === "reset"
    ? "Two-step verification reset. They are signed out everywhere."
    : action === "revoke"
      ? `Signed out everywhere. Recovery email sent to ${email}.`
      : `Recovery email sent to ${email}.`;
}

export type PersonSecurityPartialOutcome =
  { sent: true; notice: string } | { sent: false; error: string };

export function personSecurityPartialOutcome(
  action: PersonSecurityAction,
  partial: PersonSecurityPartial,
  email: string,
): PersonSecurityPartialOutcome {
  const signedOut = partial.local_revocation === "committed";
  // A sent email with a known sign-out result is a success, even when
  // the server could not finish its own record of the change.
  const sent =
    action !== "reset" &&
    partial.email_request === "accepted" &&
    partial.local_revocation !== "unconfirmed";
  if (sent) {
    return {
      sent: true,
      notice: signedOut
        ? `Signed out everywhere. Recovery email sent to ${email}.`
        : `Recovery email sent to ${email}.`,
    };
  } else if (action === "reset") {
    return {
      sent: false,
      error: signedOut
        ? partial.factors_cleared === true
          ? "Two-step verification reset. They are signed out everywhere. This change may be only partly saved."
          : "Signed out everywhere. Their authenticator app may not be removed. Check the person's settings, then try again."
        : unconfirmed,
    };
  } else {
    // "unconfirmed" email may have gone out; never invite a blind resend.
    const emailResult =
      partial.email_request === "unconfirmed"
        ? "We could not confirm the recovery email was sent. Ask the person before you send another."
        : "The recovery email did not send. Try again.";
    return {
      sent: false,
      error: signedOut
        ? `Signed out everywhere. ${emailResult}`
        : partial.local_revocation === "not_requested"
          ? emailResult
          : unconfirmed,
    };
  }
}

/** Adds the failed session reload to the shown outcome. */
export function withSessionsReloadFailure(message: string): string {
  const reload = "Sessions could not reload.";
  return message ? `${message} ${reload}` : `${reload} Reload security.`;
}

export function personSecurityFailure(caught: unknown): string {
  return caught instanceof ApiError && caught.status === 401
    ? "Your session must be verified again."
    : apiErrorMessage(
        caught,
        "This change could not be confirmed. Reload security, then try again.",
      );
}
