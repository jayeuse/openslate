"use client";

import { useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog";

export interface ConfigurationFrameProps {
  title: string;
  description?: string;
  opener?: HTMLElement | null;
  dirty?: boolean;
  onClose: () => void;
  onSave?: () => void | boolean | Promise<void | boolean>;
  children: ReactNode;
  saveLabel?: string;
  footer?: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function ConfigurationFrame({
  title,
  description,
  opener,
  dirty = false,
  onClose,
  onSave,
  children,
  saveLabel = "Save changes",
  footer,
  disabled = false,
  className,
}: ConfigurationFrameProps) {
  const keepEditing = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  function requestClose() {
    if (saving) return;
    if (confirmClose) setConfirmClose(false);
    else if (dirty) {
      previousFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setConfirmClose(true);
    } else onClose();
  }
  async function save() {
    if (!onSave || saving || disabled) return;
    setSaving(true);
    setError("");
    try {
      await onSave();
    } catch {
      setError("Changes could not be saved. Your draft is still available.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <DialogContent
        finalFocus={() => opener ?? false}
        className={cn(
          "flex h-[90dvh] max-h-[90dvh] max-w-5xl flex-col overflow-hidden p-0",
          className,
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="mt-1">
              {description || "Configure how your conversations work."}
            </DialogDescription>
          </div>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label="Close settings"
                    className="shrink-0"
                    onClick={requestClose}
                    disabled={saving}
                  />
                }
              >
                <X aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>Close settings</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </header>
        <Separator className="shrink-0" />
        <ScrollArea className="min-h-0 flex-1 overflow-hidden [&_[data-slot=scroll-area-viewport]]:[scrollbar-gutter:stable] [&_[data-slot=scroll-area-viewport]]:overscroll-contain">
          {children}
        </ScrollArea>
        <Separator className="shrink-0" />
        <footer className="bg-muted/15 grid shrink-0 grid-cols-2 items-center justify-end gap-2 px-5 py-4 sm:flex sm:flex-wrap sm:px-6">
          {error && (
            <Alert
              role="alert"
              variant="destructive"
              className="col-span-2 mr-auto"
            >
              {error}
            </Alert>
          )}
          {footer && <div className="col-span-2 mr-auto">{footer}</div>}
          <Button
            type="button"
            variant="outline"
            className={cn("min-h-11", !onSave && "col-start-2")}
            onClick={requestClose}
            disabled={saving}
          >
            {onSave ? "Cancel" : "Close"}
          </Button>
          {onSave && (
            <Button
              type="button"
              className="min-h-11"
              onClick={() => void save()}
              disabled={saving || disabled}
            >
              {saving ? "Saving…" : saveLabel}
            </Button>
          )}
        </footer>
        <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
          <AlertDialogContent
            initialFocus={keepEditing}
            finalFocus={() => previousFocus.current ?? false}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Discard changes?</AlertDialogTitle>
              <AlertDialogDescription>
                You have unsaved changes. Keep editing or discard this draft.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button
                ref={keepEditing}
                type="button"
                variant="outline"
                onClick={() => setConfirmClose(false)}
              >
                Keep editing
              </Button>
              <Button type="button" variant="destructive" onClick={onClose}>
                Discard changes
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
