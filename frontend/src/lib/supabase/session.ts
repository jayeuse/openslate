import "server-only";

import type { Session } from "@supabase/supabase-js";

import { createSupabaseServerClient } from "@/lib/supabase/server";

const confirmedInvalidErrorCodes = new Set([
  "refresh_token_not_found",
  "refresh_token_already_used",
  "session_expired",
]);

type SessionFailureReason =
  | "missing_refresh_token"
  | "auth_session_missing"
  | "refresh_token_not_found"
  | "refresh_token_already_used"
  | "session_expired"
  | "ambiguous_session"
  | "auth_provider_unavailable";

export type SessionEstablishmentResult =
  | { kind: "valid"; session: Session }
  | { kind: "invalid"; reason: SessionFailureReason }
  | { kind: "unavailable"; reason: SessionFailureReason };

type SessionFailureResult = Extract<
  SessionEstablishmentResult,
  { kind: "invalid" | "unavailable" }
>;

type SupabaseServerClient = ReturnType<typeof createSupabaseServerClient>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function confirmedInvalidReason(error: unknown): SessionFailureReason | null {
  if (!isRecord(error)) return null;
  if (error.name === "AuthSessionMissingError") return "auth_session_missing";
  const code = error.code;
  return typeof code === "string" && confirmedInvalidErrorCodes.has(code)
    ? (code as SessionFailureReason)
    : null;
}

export function classifySupabaseAuthError(
  error: unknown,
): SessionFailureResult {
  const reason = confirmedInvalidReason(error);
  return reason
    ? { kind: "invalid", reason }
    : { kind: "unavailable", reason: "auth_provider_unavailable" };
}

export async function establishSupabaseSession(
  accessToken: string | undefined,
  refreshToken: string | undefined,
  signal?: AbortSignal,
): Promise<SessionEstablishmentResult> {
  if (!refreshToken)
    return { kind: "invalid", reason: "missing_refresh_token" };

  try {
    return await establishSupabaseSessionWithClient(
      createSupabaseServerClient(signal),
      accessToken,
      refreshToken,
      signal,
    );
  } catch (error: unknown) {
    // Let the route's deadline wrapper turn an aborted provider request into a
    // 504. Other thrown provider or transport errors remain recoverable 503s.
    if (signal?.aborted) throw error;
    return classifySupabaseAuthError(error);
  }
}

export async function establishSupabaseSessionWithClient(
  supabase: SupabaseServerClient,
  accessToken: string | undefined,
  refreshToken: string | undefined,
  signal?: AbortSignal,
): Promise<SessionEstablishmentResult> {
  if (!refreshToken)
    return { kind: "invalid", reason: "missing_refresh_token" };

  try {
    const result = accessToken
      ? await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        })
      : await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (result.error) return classifySupabaseAuthError(result.error);
    if (!result.data.session)
      return { kind: "unavailable", reason: "ambiguous_session" };
    return { kind: "valid", session: result.data.session };
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    return classifySupabaseAuthError(error);
  }
}
