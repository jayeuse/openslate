import { queryOptions } from "@tanstack/react-query";
import {
  getPersonCard,
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
