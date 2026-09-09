import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  ACCESS_COOKIE,
  clearAuthCookies,
  REFRESH_COOKIE,
  setAuthCookies,
} from "@/lib/auth-cookies";
import { establishSupabaseSession } from "@/lib/supabase/session";
import { withinDeadline } from "@/lib/reliability";
import { beginSessionRoute } from "@/lib/session-response";

export async function GET(request: Request) {
  const sessionRoute = beginSessionRoute("/session/status", request.method);
  const { complete, deadline } = sessionRoute;
  const store = await cookies();
  const session = await withinDeadline(
    establishSupabaseSession(
      store.get(ACCESS_COOKIE)?.value,
      store.get(REFRESH_COOKIE)?.value,
      deadline.signal,
    ),
    deadline.signal,
  ).catch(() => null);
  const response = NextResponse.json(
    { authenticated: session !== null },
    { headers: { "Cache-Control": "no-store" } },
  );
  if (session) setAuthCookies(response, session);
  else clearAuthCookies(response);
  return complete(response, session ? undefined : "unauthenticated");
}
