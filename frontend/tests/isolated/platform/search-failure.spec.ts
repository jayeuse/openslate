import { expect, test } from "@playwright/test";

import { ApiError } from "../../../src/lib/api";
import {
  isSearchAdmissionError,
  searchFailureMessage,
} from "../../../src/components/systems/platform/helpers/search-failure";

// An admission refusal on any search card asks the shell to check the
// session, and every failed card then shows the session message. Otherwise a
// 403 card hides its denial behind a permission message and any other failure
// shows a generic one. The http journey "Search ignores old replies, hides
// denial and recovers with explicit retry" keeps the 403 alert and its Retry.

const admissionRows: { name: string; error: unknown; denied: boolean }[] = [
  {
    name: "mfa_required",
    error: new ApiError(403, "Private detail", undefined, "mfa_required"),
    denied: true,
  },
  {
    name: "ip_not_allowed",
    error: new ApiError(403, "Private detail", undefined, "ip_not_allowed"),
    denied: true,
  },
  { name: "a plain 403", error: new ApiError(403, "Denied"), denied: false },
  { name: "a 401", error: new ApiError(401, "Expired"), denied: false },
  { name: "no error", error: null, denied: false },
  {
    name: "an object that only looks like an API error",
    error: { status: 403, code: "mfa_required" },
    denied: false,
  },
];

for (const row of admissionRows)
  test(`search admission: ${row.name} ${row.denied ? "asks" : "does not ask"} the session check`, () => {
    expect(isSearchAdmissionError(row.error)).toBe(row.denied);
  });

const messageRows: {
  name: string;
  error: unknown;
  admissionDenied: boolean;
  message: string;
}[] = [
  {
    name: "an admission refusal on any card wins over this card's 403",
    error: new ApiError(403, "Denied"),
    admissionDenied: true,
    message: "Session access needs to be checked before continuing.",
  },
  {
    name: "an admission refusal on another card replaces this card's results",
    error: null,
    admissionDenied: true,
    message: "Session access needs to be checked before continuing.",
  },
  {
    name: "a 403 hides the denial",
    error: new ApiError(403, "Private denial detail"),
    admissionDenied: false,
    message: "You do not have permission to search these results.",
  },
  {
    name: "another API error is generic",
    error: new ApiError(500, "Private failure detail"),
    admissionDenied: false,
    message: "Search could not be completed.",
  },
  {
    name: "a network error is generic",
    error: new TypeError("Failed to fetch"),
    admissionDenied: false,
    message: "Search could not be completed.",
  },
];

for (const row of messageRows)
  test(`search failure: ${row.name}`, () => {
    expect(searchFailureMessage(row.error, row.admissionDenied)).toBe(
      row.message,
    );
  });
