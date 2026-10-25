"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { currentOrganizationId } from "@/lib/organization-context";

const AVATAR_PATH = /^\/api\/users\/[0-9a-f-]{36}\/avatar$/i;

/** Up to two initials from a display name or username; "?" when none. */
export function personInitials(name: string): string {
  const words = name
    .trim()
    .split(/[\s._-]+/u)
    .filter(Boolean);
  const letters = (
    words.length > 1 ? [words[0], words[words.length - 1]] : [words[0] ?? ""]
  ).map((word) => Array.from(word)[0] ?? "");
  return letters.join("").toLocaleUpperCase() || "?";
}

/** A thumbnail (64 or 256 pixels) of an account avatar URL the server returned. */
export function avatarThumbnailUrl(
  avatarUrl: string | null | undefined,
  size: 64 | 256 = 64,
): string | undefined {
  if (!avatarUrl || !AVATAR_PATH.test(avatarUrl)) return undefined;
  const orgId = currentOrganizationId();
  return `${avatarUrl}?size=${size}${orgId ? `&org=${encodeURIComponent(orgId)}` : ""}`;
}

type PersonAvatarProps = {
  name: string;
  /** The account's `/api/users/{id}/avatar` URL, or null when it has none. */
  avatarUrl: string | null | undefined;
  size?: "sm" | "default" | "lg";
  className?: string;
};

/**
 * A decorative avatar beside a person's name: the 64-pixel photo, or their
 * initials while it loads, when there is none, or when it fails.
 */
export function PersonAvatar({
  name,
  avatarUrl,
  size = "sm",
  className,
}: PersonAvatarProps) {
  const src = avatarThumbnailUrl(avatarUrl);
  return (
    <Avatar
      size={size}
      aria-hidden="true"
      className={cn("shrink-0", className)}
    >
      {src ? <AvatarImage src={src} alt="" /> : null}
      <AvatarFallback className="font-medium">
        {personInitials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
