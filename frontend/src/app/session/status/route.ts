import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  ACCESS_COOKIE,
  clearAuthCookies,
  REFRESH_COOKIE,
  setAuthCookies,
} from "@/lib/auth-cookies";
import { establishSupabaseSession } from "@/lib/supabase/session";
import {
  RequestDeadlineExceededError,
  withinDeadline,
} from "@/lib/reliability";
import { beginSessionRoute } from "@/lib/session-response";

export async function GET(request: Request) {
  const sessionRoute = beginSessionRoute("/session/status", request.method);
  const { complete, deadline } = sessionRoute;
  const store = await cookies();
  const headers = { "Cache-Control": "no-store" };
  let result: Awaited<ReturnType<typeof establishSupabaseSession>>;
  try {
    result = await withinDeadline(
      establishSupabaseSession(
        store.get(ACCESS_COOKIE)?.value,
        store.get(REFRESH_COOKIE)?.value,
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
          { status: 504, headers },
        ),
        "deadline_exceeded",
      );
    return complete(
      NextResponse.json(
        { detail: "Authentication service unavailable" },
        { status: 503, headers },
      ),
      "auth_provider_unavailable",
    );
  }

  if (result.kind === "unavailable")
    return complete(
      NextResponse.json(
        { detail: "Authentication service unavailable" },
        { status: 503, headers },
      ),
      result.reason,
    );

  const response = NextResponse.json(
    result.kind === "valid"
      ? { authenticated: true, userId: result.session.user.id }
      : { authenticated: false },
    { headers },
  );
  if (result.kind === "valid") {
    setAuthCookies(response, result.session);
    return complete(response);
  }
  clearAuthCookies(response);
  return complete(response, result.reason);
}
