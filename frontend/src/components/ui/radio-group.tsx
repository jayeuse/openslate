"use client";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { Radio } from "@base-ui/react/radio";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
export function RadioGroup({
  className,
  ...props
}: Omit<ComponentProps<typeof RadioGroupPrimitive>, "className"> & {
  className?: string;
}) {
  return (
    <RadioGroupPrimitive className={cn("grid gap-3", className)} {...props} />
  );
}
export function RadioGroupItem({
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof Radio.Root>, "className"> & {
  className?: string;
}) {
  return (
    <Radio.Root
      className={cn(
        "border-input text-primary focus-visible:outline-ring data-checked:border-primary flex size-4 shrink-0 items-center justify-center rounded-full border outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children ?? (
        <Radio.Indicator className="size-2 rounded-full bg-current" />
      )}
    </Radio.Root>
  );
}
