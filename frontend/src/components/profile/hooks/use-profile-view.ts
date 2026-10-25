"use client";

import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { ApiError } from "@/lib/api";
import {
  useAdmittedWorkspaceScope,
  useVerifiedWorkspaceUserId,
  useWorkspaceInteractionSuspended,
} from "@/components/systems/shared/runtime/workspace-identity";
import {
  personProfileFromSelf,
  type PersonProfile,
} from "../adapters/profile-view-api";
import { profileSelfOptions } from "../adapters/profile-queries";
import { personProfileOptions } from "../adapters/profile-view-queries";

export type ProfileView =
  | { status: "loading"; own: boolean }
  | { status: "ready"; own: boolean; profile: PersonProfile }
  /** Not in this organization, unknown, or hidden from a guest: one answer (PD20). */
  | { status: "unavailable" }
  | { status: "failed"; own: boolean; retrying: boolean; retry: () => void };

const personId = z.uuid();

/**
 * The profile that /profile shows: the person's own without `?person=`, or
 * with their own id (in any letter case); otherwise that person's. Without an
 * organization there are no other members: the own profile comes from the
 * account, and any other person is not available.
 */
export function useProfileView(): ProfileView {
  const requested = useSearchParams().get("person");
  const viewerId = useVerifiedWorkspaceUserId();
  const scope = useAdmittedWorkspaceScope();
  const suspended = useWorkspaceInteractionSuspended();
  const accountOnly = scope === null;
  const person = requested?.toLowerCase() || null;
  const own = !person || person === viewerId.toLowerCase();
  const valid = own || (!accountOnly && personId.safeParse(person).success);
  const targetId = own || !person ? viewerId : person;
  const organizationId = scope?.org_id ?? "";
  const read = useQuery({
    ...personProfileOptions(viewerId, organizationId, targetId),
    enabled: !accountOnly && valid && !suspended,
  });
  const self = useQuery({
    ...profileSelfOptions(viewerId),
    enabled: accountOnly && !suspended,
  });
  if (!valid) return { status: "unavailable" };
  const query = accountOnly ? self : read;
  if (query.error) {
    if (
      !accountOnly &&
      query.error instanceof ApiError &&
      query.error.status === 404
    )
      return { status: "unavailable" };
    return {
      status: "failed",
      own,
      retrying: query.isFetching,
      retry: () => void query.refetch(),
    };
  }
  if (accountOnly)
    return self.data
      ? { status: "ready", own, profile: personProfileFromSelf(self.data) }
      : { status: "loading", own };
  return read.data
    ? { status: "ready", own, profile: read.data }
    : { status: "loading", own };
}
