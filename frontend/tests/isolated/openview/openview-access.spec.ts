import { expect, test } from "@playwright/test";
import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../src/lib/api";
import {
  bindOpenViewAccess,
  isOpenViewAccessDenied,
  isReadRequest,
  trackOpenViewRead,
} from "../../../src/components/systems/openview/adapters/openview-access";

const refused = () => Promise.reject(new ApiError(403, "Forbidden"));
const ok = () => Promise.resolve("ok");

// Resolves or rejects when the test says, to order reads explicitly.
function deferred() {
  let resolve: () => void = () => {};
  let reject: () => void = () => {};
  const promise = new Promise<string>((done, fail) => {
    resolve = () => done("ok");
    reject = () => fail(new ApiError(403, "Forbidden"));
  });
  return { promise, resolve, reject };
}

test.beforeEach(() => {
  bindOpenViewAccess(new QueryClient());
});

test("a refused read refuses access until a read started later succeeds", async () => {
  await trackOpenViewRead(ok);
  expect(isOpenViewAccessDenied()).toBe(false);
  await trackOpenViewRead(refused).catch(() => undefined);
  expect(isOpenViewAccessDenied()).toBe(true);
  await trackOpenViewRead(ok);
  expect(isOpenViewAccessDenied()).toBe(false);
});

test("a read that started before the refusal cannot clear it", async () => {
  const older = deferred();
  const olderRead = trackOpenViewRead(() => older.promise);
  await trackOpenViewRead(refused).catch(() => undefined);
  older.resolve();
  await olderRead;
  expect(isOpenViewAccessDenied()).toBe(true);
});

test("a refusal older than a read that already succeeded is stale", async () => {
  const older = deferred();
  const olderRead = trackOpenViewRead(() => older.promise).catch(
    () => undefined,
  );
  await trackOpenViewRead(ok);
  older.reject();
  await olderRead;
  expect(isOpenViewAccessDenied()).toBe(false);
});

test("a new account starts with access not refused", async () => {
  await trackOpenViewRead(refused).catch(() => undefined);
  expect(isOpenViewAccessDenied()).toBe(true);
  bindOpenViewAccess(new QueryClient());
  expect(isOpenViewAccessDenied()).toBe(false);
});

test("a previous account's read cannot refuse the next account", async () => {
  const previous = deferred();
  const previousRead = trackOpenViewRead(() => previous.promise).catch(
    () => undefined,
  );
  bindOpenViewAccess(new QueryClient());
  previous.reject();
  await previousRead;
  expect(isOpenViewAccessDenied()).toBe(false);
});

test("only GET requests count as reads in shared report helpers", () => {
  expect(isReadRequest()).toBe(true);
  expect(isReadRequest({ method: "get" })).toBe(true);
  expect(isReadRequest({ method: "POST" })).toBe(false);
  expect(isReadRequest({ method: "PATCH" })).toBe(false);
});
