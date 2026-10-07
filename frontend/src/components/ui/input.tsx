import type { InputHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      data-slot="input"
      className={cn(
        "border-input bg-card placeholder:text-muted-foreground focus-visible:border-primary focus-visible:outline-ring aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 disabled:bg-muted disabled:text-muted-foreground h-10 w-full rounded-[var(--radius)] border px-3 text-sm text-[color:var(--data-ink)] transition focus-visible:outline-2 focus-visible:outline-offset-1 disabled:cursor-not-allowed aria-invalid:ring-3 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [&[type=number]]:[appearance:textfield]",
        className,
      )}
      {...props}
    />
  );
}
