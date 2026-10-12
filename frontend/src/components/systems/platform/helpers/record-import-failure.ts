import { ApiError } from "@/lib/api";

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
    return { message: error.message, recheckSession: false };
  }
  return {
    message: error instanceof Error ? error.message : fallback,
    recheckSession: false,
  };
}
