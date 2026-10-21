"use client";
import type { ComponentProps } from "react";
import { PersonCardPopover } from "@/components/person-card";
import { cn } from "@/lib/utils";
import { useCommsClient } from "../state/client-context";
import { ProfilePopover } from "./floating";
import { useCommsWorkspaceView } from "../state/use-comms-workspace";

export function PersonLink({
  avatarOnly,
  open,
  onOpenChange,
  ...props
}: ComponentProps<typeof ProfilePopover> & {
  avatarOnly?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { scope, client } = useCommsClient();
  const workspace = useCommsWorkspaceView();
  // Only live DTO identities may reach the authorized core profile boundary.
  return scope ? (
    <PersonCardPopover
      personId={props.person.id}
      label={props.person.name}
      decoration="none"
      open={open}
      onOpenChange={onOpenChange}
      presence={
        workspace.client === client &&
        Object.hasOwn(workspace.presence, props.person.id)
          ? props.presence
          : undefined
      }
      className={cn(
        props.className,
        avatarOnly && "[&>span:last-child]:sr-only",
      )}
    />
  ) : (
    <ProfilePopover {...props} />
  );
}
