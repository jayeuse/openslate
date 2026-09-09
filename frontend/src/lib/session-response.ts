import "server-only";

import type { NextResponse } from "next/server";

import {
  attachRequestId,
  createRequestDeadline,
  createRequestId,
  logSafeEvent,
  requestDeadlineMilliseconds,
} from "@/lib/reliability";

export function beginSessionRoute(route: string, method: string) {
  const requestId = createRequestId();
  const startedAt = Date.now();
  const deadline = createRequestDeadline(requestDeadlineMilliseconds());
  return {
    requestId,
    deadline,
    complete(
      response: NextResponse,
      reason?: string,
      backendRequestId?: string,
    ): NextResponse {
      deadline.dispose();
      return completeSessionResponse(
        requestId,
        route,
        method,
        startedAt,
        response,
        reason,
        backendRequestId,
      );
    },
  };
}

export function completeSessionResponse(
  requestId: string,
  route: string,
  method: string,
  startedAt: number,
  response: NextResponse,
  reason?: string,
  backendRequestId?: string,
): NextResponse {
  attachRequestId(response, backendRequestId ?? requestId);
  logSafeEvent({
    event: "request_completed",
    requestId,
    route,
    method,
    status: response.status,
    elapsedMs: Date.now() - startedAt,
    reason,
    backendRequestId,
  });
  return response;
}
