import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { listAccountSessions } from "./account-api";

export const platformKeys = {
  all: ["platform"] as const,
  accountSessions: (accountId: string) =>
    ["platform", "account-sessions", accountId] as const,
};

export const accountSessionsOptions = (accountId: string) =>
  queryOptions({
    queryKey: platformKeys.accountSessions(accountId),
    queryFn: ({ signal }) => listAccountSessions(signal),
    enabled: Boolean(accountId),
  });

export function prefetchPlatformSection(
  client: QueryClient,
  href: string,
  accountId: string | undefined,
): void {
  const url = new URL(href, "http://platform.invalid");
  if (
    url.pathname !== "/platform" ||
    url.searchParams.get("section") !== "account" ||
    !accountId
  )
    return;

  void client.prefetchQuery(accountSessionsOptions(accountId));
}
