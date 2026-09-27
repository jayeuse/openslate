"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

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
  const [client] = useState(createQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
