import "server-only";

import { createClient } from "@supabase/supabase-js";

import {
  currentPublicEnvironment,
  validateRuntimeEnvironment,
} from "@/lib/environment";
import { withRequestSignal } from "@/lib/supabase/request-fetch";

export function createSupabaseServerClient(signal?: AbortSignal) {
  const runtime = validateRuntimeEnvironment();
  const publicEnvironment = currentPublicEnvironment();
  return createClient(
    runtime.supabaseServerUrl,
    publicEnvironment.supabasePublishableKey,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      ...(signal === undefined
        ? {}
        : { global: { fetch: withRequestSignal(signal) } }),
    },
  );
}
