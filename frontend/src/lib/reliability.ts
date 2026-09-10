import "server-only";

import type { NextResponse } from "next/server";

import { validateRuntimeEnvironment } from "./environment";

export {
  createRequestDeadline,
  MAX_BFF_RESPONSE_BYTES,
  MAX_JSON_REQUEST_BYTES,
  parseJsonBody,
  PayloadTooLargeError,
  readLimitedStream,
  RequestDeadlineExceededError,
  UpstreamResponseTooLargeError,
  withinDeadline,
} from "./reliability-core";

export function createRequestId(): string {
  return crypto.randomUUID();
}

export function requestDeadlineMilliseconds(): number {
  return validateRuntimeEnvironment().requestDeadlineMilliseconds;
}

export function attachRequestId(
  response: NextResponse,
  requestId: string,
): NextResponse {
  response.headers.set("X-Request-ID", requestId);
  return response;
}

export { logSafeEvent } from "./server-logger";
