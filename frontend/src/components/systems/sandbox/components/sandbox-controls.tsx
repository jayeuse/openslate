/**
 * Compatibility types for the Designer's existing contextual add requests.
 * Global Sandbox controls deliberately no longer create graph items; people
 * add them in context from Build or from the Triggers screen.
 */
export type SandboxCreateKind =
  "department" | "module" | "field" | "relationship" | "trigger-rule";

export type SandboxCreateRequest = {
  id: number;
  kind: SandboxCreateKind;
};
