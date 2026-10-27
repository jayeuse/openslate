import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Member } from "../contract/types";

const LABEL: Record<Member["level"], string> = {
  read: "Read",
  post: "Post",
  manage: "Manager",
};

/** A person's level in a channel, always as text; Manager is the one tinted label. */
export function LevelBadge({
  level,
  label = LABEL[level],
  description,
  className,
}: {
  level: Member["level"];
  /** A grant names its own levels ("Read and post"); the chip stays the same. */
  label?: string;
  /** Why the level stops where it does: the chip's tooltip and description. */
  description?: string;
  className?: string;
}) {
  return (
    <Badge
      variant={
        level === "manage"
          ? "default"
          : level === "post"
            ? "secondary"
            : "outline"
      }
      title={description}
      aria-description={description}
      className={cn(
        "shrink-0",
        level === "manage" && "bg-action-tint text-action-text",
        className,
      )}
    >
      {label}
    </Badge>
  );
}
