import { ApiError } from "@/lib/api";

/** The sign-in form's message for a refused or failed sign-in. */
export function loginFailureMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return "That email or password is not right.";
  } else if (error instanceof ApiError && error.status === 429) {
    return error.retryAfter !== undefined
      ? `Too many attempts. Try again in ${Math.max(1, Math.ceil(error.retryAfter / 60))} minutes.`
      : "Too many attempts. Try again later.";
  } else if (error instanceof ApiError && error.status === 503) {
    return "Sign-in is not available now. Try again later.";
  } else if (
    error instanceof ApiError &&
    error.status === 403 &&
    error.code === "ip_not_allowed"
  ) {
    return "Sign-in from this network is not allowed. Contact your administrator.";
  } else {
    return "Unable to sign in. Check your connection and try again.";
  }
}
