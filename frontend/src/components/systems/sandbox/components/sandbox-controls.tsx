/**
 * Compatibility types for the Designer's existing contextual add requests.
 * Global Sandbox controls deliberately no longer create graph items; people
 * add them in context from Build or from the Automations screen.
 */
export type SandboxCreateKind =
  "department" | "module" | "field" | "relationship" | "automation-rule";

export type SandboxCreateRequest = {
  id: number;
  kind: SandboxCreateKind;
};
