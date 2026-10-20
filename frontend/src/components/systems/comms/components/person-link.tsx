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
  const { scope } = useCommsClient();
  // Only live DTO identities may reach the authorized core profile boundary.
  return scope?.kind === "live" ? (
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
