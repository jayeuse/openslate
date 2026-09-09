import { NextResponse } from "next/server";
import { z } from "zod";

import { setAuthCookies } from "@/lib/auth-cookies";
import { isSameOriginRequest } from "@/lib/request-security";
import {
  MAX_JSON_REQUEST_BYTES,
  parseJsonBody,
  PayloadTooLargeError,
  readLimitedStream,
  withinDeadline,
} from "@/lib/reliability";
import { beginSessionRoute } from "@/lib/session-response";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const LoginSchema = z
  .object({
    email: z.string().trim().email().max(320),
    password: z.string().min(1).max(1024),
  })
  .strict();

export async function POST(request: Request) {
  const sessionRoute = beginSessionRoute("/session/login", request.method);
  const { complete, deadline } = sessionRoute;
  if (!isSameOriginRequest(request))
    return complete(
      NextResponse.json({ detail: "Forbidden" }, { status: 403 }),
      "same_origin_rejected",
    );
  let body: unknown;
  try {
    body = parseJsonBody(
      await readLimitedStream(
        request.body,
        request.headers,
        MAX_JSON_REQUEST_BYTES,
        deadline.signal,
      ),
    );
  } catch (error) {
    if (error instanceof PayloadTooLargeError)
      return complete(
        NextResponse.json(
          { detail: "Request is too large" },
          { status: 413, headers: { "Cache-Control": "no-store" } },
        ),
        "payload_too_large",
      );
    return complete(
      NextResponse.json(
        { detail: "Invalid sign-in request" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      ),
      "invalid_request",
    );
  }
  const input = LoginSchema.safeParse(body);
  if (!input.success)
    return complete(
      NextResponse.json(
        { detail: "Invalid sign-in request" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      ),
      "invalid_request",
    );

  try {
    const supabase = createSupabaseServerClient(deadline.signal);
    const { data, error } = await withinDeadline(
      supabase.auth.signInWithPassword(input.data),
      deadline.signal,
    );
    if (error || !data.session) {
      return complete(
        NextResponse.json(
          { detail: "Invalid email or password" },
          { status: 401, headers: { "Cache-Control": "no-store" } },
        ),
        "invalid_credentials",
      );
    }

    const response = NextResponse.json(
      { authenticated: true },
      { headers: { "Cache-Control": "no-store" } },
    );
    setAuthCookies(response, data.session);
    return complete(response);
  } catch {
    return complete(
      NextResponse.json(
        { detail: "Unable to sign in" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      ),
      "auth_provider_unavailable",
    );
  }
}
