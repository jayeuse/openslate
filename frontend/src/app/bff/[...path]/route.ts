import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const backend = process.env.BACKEND_URL ?? "http://localhost:8000";
type Params = { params: Promise<{ path: string[] }> };

async function requestBackend(
  request: Request,
  path: string,
  token: string | undefined,
  body: ArrayBuffer | undefined,
) {
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cookie");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${backend}/api/${path}`, {
    method: request.method,
    headers,
    body,
    cache: "no-store",
  });
}

async function handle(request: Request, { params }: Params) {
  const { path } = await params;
  const store = await cookies();
  let access = store.get("openslate_access")?.value;
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
  let response = await requestBackend(request, path.join("/"), access, body);
  if (response.status === 401) {
    const refresh = store.get("openslate_refresh")?.value;
    if (!refresh)
      return NextResponse.json(
        { detail: "Authentication required" },
        { status: 401 },
      );
    const refreshResponse = await fetch(`${backend}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    const refreshed: unknown = await refreshResponse.json().catch(() => null);
    if (
      !refreshResponse.ok ||
      typeof refreshed !== "object" ||
      refreshed === null ||
      !("access_token" in refreshed) ||
      !("refresh_token" in refreshed)
    ) {
      store.delete("openslate_access");
      store.delete("openslate_refresh");
      return NextResponse.json({ detail: "Session expired" }, { status: 401 });
    }
    const token = refreshed as { access_token: string; refresh_token: string };
    access = token.access_token;
    const secure = process.env.NODE_ENV === "production";
    store.set("openslate_access", token.access_token, {
      httpOnly: true,
      secure,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 30,
    });
    store.set("openslate_refresh", token.refresh_token, {
      httpOnly: true,
      secure,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    response = await requestBackend(request, path.join("/"), access, body);
  }
  const responseBody =
    response.status === 204 ? null : await response.arrayBuffer();
  const next = new NextResponse(responseBody, { status: response.status });
  const contentType = response.headers.get("content-type");
  if (contentType) next.headers.set("content-type", contentType);
  return next;
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
