"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { useWorkspaceInteractionSuspended } from "@/components/systems/shared/runtime/workspace-identity";

export interface DialogProps extends DialogPrimitive.Root.Props {
  dismissible?: boolean;
}
export function Dialog({
  dismissible = true,
  onOpenChange,
  ...props
}: DialogProps) {
  const suspended = useWorkspaceInteractionSuspended();
  return (
    <DialogPrimitive.Root
      {...props}
      modal={suspended ? false : props.modal}
      disablePointerDismissal={!dismissible || props.disablePointerDismissal}
      onOpenChange={(open, details) => {
        if (suspended) {
          details.cancel();
          return;
        }
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
/** A close (X) button for large dialogs; place it inside DialogContent. */
export function DialogCloseButton({ disabled }: { disabled?: boolean }) {
  return (
    <DialogPrimitive.Close
      aria-label="Close"
      disabled={disabled}
      className="text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:outline-ring absolute top-3 right-3 z-10 inline-flex size-11 items-center justify-center rounded-md outline-none focus-visible:outline-2 disabled:opacity-50 xl:size-8"
    >
      <X aria-hidden="true" className="size-4" />
    </DialogPrimitive.Close>
  );
}
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
          data-slot="dialog-content"
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
