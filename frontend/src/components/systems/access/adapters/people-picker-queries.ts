"use client";

import { queryOptions } from "@tanstack/react-query";
import {
  listAccessMemberCandidates,
  listAccessUsers,
  type AccessDirectoryUser,
  type AccessMemberCandidate,
  type AccessPage,
} from "../state/api";

export type AccessPickerPerson = AccessDirectoryUser | AccessMemberCandidate;
export type AccessPeopleSource = "users" | "candidates";
type PeopleRequest = {
  search?: string;
  ids?: readonly string[];
  limit: number;
  offset: number;
};

/** The same bounded source names single- and multiple-person pickers. */
export const peoplePickerOptions = (
  source: AccessPeopleSource,
  request: PeopleRequest,
) =>
  queryOptions({
    queryKey:
      source === "users"
        ? ["access", "users", "picker", request]
        : ["access", "member-candidates", "picker", request],
    queryFn: async ({ signal }): Promise<AccessPage<AccessPickerPerson>> =>
      source === "users"
        ? listAccessUsers({
            ...request,
            deleted: "include",
            sort_by: "name",
            signal,
          })
        : listAccessMemberCandidates({
            ...request,
            sort_by: "display_name",
            signal,
          }),
  });
