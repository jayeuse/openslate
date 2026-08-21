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
    warning:
      "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100",
    destructive:
      "border-red-200 bg-red-50 text-red-950 dark:border-red-900 dark:bg-red-950/30 dark:text-red-100",
    success:
      "border-green-200 bg-green-50 text-green-950 dark:border-green-900 dark:bg-green-950/30 dark:text-green-100",
  };
  return (
    <div
      role="status"
      className={cn(
        "rounded-[var(--radius)] border p-4 text-sm",
        styles[variant],
        className,
      )}
      {...props}
    />
  );
}
