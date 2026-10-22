"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, X } from "lucide-react";
import type { WorkspaceNavigationGuard } from "@/components/workspace-navigation-guard";
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
import { useDiscardGuard } from "../../shared/hooks/use-discard-guard";

export interface ConfigurationFrameProps {
  title: string;
  description?: string;
  opener?: HTMLElement | null;
  dirty?: boolean;
  onClose: () => void;
  onSave?: () => void | boolean | Promise<void | boolean>;
  children: ReactNode;
  saveLabel?: string;
  /** Name of the header close button (default "Close settings"). */
  closeLabel?: string;
  footer?: ReactNode;
  disabled?: boolean;
  className?: string;
  embedded?: {
    registerGuard: (guard: WorkspaceNavigationGuard | null) => void;
  };
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
  closeLabel = "Close settings",
  footer,
  disabled = false,
  className,
  embedded,
}: ConfigurationFrameProps) {
  const keepEditing = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fields = useRef<HTMLFieldSetElement>(null);
  const pendingNavigation = useRef<(() => void) | null>(null);
  const {
    discardOpen,
    requestClose: guardRequestClose,
    cancelDiscard,
    confirmDiscard,
  } = useDiscardGuard({
    dirty,
    pending: saving || disabled,
    onClose: () => {
      const resume = pendingNavigation.current;
      pendingNavigation.current = null;
      if (resume) resume();
      else onClose();
    },
  });
  useEffect(() => {
    if (!embedded) return;
    embedded.registerGuard((_href, resume) => {
      if (saving || disabled) return false;
      if (!dirty) return true;
      pendingNavigation.current = resume;
      previousFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      guardRequestClose();
      return false;
    });
    return () => embedded.registerGuard(null);
  }, [embedded, dirty, saving, disabled, guardRequestClose]);
  function requestClose() {
    if (saving || disabled) return;
    pendingNavigation.current = null;
    if (dirty && !discardOpen) {
      previousFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    }
    guardRequestClose();
  }
  async function save() {
    if (!onSave || saving || disabled) return;
    setSaving(true);
    setError("");
    let accepted = false;
    try {
      accepted = (await onSave()) !== false;
    } catch {
      setError("Changes could not be saved. Your draft is still available.");
    } finally {
      setSaving(false);
      if (!accepted)
        requestAnimationFrame(() =>
          fields.current
            ?.querySelector<HTMLElement>('[aria-invalid="true"]')
            ?.focus(),
        );
    }
  }
  const content = (
    <>
      <header className="flex shrink-0 items-start justify-between gap-4 px-5 py-4 sm:px-6">
        <div className="min-w-0">
          {embedded ? (
            <h2 className="text-lg font-semibold">{title}</h2>
          ) : (
            <DialogTitle>{title}</DialogTitle>
          )}
          {description &&
            (embedded ? (
              <p className="text-muted-foreground mt-1 text-sm">
                {description}
              </p>
            ) : (
              <DialogDescription className="mt-1">
                {description}
              </DialogDescription>
            ))}
        </div>
        {embedded ? (
          <Button
            type="button"
            variant="ghost"
            aria-label="Back to conversation"
            onClick={requestClose}
            disabled={saving || disabled}
          >
            <ArrowLeft />
            Back
          </Button>
        ) : (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={closeLabel}
                    className="shrink-0"
                    onClick={requestClose}
                    disabled={saving}
                  />
                }
              >
                <X aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>{closeLabel}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </header>
      <Separator className="shrink-0" />
      <ScrollArea className="min-h-0 flex-1 overflow-hidden [&_[data-slot=scroll-area-viewport]]:[scrollbar-gutter:stable] [&_[data-slot=scroll-area-viewport]]:overscroll-contain">
        <fieldset
          ref={fields}
          disabled={saving}
          aria-busy={saving}
          className="contents"
        >
          {children}
        </fieldset>
      </ScrollArea>
      <Separator className="shrink-0" />
      {(!embedded || onSave || footer || error) && (
        <footer className="bg-muted/15 flex shrink-0 flex-wrap items-center justify-end gap-2 px-5 py-4 sm:px-6">
          {error && (
            <Alert role="alert" variant="destructive" className="w-full">
              {error}
            </Alert>
          )}
          {footer && (
            <fieldset disabled={saving} className="contents">
              <div className="mr-auto">{footer}</div>
            </fieldset>
          )}
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
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
      )}
      <AlertDialog
        open={discardOpen}
        onOpenChange={(open) => {
          if (!open) cancelDiscard();
        }}
      >
        <AlertDialogContent
          className="max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-11"
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
              onClick={cancelDiscard}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={confirmDiscard}
              disabled={saving}
            >
              Discard changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
  return embedded ? (
    <section
      role="region"
      aria-label={title}
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col overflow-hidden",
        className,
      )}
    >
      {content}
    </section>
  ) : (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <DialogContent
        finalFocus={() => opener ?? false}
        className={cn(
          "flex h-[90dvh] max-h-[90dvh] max-w-5xl flex-col overflow-hidden p-0 [&_button]:min-h-6 [&_button]:min-w-6 max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-11",
          className,
        )}
      >
        {content}
      </DialogContent>
    </Dialog>
  );
}
