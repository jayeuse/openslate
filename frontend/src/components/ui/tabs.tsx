"use client";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
export function Tabs({
  className,
  ...props
}: Omit<ComponentProps<typeof TabsPrimitive.Root>, "className"> & {
  className?: string;
}) {
  return (
    <TabsPrimitive.Root
      className={cn("flex flex-col gap-4", className)}
      {...props}
    />
  );
}
export function TabsList({
  className,
  ...props
}: Omit<ComponentProps<typeof TabsPrimitive.List>, "className"> & {
  className?: string;
}) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "bg-muted text-muted-foreground inline-flex w-fit items-center gap-1 rounded-[var(--radius)] p-1",
        className,
      )}
      {...props}
    />
  );
}
export function TabsTrigger({
  className,
  ...props
}: Omit<ComponentProps<typeof TabsPrimitive.Tab>, "className"> & {
  className?: string;
}) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "focus-visible:outline-ring data-active:bg-card data-active:text-foreground inline-flex items-center justify-center rounded-sm px-3 py-1.5 text-sm font-medium outline-none focus-visible:outline-2 disabled:opacity-50 data-active:shadow-sm",
        className,
      )}
      {...props}
    />
  );
}
export function TabsContent({
  className,
  ...props
}: Omit<ComponentProps<typeof TabsPrimitive.Panel>, "className"> & {
  className?: string;
}) {
  return (
    <TabsPrimitive.Panel
      className={cn(
        "focus-visible:outline-ring outline-none focus-visible:outline-2",
        className,
      )}
      {...props}
    />
  );
}
