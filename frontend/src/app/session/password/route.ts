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
  readLimitedStream,
  withinDeadline,
} from "@/lib/reliability";
import { beginSessionRoute } from "@/lib/session-response";

const backend = process.env.BACKEND_URL ?? "http://localhost:8000";

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
      { status: 401 },
    );
    clearAuthCookies(response);
    return complete(response, "authentication_required");
  }

  let establishedSession: Session | null = null;
  let backendRequestId: string | undefined;
  let backendAttemptStartedAt: number | undefined;
  try {
    const supabase = createSupabaseServerClient(deadline.signal);
    const session = await withinDeadline(
      supabase.auth.setSession({
        access_token: access,
        refresh_token: refresh,
      }),
      deadline.signal,
    );
    if (session.error || !session.data.session)
      throw new Error("session failed");
    establishedSession = session.data.session;

    const updated = await withinDeadline(
      supabase.auth.updateUser({ password: input.data.password }),
      deadline.signal,
    );
    if (updated.error) throw new Error("password update failed");

    backendAttemptStartedAt = Date.now();
    const accepted = await fetch(`${backend}/api/auth/invitations/accept`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${establishedSession.access_token}`,
        "X-Request-ID": requestId,
      },
      cache: "no-store",
      signal: deadline.signal,
    });
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
    if (!accepted.ok) throw new Error("invitation acceptance failed");

    const response = NextResponse.json(
      { authenticated: true },
      { headers: { "Cache-Control": "no-store" } },
    );
    setAuthCookies(response, session.data.session);
    return complete(response, undefined, backendRequestId);
  } catch {
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
    const response = NextResponse.json(
      { detail: "Unable to set password" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
    if (establishedSession) setAuthCookies(response, establishedSession);
    else clearAuthCookies(response);
    return complete(response, "password_update_failed", backendRequestId);
  }
}
