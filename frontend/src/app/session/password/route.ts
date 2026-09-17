import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { Session } from "@supabase/supabase-js";

import {
  ACCESS_COOKIE,
  clearAuthCookies,
  REFRESH_COOKIE,
  setAuthCookies,
} from "@/lib/auth-cookies";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isSameOriginRequest } from "@/lib/request-security";
import {
  logSafeEvent,
  MAX_JSON_REQUEST_BYTES,
  parseJsonBody,
  PayloadTooLargeError,
  RequestDeadlineExceededError,
  readLimitedStream,
  withinDeadline,
} from "@/lib/reliability";
import { validateRuntimeEnvironment } from "@/lib/environment";
import { beginSessionRoute } from "@/lib/session-response";
import {
  classifySupabaseAuthError,
  establishSupabaseSessionWithClient,
} from "@/lib/supabase/session";

const PasswordSchema = z
  .object({
    password: z.string().min(12).max(1024),
    confirmation: z.string().min(12).max(1024),
  })
  .strict()
  .refine((input) => input.password === input.confirmation, {
    message: "Passwords do not match",
  });

export async function POST(request: Request) {
  const runtime = validateRuntimeEnvironment();
  const sessionRoute = beginSessionRoute("/session/password", request.method);
  const { complete, deadline, requestId } = sessionRoute;
  if (!isSameOriginRequest(request))
    return complete(
      NextResponse.json({ detail: "Forbidden" }, { status: 403 }),
      "same_origin_rejected",
    );
  let body: unknown;
  try {
    body = parseJsonBody(
      await readLimitedStream(
        request.body,
        request.headers,
        MAX_JSON_REQUEST_BYTES,
        deadline.signal,
      ),
    );
  } catch (error) {
    if (error instanceof PayloadTooLargeError)
      return complete(
        NextResponse.json({ detail: "Request is too large" }, { status: 413 }),
        "payload_too_large",
      );
    if (
      error instanceof RequestDeadlineExceededError ||
      deadline.signal.aborted
    )
      return complete(
        NextResponse.json(
          { detail: "Authentication service timed out" },
          { status: 504, headers: { "Cache-Control": "no-store" } },
        ),
        "deadline_exceeded",
      );
    return complete(
      NextResponse.json({ detail: "Invalid password" }, { status: 400 }),
      "invalid_request",
    );
  }
  const input = PasswordSchema.safeParse(body);
  if (!input.success) {
    return complete(
      NextResponse.json({ detail: "Invalid password" }, { status: 400 }),
      "invalid_request",
    );
  }

  const store = await cookies();
  const access = store.get(ACCESS_COOKIE)?.value;
  const refresh = store.get(REFRESH_COOKIE)?.value;
  if (!access || !refresh) {
    const response = NextResponse.json(
      { detail: "Authentication required" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
    clearAuthCookies(response);
    return complete(response, "authentication_required");
  }

  let establishedSession: Session | null = null;
  let backendRequestId: string | undefined;
  let backendAttemptStartedAt: number | undefined;
  try {
    const supabase = createSupabaseServerClient(deadline.signal);
    let established: Awaited<
      ReturnType<typeof establishSupabaseSessionWithClient>
    >;
    try {
      established = await withinDeadline(
        establishSupabaseSessionWithClient(
          supabase,
          access,
          refresh,
          deadline.signal,
        ),
        deadline.signal,
      );
    } catch (error: unknown) {
      if (
        error instanceof RequestDeadlineExceededError ||
        deadline.signal.aborted
      )
        return complete(
          NextResponse.json(
            { detail: "Authentication service timed out" },
            { status: 504, headers: { "Cache-Control": "no-store" } },
          ),
          "deadline_exceeded",
        );
      return complete(
        NextResponse.json(
          { detail: "Authentication service unavailable" },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        ),
        "auth_provider_unavailable",
      );
    }

    if (established.kind === "invalid") {
      const response = NextResponse.json(
        {
          detail:
            established.reason === "missing_refresh_token"
              ? "Authentication required"
              : "Session expired",
        },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
      clearAuthCookies(response);
      return complete(response, established.reason);
    }
    if (established.kind === "unavailable")
      return complete(
        NextResponse.json(
          { detail: "Authentication service unavailable" },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        ),
        established.reason,
      );
    establishedSession = established.session;

    let updated: Awaited<ReturnType<typeof supabase.auth.updateUser>>;
    try {
      updated = await withinDeadline(
        supabase.auth.updateUser({ password: input.data.password }),
        deadline.signal,
      );
    } catch (error: unknown) {
      const uncertain = NextResponse.json(
        {
          detail:
            "Password update outcome is uncertain; sign in to confirm before trying again.",
        },
        {
          status:
            error instanceof RequestDeadlineExceededError ||
            deadline.signal.aborted
              ? 504
              : 503,
          headers: { "Cache-Control": "no-store" },
        },
      );
      setAuthCookies(uncertain, establishedSession);
      return complete(
        uncertain,
        error instanceof RequestDeadlineExceededError || deadline.signal.aborted
          ? "deadline_exceeded"
          : "password_update_uncertain",
      );
    }
    if (updated.error) {
      if (
        updated.error.code === "weak_password" ||
        updated.error.code === "same_password"
      ) {
        const response = NextResponse.json(
          { detail: "Unable to set password" },
          { status: 400, headers: { "Cache-Control": "no-store" } },
        );
        setAuthCookies(response, establishedSession);
        return complete(response, "password_update_rejected");
      }
      const updateFailure = classifySupabaseAuthError(updated.error);
      if (updateFailure.kind === "unavailable") {
        const uncertain = NextResponse.json(
          {
            detail:
              "Password update outcome is uncertain; sign in to confirm before trying again.",
          },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
        setAuthCookies(uncertain, establishedSession);
        return complete(uncertain, "password_update_uncertain");
      }
      if (updateFailure.kind === "invalid") {
        const response = NextResponse.json(
          { detail: "Session expired" },
          { status: 401, headers: { "Cache-Control": "no-store" } },
        );
        clearAuthCookies(response);
        return complete(response, updateFailure.reason);
      }
    }

    backendAttemptStartedAt = Date.now();
    let accepted: Response;
    try {
      accepted = await fetch(
        `${runtime.backendUrl}/api/auth/invitations/accept`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${establishedSession.access_token}`,
            "X-Request-ID": requestId,
          },
          cache: "no-store",
          signal: deadline.signal,
        },
      );
    } catch (error: unknown) {
      logSafeEvent({
        event: "backend_attempt_failed",
        requestId,
        route: "/session/password",
        method: request.method,
        elapsedMs: Date.now() - backendAttemptStartedAt,
        reason: "backend_transport_failed",
      });
      backendAttemptStartedAt = undefined;
      const uncertain = NextResponse.json(
        {
          detail:
            "Password setup outcome is uncertain; sign in to confirm before trying again.",
        },
        {
          status:
            error instanceof RequestDeadlineExceededError ||
            deadline.signal.aborted
              ? 504
              : 503,
          headers: { "Cache-Control": "no-store" },
        },
      );
      setAuthCookies(uncertain, establishedSession);
      return complete(
        uncertain,
        error instanceof RequestDeadlineExceededError || deadline.signal.aborted
          ? "deadline_exceeded"
          : "backend_transport_uncertain",
        backendRequestId,
      );
    }
    backendRequestId = accepted.headers.get("x-request-id") || undefined;
    logSafeEvent({
      event: "backend_attempt_completed",
      requestId,
      backendRequestId,
      route: "/session/password",
      method: request.method,
      status: accepted.status,
      elapsedMs: Date.now() - backendAttemptStartedAt,
    });
    backendAttemptStartedAt = undefined;
    if (!accepted.ok) {
      const response = NextResponse.json(
        { detail: "Password set, but account setup could not be completed" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
      setAuthCookies(response, establishedSession);
      return complete(
        response,
        "invitation_acceptance_rejected",
        backendRequestId,
      );
    }

    const response = NextResponse.json(
      { authenticated: true },
      { headers: { "Cache-Control": "no-store" } },
    );
    setAuthCookies(response, establishedSession);
    return complete(response, undefined, backendRequestId);
  } catch (error: unknown) {
    if (backendAttemptStartedAt !== undefined) {
      logSafeEvent({
        event: "backend_attempt_failed",
        requestId,
        route: "/session/password",
        method: request.method,
        elapsedMs: Date.now() - backendAttemptStartedAt,
        reason: "backend_transport_failed",
      });
    }
    const timedOut =
      error instanceof RequestDeadlineExceededError || deadline.signal.aborted;
    const response = NextResponse.json(
      {
        detail: establishedSession
          ? "Password setup outcome is uncertain; sign in to confirm before trying again."
          : timedOut
            ? "Authentication service timed out"
            : "Authentication service unavailable",
      },
      {
        status: establishedSession
          ? timedOut
            ? 504
            : 503
          : timedOut
            ? 504
            : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
    if (establishedSession) setAuthCookies(response, establishedSession);
    return complete(
      response,
      establishedSession
        ? timedOut
          ? "deadline_exceeded"
          : "password_setup_uncertain"
        : timedOut
          ? "deadline_exceeded"
          : "auth_provider_unavailable",
      backendRequestId,
    );
  }
}
