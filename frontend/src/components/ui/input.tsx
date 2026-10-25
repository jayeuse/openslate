import type { InputHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

/**
 * 16px text below 768px, as the textarea has, so iOS Safari does not zoom
 * the page when a field takes focus (PD56); 14px from 768px.
 */
export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      data-slot="input"
      className={cn(
        "border-input bg-card placeholder:text-muted-foreground focus-visible:border-primary focus-visible:outline-ring aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 disabled:bg-muted disabled:text-muted-foreground h-10 w-full rounded-[var(--radius)] border px-3 text-base text-[color:var(--data-ink)] transition focus-visible:outline-2 focus-visible:outline-offset-1 disabled:cursor-not-allowed aria-invalid:ring-3 md:text-sm [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [&[type=number]]:[appearance:textfield]",
        className,
      )}
      {...props}
    />
  );
}
