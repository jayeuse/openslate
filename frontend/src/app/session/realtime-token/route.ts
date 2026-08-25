import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  ACCESS_COOKIE,
  clearAuthCookies,
  REFRESH_COOKIE,
  setAuthCookies,
} from "@/lib/auth-cookies";
import { isSameOriginRequest } from "@/lib/request-security";
import { establishSupabaseSession } from "@/lib/supabase/session";

export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ detail: "Forbidden" }, { status: 403, headers });
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
    return response;
  }

  try {
    const session = await establishSupabaseSession(accessToken, refreshToken);
    if (!session) throw new Error("session refresh failed");

    const response = NextResponse.json(
      { access_token: session.access_token },
      { headers },
    );
    setAuthCookies(response, session);
    return response;
  } catch {
    const response = NextResponse.json(
      { detail: "Session expired" },
      { status: 401, headers },
    );
    clearAuthCookies(response);
    return response;
  }
}
