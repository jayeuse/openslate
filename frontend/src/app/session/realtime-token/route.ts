import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  ACCESS_COOKIE,
  clearAuthCookies,
  REFRESH_COOKIE,
  setAuthCookies,
} from "@/lib/auth-cookies";
import { isSameOriginRequest } from "@/lib/request-security";
import {
  RequestDeadlineExceededError,
  withinDeadline,
} from "@/lib/reliability";
import { beginSessionRoute } from "@/lib/session-response";
import { establishSupabaseSession } from "@/lib/supabase/session";

export async function GET(request: Request) {
  const sessionRoute = beginSessionRoute(
    "/session/realtime-token",
    request.method,
  );
  const { complete, deadline } = sessionRoute;
  const headers = { "Cache-Control": "no-store" };
  if (!isSameOriginRequest(request)) {
    return complete(
      NextResponse.json({ detail: "Forbidden" }, { status: 403, headers }),
      "same_origin_rejected",
    );
  }

  const store = await cookies();
  const accessToken = store.get(ACCESS_COOKIE)?.value;
  const refreshToken = store.get(REFRESH_COOKIE)?.value;
  if (!refreshToken) {
    const response = NextResponse.json(
      { detail: "Authentication required" },
      { status: 401, headers },
    );
    clearAuthCookies(response);
    return complete(response, "authentication_required");
  }

  try {
    const result = await withinDeadline(
      establishSupabaseSession(accessToken, refreshToken, deadline.signal),
      deadline.signal,
    );
    if (result.kind === "unavailable")
      return complete(
        NextResponse.json(
          { detail: "Authentication service unavailable" },
          { status: 503, headers },
        ),
        result.reason,
      );
    if (result.kind === "invalid") {
      const response = NextResponse.json(
        {
          detail:
            result.reason === "missing_refresh_token"
              ? "Authentication required"
              : "Session expired",
        },
        { status: 401, headers },
      );
      clearAuthCookies(response);
      return complete(response, result.reason);
    }

    const response = NextResponse.json(
      { access_token: result.session.access_token },
      { headers },
    );
    setAuthCookies(response, result.session);
    return complete(response);
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
    const response = NextResponse.json(
      { detail: "Authentication service unavailable" },
      { status: 503, headers },
    );
    return complete(response, "auth_provider_unavailable");
  }
}
