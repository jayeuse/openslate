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
