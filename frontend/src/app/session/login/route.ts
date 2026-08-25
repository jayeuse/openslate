import { NextResponse } from "next/server";
import { z } from "zod";

import { setAuthCookies } from "@/lib/auth-cookies";
import { isSameOriginRequest } from "@/lib/request-security";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const LoginSchema = z
  .object({
    email: z.string().trim().email().max(320),
    password: z.string().min(1).max(1024),
  })
  .strict();

export async function POST(request: Request) {
  if (!isSameOriginRequest(request))
    return NextResponse.json({ detail: "Forbidden" }, { status: 403 });
  const input = LoginSchema.safeParse(await request.json().catch(() => null));
  if (!input.success)
    return NextResponse.json(
      { detail: "Invalid sign-in request" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );

  try {
    const supabase = createSupabaseServerClient();
    const { data, error } = await supabase.auth.signInWithPassword(input.data);
    if (error || !data.session) {
      return NextResponse.json(
        { detail: "Invalid email or password" },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }

    const response = NextResponse.json(
      { authenticated: true },
      { headers: { "Cache-Control": "no-store" } },
    );
    setAuthCookies(response, data.session);
    return response;
  } catch {
    return NextResponse.json(
      { detail: "Unable to sign in" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
