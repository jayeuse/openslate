"use client";
import { useVerifiedWorkspaceUserId } from "../../shared/runtime/workspace-identity";
import {
  DEFAULT_COMMS_PREFERENCES,
  resolveCommsSettings,
} from "../domain/configuration";
import { useCommsWorkspaceView } from "./use-comms-workspace";
import { useCommsClient } from "./client-context";

export function useCommsConversation(selected: string) {
  const workspace = useCommsWorkspaceView();
  const { client } = useCommsClient();
  const viewerId = useVerifiedWorkspaceUserId();
  const channel = workspace.channels.find((item) => item.id === selected);
  const direct = workspace.directs.find((item) => item.id === selected);
  const preferences =
    workspace.configuration.preferences[viewerId] ?? DEFAULT_COMMS_PREFERENCES;
  const settings = resolveCommsSettings(
    workspace.configuration,
    channel,
  ).values;
  const check = workspace.checks[selected];
  const canView = !!(channel || direct) && !direct?.blocked;
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
    menuAccess: {
      canManageChannel: check?.capabilities.manageChannel.allowed ?? false,
      canCreate: check?.capabilities.createChannel.allowed ?? false,
      canAdminister: check?.capabilities.manageWorkspace.allowed ?? false,
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
