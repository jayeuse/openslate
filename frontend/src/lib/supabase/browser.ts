import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { currentPublicEnvironment } from "@/lib/environment";

let browserClient: SupabaseClient | null = null;

export function getSupabaseBrowserClient(): SupabaseClient {
  if (browserClient) return browserClient;
  const environment = currentPublicEnvironment();
  browserClient = createClient(
    environment.supabaseUrl,
    environment.supabasePublishableKey,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
  return browserClient;
}
