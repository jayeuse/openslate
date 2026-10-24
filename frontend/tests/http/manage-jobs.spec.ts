import {
  authMeBody,
  controlledSession,
  expect,
  heldResponse,
  expectNoHorizontalScroll,
  recheckSession,
  test,
  type Page,
} from "./helpers/test";
import { installOpenViewEventSource } from "./helpers/openview-event-source";
import { fixtureId as id } from "./helpers/access-api";
import { pageOf } from "../helpers/pagination";

const ADMIN = "00000000-0000-4000-8000-000000000101";
const OTHER = "00000000-0000-4000-8000-000000000102";
type Job = {
  kind: string;
  id: string;
  subject_label: string;
  subject_link: string | null;
  state: string;
  scheduled_for: string | null;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  attempts: number;
  failure_code: string | null;
  failure_label: string | null;
  can_retry: boolean;
};
function job(
  kind: string,
  number: number,
  label: string,
  overrides: Partial<Job> = {},
): Job {
  return {
    kind,
    id: id(number),
    subject_label: label,
    subject_link: null,
    state: "failed",
    scheduled_for: "2026-10-01T00:00:00Z",
    last_attempt_at: "2026-10-01T00:05:00Z",
    next_attempt_at: null,
    attempts: 5,
    failure_code: "attempts_exhausted",
    failure_label: "All attempts have failed",
    can_retry: true,
    ...overrides,
  };
}
function seedJobs(): Job[] {
  return [
    job("backup", 4, "Nightly backup", {
      subject_link: "/manage?view=backup",
      scheduled_for: "2026-10-04T00:00:00Z",
    }),
    job("report-run", 1, "Weekly Report", {
      subject_link: "/openview?section=reports",
      scheduled_for: "2026-10-03T00:00:00Z",
    }),
    job("post-publish", 1, "Meeting post", {
      subject_link: "/boards?section=posts",
      scheduled_for: "2026-10-02T00:00:00Z",
    }),
    job("event-reminder", 3, "Meeting reminder"),
    job("report-run", 5, "Closed Report", {
      can_retry: false,
      failure_code: "source_unavailable",
      failure_label: "Source unavailable",
    }),
    job("future-work", 6, "Future registry work", {
      state: "waiting_external",
      scheduled_for: null,
      last_attempt_at: null,
      attempts: 0,
      failure_code: null,
      failure_label: null,
      can_retry: false,
    }),
  ];
}

type Reply =
  | "normal"
  | "lost"
  | "wrong-location"
  | "old-id"
  | "wrong-status"
  | "wrong-id"
  | "409"
  | "404"
  | "422";
async function installJobs(
  page: Page,
  options: {
    role?: "admin" | "member" | "guest";
    rows?: Job[];
    getDelay?: ReturnType<typeof heldResponse>;
    postDelay?: ReturnType<typeof heldResponse>;
    reply?: Reply;
    roleDelay?: ReturnType<typeof heldResponse>;
    afterLossReadError?: number;
  } = {},
) {
  await installOpenViewEventSource(page);
  const session = await controlledSession(
    page,
    { id: ADMIN, role: options.role ?? "admin" },
    { identityRead: false },
  );
  let identityFailure = false;
  let rows = options.rows ?? seedJobs();
  let getError: number | null = null;
  let reply = options.reply ?? "normal";
  const gets: URL[] = [];
  const posts: Array<{ kind: string; id: string; key: string | null }> = [];
  const accepted = new Map<string, Job>();
  await page.route("**/api/auth/refresh", (route) =>
    route.fulfill({ status: 401, json: { detail: "Unauthenticated" } }),
  );
  await page.route("**/api/auth/me", async (route) => {
    const captured = { ...session.identity, access: [] };
    if (options.roleDelay) {
      options.roleDelay.enter();
      await options.roleDelay.released;
    }
    await route.fulfill(
      identityFailure
        ? { status: 503, json: { detail: "Private role canary" } }
        : { json: authMeBody(captured) },
    );
  });
  await page.route("**/api/jobs**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") {
      gets.push(url);
      const captured = structuredClone(rows);
      const capturedError = getError;
      if (gets.length === 1 && options.getDelay) {
        options.getDelay.enter();
        await options.getDelay.released;
      }
      if (capturedError) {
        if (capturedError === 401) session.signedIn = false;
        return route.fulfill({
          status: capturedError,
          json: {
            detail: {
              code: "jobs_unavailable",
              message: "Private Jobs canary",
            },
          },
        });
      }
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      const filtered = captured
        .sort(
          (a, b) =>
            Number(a.state !== "failed") - Number(b.state !== "failed") ||
            Date.parse(b.scheduled_for ?? "1970-01-01T00:00:00Z") -
              Date.parse(a.scheduled_for ?? "1970-01-01T00:00:00Z") ||
            a.id.localeCompare(b.id) ||
            a.kind.localeCompare(b.kind),
        )
        .filter(
          (row) =>
            (!url.searchParams.get("kind") ||
              row.kind === url.searchParams.get("kind")) &&
            (!url.searchParams.get("state") ||
              row.state === url.searchParams.get("state")),
        );
      const items = filtered.slice(offset, offset + limit);
      return route.fulfill({
        json: pageOf(items, { limit, offset, total: filtered.length }),
      });
    }
    const [, , , kind, targetId] = url.pathname.split("/");
    const key = request.headers()["idempotency-key"] ?? null;
    posts.push({ kind, id: targetId, key });
    if (options.postDelay) {
      options.postDelay.enter();
      await options.postDelay.released;
    }
    const original = rows.find(
      (row) => row.kind === kind && row.id === targetId,
    );
    if (!original)
      return route.fulfill({
        status: 404,
        json: {
          detail: { code: "job_not_found", message: "Private retry canary" },
        },
      });
    if (["409", "404", "422"].includes(reply)) {
      rows = rows.map((row) =>
        row === original ? { ...row, can_retry: false } : row,
      );
      return route.fulfill({
        status: Number(reply),
        json: {
          detail: {
            code: "job_not_retryable",
            message: "Private retry canary",
          },
        },
      });
    }
    let result: Job;
    if (kind === "backup") {
      if (!key)
        return route.fulfill({
          status: 422,
          json: { detail: { code: "job_retry_key_required" } },
        });
      result = accepted.get(key) ?? {
        ...original,
        id: id(100 + accepted.size),
        state: "queued",
        scheduled_for: "2026-10-05T00:00:00Z",
        last_attempt_at: null,
        next_attempt_at: null,
        attempts: 0,
        can_retry: false,
        failure_code: null,
        failure_label: null,
      };
      if (!accepted.has(key)) {
        accepted.set(key, result);
        rows = [...rows, result];
      }
      if (reply === "lost") {
        reply = "normal";
        getError = options.afterLossReadError ?? null;
        return route.abort("failed");
      }
    } else {
      result = {
        ...original,
        state: "pending",
        last_attempt_at: null,
        attempts: 0,
        failure_code: null,
        failure_label: null,
        can_retry: false,
        next_attempt_at: "2026-10-05T00:00:00Z",
      };
      rows = rows.map((row) => (row === original ? result : row));
    }
    if (reply === "old-id") result = { ...result, id: original.id };
    if (reply === "wrong-id") result = { ...result, id: id(999) };
    return route.fulfill({
      status:
        reply === "wrong-status"
          ? kind === "backup"
            ? 200
            : 201
          : kind === "backup"
            ? 201
            : 200,
      headers:
        kind === "backup"
          ? {
              Location:
                reply === "wrong-location"
                  ? `/api/backups?run_id=${original.id}`
                  : `/api/backups?run_id=${result.id}`,
            }
          : {},
      json: result,
    });
  });
  return {
    gets,
    posts,
    accepted,
    error: (status: number | null) => {
      getError = status;
    },
    setRole: (value: "admin" | "member" | "guest") => {
      session.identity = { ...session.identity, role: value };
    },
    setAccount: (value: string) => {
      session.identity = { ...session.identity, id: value };
    },
    failIdentity: () => {
      identityFailure = true;
    },
    restoreIdentity: () => {
      identityFailure = false;
    },
    setRows: (value: Job[]) => {
      rows = value;
    },
  };
}

async function openJobs(page: Page) {
  await page.goto("/manage?view=jobs");
  await expect(
    page.getByRole("heading", { name: "Jobs", exact: true }),
  ).toBeVisible();
}
const rowMenu = (page: Page, label: string) =>
  page.getByRole("button", { name: `Actions for ${label}`, exact: true });
/** Opens a row's menu and returns its Retry item. */
async function retry(page: Page, label: string) {
  await rowMenu(page, label).click();
  return page.getByRole("menuitem", { name: `Retry ${label}`, exact: true });
}

test("exact administrator sees server-priority composite Jobs and future registry rows", async ({
  page,
}) => {
  await installJobs(page);
  await openJobs(page);
  const breadcrumb = page.getByRole("navigation", {
    name: "Breadcrumb",
    exact: true,
  });
  await expect(
    breadcrumb.getByRole("link", { name: "Manage", exact: true }),
  ).toHaveAttribute("href", "/manage?view=organization");
  await expect(breadcrumb.getByText("Jobs", { exact: true })).toBeVisible();

  await expect(
    page.getByRole("link", { name: "Jobs", exact: true }),
  ).toBeVisible();
  const table = page.getByRole("table", { name: "Jobs", exact: true });
  await expect(table.getByRole("row")).toHaveCount(7);
  await expect(table.getByRole("row").nth(1)).toContainText("Nightly backup");
  await expect(table.getByRole("row").nth(2)).toContainText("Weekly Report");
  await expect(rowMenu(page, "Weekly Report")).toBeVisible();
  await expect(rowMenu(page, "Meeting post")).toBeVisible();
  await expect(rowMenu(page, "Closed Report")).toHaveCount(0);
  const future = table
    .getByRole("row")
    .filter({ hasText: "Future registry work" });
  await expect(future).toContainText("Waiting external");
  // A job that never ran shows "—" for its time and attempts, and no problem.
  await expect(future.getByRole("cell")).toHaveText([
    "Waiting external",
    "Future work",
    "Future registry work",
    "Last attempt —",
    "—",
  ]);
  await expect(table).not.toContainText(/Not recorded|No problem recorded/);
  // One-line 40px rows with no Actions column.
  await expect(table.getByRole("columnheader")).toHaveText([
    "State",
    "Job",
    "Subject",
    "When",
    "Attempts",
  ]);
  expect((await future.boundingBox())?.height).toBe(40);
  // A problem is a second line that the row is described by, read in full.
  const weekly = table.getByRole("row").filter({ hasText: "Weekly Report" });
  await expect(weekly).toHaveAccessibleDescription("All attempts have failed");
  await expect(
    page
      .getByRole("main")
      .getByText("All attempts have failed", { exact: true })
      .first(),
  ).toBeVisible();
  // The subject keeps its link, in ink.
  const subject = table.getByRole("link", {
    name: "Nightly backup",
    exact: true,
  });
  await expect(subject).toHaveAttribute("href", "/manage?view=backup");
  expect(
    await subject.evaluate(
      (node) =>
        getComputedStyle(node).color ===
        getComputedStyle(node.closest("td")!).color,
    ),
  ).toBe(true);
  // Refresh is a quiet icon whose tooltip names it.
  const refresh = page.getByRole("button", {
    name: "Refresh Jobs",
    exact: true,
  });
  await expect(refresh).toHaveText("");
  await refresh.hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(
    "Refresh Jobs",
  );
});

for (const role of ["member", "guest"] as const)
  test(`${role} direct URL has no Jobs navigation or private requests`, async ({
    page,
  }) => {
    const api = await installJobs(page, { role });
    await page.goto("/manage?view=jobs");
    await expect(
      page.getByRole("heading", { name: "Jobs", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Jobs", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText("Nightly backup", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByText("Jobs is not available to your account.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Retry/ })).toHaveCount(0);
    expect(api.gets).toHaveLength(0);
    expect(api.posts).toHaveLength(0);
  });

test("unavailable identity never admits Jobs reads or intent prefetch", async ({
  page,
}) => {
  const api = await installJobs(page);
  api.failIdentity();
  await page.goto("/manage?view=jobs");
  await expect(
    page.getByRole("heading", { name: "Jobs", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Jobs", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Nightly backup", { exact: true })).toHaveCount(
    0,
  );
  expect(api.gets).toHaveLength(0);
  // The failed check says so and can be retried; a refusal could not.
  await expect(
    page.getByText("Your access could not be checked.", { exact: true }),
  ).toBeVisible();
  api.restoreIdentity();
  await page
    .getByRole("main")
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await expect(page.getByText("Nightly backup", { exact: true })).toBeVisible();
});

test("Jobs paging and kind/state/size filters retain exact server page identities", async ({
  page,
}) => {
  const rows = Array.from({ length: 15 }, (_, number) =>
    job(
      number % 2 ? "backup" : "report-run",
      number + 20,
      `Owned job ${number + 1}`,
    ),
  );
  const api = await installJobs(page, { rows });
  await openJobs(page);
  await expect(page.getByText("Owned job 10", { exact: true })).toBeVisible();
  await expect(page.getByText("Owned job 11", { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Go to next page", exact: true })
    .click();
  await expect(page.getByText("Owned job 15", { exact: true })).toBeVisible();
  expect(api.gets.at(-1)?.searchParams.get("offset")).toBe("10");
  // Kind is in Filters, and shows as a chip.
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByLabel("Job kind", { exact: true }).selectOption("backup");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("group", { name: "Active filters", exact: true }),
  ).toContainText("Kind: Backup");
  await expect(page.getByText("Owned job 2", { exact: true })).toBeVisible();
  expect(api.gets.at(-1)?.searchParams.get("offset")).toBe("0");
  // State is a quick filter.
  const state = page.getByRole("group", { name: "Job state", exact: true });
  await expect(state.getByRole("button")).toHaveText([
    "All",
    "Pending",
    "Running",
    "Failed",
    "Succeeded",
    "Queued",
    "Canceled",
    "Interrupted",
  ]);
  await state.getByRole("button", { name: "Succeeded", exact: true }).click();
  await expect(
    page.getByText("No jobs match these filters.", { exact: true }),
  ).toBeVisible();
  expect(api.gets.at(-1)?.searchParams.get("state")).toBe("succeeded");
  await page.getByLabel("Rows per page", { exact: true }).selectOption("25");
  await expect
    .poll(() => api.gets.at(-1)?.searchParams.get("limit"))
    .toBe("25");
  await page
    .getByRole("button", { name: "Remove Kind filter", exact: true })
    .click();
  await expect
    .poll(() => api.gets.at(-1)?.searchParams.has("kind"))
    .toBe(false);
  expect(api.gets.at(-1)?.searchParams.get("state")).toBe("succeeded");
});

test("report-run retry requires a matching 200 receipt and refreshes authoritative state", async ({
  page,
}) => {
  const row = seedJobs()[1];
  const api = await installJobs(page, { rows: [row] });
  await openJobs(page);
  await expect(await retry(page, "Weekly Report")).toBeEnabled();
  await page.keyboard.press("Escape");
  const reread = page.waitForRequest(
    (request) =>
      request.method() === "GET" &&
      new URL(request.url()).pathname === "/api/jobs",
  );
  await (await retry(page, "Weekly Report")).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Retry requested." }),
  ).toBeVisible();
  await expect(page.getByRole("table", { name: "Jobs" })).toContainText(
    "Pending",
  );
  expect(api.posts).toEqual([{ kind: "report-run", id: row.id, key: null }]);
  await reread;
});

for (const response of ["wrong-id", "409", "404", "422"] as const)
  test(`scheduled ${response} response never reports retry success or automatically resends`, async ({
    page,
  }) => {
    const api = await installJobs(page, {
      rows: [seedJobs()[1]],
      reply: response,
    });
    await openJobs(page);
    await (await retry(page, "Weekly Report")).click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: /could not be confirmed|changed|available|values/ }),
    ).toBeVisible();
    await expect(
      page.getByText("Retry requested.", { exact: true }),
    ).toHaveCount(0);
    expect(api.posts).toHaveLength(1);
    await expect(page.getByText("Private retry canary")).toHaveCount(0);
  });

test("backup wrong-location receipt stays unresolved and blocks new retry keys", async ({
  page,
}) => {
  const api = await installJobs(page, { reply: "wrong-location" });
  await openJobs(page);
  await (await retry(page, "Nightly backup")).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "could not be confirmed" }),
  ).toBeVisible();
  await expect(page.getByText("Retry requested.", { exact: true })).toHaveCount(
    0,
  );
  expect(api.posts).toHaveLength(1);
  expect(api.posts[0].key).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
  await expect(await retry(page, "Weekly Report")).toBeDisabled();
  await page.keyboard.press("Escape");
});

test("uncertain backup first reads Jobs then explicitly recovers one accepted run with the same key", async ({
  page,
}) => {
  const api = await installJobs(page, { reply: "lost" });
  await openJobs(page);
  await expect(await retry(page, "Nightly backup")).toBeEnabled();
  await page.keyboard.press("Escape");
  const reread = page.waitForRequest(
    (request) =>
      request.method() === "GET" &&
      new URL(request.url()).pathname === "/api/jobs",
  );
  await (await retry(page, "Nightly backup")).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "could not be confirmed" }),
  ).toBeVisible();
  await reread;
  expect(api.posts).toHaveLength(1);
  await expect(
    page.getByRole("button", { name: "Check retry result", exact: true }),
  ).toBeEnabled();
  const key = api.posts[0].key;
  Array.from(api.accepted.values())[0].state = "succeeded";
  await page
    .getByRole("button", { name: "Check retry result", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Retry requested." }),
  ).toBeVisible();
  expect(api.posts).toHaveLength(2);
  expect(api.posts[1].key).toBe(key);
  await expect(
    page
      .getByRole("table", { name: "Jobs" })
      .getByRole("row")
      .filter({ hasText: "Nightly backup" }),
  ).toHaveCount(2);
});

test("Jobs refusal conceals cached subjects and persists across section remount until explicit fresh Retry", async ({
  page,
}) => {
  const api = await installJobs(page);
  await openJobs(page);
  await expect(page.getByText("Nightly backup", { exact: true })).toBeVisible();
  api.error(403);
  await page.getByRole("button", { name: "Refresh Jobs", exact: true }).click();
  await expect(page.getByText("Nightly backup", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Retry Jobs", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  const deniedGets = api.gets.length;
  await page.getByRole("link", { name: "Jobs", exact: true }).click();
  await expect(page.getByText("Nightly backup", { exact: true })).toHaveCount(
    0,
  );
  expect(api.gets).toHaveLength(deniedGets);
  api.error(null);
  await page.getByRole("button", { name: "Retry Jobs", exact: true }).click();
  await expect(page.getByText("Nightly backup", { exact: true })).toBeVisible();
  await expect(page.getByText("Private Jobs canary")).toHaveCount(0);
});

test("same-account role recheck cannot reuse an old administrator Jobs admission", async ({
  page,
}) => {
  const api = await installJobs(page);
  await openJobs(page);
  await expect(page.getByText("Nightly backup", { exact: true })).toBeVisible();
  const before = api.gets.length;
  api.setRole("member");
  await recheckSession(page);
  await expect(
    page.getByRole("link", { name: "Jobs", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Nightly backup", { exact: true })).toHaveCount(
    0,
  );
  expect(api.gets).toHaveLength(before);
});

test("backup uncertainty survives same-account section remount without an automatic POST", async ({
  page,
}) => {
  const api = await installJobs(page, { reply: "lost" });
  await openJobs(page);
  await (await retry(page, "Nightly backup")).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "could not be confirmed" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await page.getByRole("link", { name: "Jobs", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Check retry result", exact: true }),
  ).toBeVisible();
  expect(api.posts).toHaveLength(1);
  await page
    .getByRole("button", { name: "Check retry result", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Retry requested." }),
  ).toBeVisible();
  expect(api.posts[1].key).toBe(api.posts[0].key);
});

test("account replacement cancels a held retry and never transfers its key or late notice", async ({
  page,
}) => {
  const held = heldResponse();
  const api = await installJobs(page, { postDelay: held });
  await openJobs(page);
  await (await retry(page, "Nightly backup")).click();
  try {
    await held.entered;
    expect(api.posts).toHaveLength(1);
    api.setAccount(OTHER);
    api.setRows([job("report-run", 10, "New account job")]);
    await recheckSession(page);
    await expect(
      page.getByText("New account job", { exact: true }),
    ).toBeVisible();
  } finally {
    held.release();
  }
  await expect(page.getByText("Nightly backup", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText("Retry requested.", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Check retry result", exact: true }),
  ).toHaveCount(0);
});

test("loading role cannot reveal or prefetch Jobs before fresh admission", async ({
  page,
}) => {
  const held = heldResponse();
  const api = await installJobs(page, { roleDelay: held });
  await page.goto("/manage?view=jobs");
  try {
    await expect(
      page.getByRole("heading", { name: "Jobs", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Jobs", exact: true }),
    ).toHaveCount(0);
    expect(api.gets).toHaveLength(0);
  } finally {
    held.release();
  }
  await expect(page.getByText("Nightly backup", { exact: true })).toBeVisible();
});

test("cold Jobs load and retained 503 refresh remain truthful and require explicit read Retry", async ({
  page,
}) => {
  const held = heldResponse();
  const api = await installJobs(page, { getDelay: held });
  await openJobs(page);
  try {
    await expect(
      page.locator('[data-slot="loading-region"][aria-busy="true"]'),
    ).toHaveCount(1);
    await expect(page.getByText("Nightly backup", { exact: true })).toHaveCount(
      0,
    );
  } finally {
    held.release();
  }
  await expect(page.getByText("Nightly backup", { exact: true })).toBeVisible();
  api.error(503);
  await page.getByRole("button", { name: "Refresh Jobs", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Jobs workspace", exact: true })
      .getByRole("alert"),
  ).toContainText("could not");
  await expect(page.getByText("Nightly backup", { exact: true })).toBeVisible();
  await expect(await retry(page, "Nightly backup")).toBeDisabled();
  await page.keyboard.press("Escape");
  api.error(null);
  await page.getByRole("button", { name: "Retry Jobs", exact: true }).click();
  await expect(await retry(page, "Nightly backup")).toBeEnabled();
  await page.keyboard.press("Escape");
});

test("failed new filter never relabels prior Jobs rows as its response", async ({
  page,
}) => {
  const api = await installJobs(page);
  await openJobs(page);
  await expect(page.getByText("Weekly Report", { exact: true })).toBeVisible();
  api.error(503);
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByLabel("Job kind", { exact: true }).selectOption("backup");
  await page.keyboard.press("Escape");
  await expect(
    page
      .getByRole("region", { name: "Jobs workspace", exact: true })
      .getByRole("alert"),
  ).toContainText("could not");
  await expect(page.getByText("Weekly Report", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Nightly backup", { exact: true })).toHaveCount(
    0,
  );
});

test("pending scheduled retry locks composite peers and never double-submits", async ({
  page,
}) => {
  const held = heldResponse();
  const api = await installJobs(page, { postDelay: held });
  await openJobs(page);
  await (await retry(page, "Weekly Report")).click();
  try {
    await held.entered;
    expect(api.posts).toHaveLength(1);
    await expect(await retry(page, "Weekly Report")).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(await retry(page, "Meeting post")).toBeDisabled();
    await page.keyboard.press("Escape");
  } finally {
    held.release();
  }
  await expect(
    page.getByRole("status").filter({ hasText: "Retry requested." }),
  ).toBeVisible();
  await expect(await retry(page, "Meeting post")).toBeEnabled();
  await page.keyboard.press("Escape");
  expect(api.posts).toEqual([{ kind: "report-run", id: id(1), key: null }]);
});

test("a pending retry locks the Kind chip, Clear all and the state quick filters", async ({
  page,
}) => {
  const held = heldResponse();
  await installJobs(page, { postDelay: held });
  await openJobs(page);
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByLabel("Job kind", { exact: true }).selectOption("report-run");
  await page.keyboard.press("Escape");
  const chips = page.getByRole("group", {
    name: "Active filters",
    exact: true,
  });
  const remove = chips.getByRole("button", {
    name: "Remove Kind filter",
    exact: true,
  });
  await expect(chips).toContainText("Kind: Report run");
  await (await retry(page, "Weekly Report")).click();
  try {
    await held.entered;
    await expect(remove).toBeDisabled();
    await expect(
      chips.getByRole("button", { name: "Clear all", exact: true }),
    ).toBeDisabled();
    await expect(
      page
        .getByRole("group", { name: "Job state", exact: true })
        .getByRole("button", { name: "Failed", exact: true }),
    ).toBeDisabled();
  } finally {
    held.release();
  }
  await expect(
    page.getByRole("status").filter({ hasText: "Retry requested." }),
  ).toBeVisible();
  await expect(remove).toBeEnabled();
});

test("unsafe subject link rejects the Jobs response without creating navigation", async ({
  page,
}) => {
  await installJobs(page, {
    rows: [
      job("report-run", 1, "Unsafe private subject", {
        subject_link: "//outside.example/private",
      }),
    ],
  });
  await openJobs(page);
  await expect(
    page
      .getByRole("region", { name: "Jobs workspace", exact: true })
      .getByRole("alert"),
  ).toContainText("could not");
  await expect(
    page.getByText("Unsafe private subject", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('a[href*="outside.example"]')).toHaveCount(0);
});

test("backup readback failure cannot offer recovery POST until a fresh GET succeeds", async ({
  page,
}) => {
  const api = await installJobs(page, {
    reply: "lost",
    afterLossReadError: 503,
  });
  await openJobs(page);
  await (await retry(page, "Nightly backup")).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "could not be confirmed" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check retry result", exact: true }),
  ).toBeDisabled();
  expect(api.posts).toHaveLength(1);
  api.error(null);
  await page.getByRole("button", { name: "Retry Jobs", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Check retry result", exact: true }),
  ).toBeEnabled();
  expect(api.posts).toHaveLength(1);
  await page
    .getByRole("button", { name: "Check retry result", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Retry requested." }),
  ).toBeVisible();
  expect(api.posts[1].key).toBe(api.posts[0].key);
});

test("explicit Jobs 401 loses the session and never retains protected subjects", async ({
  page,
}) => {
  const api = await installJobs(page);
  await openJobs(page);
  await expect(page.getByText("Nightly backup", { exact: true })).toBeVisible();
  api.error(401);
  await page.getByRole("button", { name: "Refresh Jobs", exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText("Nightly backup", { exact: true })).toHaveCount(
    0,
  );
});

test("Jobs intent and SPA revisits share the exact same account query cache", async ({
  page,
}) => {
  const api = await installJobs(page);
  await page.goto("/manage?view=organization");
  const link = page.getByRole("link", { name: "Jobs", exact: true });
  await expect(link).toBeVisible();
  await link.focus();
  await expect.poll(() => api.gets.length).toBe(1);
  await link.click();
  await expect(page.getByText("Nightly backup", { exact: true })).toBeVisible();
  expect(api.gets).toHaveLength(1);
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await link.click();
  await expect(page.getByText("Nightly backup", { exact: true })).toBeVisible();
  expect(api.gets).toHaveLength(1);
});

test("empty refreshed later page displays the authoritative zero range", async ({
  page,
}) => {
  const api = await installJobs(page, {
    rows: Array.from({ length: 15 }, (_, number) =>
      job("report-run", number + 20, `Range job ${number + 1}`),
    ),
  });
  await openJobs(page);
  await page
    .getByRole("button", { name: "Go to next page", exact: true })
    .click();
  await expect(page.getByText("Range job 15", { exact: true })).toBeVisible();
  api.setRows([]);
  await page.getByRole("button", { name: "Refresh Jobs", exact: true }).click();
  await expect(
    page.getByText("No jobs match these filters.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Showing 0–0 of 0", { exact: true }),
  ).toBeVisible();
});

for (const state of ["registry", "unconfirmed"] as const) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    for (const theme of ["light", "dark"] as const) {
      test(`Jobs ${state} fits ${viewport.width}x${viewport.height} in ${theme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.emulateMedia({
          colorScheme: theme,
          reducedMotion: "reduce",
        });
        await page.route("**/api/users/*/preferences", (route) =>
          route.fulfill({
            json: {
              user_id: new URL(route.request().url()).pathname.split("/")[3],
              theme,
              appearance: { motion: "reduce", keyboard_shortcuts: true },
            },
          }),
        );
        const api = await installJobs(
          page,
          state === "unconfirmed" ? { reply: "lost" } : {},
        );
        await openJobs(page);
        if (state === "unconfirmed") {
          const reread = page.waitForRequest(
            (request) =>
              request.method() === "GET" &&
              new URL(request.url()).pathname === "/api/jobs",
          );
          await (await retry(page, "Nightly backup")).click();
          await expect(
            page
              .getByRole("alert")
              .filter({ hasText: "could not be confirmed" }),
          ).toBeVisible();
          await reread;
          expect(api.posts).toHaveLength(1);
          await expect(
            page.getByRole("button", {
              name: "Check retry result",
              exact: true,
            }),
          ).toBeEnabled();
        } else {
          const breadcrumb = page.getByRole("navigation", {
            name: "Breadcrumb",
            exact: true,
          });
          await expect(
            breadcrumb.getByRole("link", { name: "Manage", exact: true }),
          ).toHaveAttribute("href", "/manage?view=organization");
          await expect(
            breadcrumb.getByText("Jobs", { exact: true }),
          ).toBeVisible();

          await expect(
            page.getByRole("link", { name: "Jobs", exact: true }),
          ).toBeVisible();
          const table = page.getByRole("table", { name: "Jobs", exact: true });
          await expect(table.getByRole("row")).toHaveCount(7);
          await expect(table.getByRole("row").nth(1)).toContainText(
            "Nightly backup",
          );
          await expect(table.getByRole("row").nth(2)).toContainText(
            "Weekly Report",
          );
          await expect(rowMenu(page, "Weekly Report")).toBeVisible();
          await expect(rowMenu(page, "Meeting post")).toBeVisible();
          await expect(rowMenu(page, "Closed Report")).toHaveCount(0);
          const future = table
            .getByRole("row")
            .filter({ hasText: "Future registry work" });
          await expect(future).toContainText("Waiting external");
          await expect(future).toContainText("—");
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.setViewportSize(viewport);
        await expect(page.locator("html")).toHaveClass(
          theme === "dark" ? /dark/ : /^(?!.*dark)/,
        );
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        await expect(
          page.locator('[data-slot="loading-region"][aria-busy="true"]'),
        ).toHaveCount(0);
      });
    }
  }
}

test("Jobs phone rows show the full problem, the state word and 44px targets", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const problem =
    "The report run failed because its department was archived while the run waited in the queue.";
  await installJobs(page, {
    rows: [
      job("report-run", 1, "Weekly Report", {
        subject_link: "/openview?section=reports",
        failure_label: problem,
      }),
      job("event-reminder", 2, "Never ran", {
        state: "pending",
        last_attempt_at: null,
        next_attempt_at: "2026-10-05T00:00:00Z",
        attempts: 0,
        failure_code: null,
        failure_label: null,
        can_retry: false,
      }),
    ],
  });
  await openJobs(page);
  const items = page
    .getByRole("list", { name: "Jobs", exact: true })
    .getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("Failed");
  await expect(items.nth(0)).toContainText("5 attempts");
  await expect(items.nth(0).getByText(problem, { exact: true })).toBeVisible();
  await expect(items.nth(1)).toContainText("Pending");
  await expect(items.nth(1)).toContainText("Next");
  await expect(items.nth(1)).not.toContainText("attempt");
  for (const target of [
    items.nth(0).getByRole("link", { name: "Weekly Report", exact: true }),
    rowMenu(page, "Weekly Report"),
  ])
    expect((await target.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await expect(rowMenu(page, "Never ran")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});
