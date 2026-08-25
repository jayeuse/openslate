import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { Session } from "@supabase/supabase-js";

import {
  ACCESS_COOKIE,
  clearAuthCookies,
  REFRESH_COOKIE,
  setAuthCookies,
} from "@/lib/auth-cookies";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isSameOriginRequest } from "@/lib/request-security";

const PasswordSchema = z
  .object({
    password: z.string().min(12).max(1024),
    confirmation: z.string().min(12).max(1024),
  })
  .strict()
  .refine((input) => input.password === input.confirmation, {
    message: "Passwords do not match",
  });

export async function POST(request: Request) {
  if (!isSameOriginRequest(request))
    return NextResponse.json({ detail: "Forbidden" }, { status: 403 });
  const input = PasswordSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!input.success) {
    return NextResponse.json({ detail: "Invalid password" }, { status: 400 });
  }

  const store = await cookies();
  const access = store.get(ACCESS_COOKIE)?.value;
  const refresh = store.get(REFRESH_COOKIE)?.value;
  if (!access || !refresh) {
    const response = NextResponse.json(
      { detail: "Authentication required" },
      { status: 401 },
    );
    clearAuthCookies(response);
    return response;
  }

  let establishedSession: Session | null = null;
  try {
    const supabase = createSupabaseServerClient();
    const session = await supabase.auth.setSession({
      access_token: access,
      refresh_token: refresh,
    });
    if (session.error || !session.data.session)
      throw new Error("session failed");
    establishedSession = session.data.session;

    const updated = await supabase.auth.updateUser({
      password: input.data.password,
    });
    if (updated.error) throw new Error("password update failed");

    const response = NextResponse.json(
      { authenticated: true },
      { headers: { "Cache-Control": "no-store" } },
    );
    setAuthCookies(response, session.data.session);
    return response;
  } catch {
    const response = NextResponse.json(
      { detail: "Unable to set password" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
    if (establishedSession) setAuthCookies(response, establishedSession);
    else clearAuthCookies(response);
    return response;
  }
}
