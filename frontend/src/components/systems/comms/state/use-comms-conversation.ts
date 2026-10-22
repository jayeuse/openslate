"use client";
import { useState } from "react";
import { useVerifiedWorkspaceUserId } from "../../shared/runtime/workspace-identity";
import {
  DEFAULT_COMMS_PREFERENCES,
  resolveCommsSettings,
} from "../domain/configuration";
import { useCommsWorkspaceView } from "./use-comms-workspace";
import { useCommsClient } from "./client-context";
import { creationLocked } from "../domain/channel-creation";
import { useChannelCreationReach } from "./use-channel-creation";
import {
  useConversationDetail,
  useConversationPresence,
} from "./use-conversation-detail";
import { isCommsReadRefusal } from "./runtime";

export function useCommsConversation(selected: string) {
  const workspace = useCommsWorkspaceView();
  const { client, managedDepartmentIds } = useCommsClient();
  // Members, check, settings and pins load for the open conversation only.
  // After a refusal it stays concealed until its detail is read again.
  const detail = useConversationDetail(selected || undefined);
  useConversationPresence(selected || undefined);
  // A retry resets the refused read to pending, so the refusal is remembered
  // until a detail read lands after it.
  const [refusal, setRefusal] = useState<{ id: string; at: number } | null>(
    null,
  );
  if (
    detail.isError &&
    isCommsReadRefusal(detail.error) &&
    (refusal?.id !== selected || refusal.at !== detail.errorUpdatedAt)
  )
    setRefusal({ id: selected, at: detail.errorUpdatedAt });
  const detailRefused =
    refusal?.id === selected && detail.dataUpdatedAt < refusal.at;
  // What the composer says while the check is not known: loading, or a
  // failure that is not a refusal (with Retry).
  const detailStatus: "loading" | "error" | "ready" = detail.data
    ? "ready"
    : detail.isError && !isCommsReadRefusal(detail.error)
      ? "error"
      : "loading";
  const check = workspace.checks[selected];
  const { creation, reach } = useChannelCreationReach(
    workspace.categories,
    check,
  );
  const granted = reach.workspace || reach.categoryIds.size > 0;
  const viewerId = useVerifiedWorkspaceUserId();
  const channel = workspace.channels.find((item) => item.id === selected);
  const direct = workspace.directs.find((item) => item.id === selected);
  const preferences =
    workspace.configuration.preferences[viewerId] ?? DEFAULT_COMMS_PREFERENCES;
  const settings = resolveCommsSettings(
    workspace.configuration,
    channel,
  ).values;
  const canView = !!(channel || direct) && !direct?.blocked && !detailRefused;
  const canParticipate =
    !!client &&
    canView &&
    !!check &&
    check.membership_role !== "guest" &&
    !channel?.archived &&
    !direct?.blocked &&
    !settings.locked;
  const canPost =
    canParticipate &&
    (check?.conversation_level === "post" ||
      check?.conversation_level === "manage") &&
    (settings.mode !== "announcements" || check?.manager_source !== null);
  return {
    channel,
    direct,
    preferences,
    settings,
    check,
    viewerId,
    canView,
    canParticipate,
    canPost,
    detailStatus,
    retryDetail: () => {
      void detail.refetch();
    },
    menuAccess: {
      canManageChannel: check?.capabilities.manageChannel.allowed ?? false,
      // A department manager, or a grant holder with a department role,
      // creates department channels (D44 A7); the workspace check names no
      // department, so it cannot admit them. A workspace lock on
      // createChannel turns the department-manager default off.
      canCreate:
        creation.data?.decision.allowed === true ||
        (check?.capabilities.createChannel.allowed ?? false) ||
        managedDepartmentIds === "all" ||
        (!creationLocked(creation.data) && managedDepartmentIds.size > 0) ||
        granted,
      // The API creates categories only for admins and holders of a
      // workspace-level createChannel grant; department managers cannot.
      canCreateCategory:
        managedDepartmentIds === "all" ||
        creation.data?.decision.allowed === true,
      canAdminister:
        creation.data?.membership_role === "admin" ||
        (check?.capabilities.manageWorkspace.allowed ?? false),
    },
    identity: {
      people: workspace.people,
      roles: workspace.roles,
      viewerId,
      viewerPresence: workspace.account.presence,
      presence: workspace.presence,
      elevated: check?.capabilities.pin.allowed ?? false,
      allowDownload: canView && settings.fileDownloads,
      preferences,
      settings,
      capabilities: check?.capabilities,
      membershipRole: check?.membership_role,
    },
  };
}
export type CommsConversation = ReturnType<typeof useCommsConversation>;
