import { z } from "zod";

import { ApiError, apiFetch } from "@/lib/api";

const passwordChoices = {
  "12 characters + mixed case": [12, true, false],
  "16 characters + mixed case + number": [16, true, true],
  "20-character passphrase": [20, false, false],
} as const;
const timeoutChoices = {
  "15 minutes": 15,
  "30 minutes": 30,
  "60 minutes": 60,
  "8 hours": 480,
} as const;
const mfaChoices = {
  Optional: "optional",
  "Required for administrators": "admins",
  "Required for everyone": "everyone",
} as const;

const securityFields = {
  session_timeout_minutes: z.union([
    z.literal(15),
    z.literal(30),
    z.literal(60),
    z.literal(480),
  ]),
  password_min_length: z.number().int().min(12).max(128),
  password_require_mixed_case: z.boolean(),
  password_require_number: z.boolean(),
  mfa_policy: z.enum(["optional", "admins", "everyone"]),
  ip_allow_list: z.array(z.string().min(1).max(64)).max(100),
};
const securityPolicySchema = z
  .object({ revision: z.number().int().positive(), ...securityFields })
  .refine((policy) =>
    Object.values(passwordChoices).some(
      ([length, mixed, number]) =>
        policy.password_min_length === length &&
        policy.password_require_mixed_case === mixed &&
        policy.password_require_number === number,
    ),
  );
const securityPatchSchema = z
  .object({
    revision: z.number().int().positive(),
    ...z.object(securityFields).partial().shape,
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 1);

export type AccessSecurityPolicy = z.output<typeof securityPolicySchema>;
export type AccessSecurityPatch = z.output<typeof securityPatchSchema>;
export type SecuritySettingsFormFields = {
  password: keyof typeof passwordChoices;
  timeout: keyof typeof timeoutChoices;
  mfa: keyof typeof mfaChoices;
  ips: string;
};
export type SecuritySettingsFormDraft = Partial<SecuritySettingsFormFields>;

export function securitySettingsFormFields(
  policy: AccessSecurityPolicy,
): SecuritySettingsFormFields {
  const password = (
    Object.keys(passwordChoices) as (keyof typeof passwordChoices)[]
  ).find((label) => {
    const [length, mixed, number] = passwordChoices[label];
    return (
      policy.password_min_length === length &&
      policy.password_require_mixed_case === mixed &&
      policy.password_require_number === number
    );
  });
  const timeout = (
    Object.keys(timeoutChoices) as (keyof typeof timeoutChoices)[]
  ).find((label) => timeoutChoices[label] === policy.session_timeout_minutes);
  const mfa = (Object.keys(mfaChoices) as (keyof typeof mfaChoices)[]).find(
    (label) => mfaChoices[label] === policy.mfa_policy,
  );
  if (!password || !timeout || !mfa)
    throw new Error("Account policy could not be read.");
  return { password, timeout, mfa, ips: policy.ip_allow_list.join(", ") };
}

export function securitySettingsPatch(
  policy: AccessSecurityPolicy,
  draft: SecuritySettingsFormDraft,
): AccessSecurityPatch | null {
  const saved = securitySettingsFormFields(policy);
  const patch: AccessSecurityPatch = { revision: policy.revision };
  if (draft.password !== undefined && draft.password !== saved.password) {
    const [length, mixed, number] = passwordChoices[draft.password];
    patch.password_min_length = length;
    patch.password_require_mixed_case = mixed;
    patch.password_require_number = number;
  }
  if (draft.timeout !== undefined && draft.timeout !== saved.timeout)
    patch.session_timeout_minutes = timeoutChoices[draft.timeout];
  if (draft.mfa !== undefined && draft.mfa !== saved.mfa)
    patch.mfa_policy = mfaChoices[draft.mfa];
  if (draft.ips !== undefined) {
    const ips = draft.ips
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (JSON.stringify(ips) !== JSON.stringify(policy.ip_allow_list))
      patch.ip_allow_list = ips;
  }
  return Object.keys(patch).length > 1 ? patch : null;
}

export function getAccessSecurityPolicy(signal?: AbortSignal) {
  return apiFetch("/workspace/security", securityPolicySchema, {
    cache: "no-store",
    signal,
  });
}

export function updateAccessSecurityPolicy(
  patch: AccessSecurityPatch,
  signal?: AbortSignal,
) {
  return apiFetch("/workspace/security", securityPolicySchema, {
    method: "PATCH",
    body: JSON.stringify(securityPatchSchema.parse(patch)),
    signal,
  });
}

export const sessionDeviceSchema = z.enum([
  "Desktop",
  "Mobile",
  "Tablet",
  "Unknown",
]);
const adminSessionSchema = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  person_name: z.string(),
  user_agent: z.string().nullable(),
  device: sessionDeviceSchema,
  browser: z.string(),
  created_at: z.iso.datetime({ offset: true }),
  refreshed_at: z.iso.datetime({ offset: true }),
  expires_at: z.iso.datetime({ offset: true }),
  current: z.boolean(),
});
const adminSessionsSchema = z.object({
  items: z.array(adminSessionSchema),
  pagination: z.object({
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    has_more: z.boolean(),
  }),
});
export type AccessAdminSession = z.output<typeof adminSessionSchema>;
export type AccessAdminSessions = z.output<typeof adminSessionsSchema>;
export type AccessSessionsRequest = {
  limit: number;
  offset: number;
  search: string;
  sort_by: "refreshed_at" | "person_name";
  sort_order: "asc" | "desc";
  status: "all" | "current" | "remote";
  device: "all" | z.output<typeof sessionDeviceSchema>;
};
export const defaultAccessSessionsRequest: AccessSessionsRequest = {
  limit: 4,
  offset: 0,
  search: "",
  sort_by: "refreshed_at",
  sort_order: "desc",
  status: "all",
  device: "all",
};

export function listAccessSessions(
  request: AccessSessionsRequest,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(request))
    params.set(key, String(value));
  return apiFetch(`/auth/admin-sessions?${params}`, adminSessionsSchema, {
    cache: "no-store",
    signal,
  });
}

export function endAccessSession(
  session: AccessAdminSession,
  signal?: AbortSignal,
) {
  return apiFetch(
    `/users/${session.user_id}/sessions/${session.id}`,
    z.null(),
    {
      method: "DELETE",
      signal,
    },
  );
}

export function endAllAccessRemoteSessions(signal?: AbortSignal) {
  return apiFetch("/auth/admin-sessions", z.null(), {
    method: "DELETE",
    signal,
  });
}

const personSecuritySchema = z
  .object({
    user_id: z.uuid(),
    verified_factor_count: z.number().int().nonnegative(),
    target_eligible: z.boolean(),
    smtp_configured: z.boolean(),
  })
  .strict();
const effectIdentity = { operation_id: z.uuid(), user_id: z.uuid() };
const recoveryResponseSchema = z.discriminatedUnion("local_revocation", [
  z
    .object({
      ...effectIdentity,
      email_request: z.literal("accepted"),
      local_revocation: z.literal("not_requested"),
      revoked_sessions: z.null(),
    })
    .strict(),
  z
    .object({
      ...effectIdentity,
      email_request: z.literal("accepted"),
      local_revocation: z.literal("committed"),
      revoked_sessions: z.number().int().nonnegative(),
    })
    .strict(),
]);
const mfaResetResponseSchema = z
  .object({
    ...effectIdentity,
    factors_cleared: z.literal(true),
    local_revocation: z.literal("committed"),
    revoked_sessions: z.number().int().nonnegative(),
  })
  .strict();
const partialSecuritySchema = z.object({
  code: z.literal("security_action_incomplete"),
  operation_id: z.uuid(),
  email_request: z.enum(["not_attempted", "accepted", "unconfirmed"]),
  local_revocation: z.enum(["not_requested", "committed", "unconfirmed"]),
  factors_cleared: z.boolean().nullable(),
});
export type PersonSecurityStatus = z.output<typeof personSecuritySchema>;
export function getPersonSecurity(userId: string, signal?: AbortSignal) {
  return apiFetch(
    `/users/${userId}/security`,
    personSecuritySchema.refine((value) => value.user_id === userId),
    { signal, cache: "no-store", refreshOnUnauthorized: false },
  );
}
export function recoverPerson(
  userId: string,
  revokeSessions: boolean,
  signal?: AbortSignal,
) {
  return apiFetch(
    `/users/${userId}/recovery`,
    recoveryResponseSchema.refine((value) => value.user_id === userId),
    {
      method: "POST",
      signal,
      body: JSON.stringify({ revoke_sessions: revokeSessions }),
      refreshOnUnauthorized: false,
    },
  );
}
export function resetPersonMfa(userId: string, signal?: AbortSignal) {
  return apiFetch(
    `/users/${userId}/mfa/reset`,
    mfaResetResponseSchema.refine((value) => value.user_id === userId),
    {
      method: "POST",
      signal,
      body: JSON.stringify({}),
      refreshOnUnauthorized: false,
    },
  );
}
export function personSecurityPartial(error: unknown) {
  if (!(error instanceof ApiError)) return null;
  const partial = partialSecuritySchema.safeParse(error.details);
  return partial.success ? partial.data : null;
}
