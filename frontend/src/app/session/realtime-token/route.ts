import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  ACCESS_COOKIE,
  clearAuthCookies,
  REFRESH_COOKIE,
  setAuthCookies,
} from "@/lib/auth-cookies";
import { isSameOriginRequest } from "@/lib/request-security";
import { withinDeadline } from "@/lib/reliability";
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
    const session = await withinDeadline(
      establishSupabaseSession(accessToken, refreshToken, deadline.signal),
      deadline.signal,
    );
    if (!session) throw new Error("session refresh failed");

    const response = NextResponse.json(
      { access_token: session.access_token },
      { headers },
    );
    setAuthCookies(response, session);
    return complete(response);
  } catch {
    const response = NextResponse.json(
      { detail: "Session expired" },
      { status: 401, headers },
    );
    clearAuthCookies(response);
    return complete(response, "session_refresh_failed");
  }
}
