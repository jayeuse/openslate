import { expect, test } from "@playwright/test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import { ApiError } from "../../../src/lib/api";
import {
  clearRefusal,
  refusalOptions,
  refusalRevision,
  trackRefusal,
} from "../../../src/components/systems/access/hooks/refusal-latch";

const key = ["access", "people-membership-refusal"] as const;

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const failWith = (error: unknown) => () => Promise.reject(error);

test("a 401 or 403 read latches the refusal and bumps its revision", async () => {
  const queries = client();
  const forbidden = new ApiError(403, "Forbidden");
  await expect(
    trackRefusal(
      queries,
      key,
      failWith(forbidden),
      new AbortController().signal,
    ),
  ).rejects.toBe(forbidden);
  expect(queries.getQueryData(key)).toEqual({ denied: true, revision: 1 });

  const signedOut = new ApiError(401, "Unauthorized");
  await expect(trackRefusal(queries, key, failWith(signedOut))).rejects.toBe(
    signedOut,
  );
  expect(queries.getQueryData(key)).toEqual({ denied: true, revision: 2 });
  expect(refusalRevision(queries, key)).toBe(2);
});

test("an aborted 401 or 403 read does not latch", async () => {
  const queries = client();
  for (const status of [401, 403]) {
    const controller = new AbortController();
    controller.abort();
    const refused = new ApiError(status, "Refused");
    await expect(
      trackRefusal(queries, key, failWith(refused), controller.signal),
    ).rejects.toBe(refused);
  }
  expect(queries.getQueryData(key)).toBeUndefined();
  expect(refusalRevision(queries, key)).toBeUndefined();
});

test("a server or network failure does not latch", async () => {
  const queries = client();
  for (const failure of [
    new ApiError(500, "Internal Server Error"),
    new ApiError(503, "Service Unavailable"),
    new TypeError("Failed to fetch"),
  ]) {
    await expect(
      trackRefusal(
        queries,
        key,
        failWith(failure),
        new AbortController().signal,
      ),
    ).rejects.toBe(failure);
  }
  expect(queries.getQueryData(key)).toBeUndefined();
});

test("a Retry with an unchanged revision clears the latch and keeps the revision", async () => {
  const queries = client();
  await expect(
    trackRefusal(queries, key, failWith(new ApiError(403, "Forbidden"))),
  ).rejects.toBeInstanceOf(ApiError);
  const revision = refusalRevision(queries, key);
  await expect(trackRefusal(queries, key, async () => "groups")).resolves.toBe(
    "groups",
  );
  clearRefusal(queries, key, revision);
  expect(queries.getQueryData(key)).toEqual({ denied: false, revision: 1 });
});

test("an older Retry cannot clear a refusal that arrived after it started", async () => {
  const queries = client();
  // Retry started before any refusal: its snapshot has no revision.
  const beforeAny = refusalRevision(queries, key);
  await expect(
    trackRefusal(queries, key, failWith(new ApiError(401, "Unauthorized"))),
  ).rejects.toBeInstanceOf(ApiError);
  clearRefusal(queries, key, beforeAny);
  expect(queries.getQueryData(key)).toEqual({ denied: true, revision: 1 });

  // Retry started after the first refusal; a continuation is refused meanwhile.
  const older = refusalRevision(queries, key);
  await expect(
    trackRefusal(queries, key, failWith(new ApiError(403, "Forbidden"))),
  ).rejects.toBeInstanceOf(ApiError);
  clearRefusal(queries, key, older);
  expect(queries.getQueryData(key)).toEqual({ denied: true, revision: 2 });
});

test("a cached remount stays refused until a fresh Retry clears it", async () => {
  const queries = client();
  const fresh = new QueryObserver(queries, refusalOptions(key));
  expect(fresh.getCurrentResult().data).toEqual({
    denied: false,
    revision: 0,
  });
  await expect(
    trackRefusal(queries, key, failWith(new ApiError(403, "Forbidden"))),
  ).rejects.toBeInstanceOf(ApiError);

  const first = new QueryObserver(queries, refusalOptions(key));
  const stopFirst = first.subscribe(() => {});
  stopFirst();

  const remounted = new QueryObserver(queries, refusalOptions(key));
  const stopRemounted = remounted.subscribe(() => {});
  try {
    const result = remounted.getCurrentResult();
    expect(result.data).toEqual({ denied: true, revision: 1 });
    // A mount never refetches the latch back to its initial value.
    expect(result.fetchStatus).toBe("idle");
  } finally {
    stopRemounted();
  }

  clearRefusal(queries, key, refusalRevision(queries, key));
  const afterRetry = new QueryObserver(queries, refusalOptions(key));
  expect(afterRetry.getCurrentResult().data).toEqual({
    denied: false,
    revision: 1,
  });
});
