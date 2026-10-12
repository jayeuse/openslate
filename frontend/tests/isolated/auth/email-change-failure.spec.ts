import { expect, test } from "@playwright/test";

import { ApiError } from "../../../src/lib/api";
import { completeEmailChange } from "../../../src/lib/auth-api";
import { emailChangeFailure } from "../../../src/lib/email-change-failure";
import { installFetch } from "../access/fixtures";

// A failed email change confirmation reads the code from the response detail.
// A required sign-out keeps the link for after an explicit sign-out; every
// other failure spends it and says what is known: an incomplete application
// step, an invalid or used link (400, 401), or an unknown outcome. The http
// journeys keep the signed-in refusal ("${credential} cookie cannot silently
// replace accounts; ..."), the incomplete conflict ("provider-confirmed local
// conflict is application-incomplete, not rollback or authentication") and
// the no-replay checks of 400, 401 and 503 ("${outcome} confirmation is not
// refreshed or automatically replayed and never renders private proof").

const proof = "c".repeat(56);
const invalidLink =
  "This confirmation link is invalid, expired, or already used. Open a valid link from your email.";
const unknownOutcome =
  "The confirmation outcome could not be established. It may have completed at the provider. Sign in again or open the other email link; this request will not be retried.";
const incomplete =
  "Email confirmation may have completed at the provider, but application completion is incomplete. Sign in again after any address conflict is resolved.";

const wireRows: {
  name: string;
  status: number;
  detail: unknown;
  signOutRequired: boolean;
  message: string;
}[] = [
  {
    name: "a required sign-out keeps the link",
    status: 409,
    detail: { code: "signed_out_required", message: "Private detail" },
    signOutRequired: true,
    message: "Sign out explicitly before confirming this email change.",
  },
  {
    name: "an incomplete application step",
    status: 409,
    detail: { code: "email_change_incomplete", message: "Private detail" },
    signOutRequired: false,
    message: incomplete,
  },
  {
    name: "an incomplete code wins over a 400",
    status: 400,
    detail: { code: "email_change_incomplete", message: "Private detail" },
    signOutRequired: false,
    message: incomplete,
  },
  {
    name: "a 400 is an invalid or used link",
    status: 400,
    detail: `Private provider detail ${proof}`,
    signOutRequired: false,
    message: invalidLink,
  },
  {
    name: "a 401 is an invalid or used link",
    status: 401,
    detail: `Private provider detail ${proof}`,
    signOutRequired: false,
    message: invalidLink,
  },
  {
    name: "a 503 has an unknown outcome",
    status: 503,
    detail: `Private provider detail ${proof}`,
    signOutRequired: false,
    message: unknownOutcome,
  },
  {
    name: "another conflict has an unknown outcome",
    status: 409,
    detail: { code: "email_conflict", message: "Private detail" },
    signOutRequired: false,
    message: unknownOutcome,
  },
];

for (const row of wireRows)
  test(`email change failure: ${row.name}`, async () => {
    const mock = installFetch(() =>
      Response.json({ detail: row.detail }, { status: row.status }),
    );
    try {
      const error = await completeEmailChange(proof).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ApiError);
      expect(emailChangeFailure(error)).toEqual({
        signOutRequired: row.signOutRequired,
        message: row.message,
      });
    } finally {
      mock.restore();
    }
  });

const valueRows: {
  name: string;
  error: unknown;
  signOutRequired: boolean;
  message: string;
}[] = [
  {
    name: "the code is read from the response detail",
    error: new ApiError(409, "Private", { code: "signed_out_required" }),
    signOutRequired: true,
    message: "Sign out explicitly before confirming this email change.",
  },
  {
    name: "a code outside the response detail is not read",
    error: new ApiError(409, "Private", "text detail", "signed_out_required"),
    signOutRequired: false,
    message: unknownOutcome,
  },
  {
    name: "a network failure has an unknown outcome",
    error: new TypeError("Failed to fetch"),
    signOutRequired: false,
    message: unknownOutcome,
  },
  {
    name: "an object that only looks like an API error has an unknown outcome",
    error: { status: 401, details: { code: "signed_out_required" } },
    signOutRequired: false,
    message: unknownOutcome,
  },
];

for (const row of valueRows)
  test(`email change failure: ${row.name}`, () => {
    expect(emailChangeFailure(row.error)).toEqual({
      signOutRequired: row.signOutRequired,
      message: row.message,
    });
  });
