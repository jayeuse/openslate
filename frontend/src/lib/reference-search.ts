const SUFFIX = /^[0-9a-f]{8}$/;
const FULL_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The Reference filter of Audit and Security events (D7-C1, docs/specs/
 * system-health.md): the 8 characters an error message shows, or the full
 * request ID, lowercased. Anything else is left out of the request, which
 * the server would refuse with 422, and the field says what to enter.
 */
export function referenceSearch(input: string): {
  value: string;
  error: string;
} {
  const value = input.trim().toLowerCase();
  if (!value || SUFFIX.test(value) || FULL_ID.test(value))
    return { value, error: "" };
  return {
    value: "",
    error: "Enter the 8 characters of a reference, or its full ID.",
  };
}

/** The Reference field: what is typed, what the list uses, and its error. */
export type ReferenceFieldState = {
  draft: string;
  /** The last valid reference the request uses, or "". */
  applied: string;
  error: string;
};

/**
 * When the Reference field changes the list (D13 item 3): typing changes
 * nothing but clears a shown error once the field is valid or empty; blur and
 * Enter (`commit`) check it, applying a valid reference or none with the
 * error; `reset` follows a chip removed or filters cleared elsewhere.
 */
export function referenceField(
  state: ReferenceFieldState,
  action:
    | { type: "type"; value: string }
    | { type: "commit" }
    | { type: "reset"; applied: string },
): ReferenceFieldState {
  if (action.type === "reset")
    return { draft: action.applied, applied: action.applied, error: "" };
  if (action.type === "type")
    return {
      ...state,
      draft: action.value,
      error:
        state.error && referenceSearch(action.value).error ? state.error : "",
    };
  const checked = referenceSearch(state.draft);
  return checked.error
    ? { ...state, applied: "", error: checked.error }
    : { draft: checked.value, applied: checked.value, error: "" };
}
