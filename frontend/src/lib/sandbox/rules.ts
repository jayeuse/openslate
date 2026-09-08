/**
 * Sandbox pure rules (no X6, no backend).
 *
 * Embed/connect rules for the frontend-only prototype.
 */

import type { SandboxState } from "./model";

export interface SandboxRuleResult {
  ok: boolean;
  reason?: string;
}

export type SandboxEmbedKind = "department" | "module" | "field";

/** Only department > module and module > field nesting is allowed. */
export function canEmbed(
  parentKind: SandboxEmbedKind,
  childKind: SandboxEmbedKind,
): boolean {
  return (
    (parentKind === "department" && childKind === "module") ||
    (parentKind === "module" && childKind === "field")
  );
}

/**
 * Module-level connection check. Rejects self-connections and unknown
 * modules. Field involvement is handled by the caller.
 */
export function canConnect(
  sourceModuleId: string,
  targetModuleId: string,
  state: SandboxState,
): SandboxRuleResult {
  if (sourceModuleId === targetModuleId) {
    return { ok: false, reason: "A module cannot connect to itself." };
  }
  const sourceExists = state.modules.some(
    (module) => module.id === sourceModuleId,
  );
  const targetExists = state.modules.some(
    (module) => module.id === targetModuleId,
  );
  if (!sourceExists || !targetExists) {
    return { ok: false, reason: "Both modules must exist before connecting." };
  }
  const alreadyLinked = state.links.some(
    (link) =>
      link.sourceModuleId === sourceModuleId &&
      link.targetModuleId === targetModuleId,
  );
  if (alreadyLinked) {
    return { ok: false, reason: "These modules are already connected." };
  }
  return { ok: true };
}
