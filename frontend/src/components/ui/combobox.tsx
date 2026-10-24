"use client";

import { Combobox as Primitive } from "@base-ui/react/combobox";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export const Combobox = Primitive.Root;
export const ComboboxList = Primitive.List;
export const ComboboxEmpty = Primitive.Empty;

export function ComboboxTrigger({
  className,
  children,
  ...props
}: Primitive.Trigger.Props) {
  return (
    <Primitive.Trigger
      {...props}
      className={cn(
        "border-input bg-card focus-visible:outline-ring flex h-10 w-full items-center justify-between gap-2 rounded-[var(--radius)] border px-3 text-left text-sm focus-visible:outline-2 disabled:opacity-50",
        className,
      )}
    >
      {children}
      <ChevronDown className="size-4 shrink-0" aria-hidden />
    </Primitive.Trigger>
  );
}
export function ComboboxInput({ className, ...props }: Primitive.Input.Props) {
  return (
    <Primitive.Input
      {...props}
      className={cn(
        "border-input bg-background focus-visible:outline-ring h-10 w-full rounded-[var(--radius)] border px-3 text-sm focus-visible:outline-2",
        className,
      )}
    />
  );
}
export function ComboboxContent({
  children,
  positionerClassName,
  ...props
}: Primitive.Popup.Props & { positionerClassName?: string }) {
  return (
    <Primitive.Portal>
      <Primitive.Positioner
        sideOffset={4}
        className={cn("isolate", positionerClassName)}
      >
        {/* At most 20rem (about 10 slim rows), so the list opens below when
            that fits and flips above only when it does not, covering at most
            20rem (PD55). The positioner sets --available-height. */}
        <Primitive.Popup
          {...props}
          data-slot="combobox-popup"
          className="bg-popover text-popover-foreground border-border flex max-h-[min(20rem,var(--available-height))] w-[var(--anchor-width)] max-w-[var(--available-width)] flex-col gap-2 overflow-y-auto rounded-[var(--radius)] border p-2 shadow-md"
        >
          {children}
        </Primitive.Popup>
      </Primitive.Positioner>
    </Primitive.Portal>
  );
}
/** An option with a check at its end while it is the chosen value (PD55). */
export function ComboboxItem({
  className,
  children,
  ...props
}: Primitive.Item.Props) {
  return (
    <Primitive.Item
      {...props}
      className={cn(
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground flex cursor-default items-center gap-2 rounded-sm px-2 py-2 text-sm outline-none data-disabled:opacity-50",
        className,
      )}
    >
      <span className="min-w-0 flex-1">{children}</span>
      <Primitive.ItemIndicator
        data-slot="combobox-item-indicator"
        className="text-action-text flex shrink-0"
      >
        <Check aria-hidden="true" className="size-4" />
      </Primitive.ItemIndicator>
    </Primitive.Item>
  );
}
export const ComboboxGroup = Primitive.Group;
export const ComboboxCollection = Primitive.Collection;
export function ComboboxGroupLabel({
  className,
  ...props
}: Primitive.GroupLabel.Props) {
  return (
    <Primitive.GroupLabel
      {...props}
      className={cn(
        "text-muted-foreground px-2 pt-2 pb-1 text-xs font-medium",
        className,
      )}
    />
  );
}
