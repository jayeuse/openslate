import "server-only";

import type { Session } from "@supabase/supabase-js";
import type { NextResponse } from "next/server";

export const ACCESS_COOKIE = "openslate_access";
export const REFRESH_COOKIE = "openslate_refresh";

const accessMaxAge = 60 * 60;
const refreshMaxAge = 60 * 60 * 24 * 7;

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

export function setAuthCookies(
  response: NextResponse,
  session: Pick<Session, "access_token" | "refresh_token" | "expires_in">,
) {
  response.cookies.set(
    ACCESS_COOKIE,
    session.access_token,
    cookieOptions(Math.max(1, session.expires_in || accessMaxAge)),
  );
  response.cookies.set(
    REFRESH_COOKIE,
    session.refresh_token,
    cookieOptions(refreshMaxAge),
  );
}

export function clearAuthCookies(response: NextResponse) {
  const options = cookieOptions(0);
  response.cookies.set(ACCESS_COOKIE, "", options);
  response.cookies.set(REFRESH_COOKIE, "", options);
}
