// No imports: the shell's breadcrumb reads the Profile view's cache by these
// keys without loading the profile read itself.

/** Every profile this account has read, in any organization. */
export const personProfilesKey = (viewerId: string) =>
  ["profile", "person", viewerId] as const;
/** One person's profile, as this account sees it in this organization. */
export const personProfileKey = (
  viewerId: string,
  organizationId: string,
  personId: string,
) => ["profile", "person", viewerId, organizationId, personId] as const;
