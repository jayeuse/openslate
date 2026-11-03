"use client";

import { useReducer, useState } from "react";

import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { referenceField } from "@/lib/reference-search";

import { filterRowClassName } from "./access-toolbar";

/**
 * The Reference filter of Audit and Security events (D7-C1, D13 item 3): the
 * 8 characters an error message shows, or the full ID. It is checked on blur
 * and Enter only, so typing never changes the list or shows an error.
 */
export function ReferenceFilter({
  id,
  applied,
  onApply,
  disabled,
}: {
  id: string;
  /** The reference the list uses now, or "". */
  applied: string;
  onApply: (reference: string) => void;
  disabled: boolean;
}) {
  const [state, dispatch] = useReducer(referenceField, {
    draft: applied,
    applied,
    error: "",
  });
  // A chip removed or filters cleared elsewhere resets the field.
  const [seen, setSeen] = useState(applied);
  if (applied !== seen) {
    setSeen(applied);
    if (applied !== state.applied) dispatch({ type: "reset", applied });
  }
  const commit = () => {
    const next = referenceField(state, { type: "commit" });
    dispatch({ type: "commit" });
    setSeen(next.applied);
    if (next.applied !== applied) onApply(next.applied);
  };
  return (
    <Field className={filterRowClassName}>
      <FieldLabel
        htmlFor={`${id}-reference`}
        className="md:text-muted-foreground"
      >
        Reference
      </FieldLabel>
      <div className="min-w-0">
        <Input
          id={`${id}-reference`}
          value={state.draft}
          placeholder="4f9c2e1a"
          maxLength={36}
          autoComplete="off"
          spellCheck={false}
          className="min-h-11 font-mono"
          disabled={disabled}
          aria-invalid={Boolean(state.error) || undefined}
          aria-describedby={state.error ? `${id}-reference-error` : undefined}
          onChange={(event) =>
            dispatch({ type: "type", value: event.target.value })
          }
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            commit();
          }}
        />
        {state.error ? (
          <FieldError id={`${id}-reference-error`}>{state.error}</FieldError>
        ) : null}
      </div>
    </Field>
  );
}
