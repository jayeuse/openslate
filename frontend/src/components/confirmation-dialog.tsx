"use client";
import { useRef, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
export interface ConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
}
export function ConfirmationDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  pending = false,
}: ConfirmationDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange} dismissible={!pending}>
      <AlertDialogContent initialFocus={cancelRef} aria-busy={pending}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            render={
              <Button ref={cancelRef} variant="outline" disabled={pending} />
            }
          >
            Cancel
          </AlertDialogCancel>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending ? "Working…" : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
