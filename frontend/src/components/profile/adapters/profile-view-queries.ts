import { queryOptions } from "@tanstack/react-query";
import { getPersonProfile } from "./profile-api";
import { personProfileKey } from "./profile-view-keys";

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
