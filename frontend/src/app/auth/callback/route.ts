import { NextResponse } from "next/server";

import { setAuthCookies } from "@/lib/auth-cookies";
import { withinDeadline } from "@/lib/reliability";
import { beginSessionRoute } from "@/lib/session-response";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function redirectTo(request: Request, path: "/auth/setup" | "/login") {
  const response = NextResponse.redirect(new URL(path, request.url));
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: Request) {
  const sessionRoute = beginSessionRoute("/auth/callback", request.method);
  const { complete, deadline } = sessionRoute;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");

  if ((!code && !tokenHash) || (code && tokenHash)) {
    return complete(redirectTo(request, "/login"), "invalid_callback");
  }

  try {
    const supabase = createSupabaseServerClient(deadline.signal);
    const result = code
      ? await withinDeadline(
          supabase.auth.exchangeCodeForSession(code),
          deadline.signal,
        )
      : type === "invite"
        ? await withinDeadline(
            supabase.auth.verifyOtp({
              token_hash: tokenHash as string,
              type: "invite",
            }),
            deadline.signal,
          )
        : null;

    if (!result || result.error || !result.data.session) {
      return complete(
        redirectTo(request, "/login"),
        "callback_verification_failed",
      );
    }

    const response = redirectTo(request, "/auth/setup");
    setAuthCookies(response, result.data.session);
    return complete(response);
  } catch {
    return complete(
      redirectTo(request, "/login"),
      "callback_provider_unavailable",
    );
  }
}
