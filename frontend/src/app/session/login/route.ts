import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const backend = process.env.BACKEND_URL ?? "http://localhost:8000";

export async function POST(request: Request) {
  const response = await fetch(`${backend}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await request.text(),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) return NextResponse.json(body, { status: response.status });
  if (
    typeof body !== "object" ||
    body === null ||
    !("access_token" in body) ||
    !("refresh_token" in body)
  )
    return NextResponse.json(
      { detail: "Invalid authentication response" },
      { status: 502 },
    );
  const token = body as { access_token: string; refresh_token: string };
  const store = await cookies();
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
  return NextResponse.json({ authenticated: true });
}
