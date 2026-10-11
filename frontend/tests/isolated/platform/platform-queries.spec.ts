import { expect, test } from "@playwright/test";
import {
  QueryClient,
  skipToken,
  type QueryFunction,
  type QueryKey,
} from "@tanstack/react-query";

import { ApiContractError, ApiError } from "../../../src/lib/api";
import type { Notification } from "../../../src/components/systems/shared/adapters/notifications-api";
import {
  isLibraryRefused,
  notificationCountOptions,
  notificationPageOptions,
  notificationRefusalOptions,
  notificationTitleOptions,
  prefetchPlatformSection,
  trackLibraryRead,
} from "../../../src/components/systems/platform/adapters/platform-queries";
import {
  ids,
  installFetch,
  notificationWire,
  pagination,
  timestamp,
} from "./fixtures";

// Notification titles come from the current source of each notice, and a
// refused source hides only its title while the inbox and count recheck what
// the reader may still see. Library and notification reads keep a per-client
// order, so a late answer from an older read can neither hide nor restore
// private data that a newer answer decided. The http journeys keep one
// rendered example: "six new kinds show exact current-source titles and
// destinations with only one scheduled date", "Library files: a list response
// predating a refused status read cannot restore private cached data" and
// "opening resync replaces cold count and popup reads and ignores their late
// old responses".

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const common = {
  id: ids.notification,
  subjectId: ids.run,
  status: "unread",
  createdAt: timestamp,
  readAt: null,
} as const;
const notices = {
  reportRun: {
    ...common,
    kind: "report-run",
    subjectType: "report_run",
    scheduledFor: timestamp,
    reportId: ids.report,
    runId: ids.run,
  },
  reportRunFailed: {
    ...common,
    kind: "report-run-failed",
    subjectType: "scheduled_work",
    scheduledFor: timestamp,
    reportId: ids.report,
  },
  postPublish: {
    ...common,
    subjectId: ids.post,
    kind: "post-publish",
    subjectType: "board_post",
    scheduledFor: timestamp,
    boardId: ids.board,
    postId: ids.post,
    publicationRevisionId: ids.revision,
  },
  eventReminder: {
    ...common,
    subjectId: ids.event,
    kind: "event-reminder",
    subjectType: "board_event",
    scheduledFor: timestamp,
    boardId: ids.board,
    eventId: ids.event,
    occurrenceId: `${ids.event}:2026-10-04`,
    occurrenceStartAt: timestamp,
  },
  backupFailed: {
    ...common,
    subjectId: ids.backup,
    kind: "backup-failed",
    subjectType: "backup_run",
    scheduledFor: null,
  },
  recordAssigned: {
    ...common,
    subjectId: ids.record,
    kind: "record-assigned",
    subjectType: "record",
    scheduledFor: null,
    moduleId: ids.module,
  },
  invitationAccepted: {
    ...common,
    subjectId: ids.otherUser,
    kind: "invitation-accepted",
    subjectType: "user",
    scheduledFor: null,
  },
  sandboxPublished: {
    ...common,
    subjectId: ids.revision,
    kind: "sandbox-published",
    subjectType: "sandbox_version",
    scheduledFor: null,
    versionSequence: 8,
  },
  accessChanged: {
    ...common,
    subjectId: ids.user,
    kind: "access-changed",
    subjectType: "user",
    scheduledFor: null,
  },
} satisfies Record<string, Notification>;

const report = {
  id: ids.report,
  module_id: ids.module,
  name: "Operations review",
  subtitle: null,
  revision: 1,
  recipe: {
    version: 1,
    fields: [{ field_id: ids.field, expected_type: "text" }],
    filters: [],
    logic: "and",
    sorts: [],
    group_by: null,
    include_row_count: true,
  },
  is_deleted: false,
  created_at: timestamp,
  updated_at: timestamp,
};
const board = {
  id: ids.board,
  name: "Field operations",
  scope: "project",
  department_id: null,
  description: "",
  status: "active",
  revision: 1,
  level: "read",
  created_at: timestamp,
  updated_at: timestamp,
};
const event = {
  id: ids.event,
  board_id: ids.board,
  author_id: ids.user,
  title: "Safety briefing",
  details: "Private event details",
  location: "",
  links: [],
  timezone_name: "UTC",
  recurrence: "none",
  repeat_until: null,
  reminders: ["start"],
  archived: false,
  revision: 1,
  board_revision: 1,
  created_at: timestamp,
  updated_at: timestamp,
  all_day: false,
  start_date: null,
  end_date: null,
  start_at: timestamp,
  end_at: "2026-10-04T19:30:00Z",
};
function backupPage(runId: string | null) {
  return {
    items:
      runId === null
        ? []
        : [
            {
              id: runId,
              name: "Nightly safety copy",
              provenance: "scheduled",
              installation: "current",
              state: "failed",
              requested_at: timestamp,
              started_at: timestamp,
              finished_at: timestamp,
              reconciled_at: timestamp,
              schedule: "daily",
              retention_days: 30,
              snapshot_id: null,
              manifest_sha256: null,
              verified_at: null,
              failure_code: "backup_failed",
              expired_at: null,
            },
          ],
    pagination: pagination(runId === null ? 0 : 1, { limit: 1 }),
  };
}

function sources(backupRunId: string | null = ids.backup) {
  return installFetch((input) => {
    const url = new URL(String(input), "http://platform.invalid");
    if (url.pathname === `/api/reports/${ids.report}`)
      return Response.json(report);
    if (url.pathname === `/api/boards/${ids.board}`)
      return Response.json(board);
    if (url.pathname === `/api/boards/${ids.board}/events/${ids.event}`)
      return Response.json(event);
    if (url.pathname === "/api/backups")
      return Response.json(backupPage(backupRunId));
    return Response.json({ detail: "Not found" }, { status: 404 });
  });
}

const titles: {
  name: string;
  item: Notification;
  title: string;
  reads: string[];
}[] = [
  {
    name: "a Report run names its report",
    item: notices.reportRun,
    title: "Operations review",
    reads: [`/api/reports/${ids.report}`],
  },
  {
    name: "a failed Report run names its report",
    item: notices.reportRunFailed,
    title: "Operations review",
    reads: [`/api/reports/${ids.report}`],
  },
  {
    name: "a Board post names its Board",
    item: notices.postPublish,
    title: "Field operations",
    reads: [`/api/boards/${ids.board}`],
  },
  {
    name: "an Event reminder names its event",
    item: notices.eventReminder,
    title: "Safety briefing",
    reads: [`/api/boards/${ids.board}/events/${ids.event}`],
  },
  {
    name: "a failed Backup names its run",
    item: notices.backupFailed,
    title: "Nightly safety copy",
    reads: ["/api/backups"],
  },
  {
    name: "a Record assignment reads no record",
    item: notices.recordAssigned,
    title: "Record assigned to you",
    reads: [],
  },
  {
    name: "an accepted invitation reads no person",
    item: notices.invitationAccepted,
    title: "Invitation accepted",
    reads: [],
  },
  {
    name: "a Sandbox publication reads no version",
    item: notices.sandboxPublished,
    title: "Sandbox version 8 published",
    reads: [],
  },
  {
    name: "an access change reads no person",
    item: notices.accessChanged,
    title: "Your access changed",
    reads: [],
  },
];

for (const row of titles)
  test(`notification title: ${row.name}`, async () => {
    const mock = sources();
    try {
      await expect(
        client().fetchQuery(notificationTitleOptions(row.item)),
      ).resolves.toEqual({ title: row.title });
      expect(
        mock.requests.map(
          ({ input }) =>
            new URL(String(input), "http://platform.invalid").pathname,
        ),
      ).toEqual(row.reads);
    } finally {
      mock.restore();
    }
  });

test("notification title asks the backup history for the one run", async () => {
  const mock = sources();
  try {
    await client().fetchQuery(notificationTitleOptions(notices.backupFailed));
    const url = new URL(
      String(mock.requests[0]?.input),
      "http://platform.invalid",
    );
    expect(url.searchParams.get("run_id")).toBe(ids.backup);
    expect(url.searchParams.get("limit")).toBe("1");
    expect(url.searchParams.get("offset")).toBe("0");
  } finally {
    mock.restore();
  }
});

test("notification title: a removed Backup run is unavailable", async () => {
  const mock = sources(null);
  try {
    const failure = await client()
      .fetchQuery(notificationTitleOptions(notices.backupFailed))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 404 });
  } finally {
    mock.restore();
  }
});

test("notification title: another Backup run is an invalid response", async () => {
  const mock = sources(ids.otherFile);
  try {
    await expect(
      client().fetchQuery(notificationTitleOptions(notices.backupFailed)),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    mock.restore();
  }
});

test("notification titles share one read per current source", () => {
  const titlesKey = ["platform", "notifications", "titles"];
  expect(notificationTitleOptions(notices.reportRun).queryKey).toEqual([
    ...titlesKey,
    "report",
    ids.report,
  ]);
  expect(notificationTitleOptions(notices.reportRunFailed).queryKey).toEqual([
    ...titlesKey,
    "report",
    ids.report,
  ]);
  expect(notificationTitleOptions(notices.postPublish).queryKey).toEqual([
    ...titlesKey,
    "board",
    ids.board,
  ]);
  expect(notificationTitleOptions(notices.eventReminder).queryKey).toEqual([
    ...titlesKey,
    "event",
    ids.board,
    ids.event,
  ]);
  expect(notificationTitleOptions(notices.backupFailed).queryKey).toEqual([
    ...titlesKey,
    "backup-failed",
    ids.backup,
  ]);
});

for (const row of [
  { status: 403, rechecks: true },
  { status: 404, rechecks: true },
  { status: 503, rechecks: false },
])
  test(`notification title source answering ${row.status} ${row.rechecks ? "rechecks" : "keeps"} the inbox and count`, async () => {
    const queries = client();
    const pageKey = notificationPageOptions("all", 25).queryKey;
    const countKey = notificationCountOptions().queryKey;
    queries.setQueryData(pageKey, {
      items: [],
      pagination: { limit: 25, offset: 0, count: 0, total: 0, hasMore: false },
    });
    queries.setQueryData(countKey, 1);
    const mock = installFetch(() =>
      Response.json(
        { detail: "Private report detail" },
        { status: row.status },
      ),
    );
    try {
      const failure = await queries
        .fetchQuery(notificationTitleOptions(notices.reportRun))
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ status: row.status });
      expect(queries.getQueryState(pageKey)?.isInvalidated).toBe(row.rechecks);
      expect(queries.getQueryState(countKey)?.isInvalidated).toBe(row.rechecks);
    } finally {
      mock.restore();
    }
  });

const refusal = (status: number) => new ApiError(status, "Private detail");

for (const row of [
  { status: 401, refused: true },
  { status: 403, refused: true },
  { status: 404, refused: true },
  { status: 503, refused: false },
])
  test(`library read answering ${row.status} ${row.refused ? "hides" : "keeps"} the department`, async () => {
    const queries = client();
    await expect(
      trackLibraryRead(queries, ids.department, () =>
        Promise.reject(refusal(row.status)),
      ),
    ).rejects.toMatchObject({ status: row.status });
    expect(isLibraryRefused(queries, ids.department)).toBe(row.refused);
    expect(isLibraryRefused(queries, ids.otherDepartment)).toBe(false);
  });

test("library read: an older success cannot clear a newer refusal", async () => {
  const queries = client();
  const older = deferred<string>();
  const olderRead = trackLibraryRead(
    queries,
    ids.department,
    () => older.promise,
  );
  await expect(
    trackLibraryRead(queries, ids.department, () =>
      Promise.reject(refusal(403)),
    ),
  ).rejects.toMatchObject({ status: 403 });
  older.resolve("older page");
  await expect(olderRead).resolves.toBe("older page");
  expect(isLibraryRefused(queries, ids.department)).toBe(true);
});

test("library read: a newer success clears the refusal", async () => {
  const queries = client();
  await expect(
    trackLibraryRead(queries, ids.department, () =>
      Promise.reject(refusal(404)),
    ),
  ).rejects.toMatchObject({ status: 404 });
  await trackLibraryRead(queries, ids.department, async () => "fresh page");
  expect(isLibraryRefused(queries, ids.department)).toBe(false);
});

test("library read: an older refusal cannot follow a newer success", async () => {
  const queries = client();
  const older = deferred<string>();
  const olderRead = trackLibraryRead(
    queries,
    ids.department,
    () => older.promise,
  );
  await trackLibraryRead(queries, ids.department, async () => "fresh page");
  older.reject(refusal(403));
  await expect(olderRead).rejects.toMatchObject({ status: 403 });
  expect(isLibraryRefused(queries, ids.department)).toBe(false);
});

const refusalKey = notificationRefusalOptions().queryKey;

/**
 * Runs an option's own read outside the query cache, so a test awaits the
 * read to its end and owns its abort signal.
 */
function readOutsideCache<Value, Key extends QueryKey>(
  queries: QueryClient,
  options: {
    queryKey: Key;
    queryFn?: QueryFunction<Value, Key> | typeof skipToken;
  },
  signal: AbortSignal,
): Promise<Value> {
  const read = options.queryFn;
  if (typeof read !== "function") throw new Error("The option has no read");
  return Promise.resolve(
    read({
      client: queries,
      queryKey: options.queryKey,
      signal,
      meta: undefined,
    }),
  );
}

for (const row of [
  { status: 403, refused: true },
  { status: 404, refused: undefined },
])
  test(`notification count answering ${row.status} ${row.refused ? "refuses" : "does not refuse"} every notification read`, async () => {
    const queries = client();
    const mock = installFetch(() =>
      Response.json({ detail: "Private" }, { status: row.status }),
    );
    try {
      // A refusal cancels every notification read in flight, this one
      // included, so only the latch it leaves is checked.
      await queries
        .fetchQuery(notificationCountOptions())
        .catch(() => undefined);
      expect(queries.getQueryData(refusalKey)).toBe(row.refused);
    } finally {
      mock.restore();
    }
  });

test("notification reads: an older page success cannot clear a newer count refusal", async () => {
  const queries = client();
  const page = deferred<Response>();
  const mock = installFetch((input) =>
    String(input).includes("unread-count")
      ? Response.json({ detail: "Private" }, { status: 403 })
      : page.promise,
  );
  try {
    // The page read started first and is not cancelled by the refusal.
    const olderPage = readOutsideCache(
      queries,
      notificationPageOptions("all", 25),
      new AbortController().signal,
    );
    await expect.poll(() => mock.requests.length).toBe(1);
    await queries.fetchQuery(notificationCountOptions()).catch(() => undefined);
    expect(queries.getQueryData(refusalKey)).toBe(true);
    page.resolve(
      Response.json({ items: [notificationWire()], pagination: pagination(1) }),
    );
    await expect(olderPage).resolves.toMatchObject({
      items: [{ id: ids.notification }],
    });
    expect(queries.getQueryData(refusalKey)).toBe(true);
  } finally {
    mock.restore();
  }
});

test("notification reads: an older refusal cannot follow a newer success", async () => {
  const queries = client();
  const count = deferred<Response>();
  const mock = installFetch((input) =>
    String(input).includes("unread-count")
      ? count.promise
      : Response.json({
          items: [notificationWire()],
          pagination: pagination(1),
        }),
  );
  try {
    const olderCount = queries
      .fetchQuery(notificationCountOptions())
      .catch((error: unknown) => error);
    await expect.poll(() => mock.requests.length).toBe(1);
    await queries.fetchQuery(notificationPageOptions("all", 25));
    count.resolve(Response.json({ detail: "Private" }, { status: 403 }));
    await expect(olderCount).resolves.toMatchObject({ status: 403 });
    expect(queries.getQueryData(refusalKey)).toBe(false);
  } finally {
    mock.restore();
  }
});

test("notification reads: a newer success clears the refusal", async () => {
  const queries = client();
  let status = 403;
  const mock = installFetch(() =>
    status === 200
      ? Response.json({ unread_count: 2 })
      : Response.json({ detail: "Private" }, { status }),
  );
  try {
    await queries.fetchQuery(notificationCountOptions()).catch(() => undefined);
    expect(queries.getQueryData(refusalKey)).toBe(true);
    status = 200;
    await expect(queries.fetchQuery(notificationCountOptions())).resolves.toBe(
      2,
    );
    expect(queries.getQueryData(refusalKey)).toBe(false);
  } finally {
    mock.restore();
  }
});

test("notification reads: a cancelled read's refusal changes nothing", async () => {
  const queries = client();
  const answer = deferred<Response>();
  const mock = installFetch(() => answer.promise);
  const controller = new AbortController();
  try {
    const read = readOutsideCache(
      queries,
      notificationCountOptions(),
      controller.signal,
    );
    await expect.poll(() => mock.requests.length).toBe(1);
    controller.abort();
    answer.resolve(Response.json({ detail: "Private" }, { status: 403 }));
    await expect(read).rejects.toMatchObject({ status: 403 });
    expect(queries.getQueryData(refusalKey)).toBe(undefined);
  } finally {
    mock.restore();
  }
});

test("notification reads: a cancelled read's success cannot clear a refusal", async () => {
  const queries = client();
  const answer = deferred<Response>();
  let refused = true;
  const mock = installFetch(() =>
    refused
      ? Response.json({ detail: "Private" }, { status: 403 })
      : answer.promise,
  );
  const controller = new AbortController();
  try {
    await queries.fetchQuery(notificationCountOptions()).catch(() => undefined);
    expect(queries.getQueryData(refusalKey)).toBe(true);
    refused = false;
    const read = readOutsideCache(
      queries,
      notificationCountOptions(),
      controller.signal,
    );
    await expect.poll(() => mock.requests.length).toBe(2);
    controller.abort();
    answer.resolve(Response.json({ unread_count: 3 }));
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    expect(queries.getQueryData(refusalKey)).toBe(true);
  } finally {
    mock.restore();
  }
});

const administrator = { id: ids.user, role: "admin", access: [] };
// Reads the second department only; the identity cache holds the parsed form.
const reader = {
  id: ids.user,
  role: "member",
  access: [
    { departmentId: ids.otherDepartment, moduleId: null, level: "read" },
  ],
};
const catalogKey = [
  "access",
  "catalog",
  "search",
  "departments",
  { search: "", limit: 25, offset: 0, deleted: "include" },
];
const libraryKey = (departmentId: string) => [
  "platform",
  "library-files",
  departmentId,
  {
    search: "",
    sortBy: "created_at",
    sortOrder: "desc",
    deleted: "exclude",
    limit: 25,
    offset: 0,
  },
];

// Each row lists the reads that start fetching. Files rows begin with the
// two-department catalog already cached and an identity that is confirmed,
// confirmed earlier but failing to refresh, or not read yet.
type Identity = "administrator" | "reader" | "refresh failed" | "not read";
const prefetches: {
  name: string;
  href: string;
  accountId?: string;
  identity?: Identity;
  keys: unknown[];
}[] = [
  {
    name: "Notifications prefetches the first inbox page",
    href: "/platform?section=notifications",
    keys: [["platform", "notifications", "pages", "all", 25, 0]],
  },
  {
    name: "Account prefetches the account's sessions",
    href: "/platform?section=account",
    keys: [["platform", "account-sessions", ids.user]],
  },
  {
    name: "Files prefetches the catalog and the first readable library",
    href: "/platform?section=files",
    identity: "administrator",
    keys: [catalogKey, libraryKey(ids.department)],
  },
  {
    name: "Files prefetches the requested library",
    href: `/platform?section=files&department=${ids.otherDepartment}`,
    identity: "administrator",
    keys: [catalogKey, libraryKey(ids.otherDepartment)],
  },
  {
    name: "Files skips a library the reader cannot open",
    href: "/platform?section=files",
    identity: "reader",
    keys: [catalogKey, libraryKey(ids.otherDepartment)],
  },
  {
    name: "Files without a read identity prefetches only the catalog",
    href: "/platform?section=files",
    identity: "not read",
    keys: [catalogKey],
  },
  {
    name: "Files after a failed identity refresh prefetches only the catalog",
    href: "/platform?section=files",
    identity: "refresh failed",
    keys: [catalogKey],
  },
  {
    name: "Files for a department outside the catalog prefetches only the catalog",
    href: `/platform?section=files&department=${ids.file}`,
    identity: "administrator",
    keys: [catalogKey],
  },
  {
    name: "Search prefetches nothing",
    href: "/platform?section=search",
    keys: [],
  },
  {
    name: "another screen prefetches nothing",
    href: "/openview?section=notifications",
    keys: [],
  },
  {
    name: "a signed-out shell prefetches nothing",
    href: "/platform?section=notifications",
    accountId: "",
    keys: [],
  },
];

const department = (id: string, name: string) => ({
  id,
  department_name: name,
  created_at: timestamp,
  updated_at: timestamp,
  deleted_at: null,
  is_deleted: false,
  performed_by: ids.user,
});
const catalog = {
  items: [
    department(ids.department, "Maintenance"),
    department(ids.otherDepartment, "Operations"),
  ],
  pagination: pagination(2),
};

async function seed(queries: QueryClient, identity: Identity) {
  queries.setQueryData(catalogKey, catalog);
  if (identity === "not read") return;
  queries.setQueryData(
    ["auth", "me"],
    identity === "reader" ? reader : administrator,
  );
  if (identity === "refresh failed")
    await queries
      .fetchQuery({
        queryKey: ["auth", "me"],
        queryFn: () => Promise.reject(new Error("Identity unavailable")),
      })
      .catch(() => undefined);
}

for (const row of prefetches)
  test(`Platform prefetch: ${row.name}`, async () => {
    const queries = client();
    if (row.identity) await seed(queries, row.identity);
    const mock = installFetch(() =>
      Response.json({ detail: "Not found" }, { status: 404 }),
    );
    try {
      prefetchPlatformSection(queries, row.href, row.accountId ?? ids.user);
      expect(
        queries
          .getQueryCache()
          .findAll({ fetchStatus: "fetching" })
          .map((query) => query.queryKey),
      ).toEqual(row.keys);
      await expect.poll(() => queries.isFetching()).toBe(0);
    } finally {
      mock.restore();
    }
  });
