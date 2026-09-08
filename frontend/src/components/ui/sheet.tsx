"use client";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { DialogContentProps } from "./dialog";
import { cn } from "@/lib/utils";
export {
  Dialog as Sheet,
  DialogTrigger as SheetTrigger,
  DialogClose as SheetClose,
  DialogHeader as SheetHeader,
  DialogTitle as SheetTitle,
  DialogDescription as SheetDescription,
  DialogFooter as SheetFooter,
} from "./dialog";
export function SheetContent({
  className,
  side = "right",
  ...props
}: DialogContentProps & { side?: "left" | "right" }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className="bg-foreground/20 fixed inset-0 z-50 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none" />
      <DialogPrimitive.Popup
        className={cn(
          "border-border bg-card text-card-foreground fixed inset-y-0 z-50 flex w-[min(85vw,22rem)] flex-col gap-4 overflow-y-auto p-5 shadow-lg transition-transform duration-200 outline-none motion-reduce:transition-none",
          side === "left"
            ? "left-0 border-r data-ending-style:-translate-x-full data-starting-style:-translate-x-full"
            : "right-0 border-l data-ending-style:translate-x-full data-starting-style:translate-x-full",
          className,
        )}
        {...props}
      />
    </DialogPrimitive.Portal>
  );
}
