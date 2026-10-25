import { z } from "zod";
import { ApiContractError, apiFetch } from "@/lib/api";
import type { AccountRole } from "@/lib/auth-api";
import { publicCardSchema, type ProfileSelf } from "./profile-api";

// The Profile view's read. Kept apart from profile-api, which the person card
// loads on every workspace page, so only the Profile view and Account settings
// ship it.

const uuid = z.uuid();
const nullableText = z.string().nullable();
const memberProfileSchema = publicCardSchema
  .extend({
    phone: nullableText,
    bio: nullableText,
    role: z.enum(["admin", "member", "guest"]),
    groups: z.array(z.object({ id: uuid, name: z.string() }).strict()),
  })
  .strict();
/** A guest gets only the public fields; administrators and members get the rest (PD17). */
const profileWireSchema = z.union([memberProfileSchema, publicCardSchema]);

/** A profile as the Profile view shows it. A guest's view has no phone, bio, role or groups. */
export type PersonProfile = {
  personId: string;
  displayName: string;
  jobTitle: string | null;
  avatarUrl: string | null;
  phone: string | null;
  bio: string | null;
  role: AccountRole | null;
  groups: { id: string; name: string }[];
};

export function personProfileFromWire(
  personId: string,
  wire: z.output<typeof profileWireSchema>,
): PersonProfile {
  const id = uuid.parse(personId);
  if (wire.avatar_url !== null && wire.avatar_url !== `/api/users/${id}/avatar`)
    throw new ApiContractError();
  const full = "role" in wire ? wire : null;
  return {
    personId: id,
    displayName: wire.display_name,
    jobTitle: wire.job_title,
    avatarUrl: wire.avatar_url,
    phone: full?.phone ?? null,
    bio: full?.bio ?? null,
    role: full?.role ?? null,
    groups: full ? full.groups.map(({ id, name }) => ({ id, name })) : [],
  };
}

/** Without an organization there is no profile read: the own profile comes from the account. */
export function personProfileFromSelf(self: ProfileSelf): PersonProfile {
  return {
    personId: self.id,
    displayName: self.display_name?.trim() ? self.display_name : self.username,
    jobTitle: self.job_title,
    avatarUrl: self.avatar_file_id ? `/api/users/${self.id}/avatar` : null,
    phone: self.phone,
    bio: self.bio,
    role: null,
    groups: [],
  };
}

export async function getPersonProfile(
  personId: string,
  signal?: AbortSignal,
): Promise<PersonProfile> {
  const id = uuid.parse(personId);
  const wire = await apiFetch(`/users/${id}/profile`, profileWireSchema, {
    signal,
    cache: "no-store",
    refreshOnUnauthorized: false,
  });
  signal?.throwIfAborted();
  return personProfileFromWire(id, wire);
}
