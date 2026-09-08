/**
 * Sandbox pure rules (no X6, no backend).
 *
 * Embed/connect/stage gating for the frontend-only prototype.
 */

import type { SandboxState, Stage } from "./model";

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

export function canEnterStage(
  stage: Stage,
  state: SandboxState,
): SandboxRuleResult {
  switch (stage) {
    case "departments":
      return { ok: true };
    case "modules":
      return state.departments.length >= 1
        ? { ok: true }
        : { ok: false, reason: "Add at least one department first." };
    case "fields":
      return state.modules.length >= 1
        ? { ok: true }
        : { ok: false, reason: "Add at least one module first." };
    case "relationships":
      return state.modules.length >= 2
        ? { ok: true }
        : { ok: false, reason: "Add at least two modules first." };
    case "automation":
      return { ok: true };
  }
}

/** Readiness of every stage for the given mock state. */
export function stageStatus(
  state: SandboxState,
): Record<Stage, SandboxRuleResult> {
  return {
    departments: canEnterStage("departments", state),
    modules: canEnterStage("modules", state),
    fields: canEnterStage("fields", state),
    relationships: canEnterStage("relationships", state),
    automation: canEnterStage("automation", state),
  };
}
