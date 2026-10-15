import { expect, test } from "@playwright/test";

import { ApiError } from "../../../src/lib/api";
import { importFailure } from "../../../src/components/systems/platform/helpers/record-import-failure";

// A failed CSV read, preview or import shows one message. An admission
// refusal (mfa_required, ip_not_allowed) or a 401 also asks the shell to check
// the session; the hook queues that check. The http journeys keep the
// administrator message ("Import and export role refusals retain drafts and
// never report creation or download") and the schema-changed message ("Schema
// drift and oversized UTF-8 rows retain the draft without writes").

const fallback = "Import could not be completed.";

const rows: {
  name: string;
  error: unknown;
  message: string;
  recheckSession: boolean;
}[] = [
  {
    name: "mfa_required asks the session check",
    error: new ApiError(403, "Private detail", undefined, "mfa_required"),
    message: "Session access needs to be checked before continuing.",
    recheckSession: true,
  },
  {
    name: "ip_not_allowed asks the session check",
    error: new ApiError(403, "Private detail", undefined, "ip_not_allowed"),
    message: "Session access needs to be checked before continuing.",
    recheckSession: true,
  },
  {
    name: "an admission code wins over a 401",
    error: new ApiError(401, "Private detail", undefined, "mfa_required"),
    message: "Session access needs to be checked before continuing.",
    recheckSession: true,
  },
  {
    name: "a 401 asks the session check",
    error: new ApiError(401, "Private detail"),
    message: "Your session needs to be checked before continuing.",
    recheckSession: true,
  },
  {
    name: "a 403 names the administrator permission",
    error: new ApiError(403, "Private detail"),
    message: "Administrator permission is required to import records.",
    recheckSession: false,
  },
  {
    name: "a 403 wins over schema_changed",
    error: new ApiError(403, "Private detail", undefined, "schema_changed"),
    message: "Administrator permission is required to import records.",
    recheckSession: false,
  },
  {
    name: "schema_changed asks for a new preview",
    error: new ApiError(409, "Private detail", undefined, "schema_changed"),
    message: "Module schema changed; preview again.",
    recheckSession: false,
  },
  {
    name: "a 404 asks for another module",
    error: new ApiError(404, "Private detail"),
    message: "This module is no longer available. Choose another module.",
    recheckSession: false,
  },
  {
    name: "another API error shows its own message",
    error: new ApiError(422, "Row 2 has an invalid quantity."),
    message: "Row 2 has an invalid quantity.",
    recheckSession: false,
  },
  {
    name: "a local error shows its own message",
    error: new Error("The CSV needs a header row."),
    message: "The CSV needs a header row.",
    recheckSession: false,
  },
  {
    name: "a thrown value that is not an error shows the fallback",
    error: "lost",
    message: fallback,
    recheckSession: false,
  },
  {
    name: "an object that only looks like an API error shows the fallback",
    error: { status: 401, code: "mfa_required", message: "Private detail" },
    message: fallback,
    recheckSession: false,
  },
];

for (const row of rows)
  test(`import failure: ${row.name}`, () => {
    expect(importFailure(row.error, fallback)).toEqual({
      message: row.message,
      recheckSession: row.recheckSession,
    });
  });
