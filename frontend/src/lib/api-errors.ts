import { ApiContractError, ApiError } from "@/lib/api";

/** Present authored action copy, never untrusted response messages or details. */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiContractError)
    return "The server returned an unexpected response. Refresh and try again.";
  if (error instanceof TypeError)
    return "Could not connect. Check your connection and try again.";
  if (error instanceof ApiError) {
    if (error.status === 503 && error.code === "relationship_busy")
      return "Relationships are temporarily unavailable. Refresh and try again.";
    switch (error.status) {
      case 401:
        return "Your session expired. Sign in again.";
      case 403:
        return "You do not have permission to perform this action.";
      case 404:
        return "This item is no longer available. Refresh and try again.";
      case 409:
        if (error.code === "version_limit")
          return "Version history is full. Delete old checkpoints in History.";
        return "This item changed. Refresh it and try again.";
      case 422:
        return "Check the entered values and try again.";
      case 429:
        return "Too many requests. Wait a moment and try again.";
      case 503:
        return "This service is temporarily unavailable. Try again.";
    }
  }
  return fallback;
}

/**
 * The full request ID of a failed request, shown as its error reference (R5,
 * docs/specs/system-health.md). Failures that never reached the server (a
 * failed fetch, an abort, a browser check) have none.
 */
export function apiErrorReference(error: unknown): string | undefined {
  if (error instanceof ApiError || error instanceof ApiContractError)
    return error.requestId;
  return undefined;
}

/** An API error's message and reference, kept together until they render. */
export type ApiErrorText = { message: string; reference: string | undefined };

export function apiErrorText(error: unknown, fallback: string): ApiErrorText {
  return {
    message: apiErrorMessage(error, fallback),
    reference: apiErrorReference(error),
  };
}

/**
 * A screen's error state: the words it shows and, when `cause` is a failed
 * request, that request's reference (D1.6). An empty message clears it.
 */
export function errorTextFor(
  message: string,
  cause?: unknown,
): ApiErrorText | null {
  return message ? { message, reference: apiErrorReference(cause) } : null;
}
