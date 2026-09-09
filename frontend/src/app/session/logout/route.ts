import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  ACCESS_COOKIE,
  clearAuthCookies,
  REFRESH_COOKIE,
} from "@/lib/auth-cookies";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isSameOriginRequest } from "@/lib/request-security";
import { withinDeadline } from "@/lib/reliability";
import { beginSessionRoute } from "@/lib/session-response";

export async function POST(request: Request) {
  const sessionRoute = beginSessionRoute("/session/logout", request.method);
  const { complete, deadline } = sessionRoute;
  if (!isSameOriginRequest(request))
    return complete(
      NextResponse.json({ detail: "Forbidden" }, { status: 403 }),
      "same_origin_rejected",
    );
  const store = await cookies();
  const access = store.get(ACCESS_COOKIE)?.value;
  const refresh = store.get(REFRESH_COOKIE)?.value;

  try {
    const supabase = createSupabaseServerClient(deadline.signal);
    if (access && refresh) {
      const session = await withinDeadline(
        supabase.auth.setSession({
          access_token: access,
          refresh_token: refresh,
        }),
        deadline.signal,
      );
      if (!session.error && session.data.session) {
        await withinDeadline(
          supabase.auth.signOut({ scope: "local" }),
          deadline.signal,
        );
      } else if (refresh) {
        const refreshed = await withinDeadline(
          supabase.auth.refreshSession({ refresh_token: refresh }),
          deadline.signal,
        );
        if (!refreshed.error && refreshed.data.session) {
          await withinDeadline(
            supabase.auth.signOut({ scope: "local" }),
            deadline.signal,
          );
        }
      }
    } else if (refresh) {
      const session = await withinDeadline(
        supabase.auth.refreshSession({ refresh_token: refresh }),
        deadline.signal,
      );
      if (!session.error && session.data.session) {
        await withinDeadline(
          supabase.auth.signOut({ scope: "local" }),
          deadline.signal,
        );
      }
    }
  } catch {
    // Cookie removal is the source of truth for this browser, even if Auth is
    // unavailable while signing out.
  }

  const response = new NextResponse(null, { status: 204 });
  clearAuthCookies(response);
  return complete(response);
}
