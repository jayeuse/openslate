"use client";
import { useCommsClient } from "./client-context";
import { useCommsRead } from "./runtime";
import { grantReach } from "../domain/channel-creation";
import type { Category } from "../domain/view-model";
import type { CapabilityCheck } from "../contract/types";

/**
 * Where createChannel grants reach the viewer: the workspace creation check,
 * plus one creation check per category of a department the viewer holds a
 * role in (category grants show only there). An admin needs neither.
 */
export function useChannelCreationReach(
  categories: readonly Category[],
  openCheck?: CapabilityCheck,
) {
  const { managedDepartmentIds, departmentRoleIds } = useCommsClient();
  const admin = managedDepartmentIds === "all";
  const creation = useCommsRead(
    "channel-creation:workspace",
    (client, signal) =>
      client.getChannelCreationCheck({ kind: "workspace" }, { signal }),
  );
  const candidates = admin
    ? []
    : categories
        .filter(
          (category) =>
            category.departmentId &&
            departmentRoleIds.has(category.departmentId),
        )
        .map((category) => category.id)
        .sort();
  const categoryChecks = useCommsRead(
    `channel-creation:categories:${candidates.join(",")}`,
    (client, signal) =>
      Promise.all(
        candidates.map(async (categoryId) => ({
          categoryId,
          check: await client.getChannelCreationCheck(
            { kind: "category", id: categoryId },
            { signal },
          ),
        })),
      ),
    candidates.length > 0,
  );
  const reach = grantReach(
    [
      ...(creation.data ? [creation.data.decision] : []),
      ...(openCheck ? [openCheck.capabilities.createChannel] : []),
    ],
    categoryChecks.data ?? [],
  );
  return { admin, creation, candidates, categoryChecks, reach };
}
