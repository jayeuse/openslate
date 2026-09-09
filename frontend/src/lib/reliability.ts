import "server-only";

import type { NextResponse } from "next/server";

import {
  MAX_BFF_RESPONSE_BYTES,
  MAX_JSON_REQUEST_BYTES,
} from "./reliability-core";

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

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const BFF_REQUEST_BODY_LIMIT_BYTES = positiveIntegerEnvironment(
  "BFF_REQUEST_BODY_LIMIT_BYTES",
  MAX_JSON_REQUEST_BYTES,
);
export const BFF_RESPONSE_BODY_LIMIT_BYTES = positiveIntegerEnvironment(
  "BFF_RESPONSE_BODY_LIMIT_BYTES",
  MAX_BFF_RESPONSE_BYTES,
);
const BFF_DEADLINE_MS = positiveIntegerEnvironment(
  "BFF_REQUEST_DEADLINE_MS",
  60_000,
);

export function createRequestId(): string {
  return crypto.randomUUID();
}

export function requestDeadlineMilliseconds(): number {
  return BFF_DEADLINE_MS;
}

export function attachRequestId(
  response: NextResponse,
  requestId: string,
): NextResponse {
  response.headers.set("X-Request-ID", requestId);
  return response;
}

export { logSafeEvent } from "./server-logger";
