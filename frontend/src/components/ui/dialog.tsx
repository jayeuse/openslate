"use client";

import {
  useEffect,
  type DialogHTMLAttributes,
  type HTMLAttributes,
} from "react";

import { cn } from "@/lib/utils";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

/**
 * Minimal accessible dialog built on the native `<dialog>` element.
 *
 * No extra dependencies: the root renders a fixed overlay and handles
 * Escape + backdrop dismissal + body scroll lock. Content uses
 * `<dialog open>` so semantics survive without `showModal()`.
 */
export function Dialog({ open, onOpenChange, children }: DialogProps) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onOpenChange]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close dialog"
        data-testid="dialog-backdrop"
        onClick={() => onOpenChange(false)}
        className="bg-foreground/20 absolute inset-0 cursor-default"
      />
      {children}
    </div>
  );
}

export function DialogContent({
  className,
  children,
  ...props
}: DialogHTMLAttributes<HTMLDialogElement>) {
  return (
    <dialog
      {...props}
      open
      aria-modal="true"
      className={cn(
        "border-border bg-card text-card-foreground relative z-10 max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-[var(--radius)] border p-5 shadow-lg",
        className,
      )}
    >
      {children}
    </dialog>
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
}: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-base font-semibold", className)} {...props} />;
}

export function DialogDescription({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("text-muted-foreground text-sm", className)} {...props} />
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
