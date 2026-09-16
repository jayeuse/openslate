"use client";

import { useId } from "react";

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { Field, FieldLabel } from "@/components/ui/field";

export interface SearchSelectOption {
  value: string;
  label: string;
  description?: string;
}

export interface SearchSelectProps {
  label: string;
  value: string;
  options: readonly SearchSelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  id?: string;
}

/**
 * A controlled, searchable option field built on the shared Base UI combobox.
 *
 * The option list and selection rules stay with the caller. This component
 * standardizes the field label, trigger, search input, option rows, and empty
 * state wherever the same interaction is needed.
 */
export function SearchSelect({
  label,
  value,
  options,
  onValueChange,
  disabled = false,
  placeholder = "Choose an option",
  searchPlaceholder = "Search…",
  emptyMessage = "No matches. Try another search.",
  id,
}: SearchSelectProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const optionByValue = new Map(
    options.map((option) => [option.value, option]),
  );
  const selected = optionByValue.get(value);

  return (
    <Field>
      <FieldLabel htmlFor={controlId}>{label}</FieldLabel>
      <Combobox
        items={options.map((option) => option.value)}
        value={value}
        disabled={disabled}
        itemToStringLabel={(item) =>
          typeof item === "string" ? (optionByValue.get(item)?.label ?? "") : ""
        }
        onValueChange={(next) => {
          if (typeof next === "string") onValueChange(next);
        }}
      >
        <ComboboxTrigger id={controlId} aria-label={label} className="min-h-11">
          <span className="truncate">{selected?.label ?? placeholder}</span>
        </ComboboxTrigger>
        <ComboboxContent positionerClassName="z-[60]">
          <ComboboxInput
            aria-label={`Search ${label.toLowerCase()}`}
            placeholder={searchPlaceholder}
            className="min-h-11"
          />
          <ComboboxList>
            {(item: string) => {
              const option = optionByValue.get(item);
              if (!option) return null;

              return (
                <ComboboxItem
                  key={option.value}
                  value={option.value}
                  className="min-h-11"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate">{option.label}</span>
                    {option.description && (
                      <span className="text-muted-foreground text-xs">
                        {option.description}
                      </span>
                    )}
                  </span>
                </ComboboxItem>
              );
            }}
          </ComboboxList>
          <ComboboxEmpty className="text-muted-foreground p-3 text-sm">
            {emptyMessage}
          </ComboboxEmpty>
        </ComboboxContent>
      </Combobox>
    </Field>
  );
}
