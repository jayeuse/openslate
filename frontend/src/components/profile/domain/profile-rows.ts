import { membershipRoleLabels } from "@/lib/auth-api";
import type { PersonProfile } from "../adapters/profile-api";

/** One label-left row of the About panel. */
export type ProfileAboutRow =
  | { label: "Phone" | "Role"; value: string }
  | { label: "Groups"; groups: { id: string; name: string }[] };

function filled(value: string | null): string | null {
  return value?.trim() ? value : null;
}

/**
 * What the Profile view shows beside the photo and name (PD18): About rows for
 * the fields that have a value, and the bio, or null for no Bio panel. A
 * guest's view has none of these, so it shows only the photo, name and title.
 * `fillHint` is true only on the person's own profile when the job title,
 * phone and bio are all empty (PD35).
 */
export function profileFacts(
  profile: PersonProfile,
  own = false,
): {
  about: ProfileAboutRow[];
  bio: string | null;
  fillHint: boolean;
} {
  const about: ProfileAboutRow[] = [];
  const phone = filled(profile.phone);
  if (phone) about.push({ label: "Phone", value: phone });
  if (profile.role)
    about.push({ label: "Role", value: membershipRoleLabels[profile.role] });
  if (profile.groups.length)
    about.push({ label: "Groups", groups: profile.groups });
  const bio = filled(profile.bio);
  const fillHint = own && !phone && !bio && !filled(profile.jobTitle);
  return { about, bio, fillHint };
}
