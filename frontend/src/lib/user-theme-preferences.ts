import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";
import type { AppearanceMode } from "@/lib/appearance-preferences";

const preferenceSchema = z.object({
  user_id: z.string().uuid(),
  theme: z.enum(["light", "dark"]),
});

export const userThemeKey = (userId: string) =>
  ["platform", "user-theme", userId] as const;

async function userThemeRequest(userId: string, init: RequestInit) {
  const preference = await apiFetch(
    `/users/${encodeURIComponent(userId)}/preferences`,
    preferenceSchema,
    { ...init, cache: "no-store", refreshOnUnauthorized: false },
  );
  if (preference.user_id !== userId)
    throw new ApiError(
      403,
      "Theme belongs to another account",
      undefined,
      "preferences_owner_mismatch",
    );
  return preference;
}

export function readUserTheme(userId: string, signal?: AbortSignal) {
  return userThemeRequest(userId, { signal });
}

export const userThemeOptions = (userId: string) =>
  queryOptions({
    queryKey: userThemeKey(userId),
    queryFn: ({ signal }) => readUserTheme(userId, signal),
  });

export function saveUserTheme(userId: string, theme: AppearanceMode) {
  return userThemeRequest(userId, {
    method: "PATCH",
    body: JSON.stringify({ theme }),
  });
}

export function themeNeedsSessionRecheck(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 401 || error.code === "preferences_owner_mismatch")
  );
}
