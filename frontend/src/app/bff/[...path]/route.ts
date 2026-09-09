import { safeLogRoute } from "@/lib/log-routes";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  ACCESS_COOKIE,
  clearAuthCookies,
  REFRESH_COOKIE,
  setAuthCookies,
} from "@/lib/auth-cookies";
import { isSameOriginRequest } from "@/lib/request-security";
import {
  attachRequestId,
  BFF_REQUEST_BODY_LIMIT_BYTES,
  BFF_RESPONSE_BODY_LIMIT_BYTES,
  createRequestDeadline,
  createRequestId,
  logSafeEvent,
  PayloadTooLargeError,
  readLimitedStream,
  RequestDeadlineExceededError,
  requestDeadlineMilliseconds,
  UpstreamResponseTooLargeError,
  withinDeadline,
} from "@/lib/reliability";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const maxDuration = 60;

const backend = process.env.BACKEND_URL ?? "http://localhost:8000";

const invitationAcceptancePath = "auth/invitations/accept";
type Params = { params: Promise<{ path: string[] }> };

function responseWithId(
  routeTemplate: string,
  responseRequestId: string,
  logRequestId: string,
  method: string,
  startedAt: number,
  response: NextResponse,
  reason?: string,
) {
  attachRequestId(response, responseRequestId);
  logSafeEvent({
    event: "request_completed",
    requestId: logRequestId,
    route: routeTemplate,
    method,
    status: response.status,
    elapsedMs: Date.now() - startedAt,
    reason,
    backendRequestId:
      responseRequestId === logRequestId ? undefined : responseRequestId,
  });
  return response;
}

function safeError(
  detail: string,
  status: number,
  headers?: HeadersInit,
): NextResponse {
  return NextResponse.json({ detail }, { status, headers });
}

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
  signal: AbortSignal,
) {
  const headers = forwardHeaders(request, token);
  return fetch(`${backend}/api/${path}${new URL(request.url).search}`, {
    method: request.method,
    headers,
    body: body?.slice(0),
    cache: "no-store",
    signal,
  });
}

async function handle(request: Request, { params }: Params) {
  const requestId = createRequestId();
  const startedAt = Date.now();
  const deadline = createRequestDeadline(requestDeadlineMilliseconds());
  let diagnosticId = requestId;
  let routeTemplate = "unmatched";
  let refreshedSession: Parameters<typeof setAuthCookies>[1] | null = null;
  let authenticationRejected = false;
  const complete = (response: NextResponse, reason?: string) => {
    if (authenticationRejected || response.status === 401)
      clearAuthCookies(response);
    else if (refreshedSession) setAuthCookies(response, refreshedSession);
    return responseWithId(
      routeTemplate,
      diagnosticId,
      requestId,
      request.method,
      startedAt,
      response,
      reason,
    );
  };

  try {
    const { path } = await params;
    routeTemplate = safeLogRoute(`/bff/${path.join("/")}`);
    if (path.join("/") === invitationAcceptancePath)
      return complete(
        safeError("Forbidden", 403),
        "invitation_acceptance_blocked",
      );

    if (
      !["GET", "HEAD"].includes(request.method) &&
      !isSameOriginRequest(request)
    )
      return complete(safeError("Forbidden", 403), "same_origin_rejected");

    const store = await cookies();
    let access = store.get(ACCESS_COOKIE)?.value;
    const backendPath = path
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await readLimitedStream(
            request.body,
            request.headers,
            BFF_REQUEST_BODY_LIMIT_BYTES,
            deadline.signal,
          );

    let attemptStartedAt = Date.now();
    let response = await requestBackend(
      request,
      backendPath,
      access,
      body,
      deadline.signal,
    );
    diagnosticId = response.headers.get("x-request-id") ?? requestId;
    logSafeEvent({
      event: "backend_attempt_completed",
      requestId,
      route: routeTemplate,
      method: request.method,
      status: response.status,
      elapsedMs: Date.now() - attemptStartedAt,
      backendRequestId: response.headers.get("x-request-id") ?? undefined,
    });

    if (response.status === 401) {
      if (response.body !== null)
        void response.body.cancel().catch(() => undefined);
      const refresh = store.get(REFRESH_COOKIE)?.value;
      if (!refresh) {
        const next = safeError("Authentication required", 401);
        return complete(next, "authentication_required");
      }

      try {
        const supabase = createSupabaseServerClient(deadline.signal);
        const refreshed = await withinDeadline(
          supabase.auth.refreshSession({ refresh_token: refresh }),
          deadline.signal,
        );
        if (refreshed.error || !refreshed.data.session)
          throw new Error("refresh failed");
        refreshedSession = refreshed.data.session;
        access = refreshedSession.access_token;
      } catch (error) {
        if (error instanceof RequestDeadlineExceededError) throw error;
        const next = safeError("Session expired", 401);
        return complete(next, "session_refresh_failed");
      }

      attemptStartedAt = Date.now();
      response = await requestBackend(
        request,
        backendPath,
        access,
        body,
        deadline.signal,
      );
      diagnosticId = response.headers.get("x-request-id") ?? requestId;
      logSafeEvent({
        event: "backend_attempt_completed",
        requestId,
        route: routeTemplate,
        method: request.method,
        status: response.status,
        elapsedMs: Date.now() - attemptStartedAt,
        backendRequestId: response.headers.get("x-request-id") ?? undefined,
      });
    }

    // A rejected token must stay rejected even if reading the error body fails.
    authenticationRejected = response.status === 401;
    let responseBody: ArrayBuffer | null;
    try {
      responseBody =
        response.status === 204 ||
        response.status === 304 ||
        request.method === "HEAD"
          ? null
          : await readLimitedStream(
              response.body,
              response.headers,
              BFF_RESPONSE_BODY_LIMIT_BYTES,
              deadline.signal,
            );
    } catch (error) {
      if (error instanceof PayloadTooLargeError)
        throw new UpstreamResponseTooLargeError();
      throw error;
    }
    const next = new NextResponse(responseBody, { status: response.status });
    for (const name of [
      "cache-control",
      "content-disposition",
      "content-type",
      "etag",
      "location",
      "last-modified",
      "retry-after",
      "vary",
      "www-authenticate",
    ]) {
      const value = response.headers.get(name);
      if (value) next.headers.set(name, value);
    }
    return complete(next, response.status >= 500 ? "backend_error" : undefined);
  } catch (error) {
    if (error instanceof UpstreamResponseTooLargeError)
      return complete(
        safeError(
          "Upstream response is too large; confirm the result before retrying.",
          502,
        ),
        "upstream_response_too_large",
      );
    if (error instanceof PayloadTooLargeError)
      return complete(
        safeError("Request or upstream response is too large", 413),
        "payload_too_large",
      );
    if (
      error instanceof RequestDeadlineExceededError ||
      deadline.signal.aborted
    )
      return complete(
        safeError(
          "Upstream request timed out; confirm the result before retrying.",
          504,
        ),
        "deadline_exceeded",
      );
    return complete(
      safeError("Upstream service is unavailable", 502),
      "upstream_unavailable",
    );
  } finally {
    deadline.dispose();
  }
}

async function handleOptions(_request: Request, { params }: Params) {
  const requestId = createRequestId();
  const startedAt = Date.now();
  const { path } = await params;
  const routeTemplate = safeLogRoute(`/bff/${path.join("/")}`);
  if (path.join("/") === invitationAcceptancePath)
    return responseWithId(
      routeTemplate,
      requestId,
      requestId,
      "OPTIONS",
      startedAt,
      safeError("Forbidden", 403),
      "invitation_acceptance_blocked",
    );
  return responseWithId(
    routeTemplate,
    requestId,
    requestId,
    "OPTIONS",
    startedAt,
    new NextResponse(null, {
      status: 204,
      headers: { Allow: "GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS" },
    }),
  );
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handleOptions;
