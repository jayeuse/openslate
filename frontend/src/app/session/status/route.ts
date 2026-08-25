import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  ACCESS_COOKIE,
  clearAuthCookies,
  REFRESH_COOKIE,
  setAuthCookies,
} from "@/lib/auth-cookies";
import { establishSupabaseSession } from "@/lib/supabase/session";

export async function GET() {
  const store = await cookies();
  const session = await establishSupabaseSession(
    store.get(ACCESS_COOKIE)?.value,
    store.get(REFRESH_COOKIE)?.value,
  ).catch(() => null);
  const response = NextResponse.json(
    { authenticated: session !== null },
    { headers: { "Cache-Control": "no-store" } },
  );
  if (session) setAuthCookies(response, session);
  else clearAuthCookies(response);
  return response;
}
