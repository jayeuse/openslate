import { z } from "zod";

import { ApiError, apiFetch } from "@/lib/api";

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
const securityPolicySchema = z.object({
  revision: z.number().int().positive(),
  ...securityFields,
});
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
  minimumLength: string;
  requireMixedCase: boolean;
  requireNumber: boolean;
  timeout: keyof typeof timeoutChoices;
  mfa: keyof typeof mfaChoices;
  ips: string[];
  ipEntry: string;
};
export type SecuritySettingsFormDraft = Partial<SecuritySettingsFormFields>;
export type SecuritySettingsFormErrors = Partial<
  Record<keyof SecuritySettingsFormFields, string>
>;
export type SecuritySettingsChange = <
  K extends keyof SecuritySettingsFormFields,
>(
  key: K,
  value: SecuritySettingsFormFields[K],
) => void;
const networkInputSchema = z
  .string()
  .max(64)
  .pipe(z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()]));

export function validSecurityNetwork(value: string) {
  return networkInputSchema.safeParse(value).success;
}

/** Compare draft chips with a resolved host, including canonical single-host CIDRs. */
export function securityNetworkKey(value: string) {
  if (!validSecurityNetwork(value)) return value;
  const [rawHost, rawPrefix] = value.split("/");
  let host = rawHost;
  let prefix =
    rawPrefix === undefined
      ? host.includes(":")
        ? 128
        : 32
      : Number(rawPrefix);
  if (host.includes(":")) {
    try {
      host = new URL(`http://[${host}]`).hostname.slice(1, -1);
    } catch {
      return value;
    }
    if (host.startsWith("::ffff:") && prefix >= 96) {
      const words = host.slice(7).split(":");
      if (words.length === 2) {
        const high = Number.parseInt(words[0], 16);
        const low = Number.parseInt(words[1], 16);
        host = [high >> 8, high & 255, low >> 8, low & 255].join(".");
        prefix -= 96;
      }
    }
  }
  return `${host}/${prefix}`;
}

export function securitySettingsFormErrors(
  fields: SecuritySettingsFormFields,
): SecuritySettingsFormErrors {
  const errors: SecuritySettingsFormErrors = {};
  if (
    !/^\d{2,3}$/.test(fields.minimumLength) ||
    Number(fields.minimumLength) < 12 ||
    Number(fields.minimumLength) > 128
  )
    errors.minimumLength =
      "Minimum password length must be a whole number from 12 to 128.";
  if (
    fields.ips.length > 100 ||
    fields.ips.some((value) => !validSecurityNetwork(value))
  )
    errors.ips = "Use valid IP addresses or CIDR ranges, up to 100 entries.";
  if (fields.ipEntry.trim())
    errors.ipEntry = validSecurityNetwork(fields.ipEntry.trim())
      ? "Add or clear the address before saving."
      : "Enter a valid IP address or CIDR range.";
  return errors;
}

export function securitySettingsFormFields(
  policy: AccessSecurityPolicy,
): SecuritySettingsFormFields {
  const timeout = (
    Object.keys(timeoutChoices) as (keyof typeof timeoutChoices)[]
  ).find((label) => timeoutChoices[label] === policy.session_timeout_minutes);
  const mfa = (Object.keys(mfaChoices) as (keyof typeof mfaChoices)[]).find(
    (label) => mfaChoices[label] === policy.mfa_policy,
  );
  if (!timeout || !mfa) throw new Error("Account policy could not be read.");
  return {
    minimumLength: String(policy.password_min_length),
    requireMixedCase: policy.password_require_mixed_case,
    requireNumber: policy.password_require_number,
    timeout,
    mfa,
    ips: policy.ip_allow_list,
    ipEntry: "",
  };
}

export function securitySettingsPatch(
  policy: AccessSecurityPolicy,
  draft: SecuritySettingsFormDraft,
): AccessSecurityPatch | null {
  const saved = securitySettingsFormFields(policy);
  const patch: AccessSecurityPatch = { revision: policy.revision };
  if (
    draft.minimumLength !== undefined &&
    draft.minimumLength !== saved.minimumLength
  )
    patch.password_min_length = Number(draft.minimumLength);
  if (
    draft.requireMixedCase !== undefined &&
    draft.requireMixedCase !== saved.requireMixedCase
  )
    patch.password_require_mixed_case = draft.requireMixedCase;
  if (
    draft.requireNumber !== undefined &&
    draft.requireNumber !== saved.requireNumber
  )
    patch.password_require_number = draft.requireNumber;
  if (draft.timeout !== undefined && draft.timeout !== saved.timeout)
    patch.session_timeout_minutes = timeoutChoices[draft.timeout];
  if (draft.mfa !== undefined && draft.mfa !== saved.mfa)
    patch.mfa_policy = mfaChoices[draft.mfa];
  if (draft.ips !== undefined) {
    const ips = draft.ips;
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

export function getAccessCallerIp(signal?: AbortSignal) {
  return apiFetch(
    "/workspace/security/caller-ip",
    z.object({ address: z.union([z.ipv4(), z.ipv6()]) }).strict(),
    { cache: "no-store", signal },
  );
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
