"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { UserPreferencesProvider } from "@/components/theme-provider";
import { bindOpenViewAccess } from "@/components/systems/openview/adapters/openview-access";
import { bindSandboxHistoryAccess } from "@/components/systems/sandbox/state/sandbox-history-access";

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Server invalidation events keep cached reads current; this only
        // bounds how long a revisit trusts data without a background check.
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        // Reads fail visibly and offer Retry; nothing retries on its own.
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
}

/**
 * The client cache for one verified account. Mount it inside the subtree
 * keyed by the verified user, so a different account starts with an empty
 * cache and signing out drops it.
 */
export function AppQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => {
    const created = createQueryClient();
    // A new account starts with OpenView access unknown, not refused.
    bindOpenViewAccess(created);
    bindSandboxHistoryAccess(created);
    return created;
  });
  return (
    <QueryClientProvider client={client}>
      <UserPreferencesProvider>{children}</UserPreferencesProvider>
    </QueryClientProvider>
  );
}
