import type { InputHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "border-input bg-card text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:outline-ring h-10 w-full rounded-[var(--radius)] border px-3 text-sm transition focus-visible:outline-2 focus-visible:outline-offset-1",
        className,
      )}
      {...props}
    />
  );
}
