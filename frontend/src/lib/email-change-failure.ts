import { ApiError } from "@/lib/api";

export type EmailChangeFailure = {
  /** The browser is signed in; the link stays unused until an explicit sign-out. */
  signOutRequired: boolean;
  message: string;
};

function errorCode(error: unknown): unknown {
  return error instanceof ApiError &&
    typeof error.details === "object" &&
    error.details !== null &&
    "code" in error.details
    ? error.details.code
    : null;
}

/** Maps a failed email change confirmation. Every failure except a required
 * sign-out spends the one-time link; it is never replayed, even after a 401. */
export function emailChangeFailure(failure: unknown): EmailChangeFailure {
  if (errorCode(failure) === "signed_out_required")
    return {
      signOutRequired: true,
      message: "Sign out explicitly before confirming this email change.",
    };
  return {
    signOutRequired: false,
    message:
      errorCode(failure) === "email_change_incomplete"
        ? "Email confirmation may have completed at the provider, but application completion is incomplete. Sign in again after any address conflict is resolved."
        : failure instanceof ApiError &&
            (failure.status === 400 || failure.status === 401)
          ? "This confirmation link is invalid, expired, or already used. Open a valid link from your email."
          : "The confirmation outcome could not be established. It may have completed at the provider. Sign in again or open the other email link; this request will not be retried.",
  };
}
