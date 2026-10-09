import { queryOptions } from "@tanstack/react-query";
import { readProfileSelf } from "./profile-api";

export const profileSelfKey = (userId: string) =>
  ["profile", "self", userId] as const;
export const profileSelfOptions = (userId: string) =>
  queryOptions({
    queryKey: profileSelfKey(userId),
    queryFn: ({ signal }) => readProfileSelf(userId, signal),
  });
