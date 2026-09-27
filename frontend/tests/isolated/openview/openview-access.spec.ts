import { expect, test } from "@playwright/test";
import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../src/lib/api";
import {
  isOpenViewAccessDenied,
  watchOpenViewAccess,
} from "../../../src/components/systems/openview/adapters/openview-access";
import { openViewKeys } from "../../../src/components/systems/openview/adapters/openview-queries";

const refused = () => Promise.reject(new ApiError(403, "Forbidden"));
const ok = () => Promise.resolve({ items: [] });

function client() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  watchOpenViewAccess(queryClient);
  return queryClient;
}

test("a refused OpenView read refuses access until a later read succeeds", async () => {
  const queryClient = client();
  await queryClient.fetchQuery({
    queryKey: ["openview", "catalog"],
    queryFn: ok,
  });
  expect(isOpenViewAccessDenied(queryClient)).toBe(false);

  await queryClient
    .fetchQuery({ queryKey: ["openview", "reports", "list"], queryFn: refused })
    .catch(() => undefined);
  expect(isOpenViewAccessDenied(queryClient)).toBe(true);

  // A read of another collection, started after the refusal, confirms access.
  await queryClient.fetchQuery({
    queryKey: ["openview", "catalog"],
    queryFn: ok,
    staleTime: 0,
  });
  expect(isOpenViewAccessDenied(queryClient)).toBe(false);
});

test("the signed-in identity read neither sets nor clears the OpenView latch", async () => {
  const queryClient = client();
  await queryClient
    .fetchQuery({ queryKey: ["openview", "catalog"], queryFn: refused })
    .catch(() => undefined);
  expect(isOpenViewAccessDenied(queryClient)).toBe(true);

  // Identity still reads after records.read is revoked; it proves nothing.
  await queryClient.fetchQuery({
    queryKey: openViewKeys.authMe(),
    queryFn: ok,
  });
  expect(isOpenViewAccessDenied(queryClient)).toBe(true);

  const identityOnly = client();
  await identityOnly
    .fetchQuery({ queryKey: openViewKeys.authMe(), queryFn: refused })
    .catch(() => undefined);
  expect(isOpenViewAccessDenied(identityOnly)).toBe(false);
});

test("a manual cache write after a save does not clear the latch", async () => {
  const queryClient = client();
  await queryClient
    .fetchQuery({ queryKey: ["openview", "reports", "list"], queryFn: refused })
    .catch(() => undefined);
  // A save through records.write updates the cached list by hand.
  queryClient.setQueryData(["openview", "reports", "list"], { items: [] });
  expect(isOpenViewAccessDenied(queryClient)).toBe(true);
});

test("a read that started before the refusal cannot clear it", async () => {
  const queryClient = client();
  let finish: () => void = () => {};
  const slow = new Promise<{ items: never[] }>((resolve) => {
    finish = () => resolve({ items: [] });
  });
  const older = queryClient
    .fetchQuery({ queryKey: ["openview", "catalog"], queryFn: () => slow })
    .catch(() => undefined);
  await queryClient
    .fetchQuery({ queryKey: ["openview", "reports", "list"], queryFn: refused })
    .catch(() => undefined);
  finish();
  await older;
  expect(isOpenViewAccessDenied(queryClient)).toBe(true);
});
