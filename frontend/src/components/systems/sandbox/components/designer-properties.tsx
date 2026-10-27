"use client";

import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { Design } from "../domain/model";

// The parts of Properties (docs/specs/sandbox-relayout.md S12): label-left
// rows for settings, the module's Department and Title field, and the
// lifecycle actions of a module or department. The Designer owns the state
// and the commands; these only render them.

/**
 * One setting as a label-left row from 1280px: a muted 6rem label column and
 * the control on the right (DESIGN "Slim controls", Layout). Narrower, the
 * label sits above; an `inline` row (a checkbox) keeps the control first.
 */
export function PropertyRow({
  id,
  label,
  labelEnd,
  error,
  errorId,
  inline = false,
  className,
  children,
}: {
  id: string;
  label: ReactNode;
  /** Beside the label, such as a help button. */
  labelEnd?: ReactNode;
  error?: string;
  errorId?: string;
  inline?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Field
      data-invalid={error ? true : undefined}
      className={cn(
        "min-w-0 gap-1.5 xl:grid xl:grid-cols-[6rem_minmax(0,1fr)] xl:items-start xl:gap-x-3",
        inline &&
          "max-xl:flex-row-reverse max-xl:items-center max-xl:justify-end",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-1 xl:min-h-8">
        <FieldLabel
          htmlFor={id}
          className="text-muted-foreground font-normal [overflow-wrap:anywhere] xl:text-sm"
        >
          {label}
        </FieldLabel>
        {labelEnd}
      </div>
      <div className="grid min-w-0 gap-1">
        {children}
        {error ? (
          <FieldError id={errorId} className="text-xs">
            {error}
          </FieldError>
        ) : null}
      </div>
    </Field>
  );
}

const TITLE_FIELD_TYPES = new Set([
  "Text",
  "Long text",
  "Email",
  "URL",
  "Integer",
  "Number",
  "Select",
]);

/** The module's rarer settings: its department (a move) and title field. */
export function ModuleSettings({
  module,
  departments,
  pending,
  moveError,
  titleFieldError,
  onMove,
  onTitleField,
}: {
  module: Design["modules"][number];
  departments: Design["departments"];
  pending: boolean;
  moveError: string;
  titleFieldError: string;
  onMove: (departmentId: string) => void;
  onTitleField: (fieldId: string | null) => void;
}) {
  return (
    <>
      <PropertyRow
        id="sandbox-move-module-department"
        label="Department"
        error={moveError}
        errorId="sandbox-move-module-department-error"
      >
        <NativeSelect
          id="sandbox-move-module-department"
          aria-label="Move module to department"
          className="w-full [&_select]:min-h-10"
          value={module.department}
          disabled={pending}
          aria-invalid={moveError ? true : undefined}
          aria-describedby={
            moveError ? "sandbox-move-module-department-error" : undefined
          }
          onChange={(event) => onMove(event.target.value)}
        >
          {departments.map((item) => (
            <NativeSelectOption key={item.id} value={item.id}>
              {item.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </PropertyRow>
      <PropertyRow
        id="sandbox-record-title-field"
        label="Title field"
        error={titleFieldError}
        errorId="sandbox-record-title-field-error"
        labelEnd={
          <Popover>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label="About the title field"
                  className="text-muted-foreground hover:text-foreground focus-visible:outline-ring -my-2 inline-flex size-11 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:outline-2 xl:my-0 xl:size-6"
                />
              }
            >
              <Info aria-hidden="true" className="size-3.5" />
            </PopoverTrigger>
            <PopoverContent side="top" className="slim-ui w-auto max-w-64">
              Names this module&apos;s records in Boards links.
            </PopoverContent>
          </Popover>
        }
      >
        <NativeSelect
          id="sandbox-record-title-field"
          className="w-full [&_select]:min-h-10"
          value={module.titleFieldId ?? ""}
          disabled={pending}
          aria-invalid={titleFieldError ? true : undefined}
          aria-describedby={
            titleFieldError
              ? "sandbox-record-title-field-error sandbox-record-title-field-help"
              : "sandbox-record-title-field-help"
          }
          onChange={(event) => onTitleField(event.currentTarget.value || null)}
        >
          <NativeSelectOption value="">Use the Record ID</NativeSelectOption>
          {module.fields
            .filter(
              (field) => !field.closed && TITLE_FIELD_TYPES.has(field.type),
            )
            .map((field) => (
              <NativeSelectOption key={field.id} value={field.id}>
                {field.name}
              </NativeSelectOption>
            ))}
        </NativeSelect>
        <span id="sandbox-record-title-field-help" className="sr-only">
          Names this module&apos;s records in Boards links.
        </span>
      </PropertyRow>
    </>
  );
}

/**
 * Close or Reopen, Delete, and Delete forever for the selected module or
 * department, with the note that says when a close applies.
 */
export function LifecycleActions({
  kind,
  closed,
  canPurge,
  disabled,
  reason,
  bound,
  pending,
  onToggle,
  onDelete,
  onPurge,
}: {
  kind: "module" | "department";
  closed: boolean;
  canPurge: boolean;
  /** Closing or purging waits (live state loading, edits open). */
  disabled: boolean;
  /** Why, when it waits. */
  reason: string | null;
  /** A live item: the close changes live state now. */
  bound: boolean;
  pending: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onPurge: () => void;
}) {
  return (
    <div
      role="group"
      aria-label={`${kind === "module" ? "Module" : "Department"} lifecycle`}
      className="flex flex-col gap-1.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <DisabledReason reason={disabled ? reason : null}>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            aria-describedby="sandbox-lifecycle-note"
            onClick={onToggle}
          >
            {`${closed ? "Reopen" : "Close"} ${kind}`}
          </Button>
        </DisabledReason>
        <Button
          size="sm"
          variant="ghost"
          className="text-danger-text"
          disabled={pending}
          onClick={onDelete}
        >
          Delete {kind}
        </Button>
        {canPurge ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-danger-text"
            disabled={disabled}
            onClick={onPurge}
          >
            Delete {kind} forever
          </Button>
        ) : null}
      </div>
      <p id="sandbox-lifecycle-note" className="text-muted-foreground text-xs">
        {!bound
          ? "Applies when you publish."
          : closed
            ? "Reopening allows new records again."
            : "Stops new records. Keeps existing data."}
      </p>
    </div>
  );
}
