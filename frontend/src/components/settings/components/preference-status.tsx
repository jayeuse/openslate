"use client";

import { Check } from "lucide-react";
import {
  useUserPreferences,
  UserPreferencesStatus,
} from "@/components/theme-provider";

/**
 * The one status of the preferences that save at once (PD10, P-F6). The page
 * mounts it once, beside the title of the group the person changed last, so
 * a screen reader hears each result once. Loading, saving and the error with
 * Retry preferences are the shared status; at rest it reads "Saved".
 */
export function PreferenceStatus() {
  const preference = useUserPreferences();
  if (preference.error || preference.loading || preference.saving)
    return (
      <div className="basis-full sm:basis-auto [&_[role=status]]:text-[0.8125rem]">
        <UserPreferencesStatus />
      </div>
    );
  return (
    <span
      role="status"
      className="text-muted-foreground inline-flex items-center gap-1.5 text-[0.8125rem]"
    >
      <Check aria-hidden="true" className="text-flow-text size-3.5" />
      Saved
    </span>
  );
}
