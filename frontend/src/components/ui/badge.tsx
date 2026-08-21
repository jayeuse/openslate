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
    success:
      "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
    warning:
      "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    destructive: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
    outline: "border border-border text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium",
        styles[variant],
        className,
      )}
      {...props}
    />
  );
}
