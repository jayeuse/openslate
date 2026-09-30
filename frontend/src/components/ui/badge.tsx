import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function Badge({
  className,
  variant = "default",
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  variant?:
    "default" | "secondary" | "success" | "warning" | "destructive" | "outline";
}) {
  const styles = {
    default: "bg-accent text-accent-foreground",
    secondary: "bg-secondary text-secondary-foreground",
    // Status chips: an inset hairline in the signal's rule, as on the website.
    // Sentence case, because many carry dates or phrases.
    success:
      "bg-flow-tint text-flow-text shadow-[inset_0_0_0_1px_var(--flow-rule)] rounded-chip font-semibold",
    warning:
      "bg-warn-tint text-warn-text shadow-[inset_0_0_0_1px_var(--warn-rule)] rounded-chip font-semibold",
    destructive:
      "bg-danger-tint text-danger-text shadow-[inset_0_0_0_1px_var(--danger-rule)] rounded-chip font-semibold",
    outline: "border border-border text-muted-foreground",
  };
  return (
    <span
      data-slot="badge"
      data-variant={variant}
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        styles[variant],
        className,
      )}
      {...props}
    />
  );
}
