"use client";

import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import type { OpenViewDataSourceField } from "../adapters/views-api";
import { assignableUsersOptions } from "../adapters/openview-queries";
import {
  selectOptions,
  type RecordFormErrors,
  type RecordFormValue,
  type RecordFormValues,
} from "../domain/record-form";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PersonCardPopover } from "@/components/person-card";

type RecordFormFieldsProps = {
  moduleId: string;
  fields: readonly OpenViewDataSourceField[];
  values: RecordFormValues;
  errors: RecordFormErrors;
  disabled: boolean;
  onChange: (fieldId: string, value: RecordFormValue) => void;
};

const INPUT_TYPES: Partial<Record<OpenViewDataSourceField["type"], string>> = {
  email: "email",
  url: "url",
  number: "number",
  int: "number",
  date: "date",
  datetime: "datetime-local",
};

function PersonSelect({
  id,
  moduleId,
  value,
  disabled,
  invalid,
  describedBy,
  onChange,
}: {
  id: string;
  moduleId: string;
  value: string;
  disabled: boolean;
  invalid: boolean;
  describedBy: string | undefined;
  onChange: (value: string) => void;
}) {
  const people = useQuery(assignableUsersOptions(moduleId, ""));
  const listed = people.data?.items ?? [];
  const known = !value || listed.some((person) => person.id === value);
  const selected = !people.isError
    ? listed.find((person) => person.id === value)
    : undefined;
  return (
    <>
      <Select
        id={id}
        className="min-h-11"
        value={value}
        disabled={disabled || people.isPending}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onValueChange={onChange}
      >
        <option value="">
          {people.isPending
            ? "Loading people…"
            : people.isError
              ? "People could not be loaded"
              : "No one"}
        </option>
        {known ? null : <option value={value}>Current person</option>}
        {listed.map((person) => (
          <option key={person.id} value={person.id}>
            {person.displayName ?? person.username}
          </option>
        ))}
      </Select>
      {selected ? (
        <PersonCardPopover
          personId={selected.id}
          label={selected.displayName ?? selected.username}
        />
      ) : null}
    </>
  );
}

function FieldControl({
  id,
  moduleId,
  field,
  value,
  disabled,
  invalid,
  describedBy,
  onChange,
}: {
  id: string;
  moduleId: string;
  field: OpenViewDataSourceField;
  value: RecordFormValue;
  disabled: boolean;
  invalid: boolean;
  describedBy: string | undefined;
  onChange: (value: RecordFormValue) => void;
}) {
  const text = typeof value === "string" ? value : "";
  const common = {
    id,
    disabled,
    "aria-invalid": invalid || undefined,
    "aria-describedby": describedBy,
  };
  if (field.type === "boolean")
    return (
      <Checkbox
        {...common}
        checked={value === true}
        onCheckedChange={(checked) => onChange(checked === true)}
      />
    );
  if (field.type === "long_text")
    return (
      <Textarea
        {...common}
        rows={4}
        value={text}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  if (field.type === "select")
    return (
      <Select
        {...common}
        className="min-h-11"
        value={text}
        onValueChange={onChange}
      >
        <option value="">{field.required ? "Choose an option" : "None"}</option>
        {selectOptions(field).map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </Select>
    );
  if (field.type === "user")
    return (
      <PersonSelect
        id={id}
        moduleId={moduleId}
        value={text}
        disabled={disabled}
        invalid={invalid}
        describedBy={describedBy}
        onChange={onChange}
      />
    );
  return (
    <Input
      {...common}
      className="min-h-11"
      type={INPUT_TYPES[field.type] ?? "text"}
      inputMode={field.type === "decimal" ? "decimal" : undefined}
      step={
        field.type === "number" ? "any" : field.type === "int" ? 1 : undefined
      }
      value={text}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** One labelled control for each editable field of a record. */
export function RecordFormFields({
  moduleId,
  fields,
  values,
  errors,
  disabled,
  onChange,
}: RecordFormFieldsProps) {
  const prefix = useId();
  return (
    <FieldGroup className="gap-4">
      {fields.map((field) => {
        const id = `${prefix}-${field.id}`;
        const error = errors[field.id];
        const errorId = error ? `${id}-error` : undefined;
        const control = (
          <FieldControl
            id={id}
            moduleId={moduleId}
            field={field}
            value={values[field.id] ?? ""}
            disabled={disabled}
            invalid={Boolean(error)}
            describedBy={errorId}
            onChange={(value) => onChange(field.id, value)}
          />
        );
        return (
          <Field key={field.id} className="min-w-0">
            {field.type === "boolean" ? (
              <div className="flex min-h-11 items-center gap-3">
                {control}
                <FieldLabel htmlFor={id}>{field.name}</FieldLabel>
              </div>
            ) : (
              <>
                <FieldLabel htmlFor={id}>
                  {field.name}
                  {field.required ? (
                    <span className="text-muted-foreground font-normal">
                      {" "}
                      (required)
                    </span>
                  ) : null}
                </FieldLabel>
                {control}
              </>
            )}
            {error ? (
              <p id={errorId} className="text-destructive text-sm">
                {error}
              </p>
            ) : null}
          </Field>
        );
      })}
    </FieldGroup>
  );
}
