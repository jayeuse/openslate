"use client";

import type { HTMLAttributes, ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The Sandbox dialog frame, after "Dialogs in Access" (DESIGN.md): the dialog
// content is the one scroller (flex column, so sticky children stick), its
// header keeps the title and a named close button in view, and its footer
// keeps the buttons in view. Short alert dialogs keep the plain layout.

/** The content class for a framed dialog: a flex column, so the frame sticks. */
export const sandboxDialogContentClass = "slim-ui flex flex-col gap-4";

/**
 * The pinned header: the title (a DialogTitle or AlertDialogTitle), an
 * optional description, and a close button named for the dialog.
 */
export function SandboxDialogHeader({
  title,
  description,
  closeLabel,
  closeDisabled,
  onClose,
}: {
  title: ReactNode;
  description?: ReactNode;
  closeLabel: string;
  closeDisabled?: boolean;
  onClose: () => void;
}) {
  return (
    <div className="bg-card sticky -top-5 z-10 -mx-5 -mt-5 flex shrink-0 items-start justify-between gap-3 border-b px-5 pt-3 pb-3">
      <div className="flex min-w-0 flex-col gap-1 pt-2.5 xl:pt-1.5">
        {title}
        {description}
      </div>
      {/* size-11 keeps a 44px target below 1280px; the slim icon-button
          rule makes it 32px from there, as in Access. */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="-mr-2 size-11 shrink-0"
        aria-label={closeLabel}
        disabled={closeDisabled}
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}

/** The pinned footer; its button row is a DialogFooter (or a plain row). */
export function SandboxDialogFooter({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "bg-card sticky -bottom-5 z-10 -mx-5 -mb-5 grid shrink-0 gap-3 border-t px-5 pt-3 pb-4",
        className,
      )}
      {...props}
    />
  );
}
