"use client";
import { Menu } from "@base-ui/react/menu";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuGroup = Menu.Group;
export const DropdownMenuLabel = Menu.GroupLabel;
export function DropdownMenuContent({
  className,
  side = "bottom",
  align = "start",
  sideOffset = 4,
  ...props
}: Omit<ComponentProps<typeof Menu.Popup>, "className"> & {
  className?: string;
  side?: ComponentProps<typeof Menu.Positioner>["side"];
  align?: ComponentProps<typeof Menu.Positioner>["align"];
  sideOffset?: number;
}) {
  return (
    <Menu.Portal>
      <Menu.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        className="z-50 outline-none"
      >
        <Menu.Popup
          className={cn(
            "border-border bg-popover text-popover-foreground min-w-40 rounded-[var(--radius)] border p-1 shadow-md transition-opacity duration-100 outline-none data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none",
            className,
          )}
          {...props}
        />
      </Menu.Positioner>
    </Menu.Portal>
  );
}
export function DropdownMenuItem({
  className,
  variant = "default",
  ...props
}: Omit<ComponentProps<typeof Menu.Item>, "className"> & {
  className?: string;
  variant?: "default" | "destructive";
}) {
  return (
    <Menu.Item
      className={cn(
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:size-4",
        variant === "destructive" && "text-destructive",
        className,
      )}
      {...props}
    />
  );
}
export function DropdownMenuSeparator({
  className,
  ...props
}: Omit<ComponentProps<typeof Menu.Separator>, "className"> & {
  className?: string;
}) {
  return (
    <Menu.Separator
      className={cn("bg-border -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}
