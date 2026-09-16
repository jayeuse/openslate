"use client";

import { useId, type ComponentProps } from "react";
import { Search } from "lucide-react";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Field, FieldLabel } from "@/components/ui/field";
import { cn } from "@/lib/utils";

export interface SearchFieldProps extends Omit<
  ComponentProps<"input">,
  "defaultValue" | "onChange" | "type" | "value"
> {
  /** Visible label used to name the input and describe the search scope. */
  label: string;
  /** Controlled search value. */
  value: string;
  /** Called with the next search value as the user types. */
  onValueChange: (value: string) => void;
}

/**
 * The shared labeled search field for workspace and supporting screens.
 *
 * Search behavior stays with the caller; this component owns the consistent
 * label, icon, control height, focus, and light/dark surface treatment.
 */
export function SearchField({
  label,
  id,
  value,
  onValueChange,
  className,
  ...props
}: SearchFieldProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;

  return (
    <Field>
      <FieldLabel htmlFor={controlId}>{label}</FieldLabel>
      <InputGroup
        className={cn("h-11 min-h-11", className)}
        data-search-field="true"
      >
        <InputGroupAddon aria-hidden="true">
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          {...props}
          id={controlId}
          type="search"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          className="h-full"
        />
      </InputGroup>
    </Field>
  );
}
