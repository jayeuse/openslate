// Response bodies shaped like the current FastAPI Platform models. Each one is
// the smallest valid example; tests spread and change single fields.

export const ids = {
  user: "00000000-0000-4000-8000-000000000001",
  otherUser: "00000000-0000-4000-8000-000000000002",
  department: "61000000-0000-4000-8000-000000000001",
  otherDepartment: "61000000-0000-4000-8000-000000000002",
  file: "63000000-0000-4000-8000-000000000001",
  otherFile: "63000000-0000-4000-8000-000000000002",
  module: "10000000-0000-4000-8000-000000000001",
  field: "20000000-0000-4000-8000-000000000001",
  board: "40000000-0000-4000-8000-000000000001",
  result: "50000000-0000-4000-8000-000000000001",
  record: "50000000-0000-4000-8000-000000000002",
  notification: "00000000-0000-4000-8000-000000000201",
  otherNotification: "00000000-0000-4000-8000-000000000202",
  report: "00000000-0000-4000-8000-000000000203",
  run: "00000000-0000-4000-8000-000000000204",
  post: "00000000-0000-4000-8000-000000000206",
  revision: "00000000-0000-4000-8000-000000000207",
  event: "00000000-0000-4000-8000-000000000208",
  backup: "00000000-0000-4000-8000-000000000209",
};
export const timestamp = "2026-10-04T18:30:00Z";

export type RecordedRequest = { input: RequestInfo | URL; init?: RequestInit };

/**
 * Replaces `fetch` for one test; `restore()` puts the original back. A
 * responder may return a pending promise to hold the answer.
 */
export function installFetch(
  response: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Response | Promise<Response>,
): { requests: RecordedRequest[]; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input, init });
    return response(input, init);
  };
  return { requests, restore: () => (globalThis.fetch = originalFetch) };
}

/** A ready Library document in `ids.department`. */
export function libraryFileWire(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.file,
    purpose: "library_document",
    record_id: null,
    board_id: null,
    department_id: ids.department,
    creator_id: ids.user,
    filename: "Safety guide.pdf",
    media_type: "application/pdf",
    expected_size: 24,
    actual_size: 24,
    state: "ready",
    failure_code: null,
    is_deleted: false,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

/** A Report-run notification reference. */
export function notificationWire(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.notification,
    kind: "report-run",
    subject_type: "report_run",
    subject_id: ids.run,
    report_id: ids.report,
    run_id: ids.run,
    status: "unread",
    scheduled_for: timestamp,
    created_at: timestamp,
    read_at: null,
    ...overrides,
  };
}

/** A wire `pagination` block that agrees with `count` items. */
export function pagination(
  count: number,
  {
    limit = 25,
    offset = 0,
    total = offset + count,
  }: { limit?: number; offset?: number; total?: number } = {},
) {
  return {
    limit,
    offset,
    count,
    total,
    has_more: offset + count < total,
  };
}
