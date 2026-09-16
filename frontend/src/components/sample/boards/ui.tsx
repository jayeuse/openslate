"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export function BoardEmpty({
  title,
  description,
  icon,
  children,
}: {
  title: string;
  description: string;
  icon?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Empty className="min-h-64 rounded-xl border border-dashed">
      <EmptyHeader>
        {icon && <EmptyMedia variant="icon">{icon}</EmptyMedia>}
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children}
    </Empty>
  );
}

export function ConfirmAction({
  open,
  title,
  description,
  action,
  phrase,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  action: string;
  phrase?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const id = useId();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setTyped("");
          onCancel();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {phrase && (
          <Field className="mt-4">
            <FieldLabel htmlFor={id}>Type “{phrase}” to confirm</FieldLabel>
            <Input
              id={id}
              value={typed}
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
            />
          </Field>
        )}
        <AlertDialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => {
              setTyped("");
              onCancel();
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="min-h-11"
            disabled={phrase !== undefined && typed !== phrase}
            onClick={() => {
              setTyped("");
              onConfirm();
            }}
          >
            {action}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function EditSheet({
  open,
  title,
  description,
  dirty,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description: string;
  dirty: boolean;
  onClose: () => void;
  children: ReactNode | ((requestClose: () => void) => ReactNode);
}) {
  const [discard, setDiscard] = useState(false);
  const [destination, setDestination] = useState<string | null>(null);
  const router = useRouter();
  useEffect(() => {
    if (!open || !dirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const followLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
      const anchor =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : null;
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download")
      )
        return;
      if (anchor.href === window.location.href) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setDestination(anchor.href);
      setDiscard(true);
    };
    window.addEventListener("beforeunload", preventUnload);
    document.addEventListener("click", followLink, true);
    return () => {
      window.removeEventListener("beforeunload", preventUnload);
      document.removeEventListener("click", followLink, true);
    };
  }, [open, dirty]);
  function requestClose() {
    if (dirty) setDiscard(true);
    else onClose();
  }
  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!next) requestClose();
        }}
      >
        <SheetContent className="w-full gap-6 sm:w-[min(92vw,40rem)]">
          <SheetHeader className="pr-10">
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </SheetHeader>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            aria-label={`Close ${title.toLowerCase()}`}
            className="absolute top-3 right-3 size-11"
            onClick={requestClose}
          >
            <X />
          </Button>
          {typeof children === "function" ? children(requestClose) : children}
        </SheetContent>
      </Sheet>
      <ConfirmAction
        open={discard}
        title="Discard unsaved changes?"
        description="Your saved content stays as it is. Changes made in this editor will be discarded."
        action="Discard changes"
        onCancel={() => {
          setDiscard(false);
          setDestination(null);
        }}
        onConfirm={() => {
          setDiscard(false);
          onClose();
          if (destination) {
            const url = new URL(destination);
            setDestination(null);
            if (url.origin === window.location.origin)
              router.push(`${url.pathname}${url.search}${url.hash}` as Route);
            else setTimeout(() => window.location.assign(url.href), 0);
          }
        }}
      />
    </>
  );
}
