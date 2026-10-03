"use client";
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { useState, type ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { useWorkspaceInteractionSuspended } from "@/components/systems/shared/runtime/workspace-identity";
export {
  DialogHeader as AlertDialogHeader,
  DialogFooter as AlertDialogFooter,
} from "./dialog";
export interface AlertDialogProps extends AlertDialogPrimitive.Root.Props {
  dismissible?: boolean;
}
export function AlertDialog({
  dismissible = true,
  onOpenChange,
  ...props
}: AlertDialogProps) {
  const suspended = useWorkspaceInteractionSuspended();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(
    Boolean(props.defaultOpen),
  );
  return (
    <AlertDialogPrimitive.Root
      {...props}
      open={!suspended && (props.open ?? uncontrolledOpen)}
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
        if (!details.isCanceled && props.open === undefined)
          setUncontrolledOpen(open);
      }}
    />
  );
}
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
export const AlertDialogCancel = AlertDialogPrimitive.Close;
export function AlertDialogContent({
  className,
  ...props
}: Omit<ComponentProps<typeof AlertDialogPrimitive.Popup>, "className"> & {
  className?: string;
}) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop className="bg-foreground/20 fixed inset-0 z-50 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none" />
      <AlertDialogPrimitive.Viewport className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
        <AlertDialogPrimitive.Popup
          className={cn(
            "border-border bg-card text-card-foreground pointer-events-auto relative max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-[var(--radius)] border p-5 shadow-lg transition-opacity duration-150 outline-none data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none",
            className,
          )}
          {...props}
        />
      </AlertDialogPrimitive.Viewport>
    </AlertDialogPrimitive.Portal>
  );
}
export function AlertDialogTitle({
  className,
  ...props
}: Omit<ComponentProps<typeof AlertDialogPrimitive.Title>, "className"> & {
  className?: string;
}) {
  return (
    <AlertDialogPrimitive.Title
      className={cn("text-base font-semibold", className)}
      {...props}
    />
  );
}
export function AlertDialogDescription({
  className,
  ...props
}: Omit<
  ComponentProps<typeof AlertDialogPrimitive.Description>,
  "className"
> & { className?: string }) {
  return (
    <AlertDialogPrimitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}
