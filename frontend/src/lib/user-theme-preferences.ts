import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";
import type { AppearanceMode } from "@/lib/appearance-preferences";

const preferenceSchema = z
  .object({
    user_id: z.string().uuid(),
    theme: z.enum(["light", "dark", "system"]),
    appearance: z
      .object({
        motion: z.enum(["system", "reduce"]),
        keyboard_shortcuts: z.boolean(),
        timezone: z.string().nullable().default(null),
        date_format: z
          .enum(["organization", "dmy", "mdy", "ymd"])
          .default("organization"),
        time_format: z
          .enum(["organization", "12h", "24h"])
          .default("organization"),
        week_start: z
          .enum(["organization", "monday", "sunday"])
          .default("organization"),
        start_page: z
          .enum([
            "automatic",
            "sandbox",
            "boards",
            "comms",
            "access",
            "openview",
            "manage",
            "platform",
          ])
          .default("automatic"),
      })
      .strict(),
  })
  .strict();

export type UserPreferences = z.infer<typeof preferenceSchema>;
export type UserPreferencesPatch = {
  theme?: AppearanceMode;
  appearance?: Partial<UserPreferences["appearance"]>;
};
export const userPreferencesKey = (userId: string) =>
  ["platform", "user-preferences", userId] as const;

async function userPreferencesRequest(userId: string, init: RequestInit) {
  const preference = await apiFetch(
    `/users/${encodeURIComponent(userId)}/preferences`,
    preferenceSchema,
    { ...init, cache: "no-store", refreshOnUnauthorized: false },
  );
  if (preference.user_id !== userId)
    throw new ApiError(
      403,
      "Preferences belong to another account",
      undefined,
      "preferences_owner_mismatch",
    );
  return preference;
}

export function readUserPreferences(userId: string, signal?: AbortSignal) {
  return userPreferencesRequest(userId, { signal });
}
export const userPreferencesOptions = (userId: string) =>
  queryOptions({
    queryKey: userPreferencesKey(userId),
    queryFn: ({ signal }) => readUserPreferences(userId, signal),
  });
export function saveUserPreferences(
  userId: string,
  patch: UserPreferencesPatch,
) {
  return userPreferencesRequest(userId, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}
export function preferencesNeedSessionRecheck(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 401 || error.code === "preferences_owner_mismatch")
  );
}
