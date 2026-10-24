import { queryOptions } from "@tanstack/react-query";
import {
  getPersonCard,
  getPersonProfile,
  readProfileSelf,
  type PersonCardViewer,
} from "./profile-api";

export const profileSelfKey = (userId: string) =>
  ["profile", "self", userId] as const;
export const profileSelfOptions = (userId: string) =>
  queryOptions({
    queryKey: profileSelfKey(userId),
    queryFn: ({ signal }) => readProfileSelf(userId, signal),
  });

export const personCardKey = (viewer: PersonCardViewer, targetId: string) =>
  ["profile", "person-card", viewer.id, viewer.role, targetId] as const;
export const personCardOptions = (viewer: PersonCardViewer, targetId: string) =>
  queryOptions({
    queryKey: personCardKey(viewer, targetId),
    queryFn: ({ signal }) => getPersonCard(viewer, targetId, signal),
    // Refusals require deliberate Retry. Mounting another byline never replays a refused read.
    retryOnMount: false,
  });

/** Every profile this account has read, in any organization. */
export const personProfilesKey = (viewerId: string) =>
  ["profile", "person", viewerId] as const;
/** One person's profile, as this account sees it in this organization. */
export const personProfileKey = (
  viewerId: string,
  organizationId: string,
  personId: string,
) => ["profile", "person", viewerId, organizationId, personId] as const;
export const personProfileOptions = (
  viewerId: string,
  organizationId: string,
  personId: string,
) =>
  queryOptions({
    queryKey: personProfileKey(viewerId, organizationId, personId),
    queryFn: ({ signal }) => getPersonProfile(personId, signal),
    // A 404 or failure needs a deliberate Retry; remounting never replays it.
    retryOnMount: false,
  });
