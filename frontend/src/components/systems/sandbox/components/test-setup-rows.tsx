"use client";

import { useId, type ReactNode } from "react";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import type {
  SandboxDocumentField,
  SandboxFieldValue,
} from "../domain/document";

// The rows of the Test setup (docs/specs/sandbox-relayout.md S11): a muted
// label on the left and the control on the right once the Setup pane is
// 22rem wide; narrower, the label sits above. A row's error shows only after
// Run test found it, under the control it is about.

/** The id of a row's error line, for its control's description. */
export function setupErrorId(controlId: string) {
  return `${controlId}-error`;
}

/** The ARIA a control needs while its row shows an error. */
export function setupErrorProps(errorId: string, error: string | undefined) {
  return error
    ? { "aria-invalid": true as const, "aria-describedby": errorId }
    : {};
}

export function SetupRow({
  id,
  label,
  error,
  errorId = setupErrorId(id),
  children,
}: {
  id: string;
  label: string;
  error?: string;
  /** Defaults to the control id plus "-error"; field ids may hold spaces. */
  errorId?: string;
  children: ReactNode;
}) {
  return (
    <Field className="min-w-0 gap-1.5 @min-[22rem]/setup:grid @min-[22rem]/setup:grid-cols-[7rem_minmax(0,1fr)] @min-[22rem]/setup:items-start @min-[22rem]/setup:gap-x-3">
      <FieldLabel
        htmlFor={id}
        className="text-muted-foreground font-normal [overflow-wrap:anywhere] xl:text-sm @min-[22rem]/setup:flex @min-[22rem]/setup:min-h-11 @min-[22rem]/setup:items-center @min-[22rem]/setup:xl:min-h-8"
      >
        {label}
      </FieldLabel>
      <div className="grid min-w-0 gap-1">
        {children}
        {error ? (
          <p id={errorId} className="text-destructive text-xs">
            {error}
          </p>
        ) : null}
      </div>
    </Field>
  );
}

/** One test value, with the control its field type takes. */
export function TestValueRow({
  field,
  value,
  error,
  onChange,
}: {
  field: SandboxDocumentField;
  value: SandboxFieldValue;
  error: string | undefined;
  onChange: (value: SandboxFieldValue) => void;
}) {
  const id = `sandbox-test-${field.id}`;
  // Generated ids: a field id can hold a space, which splits an id list.
  const errorId = useId();
  const helpId = useId();
  const errorProps = setupErrorProps(errorId, error);
  const config = field.config;
  const row = { id, label: field.name, error, errorId };
  if (config.kind === "user") {
    // The test uses the typed ID as is; nobody's access is looked up.
    return (
      <SetupRow {...row}>
        <Input
          id={id}
          placeholder="Paste the person's ID"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${helpId} ${errorId}` : helpId}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value || null)}
        />
        <p id={helpId} className="text-muted-foreground text-xs">
          The test uses this ID as is. It does not check that the person can
          sign in.
        </p>
      </SetupRow>
    );
  }
  if (config.kind === "checkbox")
    return (
      <SetupRow {...row}>
        <NativeSelect
          id={id}
          {...errorProps}
          value={String(value === true)}
          onChange={(event) => onChange(event.target.value === "true")}
        >
          <NativeSelectOption value="true">Yes</NativeSelectOption>
          <NativeSelectOption value="false">No</NativeSelectOption>
        </NativeSelect>
      </SetupRow>
    );
  if (config.kind === "select")
    return (
      <SetupRow {...row}>
        <NativeSelect
          id={id}
          {...errorProps}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <NativeSelectOption value="">Choose a value</NativeSelectOption>
          {config.options.map((option) => (
            <NativeSelectOption key={option.id} value={option.id}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </SetupRow>
    );
  const numeric = config.kind === "number" || config.kind === "integer";
  return (
    <SetupRow {...row}>
      <Input
        id={id}
        {...errorProps}
        type={
          numeric
            ? "number"
            : config.kind === "date"
              ? "date"
              : config.kind === "datetime"
                ? "datetime-local"
                : "text"
        }
        value={value === null ? "" : String(value)}
        onChange={(event) =>
          onChange(
            numeric
              ? event.target.value === ""
                ? null
                : Number(event.target.value)
              : event.target.value,
          )
        }
      />
    </SetupRow>
  );
}
