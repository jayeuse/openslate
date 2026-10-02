import { z } from "zod";
import { apiFetch } from "@/lib/api";

const factor = z.object({
  id: z.string().uuid(),
  factor_type: z.string(),
  status: z.enum(["verified", "unverified"]),
});
const status = z.object({
  user_id: z.string().uuid(),
  assurance_level: z.enum(["aal1", "aal2"]),
  required: z.boolean(),
  factors: z.array(factor),
});
const enrollment = z.object({
  id: z.string().uuid(),
  totp: z.object({
    qr_code: z.string().min(1),
    secret: z.string().min(1),
    uri: z.string().min(1),
  }),
});
export type MfaStatus = z.output<typeof status>;
export type MfaEnrollment = z.output<typeof enrollment>;

export function getMfaStatus(signal?: AbortSignal) {
  return apiFetch("/auth/mfa", status, {
    cache: "no-store",
    signal,
    refreshOnUnauthorized: false,
  });
}
export function enrollMfa() {
  return apiFetch("/auth/mfa/factors", enrollment, {
    method: "POST",
    body: JSON.stringify({}),
    refreshOnUnauthorized: false,
  });
}
export function verifyMfa(factorId: string, code: string) {
  return apiFetch(
    `/auth/mfa/factors/${encodeURIComponent(factorId)}/verification`,
    z.object({ verified: z.literal(true), access_token: z.null() }),
    {
      method: "POST",
      body: JSON.stringify({ code }),
      refreshOnUnauthorized: false,
    },
  );
}
export function removeMfa(factorId: string) {
  return apiFetch(
    `/auth/mfa/factors/${encodeURIComponent(factorId)}`,
    z.null(),
    { method: "DELETE", refreshOnUnauthorized: false },
  );
}

export function cancelMfaEnrollment(factorId: string) {
  return apiFetch(
    `/auth/mfa/factors/${encodeURIComponent(factorId)}?unverified_only=true`,
    z.null(),
    { method: "DELETE", refreshOnUnauthorized: false },
  );
}
