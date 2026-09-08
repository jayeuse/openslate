"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { ChevronDown } from "lucide-react";
import type { OptionHTMLAttributes, SelectHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

const selectVariants = cva(
  "border-input bg-card text-foreground focus-visible:border-primary w-full appearance-none rounded-[var(--radius)] border pr-9 shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      size: {
        default: "h-10 px-3 text-sm",
        sm: "h-8 px-2.5 text-xs",
      },
    },
    defaultVariants: {
      size: "default",
    },
  },
);

export interface SelectProps
  extends
    Omit<
      SelectHTMLAttributes<HTMLSelectElement>,
      "onChange" | "size" | "value"
    >,
    VariantProps<typeof selectVariants> {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
}

/**
 * Accessible native `<select>` styled with semantic tokens.
 *
 * Native fallback (no Radix dependency): keyboard, screen-reader, and
 * light/dark behavior come from the platform control + tokens.
 */
export function Select({
  className,
  size,
  value,
  onValueChange,
  placeholder,
  children,
  ...props
}: SelectProps) {
  return (
    <span className="relative inline-flex w-full items-center">
      <select
        {...props}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        className={cn(selectVariants({ size, className }))}
      >
        {placeholder !== undefined && placeholder.length > 0 ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="text-muted-foreground pointer-events-none absolute right-3 size-4"
      />
    </span>
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: OptionHTMLAttributes<HTMLOptionElement> & { value: string }) {
  return (
    <option className={cn(className)} {...props}>
      {children}
    </option>
  );
}
