import { expect, test } from "@playwright/test";

import { ApiContractError, ApiError } from "../../../src/lib/api";
import { personSecurityPartial } from "../../../src/components/systems/access/adapters/security-api";
import {
  personSecurityFailure,
  personSecurityPartialOutcome,
  personSecuritySuccess,
  sessionsNotReloaded,
  withSessionsReloadFailure,
  type PersonSecurityAction,
} from "../../../src/components/systems/access/helpers/person-security-outcome";

// Person security feedback states only what the server confirmed. A partial
// result is a success notice when the email was accepted and the sign-out
// result is known; otherwise it is an alert that names the confirmed sign-out,
// never invites a blind resend of an unconfirmed email, and says "partly
// saved" when the sign-out itself is unconfirmed. The http journeys keep one
// sent and one failed partial ("partial feedback: ${state.name}"), the
// session read-back ("partial revocation is truthful and performs session
// read-back without replay"), the 401 verification and the reset command.

const email = "ana@example.com";
const unconfirmed =
  "This change may be only partly saved. Check the person's settings, then try again.";

function partial(
  email_request: "not_attempted" | "accepted" | "unconfirmed",
  local_revocation: "not_requested" | "committed" | "unconfirmed",
  factors_cleared: boolean | null = null,
) {
  const parsed = personSecurityPartial(
    new ApiError(503, "Private diagnostic", {
      code: "security_action_incomplete",
      operation_id: "00000000-0000-4000-8000-000000000900",
      email_request,
      local_revocation,
      factors_cleared,
      message: "Private diagnostic",
    }),
  );
  if (!parsed) throw new Error("The partial result fixture must parse");
  return parsed;
}

const partialRows: {
  name: string;
  action: PersonSecurityAction;
  partial: ReturnType<typeof partial>;
  outcome: ReturnType<typeof personSecurityPartialOutcome>;
}[] = [
  {
    name: "an accepted email without a sign-out is sent",
    action: "email",
    partial: partial("accepted", "not_requested"),
    outcome: { sent: true, notice: "Recovery email sent to ana@example.com." },
  },
  {
    name: "an accepted email with a committed sign-out is sent",
    action: "revoke",
    partial: partial("accepted", "committed"),
    outcome: {
      sent: true,
      notice: "Signed out everywhere. Recovery email sent to ana@example.com.",
    },
  },
  {
    name: "an accepted email with an unconfirmed sign-out is partly saved",
    action: "revoke",
    partial: partial("accepted", "unconfirmed"),
    outcome: { sent: false, error: unconfirmed },
  },
  {
    name: "a committed sign-out with an unsent email",
    action: "revoke",
    partial: partial("not_attempted", "committed"),
    outcome: {
      sent: false,
      error:
        "Signed out everywhere. The recovery email did not send. Try again.",
    },
  },
  {
    name: "a committed sign-out with an unconfirmed email never invites a resend",
    action: "revoke",
    partial: partial("unconfirmed", "committed"),
    outcome: {
      sent: false,
      error:
        "Signed out everywhere. We could not confirm the recovery email was sent. Ask the person before you send another.",
    },
  },
  {
    name: "an unsent email without a sign-out",
    action: "email",
    partial: partial("not_attempted", "not_requested"),
    outcome: {
      sent: false,
      error: "The recovery email did not send. Try again.",
    },
  },
  {
    name: "an unconfirmed email without a sign-out never invites a resend",
    action: "email",
    partial: partial("unconfirmed", "not_requested"),
    outcome: {
      sent: false,
      error:
        "We could not confirm the recovery email was sent. Ask the person before you send another.",
    },
  },
  {
    name: "an unsent email with an unconfirmed sign-out is partly saved",
    action: "revoke",
    partial: partial("not_attempted", "unconfirmed"),
    outcome: { sent: false, error: unconfirmed },
  },
  {
    name: "a reset that signed out and cleared the factors is partly saved",
    action: "reset",
    partial: partial("not_attempted", "committed", true),
    outcome: {
      sent: false,
      error:
        "Two-step verification reset. They are signed out everywhere. This change may be only partly saved.",
    },
  },
  {
    name: "a reset that signed out but did not clear the factors",
    action: "reset",
    partial: partial("not_attempted", "committed", false),
    outcome: {
      sent: false,
      error:
        "Signed out everywhere. Their authenticator app may not be removed. Check the person's settings, then try again.",
    },
  },
  {
    name: "a reset that signed out with unknown factors",
    action: "reset",
    partial: partial("not_attempted", "committed", null),
    outcome: {
      sent: false,
      error:
        "Signed out everywhere. Their authenticator app may not be removed. Check the person's settings, then try again.",
    },
  },
  {
    name: "a reset with an unconfirmed sign-out is partly saved",
    action: "reset",
    partial: partial("not_attempted", "unconfirmed", true),
    outcome: { sent: false, error: unconfirmed },
  },
  {
    name: "a reset is never an email success",
    action: "reset",
    partial: partial("accepted", "committed", true),
    outcome: {
      sent: false,
      error:
        "Two-step verification reset. They are signed out everywhere. This change may be only partly saved.",
    },
  },
];

for (const row of partialRows)
  test(`person security partial: ${row.name}`, () => {
    expect(
      personSecurityPartialOutcome(row.action, row.partial, email),
    ).toEqual(row.outcome);
  });

for (const [action, notice] of [
  ["email", "Recovery email sent to ana@example.com."],
  ["revoke", "Signed out everywhere. Recovery email sent to ana@example.com."],
  ["reset", "Two-step verification reset. They are signed out everywhere."],
] as const)
  test(`person security success: ${action}`, () => {
    expect(personSecuritySuccess(action, email)).toBe(notice);
  });

test("a finished change whose sessions do not reload asks for a reload first", () => {
  expect(sessionsNotReloaded).toBe(
    "The change is done, but sessions could not reload. Reload before you do anything else.",
  );
});

for (const [shown, combined] of [
  ["", "Sessions could not reload. Reload security."],
  [
    unconfirmed,
    "This change may be only partly saved. Check the person's settings, then try again. Sessions could not reload.",
  ],
] as const)
  test(`a partial result whose sessions do not reload: ${shown ? "after an alert" : "alone"}`, () => {
    expect(withSessionsReloadFailure(shown)).toBe(combined);
  });

const failureRows: { name: string; error: unknown; message: string }[] = [
  {
    name: "a 401 asks for session verification",
    error: new ApiError(401, "Expired"),
    message: "Your session must be verified again.",
  },
  {
    name: "a 403 is a permission refusal",
    error: new ApiError(403, "Private"),
    message: "You do not have permission to perform this action.",
  },
  {
    name: "a lost connection",
    error: new TypeError("Failed to fetch"),
    message: "Could not connect. Check your connection and try again.",
  },
  {
    name: "a malformed reply",
    error: new ApiContractError(),
    message:
      "The server returned an unexpected response. Refresh and try again.",
  },
  {
    name: "a server error is not confirmed",
    error: new ApiError(500, "Private"),
    message:
      "This change could not be confirmed. Reload security, then try again.",
  },
  {
    name: "an object that only looks like a 401 is not confirmed",
    error: { status: 401 },
    message:
      "This change could not be confirmed. Reload security, then try again.",
  },
  {
    name: "an unknown failure is not confirmed",
    error: new Error("Private"),
    message:
      "This change could not be confirmed. Reload security, then try again.",
  },
];

for (const row of failureRows)
  test(`person security failure: ${row.name}`, () => {
    expect(personSecurityFailure(row.error)).toBe(row.message);
  });
