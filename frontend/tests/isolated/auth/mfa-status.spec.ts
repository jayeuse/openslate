import { expect, test } from "@playwright/test";

import { ApiContractError } from "../../../src/lib/api";
import { getMfaStatus } from "../../../src/lib/mfa-api";
import { installFetch } from "../access/fixtures";

// The MFA status read is strict: a body with a missing or unsupported policy
// fact is refused whole, so the gate and the Access dialog show "could not
// load" instead of inventing a requirement or a deadline. The http journey
// keeps one invalid body with its Retry ("missing policy fact leaves MFA
// unavailable until a valid fresh Retry" in auth-mfa-policy.spec.ts).

const userId = "00000000-0000-4000-8000-000000000001";
const status = {
  user_id: userId,
  assurance_level: "aal1",
  required: false,
  policy_required: true,
  required_since: "2026-10-01T08:30:00Z",
  enrollment_deadline: "2026-10-08T08:30:00Z",
  factors: [],
};

async function read(body: unknown) {
  const mock = installFetch(() => Response.json(body));
  try {
    const result = await getMfaStatus();
    expect(String(mock.requests[0]?.input)).toBe("/api/auth/mfa");
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
    return result;
  } finally {
    mock.restore();
  }
}

for (const row of [
  { name: "a grace period with UTC dates", body: status },
  {
    name: "a requirement with no recorded episode",
    body: {
      ...status,
      required: true,
      required_since: null,
      enrollment_deadline: null,
    },
  },
  {
    name: "dates with a workspace offset",
    body: {
      ...status,
      required_since: "2026-10-01T16:30:00+08:00",
      enrollment_deadline: "2026-10-08T16:30:00+08:00",
    },
  },
  {
    name: "a verified factor at aal2",
    body: {
      ...status,
      assurance_level: "aal2",
      required: true,
      factors: [
        {
          id: "00000000-0000-4000-8000-000000000501",
          factor_type: "totp",
          status: "verified",
        },
      ],
    },
  },
]) {
  test(`MFA status accepts ${row.name}`, async () => {
    await expect(read(row.body)).resolves.toEqual(row.body);
  });
}

for (const row of [
  {
    name: "a missing policy fact",
    body: {
      user_id: userId,
      assurance_level: "aal1",
      required: false,
      required_since: "2026-10-01T08:30:00Z",
      enrollment_deadline: "2026-10-08T08:30:00Z",
      factors: [],
    },
  },
  {
    name: "a deadline without an offset",
    body: { ...status, enrollment_deadline: "2026-10-08T08:30:00" },
  },
  {
    name: "a start without an offset",
    body: { ...status, required_since: "2026-10-01T08:30:00" },
  },
  { name: "an unknown field", body: { ...status, grace_days: 7 } },
  {
    name: "an unknown assurance level",
    body: { ...status, assurance_level: "aal3" },
  },
  {
    name: "a factor in an unknown state",
    body: {
      ...status,
      factors: [
        {
          id: "00000000-0000-4000-8000-000000000501",
          factor_type: "totp",
          status: "pending",
        },
      ],
    },
  },
]) {
  test(`MFA status refuses ${row.name}`, async () => {
    await expect(read(row.body)).rejects.toBeInstanceOf(ApiContractError);
  });
}
