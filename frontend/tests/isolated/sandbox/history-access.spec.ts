import { expect, test } from "@playwright/test";
import { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../../../src/lib/api";
import type {
  SandboxVersion,
  SandboxVersionDetail,
  SandboxVersionPage,
} from "../../../src/components/systems/sandbox/state/api";
import {
  bindSandboxHistoryAccess,
  invalidateSandboxHistoryVersion,
  trackSandboxHistoryList,
  trackSandboxHistoryVersion,
  useSandboxHistoryAccess,
} from "../../../src/components/systems/sandbox/state/sandbox-history-access";
import {
  configuredSandboxDesign,
  sandboxDocumentFromDesign,
} from "../../helpers/sandbox-fixtures";

// History access is one fence for the whole account cache: a refusal hides
// every History read that started before it arrived, a missing reply hides
// one version, and only a read that started later can lift either.

const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";

function version(id: string, isDeleted = false): SandboxVersion {
  return {
    id,
    sequence: 1,
    kind: "checkpoint",
    label: "Before import",
    note: null,
    sourceDocumentRevision: 1,
    sourceVersionId: null,
    contentHash: "c".repeat(64),
    byteCount: 321,
    metadataRevision: 1,
    createdAt: "2026-09-21T10:00:00Z",
    performedBy: null,
    isDeleted,
    deletedAt: isDeleted ? "2026-09-22T10:00:00Z" : null,
  };
}

function detail(id: string, isDeleted = false): SandboxVersionDetail {
  return {
    ...version(id, isDeleted),
    document: sandboxDocumentFromDesign(configuredSandboxDesign),
  };
}

function page(items: SandboxVersion[]): SandboxVersionPage {
  return {
    items,
    limit: 25,
    offset: 0,
    count: items.length,
    total: items.length,
    hasMore: false,
    mutableCount: items.length,
    versionCap: 50,
  };
}

/** A read the test settles later, in the order the row needs. */
function held<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { read: () => promise, resolve, reject };
}

/** What History shows now, read through the same hook the screens use. */
function access(): { denied: boolean; missing: string[] } {
  let seen: { denied: boolean; missing: string[] } | null = null;
  function Probe() {
    const current = useSandboxHistoryAccess();
    seen = {
      denied: current.denied,
      missing: [...current.missingVersionIds].sort(),
    };
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  if (!seen) throw new Error("History access was not rendered");
  return seen;
}

async function settle(read: Promise<unknown>): Promise<void> {
  await read.then(
    () => undefined,
    () => undefined,
  );
}

test.beforeEach(() => {
  bindSandboxHistoryAccess(new QueryClient());
});

for (const row of [
  { status: 401, expected: { denied: true, missing: [] } },
  { status: 403, expected: { denied: true, missing: [] } },
  { status: 404, expected: { denied: true, missing: [] } },
]) {
  test(`a History list ${row.status} refuses all of History`, async () => {
    await expect(
      trackSandboxHistoryList(() =>
        Promise.reject(new ApiError(row.status, "Refused")),
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(access()).toEqual(row.expected);
  });
}

for (const row of [
  { status: 401, expected: { denied: true, missing: [] } },
  { status: 403, expected: { denied: true, missing: [] } },
  { status: 404, expected: { denied: false, missing: [first] } },
]) {
  test(`a version read ${row.status} ${row.expected.denied ? "refuses all of History" : "marks only that version missing"}`, async () => {
    await expect(
      trackSandboxHistoryVersion(first, () =>
        Promise.reject(new ApiError(row.status, "Refused")),
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(access()).toEqual(row.expected);
  });
}

for (const row of [
  {
    name: "History list",
    track: (error: ApiError) =>
      trackSandboxHistoryList(() => Promise.reject(error)),
  },
  {
    name: "version read",
    track: (error: ApiError) =>
      trackSandboxHistoryVersion(first, () => Promise.reject(error)),
  },
]) {
  test(`a ${row.name} 503 neither refuses nor hides a version`, async () => {
    await expect(
      row.track(new ApiError(503, "Unavailable")),
    ).rejects.toBeInstanceOf(ApiError);
    expect(access()).toEqual({ denied: false, missing: [] });
  });
}

test("a read that started before a refusal arrived cannot lift it", async () => {
  const refusing = held<SandboxVersionPage>();
  const earlier = held<SandboxVersionPage>();
  const refused = trackSandboxHistoryList(refusing.read);
  const late = trackSandboxHistoryList(earlier.read);
  refusing.reject(new ApiError(403, "Refused"));
  await settle(refused);
  earlier.resolve(page([version(first)]));
  await expect(late).resolves.toEqual(page([version(first)]));
  expect(access()).toEqual({ denied: true, missing: [] });
});

test("a read that started after the refusal lifts it", async () => {
  await settle(
    trackSandboxHistoryList(() => Promise.reject(new ApiError(403, "Refused"))),
  );
  expect(access().denied).toBe(true);
  await trackSandboxHistoryList(() => Promise.resolve(page([version(first)])));
  expect(access()).toEqual({ denied: false, missing: [] });
});

test("a version read that started before its missing reply arrived cannot restore it", async () => {
  const missingRead = held<SandboxVersionDetail>();
  const earlierRead = held<SandboxVersionDetail>();
  const missing = trackSandboxHistoryVersion(first, missingRead.read);
  const earlier = trackSandboxHistoryVersion(first, earlierRead.read);
  missingRead.reject(new ApiError(404, "Missing"));
  await settle(missing);
  earlierRead.resolve(detail(first));
  await expect(earlier).resolves.toEqual(detail(first));
  expect(access()).toEqual({ denied: false, missing: [first] });
});

test("a later list read that returns a missing version restores it", async () => {
  await settle(
    trackSandboxHistoryVersion(first, () =>
      Promise.reject(new ApiError(404, "Missing")),
    ),
  );
  expect(access().missing).toEqual([first]);
  await trackSandboxHistoryList(() =>
    Promise.resolve(page([version(first), version(second)])),
  );
  expect(access()).toEqual({ denied: false, missing: [] });
});

test("a list row marked deleted does not restore a missing version", async () => {
  await settle(
    trackSandboxHistoryVersion(first, () =>
      Promise.reject(new ApiError(404, "Missing")),
    ),
  );
  await trackSandboxHistoryList(() =>
    Promise.resolve(page([version(first, true)])),
  );
  expect(access()).toEqual({ denied: false, missing: [first] });
});

test("a version read that returns a deleted version marks it missing", async () => {
  await expect(
    trackSandboxHistoryVersion(first, () =>
      Promise.resolve(detail(first, true)),
    ),
  ).resolves.toEqual(detail(first, true));
  expect(access()).toEqual({ denied: false, missing: [first] });
});

test("a confirmed deletion marks the version missing until a later read returns it", async () => {
  invalidateSandboxHistoryVersion(second);
  expect(access()).toEqual({ denied: false, missing: [second] });
  await trackSandboxHistoryVersion(second, () =>
    Promise.resolve(detail(second)),
  );
  expect(access()).toEqual({ denied: false, missing: [] });
});

test("binding another account cache clears History refusals and ignores reads from before", async () => {
  await settle(
    trackSandboxHistoryList(() => Promise.reject(new ApiError(403, "Refused"))),
  );
  await settle(
    trackSandboxHistoryVersion(second, () =>
      Promise.reject(new ApiError(404, "Missing")),
    ),
  );
  const previous = held<SandboxVersionPage>();
  const previousRead = trackSandboxHistoryList(previous.read);
  bindSandboxHistoryAccess(new QueryClient());
  expect(access()).toEqual({ denied: false, missing: [] });
  previous.reject(new ApiError(403, "Refused"));
  await settle(previousRead);
  expect(access()).toEqual({ denied: false, missing: [] });
});

test("a refusal cancels History queries in flight and keeps their earlier data", async () => {
  const client = new QueryClient();
  bindSandboxHistoryAccess(client);
  const key = ["sandbox", "versions", { offset: 25 }];
  client.setQueryData(key, page([version(first)]));
  const inFlight = client.fetchQuery({
    queryKey: key,
    queryFn: () => new Promise<SandboxVersionPage>(() => {}),
  });
  expect(client.getQueryState(key)?.fetchStatus).toBe("fetching");
  await settle(
    trackSandboxHistoryList(() => Promise.reject(new ApiError(403, "Refused"))),
  );
  await expect.poll(() => client.getQueryState(key)?.fetchStatus).toBe("idle");
  await settle(inFlight);
  expect(client.getQueryData(key)).toEqual(page([version(first)]));
  expect(access()).toEqual({ denied: true, missing: [] });
});
