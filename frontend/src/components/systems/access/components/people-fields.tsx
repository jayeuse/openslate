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

import { cn } from "@/lib/utils";

import { ActionError } from "./editor-conflicts";

// Labelled fields shared by the invitation form and the person editor. Each
// field ties its hint and error to the control with aria-describedby.

/**
 * Label-left rows for a sheet's Details tab: from 768px a 128px muted label
 * column and the field on the right in a 40px row; phones stack the label
 * above. Dialogs and toolbars keep the label above.
 */
export const detailRowClassName =
  "md:grid md:grid-cols-[8rem_minmax(0,1fr)] md:items-center md:gap-x-4 md:gap-y-1 md:min-h-10";
export const detailLabelClassName = "md:text-muted-foreground";
/** The hint and error of a row sit under the field, in the field's column. */
const detailNoteClassName = "md:col-start-2";

export function FieldRow({
  id,
  label,
  children,
}: {
  id?: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <Field className={cn("min-w-0", detailRowClassName)}>
      <FieldLabel htmlFor={id} className={detailLabelClassName}>
        {label}
      </FieldLabel>
      {children}
    </Field>
  );
}

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
  layout = "stacked",
  ...input
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  description?: ReactNode;
  error?: string | null;
  /** "row" sets the label left of the field from 768px (sheet Details). */
  layout?: "stacked" | "row";
} & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "id" | "value" | "onChange" | "className"
>) {
  const row = layout === "row";
  return (
    <Field className={cn("min-w-0", row && detailRowClassName)}>
      <FieldLabel htmlFor={id} className={cn(row && detailLabelClassName)}>
        {label}
      </FieldLabel>
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
        <FieldDescription
          id={`${id}-hint`}
          className={cn(row && detailNoteClassName)}
        >
          {description}
        </FieldDescription>
      ) : null}
      {error ? (
        <FieldError
          id={`${id}-error`}
          className={cn(row && detailNoteClassName)}
        >
          {error}
        </FieldError>
      ) : null}
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
  layout = "stacked",
}: {
  id: string;
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  description?: ReactNode;
  error?: string | null;
  disabled?: boolean;
  /** "row" sets the label left of the field from 768px (sheet Details). */
  layout?: "stacked" | "row";
}) {
  const row = layout === "row";
  return (
    <Field className={cn("min-w-0", row && detailRowClassName)}>
      <FieldLabel htmlFor={id} className={cn(row && detailLabelClassName)}>
        {label}
      </FieldLabel>
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
        <FieldDescription
          id={`${id}-hint`}
          className={cn(row && detailNoteClassName)}
        >
          {description}
        </FieldDescription>
      ) : null}
      {error ? (
        <FieldError
          id={`${id}-error`}
          className={cn(row && detailNoteClassName)}
        >
          {error}
        </FieldError>
      ) : null}
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
      <AlertDialogContent className="access-ui slim-ui">
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
