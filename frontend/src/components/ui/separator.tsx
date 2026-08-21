import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Separator({
  className,
  ...props
}: HTMLAttributes<HTMLHRElement>) {
  return (
    <hr
      className={cn("border-border border-0 border-t", className)}
      {...props}
    />
  );
}
