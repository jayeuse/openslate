import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function Alert({
  className,
  variant = "default",
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  variant?: "default" | "warning" | "destructive" | "success";
}) {
  const styles = {
    default: "border-border bg-card",
    warning: "border-warn-rule bg-warn-tint text-foreground",
    destructive: "border-danger-rule bg-danger-tint text-foreground",
    success: "border-flow-rule bg-flow-tint text-foreground",
  };
  return (
    <div
      role={variant === "destructive" ? "alert" : "status"}
      className={cn(
        "rounded-[var(--radius)] border p-4 text-sm",
        styles[variant],
        className,
      )}
      {...props}
    />
  );
}
