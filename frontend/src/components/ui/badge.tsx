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
    success: "bg-flow-tint text-flow-text",
    warning: "bg-warn-tint text-warn-text",
    destructive: "bg-danger-tint text-danger-text",
    outline: "border border-border text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        styles[variant],
        className,
      )}
      {...props}
    />
  );
}
