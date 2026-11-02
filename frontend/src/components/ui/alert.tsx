import type { HTMLAttributes } from "react";

import { ErrorReference } from "@/components/ui/error-reference";
import { cn } from "@/lib/utils";

export function Alert({
  className,
  variant = "default",
  reference,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  variant?: "default" | "warning" | "destructive" | "success";
  /** The failed request's full ID. It renders as the error reference, always
   * the last part of the alert (D1.4, docs/specs/system-health.md); with no
   * ID it renders nothing. */
  reference?: string | null;
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
      data-slot="alert"
      data-variant={variant}
      className={cn(
        "rounded-[var(--radius)] border p-4 text-sm",
        styles[variant],
        className,
      )}
      {...props}
    >
      {children}
      {reference ? (
        <ErrorReference id={reference} className="basis-full" />
      ) : null}
    </div>
  );
}
