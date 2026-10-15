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
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import { Button } from "@/components/ui/button";

export interface SearchSelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
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
  /** Controlled remote search; the caller returns matching options. */
  search?: string;
  onSearchChange?: (search: string) => void;
  selectedOption?: SearchSelectOption;
  loading?: boolean;
  error?: string;
  validationError?: string;
  onRetry?: () => void;
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
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
  search,
  onSearchChange,
  selectedOption,
  loading = false,
  error,
  validationError,
  onRetry,
  hasMore = false,
  onLoadMore,
  loadingMore = false,
}: SearchSelectProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const validationId = `${controlId}-error`;
  const searchLabelId = `${controlId}-search-label`;
  const optionByValue = new Map(
    options.map((option) => [option.value, option]),
  );
  if (selectedOption && !optionByValue.has(selectedOption.value))
    optionByValue.set(selectedOption.value, selectedOption);
  const selected = optionByValue.get(value);

  return (
    <Field invalid={Boolean(validationError)}>
      <FieldLabel htmlFor={controlId}>{label}</FieldLabel>
      <Combobox
        items={[...optionByValue.keys()]}
        {...(onSearchChange
          ? {
              inputValue: search ?? "",
              filter: null,
              onInputValueChange: (
                next: string,
                details: { reason: string },
              ) => {
                if (
                  ["input-change", "input-clear", "clear-press"].includes(
                    details.reason,
                  )
                )
                  onSearchChange(next);
              },
            }
          : {})}
        value={value}
        disabled={disabled}
        itemToStringLabel={(item) =>
          typeof item === "string" ? (optionByValue.get(item)?.label ?? "") : ""
        }
        onValueChange={(next) => {
          if (typeof next === "string") onValueChange(next);
        }}
      >
        <ComboboxTrigger
          id={controlId}
          aria-label={label}
          aria-invalid={Boolean(validationError)}
          aria-describedby={validationError ? validationId : undefined}
          className="min-h-11"
        >
          <span className="truncate">{selected?.label ?? placeholder}</span>
        </ComboboxTrigger>
        <ComboboxContent positionerClassName="z-[60]">
          {/* The field label would otherwise name the search box too, so the
              trigger and the search box would read the same. */}
          <span id={searchLabelId} className="sr-only">
            {`Search ${label.toLowerCase()}`}
          </span>
          <ComboboxInput
            aria-labelledby={searchLabelId}
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
                  disabled={option.disabled}
                  className="min-h-11"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="break-words">{option.label}</span>
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
          {loading ? (
            <p role="status" className="text-muted-foreground p-3 text-sm">
              Loading options…
            </p>
          ) : error ? (
            <div role="alert" className="space-y-2 p-3 text-sm">
              <p>{error}</p>
              {onRetry ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={onRetry}
                >
                  Retry
                </Button>
              ) : null}
            </div>
          ) : (
            <ComboboxEmpty className="text-muted-foreground p-3 text-sm">
              {emptyMessage}
            </ComboboxEmpty>
          )}
          {hasMore && onLoadMore ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={loading || loadingMore}
              onClick={onLoadMore}
            >
              {loadingMore ? "Loading more…" : "Load more"}
            </Button>
          ) : null}
        </ComboboxContent>
      </Combobox>
      {validationError ? (
        <FieldError id={validationId}>{validationError}</FieldError>
      ) : null}
    </Field>
  );
}
