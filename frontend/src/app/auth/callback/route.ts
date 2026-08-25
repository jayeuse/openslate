import { NextResponse } from "next/server";

import { setAuthCookies } from "@/lib/auth-cookies";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function redirectTo(request: Request, path: "/auth/setup" | "/login") {
  const response = NextResponse.redirect(new URL(path, request.url));
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");

  if ((!code && !tokenHash) || (code && tokenHash)) {
    return redirectTo(request, "/login");
  }

  try {
    const supabase = createSupabaseServerClient();
    const result = code
      ? await supabase.auth.exchangeCodeForSession(code)
      : type === "invite"
        ? await supabase.auth.verifyOtp({
            token_hash: tokenHash as string,
            type: "invite",
          })
        : null;

    if (!result || result.error || !result.data.session) {
      return redirectTo(request, "/login");
    }

    const response = redirectTo(request, "/auth/setup");
    setAuthCookies(response, result.data.session);
    return response;
  } catch {
    return redirectTo(request, "/login");
  }
}
