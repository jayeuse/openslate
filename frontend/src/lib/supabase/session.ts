import "server-only";

import type { Session } from "@supabase/supabase-js";

import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function establishSupabaseSession(
  accessToken: string | undefined,
  refreshToken: string | undefined,
): Promise<Session | null> {
  if (!refreshToken) return null;
  const supabase = createSupabaseServerClient();
  const result = accessToken
    ? await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      })
    : await supabase.auth.refreshSession({ refresh_token: refreshToken });
  return result.error ? null : result.data.session;
}
