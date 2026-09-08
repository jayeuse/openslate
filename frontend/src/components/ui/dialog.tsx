"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { ComponentProps, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface DialogProps extends DialogPrimitive.Root.Props {
  dismissible?: boolean;
}
export function Dialog({
  dismissible = true,
  onOpenChange,
  ...props
}: DialogProps) {
  return (
    <DialogPrimitive.Root
      {...props}
      disablePointerDismissal={!dismissible || props.disablePointerDismissal}
      onOpenChange={(open, details) => {
        if (!open && !dismissible) {
          details.cancel();
          return;
        }
        onOpenChange?.(open, details);
      }}
    />
  );
}
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export type DialogContentProps = Omit<
  ComponentProps<typeof DialogPrimitive.Popup>,
  "className"
> & { className?: string };
export function DialogContent({ className, ...props }: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        data-testid="dialog-backdrop"
        className="bg-foreground/20 fixed inset-0 z-50 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none"
      />
      <DialogPrimitive.Viewport className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
        <DialogPrimitive.Popup
          className={cn(
            "border-border bg-card text-card-foreground pointer-events-auto relative max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-[var(--radius)] border p-5 shadow-lg transition-opacity duration-150 outline-none data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none",
            className,
          )}
          {...props}
        />
      </DialogPrimitive.Viewport>
    </DialogPrimitive.Portal>
  );
}
export function DialogHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5", className)} {...props} />;
}
export function DialogTitle({
  className,
  ...props
}: Omit<ComponentProps<typeof DialogPrimitive.Title>, "className"> & {
  className?: string;
}) {
  return (
    <DialogPrimitive.Title
      className={cn("text-base font-semibold", className)}
      {...props}
    />
  );
}
export function DialogDescription({
  className,
  ...props
}: Omit<ComponentProps<typeof DialogPrimitive.Description>, "className"> & {
  className?: string;
}) {
  return (
    <DialogPrimitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}
export function DialogFooter({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}
