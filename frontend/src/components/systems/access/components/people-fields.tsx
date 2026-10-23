"use client";

import type { InputHTMLAttributes, ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";

import { ActionError } from "./editor-conflicts";

// Labelled fields shared by the invitation form and the person editor. Each
// field ties its hint and error to the control with aria-describedby.

function describedBy(
  id: string,
  description?: ReactNode,
  error?: string | null,
) {
  return (
    [description ? `${id}-hint` : null, error ? `${id}-error` : null]
      .filter(Boolean)
      .join(" ") || undefined
  );
}

export function TextField({
  id,
  label,
  value,
  onChange,
  description,
  error,
  ...input
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  description?: ReactNode;
  error?: string | null;
} & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "id" | "value" | "onChange" | "className"
>) {
  return (
    <Field className="min-w-0">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        {...input}
        id={id}
        value={value}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy(id, description, error)}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-11"
      />
      {description ? (
        <FieldDescription id={`${id}-hint`}>{description}</FieldDescription>
      ) : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}

export function SelectField({
  id,
  label,
  value,
  options,
  onChange,
  description,
  error,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  description?: ReactNode;
  error?: string | null;
  disabled?: boolean;
}) {
  return (
    <Field className="min-w-0">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <NativeSelect
        id={id}
        value={value}
        disabled={disabled}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy(id, description, error)}
        className="w-full [&_select]:min-h-11"
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <NativeSelectOption key={option.value} value={option.value}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {description ? (
        <FieldDescription id={`${id}-hint`}>{description}</FieldDescription>
      ) : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}

/**
 * Asks before unsaved changes are thrown away. A discard that fails keeps
 * the dialog open with its `error`.
 */
export function DiscardChangesDialog({
  open,
  title,
  description,
  error = "",
  onKeep,
  onDiscard,
}: {
  open: boolean;
  title: string;
  description: string;
  error?: string;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onKeep()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <ActionError message={error} title={null} />
        <AlertDialogFooter>
          <Button variant="outline" className="min-h-11" onClick={onKeep}>
            Keep editing
          </Button>
          <Button
            variant="destructive"
            className="min-h-11"
            onClick={onDiscard}
          >
            Discard changes
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
