import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

// A tint of the ink, not a fill token, so a placeholder shows on the page
// ground and on cards alike, in every look and mode.
export function Skeleton({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "bg-foreground/10 animate-pulse rounded-[var(--radius)] motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}
