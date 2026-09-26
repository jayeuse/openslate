"use client";
import { Field as FieldPrimitive } from "@base-ui/react/field";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
export function Field({
  className,
  ...props
}: Omit<ComponentProps<typeof FieldPrimitive.Root>, "className"> & {
  className?: string;
}) {
  return (
    <FieldPrimitive.Root
      className={cn("flex flex-col gap-2 data-disabled:opacity-50", className)}
      {...props}
    />
  );
}
export const FieldControl = FieldPrimitive.Control;
export function FieldLabel({
  className,
  ...props
}: Omit<ComponentProps<typeof FieldPrimitive.Label>, "className"> & {
  className?: string;
}) {
  return (
    <FieldPrimitive.Label
      data-slot="field-label"
      className={cn("text-sm font-medium", className)}
      {...props}
    />
  );
}
export function FieldDescription({
  className,
  ...props
}: Omit<ComponentProps<typeof FieldPrimitive.Description>, "className"> & {
  className?: string;
}) {
  return (
    <FieldPrimitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}
export function FieldError({
  className,
  children,
  errors,
  role = "alert",
  ...props
}: Omit<ComponentProps<typeof FieldPrimitive.Error>, "className"> & {
  className?: string;
  errors?: ({ message?: string } | undefined)[];
}) {
  const messages = [
    ...new Set(errors?.map((error) => error?.message).filter(Boolean)),
  ];
  const content = children ?? messages.join(" ");
  if (!content) return null;
  return (
    <FieldPrimitive.Error
      match
      role={role}
      className={cn("text-destructive text-sm", className)}
      {...props}
    >
      {content}
    </FieldPrimitive.Error>
  );
}
export function FieldGroup({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-5", className)} {...props} />;
}
export function FieldSet({ className, ...props }: ComponentProps<"fieldset">) {
  return (
    <fieldset className={cn("flex flex-col gap-4", className)} {...props} />
  );
}
export function FieldLegend({ className, ...props }: ComponentProps<"legend">) {
  return (
    <legend className={cn("mb-2 text-sm font-medium", className)} {...props} />
  );
}
