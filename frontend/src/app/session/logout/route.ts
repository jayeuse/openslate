import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  ACCESS_COOKIE,
  clearAuthCookies,
  REFRESH_COOKIE,
} from "@/lib/auth-cookies";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isSameOriginRequest } from "@/lib/request-security";

export async function POST(request: Request) {
  if (!isSameOriginRequest(request))
    return NextResponse.json({ detail: "Forbidden" }, { status: 403 });
  const store = await cookies();
  const access = store.get(ACCESS_COOKIE)?.value;
  const refresh = store.get(REFRESH_COOKIE)?.value;

  try {
    const supabase = createSupabaseServerClient();
    if (access && refresh) {
      const session = await supabase.auth.setSession({
        access_token: access,
        refresh_token: refresh,
      });
      if (!session.error && session.data.session) {
        await supabase.auth.signOut({ scope: "local" });
      } else if (refresh) {
        const refreshed = await supabase.auth.refreshSession({
          refresh_token: refresh,
        });
        if (!refreshed.error && refreshed.data.session) {
          await supabase.auth.signOut({ scope: "local" });
        }
      }
    } else if (refresh) {
      const session = await supabase.auth.refreshSession({
        refresh_token: refresh,
      });
      if (!session.error && session.data.session) {
        await supabase.auth.signOut({ scope: "local" });
      }
    }
  } catch {
    // Cookie removal is the source of truth for this browser, even if Auth is
    // unavailable while signing out.
  }

  const response = new NextResponse(null, { status: 204 });
  clearAuthCookies(response);
  return response;
}
