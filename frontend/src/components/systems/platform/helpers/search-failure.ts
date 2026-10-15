import { ApiError } from "@/lib/api";

/** An admission refusal on any search card asks the shell to check the session. */
export function isSearchAdmissionError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === "mfa_required" || error.code === "ip_not_allowed")
  );
}

/** The message of a failed search card; an admission refusal on any card wins. */
export function searchFailureMessage(
  error: unknown,
  admissionDenied: boolean,
): string {
  return admissionDenied
    ? "Session access needs to be checked before continuing."
    : error instanceof ApiError && error.status === 403
      ? "You do not have permission to search these results."
      : "Search could not be completed.";
}
