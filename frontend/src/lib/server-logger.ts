import "server-only";

import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { requiredLogDirectory } from "./environment";
import { safeLogRoute } from "./log-routes";

type SafeLogEvent = Readonly<{
  event: string;
  requestId: string;
  route: string;
  method: string;
  status?: number;
  elapsedMs?: number;
  reason?: string;
  backendRequestId?: string;
}>;
const events = new Set([
  "request_completed",
  "backend_attempt_completed",
  "backend_attempt_failed",
]);
const reasons = new Set([
  "authentication_required",
  "backend_error",
  "deadline_exceeded",
  "invitation_acceptance_blocked",
  "payload_too_large",
  "same_origin_rejected",
  "session_refresh_failed",
  "upstream_response_too_large",
  "upstream_unavailable",
  "auth_provider_unavailable",
  "invalid_credentials",
  "invalid_request",
  "backend_transport_failed",
  "password_update_failed",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let sinkFailed = false;
let lastWarning = -Infinity;

export function logSafeEvent(input: SafeLogEvent): void {
  const now = new Date();
  const status =
    Number.isInteger(input.status) &&
    input.status! >= 100 &&
    input.status! <= 599
      ? input.status
      : undefined;
  const severity =
    (status ?? 0) >= 500 || input.event === "backend_attempt_failed"
      ? "error"
      : (status ?? 0) >= 400
        ? "warn"
        : "info";
  const record = {
    timestamp: now.toISOString(),
    severity,
    service: "frontend",
    event: events.has(input.event) ? input.event : "unknown_event",
    request_id: uuid.test(input.requestId) ? input.requestId : "unavailable",
    route: safeLogRoute(input.route),
    method: /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(input.method)
      ? input.method
      : "OTHER",
    status,
    elapsed_ms:
      Number.isFinite(input.elapsedMs) && input.elapsedMs! >= 0
        ? Math.round(input.elapsedMs!)
        : undefined,
    reason:
      input.reason && reasons.has(input.reason) ? input.reason : undefined,
    backend_request_id:
      input.backendRequestId && uuid.test(input.backendRequestId)
        ? input.backendRequestId
        : undefined,
  };
  const time = record.timestamp.slice(11, 23) + "Z";
  // Synchronous append keeps memory bounded and creates no background write queue.
  try {
    const directory = resolve(requiredLogDirectory());
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    appendFileSync(
      resolve(directory, `${record.timestamp.slice(0, 10)}.log`),
      JSON.stringify(record) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
    if (sinkFailed) console.info(`${time} INFO frontend log_sink_recovered`);
    sinkFailed = false;
    lastWarning = -Infinity;
  } catch {
    sinkFailed = true;
    if (now.getTime() - lastWarning >= 60_000) {
      console.error(`${time} ERROR frontend log_sink_failed`);
      lastWarning = now.getTime();
    }
  }
  if (record.event === "request_completed") {
    console[severity](
      `${time} ${severity.toUpperCase()} frontend ${record.method} ${record.route} ${status ?? "-"} ${record.elapsed_ms ?? 0}ms${record.reason ? ` ${record.reason}` : ""}${severity === "info" ? "" : ` id=${record.backend_request_id ?? record.request_id}`}`,
    );
  }
}
