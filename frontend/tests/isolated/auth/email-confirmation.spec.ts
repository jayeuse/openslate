import { expect, test } from "@playwright/test";

import { ApiContractError } from "../../../src/lib/api";
import { completeEmailChange } from "../../../src/lib/auth-api";
import { installFetch } from "../access/fixtures";

// An email change completes in two steps: the first link is acknowledged
// without a session (partial), the second one signs the person in (full).
// Any other body is refused whole, so the landing page cannot publish success.
// The http journey keeps one refused body with its alert ("a contradictory
// partial/full response cannot publish confirmation success" in
// auth-email-change.spec.ts).

const proof = "c".repeat(56);
const partial = { authenticated: false, confirmation_required: true };
const full = {
  authenticated: true,
  confirmation_required: false,
  setup_required: false,
};

async function confirm(body: unknown) {
  const mock = installFetch(() => Response.json(body));
  try {
    const result = await completeEmailChange(proof);
    expect(String(mock.requests[0]?.input)).toBe("/api/auth/email/complete");
    expect(mock.requests[0]?.init?.method).toBe("POST");
    expect(mock.requests[0]?.init?.body).toBe(
      JSON.stringify({ token_hash: proof }),
    );
    return result;
  } finally {
    mock.restore();
  }
}

for (const row of [
  { name: "a first-link acknowledgment", body: partial },
  { name: "a final sign-in", body: full },
  {
    name: "a final sign-in that needs account setup",
    body: { ...full, setup_required: true },
  },
]) {
  test(`email confirmation accepts ${row.name}`, async () => {
    await expect(confirm(row.body)).resolves.toEqual(row.body);
  });
}

for (const row of [
  {
    name: "a non-Boolean sign-in flag",
    body: { ...full, authenticated: "false" },
  },
  {
    name: "a sign-in that still asks for confirmation",
    body: { ...full, confirmation_required: true },
  },
  {
    name: "an acknowledgment that asks for no confirmation",
    body: { ...partial, confirmation_required: false },
  },
  {
    name: "an acknowledgment with a setup flag",
    body: { ...partial, setup_required: false },
  },
  {
    name: "a sign-in without its setup flag",
    body: { authenticated: true, confirmation_required: false },
  },
]) {
  test(`email confirmation refuses ${row.name}`, async () => {
    await expect(confirm(row.body)).rejects.toBeInstanceOf(ApiContractError);
  });
}
