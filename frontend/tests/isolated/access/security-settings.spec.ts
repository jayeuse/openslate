import { expect, test } from "@playwright/test";

import { ApiContractError } from "../../../src/lib/api";
import {
  getAccessSecurityPolicy,
  securitySettingsFormErrors,
  securitySettingsPatch,
  type AccessSecurityPolicy,
  type SecuritySettingsFormDraft,
  type SecuritySettingsFormErrors,
  type SecuritySettingsFormFields,
} from "../../../src/components/systems/access/adapters/security-api";
import { installFetch } from "./fixtures";

// The Account policy dialog's rules, below the http journeys in
// access-security.spec.ts. Those journeys keep one example of each outcome
// with its exact wire body; these tables own the inputs.

// The saved policy of the http fake (helpers/manage-security.ts).
const policy: AccessSecurityPolicy = {
  revision: 1,
  session_timeout_minutes: 60,
  session_absolute_lifetime_minutes: null,
  session_concurrent_limit: null,
  session_retention_days: 365,
  security_event_retention_days: 365,
  password_min_length: 12,
  password_require_mixed_case: true,
  password_require_number: false,
  mfa_require_admin: false,
  mfa_require_member: false,
  mfa_require_guest: false,
  mfa_grace_days: 0,
  login_failed_attempt_threshold: 5,
  login_window_minutes: 15,
  login_cooldown_minutes: 15,
  ip_allow_list: [],
};

// The same policy as the form shows it.
const fields: SecuritySettingsFormFields = {
  minimumLength: "12",
  requireMixedCase: true,
  requireNumber: false,
  timeout: "60 minutes",
  absoluteLifetime: "Off",
  concurrentLimit: "Off",
  sessionRetention: "365",
  eventRetention: "365",
  requireMfaAdmin: false,
  requireMfaMember: false,
  requireMfaGuest: false,
  mfaGrace: "0",
  loginThreshold: "5",
  loginWindow: "15",
  loginCooldown: "15",
  ips: [],
  ipEntry: "",
};

const lifetime = "Lifetime must be a whole number from 1 to 43200.";
const sessions = "Maximum sessions must be a whole number from 1 to 100.";
const grace = "Enrollment grace must be a whole number from 0 to 30.";
const attempts = "Failed attempts must be a whole number from 1 to 100.";
const attemptWindow = "Attempt window must be a whole number from 1 to 1440.";
const lockout = "Lockout duration must be a whole number from 1 to 1440.";
const sessionRetention =
  "Session retention must be a whole number from 1 to 3650.";
const eventRetention =
  "Security event retention must be a whole number from 1 to 3650.";
const passwordLength =
  "Minimum password length must be a whole number from 12 to 128.";
const networks = "Use valid IP addresses or CIDR ranges, up to 100 entries.";

// Valid siblings for the retention rows: the values the http journey saved.
const validLimits: Partial<SecuritySettingsFormFields> = {
  absoluteLifetime: "1",
  concurrentLimit: "1",
  loginThreshold: "100",
  loginWindow: "1",
  loginCooldown: "1",
  sessionRetention: "1",
  eventRetention: "3650",
};

const networkList = (count: number) =>
  Array.from({ length: count }, (_, index) => `10.0.${index}.0/24`);

const formRows: {
  name: string;
  change: Partial<SecuritySettingsFormFields>;
  errors: SecuritySettingsFormErrors;
}[] = [
  { name: "the saved policy is valid", change: {}, errors: {} },
  {
    name: "a limited lifetime needs a value",
    change: { absoluteLifetime: "" },
    errors: { absoluteLifetime: lifetime },
  },
  {
    name: "each numeric field outside its range is named",
    change: {
      absoluteLifetime: "43201",
      concurrentLimit: "101",
      mfaGrace: "-1",
      loginThreshold: "0",
      loginWindow: "1441",
      loginCooldown: "1.5",
      sessionRetention: "0",
      eventRetention: "3651",
    },
    errors: {
      absoluteLifetime: lifetime,
      concurrentLimit: sessions,
      mfaGrace: grace,
      loginThreshold: attempts,
      loginWindow: attemptWindow,
      loginCooldown: lockout,
      sessionRetention,
      eventRetention,
    },
  },
  {
    name: "an exponent is not a whole number",
    change: { loginCooldown: "1e2" },
    errors: { loginCooldown: lockout },
  },
  ...(["", "0", "-1", "1.5", "1e2", "3651"] as const).flatMap((value) => [
    {
      name: `session retention ${JSON.stringify(value)} is refused alone`,
      change: { ...validLimits, sessionRetention: value },
      errors: { sessionRetention },
    },
    {
      name: `security event retention ${JSON.stringify(value)} is refused alone`,
      change: { ...validLimits, eventRetention: value },
      errors: { eventRetention },
    },
  ]),
  {
    name: "every limit at its lower bound is valid",
    change: {
      minimumLength: "12",
      absoluteLifetime: "1",
      concurrentLimit: "1",
      mfaGrace: "0",
      loginThreshold: "1",
      loginWindow: "1",
      loginCooldown: "1",
      sessionRetention: "1",
      eventRetention: "1",
    },
    errors: {},
  },
  {
    name: "every limit at its upper bound is valid",
    change: {
      minimumLength: "128",
      absoluteLifetime: "43200",
      concurrentLimit: "100",
      mfaGrace: "30",
      loginThreshold: "100",
      loginWindow: "1440",
      loginCooldown: "1440",
      sessionRetention: "3650",
      eventRetention: "3650",
    },
    errors: {},
  },
  {
    name: "Off is valid only for the lifetime and the session limit",
    change: {
      absoluteLifetime: "Off",
      concurrentLimit: "Off",
      mfaGrace: "Off",
    },
    errors: { mfaGrace: grace },
  },
  {
    name: "an 11-character password minimum is refused",
    change: { minimumLength: "11" },
    errors: { minimumLength: passwordLength },
  },
  {
    name: "a 129-character password minimum is refused",
    change: { minimumLength: "129" },
    errors: { minimumLength: passwordLength },
  },
  {
    name: "a password minimum must be a whole number",
    change: { minimumLength: "1e2" },
    errors: { minimumLength: passwordLength },
  },
  {
    name: "100 valid address chips are accepted",
    change: { ips: networkList(100) },
    errors: {},
  },
  {
    name: "101 address chips are refused",
    change: { ips: networkList(101) },
    errors: { ips: networks },
  },
  {
    name: "an invalid address chip is refused",
    change: { ips: ["10.0.0.0/8", "not-an-address"] },
    errors: { ips: networks },
  },
  {
    name: "a valid address still in the entry must be added or cleared",
    change: { ipEntry: " 198.51.100.7 " },
    errors: { ipEntry: "Add or clear the address before saving." },
  },
  {
    name: "an invalid address in the entry is named",
    change: { ipEntry: "198.51.100" },
    errors: { ipEntry: "Enter a valid IP address or CIDR range." },
  },
  {
    name: "a blank entry is ignored",
    change: { ipEntry: "   " },
    errors: {},
  },
];

for (const row of formRows)
  test(`security settings form: ${row.name}`, () => {
    expect(securitySettingsFormErrors({ ...fields, ...row.change })).toEqual(
      row.errors,
    );
  });

// A malformed retention value never becomes a default: the read is refused.
const policyRows: { name: string; body: Record<string, unknown> }[] = (
  ["session_retention_days", "security_event_retention_days"] as const
).flatMap((field) =>
  ([undefined, null, false, "365", 365.5, 0, 3651] as const).map((value) => {
    const body: Record<string, unknown> = {
      ...policy,
      session_retention_days: 57,
      security_event_retention_days: 823,
    };
    if (value === undefined) delete body[field];
    else body[field] = value;
    return { name: `${field} ${JSON.stringify(value) ?? "missing"}`, body };
  }),
);

for (const row of policyRows)
  test(`security policy read refuses malformed ${row.name}`, async () => {
    const mock = installFetch(() => Response.json(row.body));
    try {
      await expect(getAccessSecurityPolicy()).rejects.toBeInstanceOf(
        ApiContractError,
      );
      expect(mock.requests).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

test("security policy read keeps separate retention days within 1 to 3650", async () => {
  for (const [sessionDays, eventDays] of [
    [57, 823],
    [1, 3650],
  ]) {
    const body = {
      ...policy,
      session_retention_days: sessionDays,
      security_event_retention_days: eventDays,
    };
    const mock = installFetch(() => Response.json(body));
    try {
      await expect(getAccessSecurityPolicy()).resolves.toEqual(body);
      expect(String(mock.requests[0]?.input)).toBe("/api/workspace/security");
      expect(mock.requests[0]?.init?.cache).toBe("no-store");
    } finally {
      mock.restore();
    }
  }
});

// The policy after the first save of the http journey "independent roles and
// numeric limits save only changed keys, including false zero and Off".
const limited: AccessSecurityPolicy = {
  ...policy,
  revision: 2,
  session_absolute_lifetime_minutes: 43200,
  session_concurrent_limit: 100,
  mfa_require_admin: true,
  mfa_require_guest: true,
  mfa_grace_days: 30,
  login_failed_attempt_threshold: 1,
  login_window_minutes: 1440,
  login_cooldown_minutes: 1440,
};

const patchRows: {
  name: string;
  saved: AccessSecurityPolicy;
  draft: SecuritySettingsFormDraft;
  patch: Record<string, unknown> | null;
}[] = [
  {
    name: "a toggle set back to its saved value sends nothing",
    saved: policy,
    draft: { requireMfaMember: false },
    patch: null,
  },
  {
    name: "every value equal to the saved policy sends nothing",
    saved: policy,
    draft: fields,
    patch: null,
  },
  {
    name: "limits and roles send only the changed keys",
    saved: policy,
    draft: {
      requireMfaMember: false,
      absoluteLifetime: "43200",
      concurrentLimit: "100",
      requireMfaAdmin: true,
      requireMfaGuest: true,
      mfaGrace: "30",
      loginThreshold: "1",
      loginWindow: "1440",
      loginCooldown: "1440",
    },
    patch: {
      revision: 1,
      session_absolute_lifetime_minutes: 43200,
      session_concurrent_limit: 100,
      mfa_require_admin: true,
      mfa_require_guest: true,
      mfa_grace_days: 30,
      login_failed_attempt_threshold: 1,
      login_window_minutes: 1440,
      login_cooldown_minutes: 1440,
    },
  },
  {
    name: "false, zero and Off are sent as values",
    saved: limited,
    draft: {
      requireMfaAdmin: false,
      requireMfaGuest: false,
      mfaGrace: "0",
      absoluteLifetime: "Off",
      concurrentLimit: "Off",
    },
    patch: {
      revision: 2,
      session_absolute_lifetime_minutes: null,
      session_concurrent_limit: null,
      mfa_require_admin: false,
      mfa_require_guest: false,
      mfa_grace_days: 0,
    },
  },
  {
    name: "session retention is sent without event retention",
    saved: policy,
    draft: { sessionRetention: "90", eventRetention: "365" },
    patch: { revision: 1, session_retention_days: 90 },
  },
  {
    name: "event retention is sent without session retention",
    saved: { ...policy, revision: 2, session_retention_days: 90 },
    draft: { sessionRetention: "90", eventRetention: "730" },
    patch: { revision: 2, security_event_retention_days: 730 },
  },
  {
    name: "bounds and retention saved together",
    saved: policy,
    draft: { ...fields, ...validLimits },
    patch: {
      revision: 1,
      session_absolute_lifetime_minutes: 1,
      session_concurrent_limit: 1,
      login_failed_attempt_threshold: 100,
      login_window_minutes: 1,
      login_cooldown_minutes: 1,
      session_retention_days: 1,
      security_event_retention_days: 3650,
    },
  },
  {
    name: "password rules and the timeout choice",
    saved: policy,
    draft: {
      minimumLength: "16",
      requireMixedCase: false,
      requireNumber: true,
      timeout: "8 hours",
    },
    patch: {
      revision: 1,
      password_min_length: 16,
      password_require_mixed_case: false,
      password_require_number: true,
      session_timeout_minutes: 480,
    },
  },
  {
    name: "a member requirement alone",
    saved: policy,
    draft: { requireMfaMember: true },
    patch: { revision: 1, mfa_require_member: true },
  },
  {
    name: "the same address list sends nothing",
    saved: { ...policy, ip_allow_list: ["10.0.0.0/8", "192.0.2.1/32"] },
    draft: { ips: ["10.0.0.0/8", "192.0.2.1/32"] },
    patch: null,
  },
  {
    name: "a reordered address list is a change",
    saved: { ...policy, ip_allow_list: ["10.0.0.0/8", "192.0.2.1/32"] },
    draft: { ips: ["192.0.2.1/32", "10.0.0.0/8"] },
    patch: { revision: 1, ip_allow_list: ["192.0.2.1/32", "10.0.0.0/8"] },
  },
];

for (const row of patchRows)
  test(`security settings patch: ${row.name}`, () => {
    expect(securitySettingsPatch(row.saved, row.draft)).toEqual(row.patch);
  });
