"use client";

import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Progress({
  className,
  value,
  max = 100,
  ...props
}: Omit<ComponentProps<typeof ProgressPrimitive.Root>, "className"> & {
  className?: string;
}) {
  const percentage =
    value === null ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <ProgressPrimitive.Root
      className={cn(
        "bg-muted h-2 w-full overflow-hidden rounded-full",
        className,
      )}
      value={value === null ? null : Math.min(max, Math.max(0, value))}
      max={max}
      {...props}
    >
      <ProgressPrimitive.Track className="h-full w-full">
        <ProgressPrimitive.Indicator
          className="bg-primary h-full transition-[width] motion-reduce:transition-none"
          style={{ width: `${percentage}%` }}
        />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
}
