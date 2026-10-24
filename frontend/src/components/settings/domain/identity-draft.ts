import type {
  IdentityField,
  ProfilePatch,
  ProfileSelf,
} from "@/components/profile/adapters/profile-api";

/** The Identity fields saved through the pinned footer (PD10), in row order. */
export const IDENTITY_FIELDS = [
  "display_name",
  "job_title",
  "phone",
  "bio",
] as const satisfies readonly IdentityField[];

export type IdentityDraft = Record<IdentityField, string>;
type SavedIdentity = Pick<ProfileSelf, IdentityField>;

/** The saved profile as editable text; an empty value is "". */
export function savedDraft(self: SavedIdentity | undefined): IdentityDraft {
  return {
    display_name: self?.display_name ?? "",
    job_title: self?.job_title ?? "",
    phone: self?.phone ?? "",
    bio: self?.bio ?? "",
  };
}

/** The fields whose draft differs from the saved profile, in row order. */
export function changedFields(
  draft: IdentityDraft | null,
  self: SavedIdentity | undefined,
): IdentityField[] {
  if (!draft || !self) return [];
  const saved = savedDraft(self);
  return IDENTITY_FIELDS.filter((field) => draft[field] !== saved[field]);
}

/** Only the changed fields; an emptied field clears to null. */
export function identityPatch(
  draft: IdentityDraft,
  self: SavedIdentity,
): ProfilePatch {
  const patch: ProfilePatch = {};
  for (const field of changedFields(draft, self))
    patch[field] = draft[field] === "" ? null : draft[field];
  return patch;
}
