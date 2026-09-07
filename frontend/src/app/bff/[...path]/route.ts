import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  ACCESS_COOKIE,
  clearAuthCookies,
  REFRESH_COOKIE,
  setAuthCookies,
} from "@/lib/auth-cookies";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isSameOriginRequest } from "@/lib/request-security";

const backend = process.env.BACKEND_URL ?? "http://localhost:8000";
type Params = { params: Promise<{ path: string[] }> };
const invitationAcceptancePath = "auth/invitations/accept";

function forwardHeaders(request: Request, token: string | undefined) {
  const headers = new Headers();
  for (const name of [
    "accept",
    "accept-language",
    "content-type",
    "if-match",
    "if-none-match",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

async function requestBackend(
  request: Request,
  path: string,
  token: string | undefined,
  body: ArrayBuffer | undefined,
) {
  const headers = forwardHeaders(request, token);
  return fetch(`${backend}/api/${path}${new URL(request.url).search}`, {
    method: request.method,
    headers,
    body: body?.slice(0),
    cache: "no-store",
  });
}

async function handle(request: Request, { params }: Params) {
  const { path } = await params;
  if (path.join("/") === invitationAcceptancePath)
    return NextResponse.json({ detail: "Forbidden" }, { status: 403 });

  if (
    !["GET", "HEAD"].includes(request.method) &&
    !isSameOriginRequest(request)
  )
    return NextResponse.json({ detail: "Forbidden" }, { status: 403 });
  const store = await cookies();
  let access = store.get(ACCESS_COOKIE)?.value;
  let refreshedSession = null;
  const backendPath = path
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
  let response = await requestBackend(request, backendPath, access, body);
  if (response.status === 401) {
    const refresh = store.get(REFRESH_COOKIE)?.value;
    if (!refresh) {
      const next = NextResponse.json(
        { detail: "Authentication required" },
        { status: 401 },
      );
      clearAuthCookies(next);
      return next;
    }

    try {
      const supabase = createSupabaseServerClient();
      const refreshed = await supabase.auth.refreshSession({
        refresh_token: refresh,
      });
      refreshedSession = refreshed.data.session;
      if (refreshed.error || !refreshedSession)
        throw new Error("refresh failed");
      access = refreshedSession.access_token;
    } catch {
      const next = NextResponse.json(
        { detail: "Session expired" },
        { status: 401 },
      );
      clearAuthCookies(next);
      return next;
    }

    response = await requestBackend(request, backendPath, access, body);
  }
  const responseBody =
    response.status === 204 ? null : await response.arrayBuffer();
  const next = new NextResponse(responseBody, { status: response.status });
  for (const name of [
    "cache-control",
    "content-disposition",
    "content-type",
    "etag",
    "location",
    "last-modified",
    "vary",
    "www-authenticate",
  ]) {
    const value = response.headers.get(name);
    if (value) next.headers.set(name, value);
  }
  if (response.status === 401) clearAuthCookies(next);
  else if (refreshedSession) setAuthCookies(next, refreshedSession);
  return next;
}

async function handleOptions(_request: Request, { params }: Params) {
  const { path } = await params;
  if (path.join("/") === invitationAcceptancePath)
    return NextResponse.json({ detail: "Forbidden" }, { status: 403 });
  return new NextResponse(null, {
    status: 204,
    headers: {
      Allow: "GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS",
    },
  });
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handleOptions;
