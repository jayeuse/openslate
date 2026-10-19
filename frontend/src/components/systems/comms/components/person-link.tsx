"use client";
import type { ComponentProps } from "react";
import { PersonCardPopover } from "@/components/person-card";
import { cn } from "@/lib/utils";
import { useCommsClient } from "../state/client-context";
import { ProfilePopover } from "./floating";

export function PersonLink({
  avatarOnly,
  ...props
}: ComponentProps<typeof ProfilePopover> & { avatarOnly?: boolean }) {
  const { client } = useCommsClient();
  // Phase A verifies only the admitted account against core identity. A UUID
  // from the local directory is not evidence of a real core profile.
  return props.person.id === client?.context.user_id ? (
    <PersonCardPopover
      personId={props.person.id}
      label={props.person.name}
      decoration="none"
      className={cn(
        props.className,
        avatarOnly && "[&>span:last-child]:sr-only",
      )}
    />
  ) : (
    <ProfilePopover {...props} />
  );
}
