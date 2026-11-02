import { ApiError } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";

export type ImportFailure = { message: string; recheckSession: boolean };

/** Maps a failed CSV read, preview, or import to its message. An admission
 * refusal or a 401 also asks the shell to check the session. */
export function importFailure(error: unknown, fallback: string): ImportFailure {
  if (error instanceof ApiError) {
    if (error.code === "mfa_required" || error.code === "ip_not_allowed")
      return {
        message: "Session access needs to be checked before continuing.",
        recheckSession: true,
      };
    if (error.status === 401)
      return {
        message: "Your session needs to be checked before continuing.",
        recheckSession: true,
      };
    if (error.status === 403)
      return {
        message: "Administrator permission is required to import records.",
        recheckSession: false,
      };
    if (error.code === "schema_changed")
      return {
        message: "Module schema changed; preview again.",
        recheckSession: false,
      };
    if (error.status === 404)
      return {
        message: "This module is no longer available. Choose another module.",
        recheckSession: false,
      };
    // The server's words never show (S1-C6); the shared path says it plainly.
    return { message: apiErrorMessage(error, fallback), recheckSession: false };
  }
  return {
    // A plain `Error` is a local check with its own words; a rejected
    // response or a failed connection takes the shared plain words.
    message:
      error instanceof Error && error.constructor === Error
        ? error.message
        : apiErrorMessage(error, fallback),
    recheckSession: false,
  };
}
