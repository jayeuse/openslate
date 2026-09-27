export type DesignerPane = "Structure" | "Canvas" | "Inspector";

export interface SandboxViewPreferences {
  gridVisible: boolean;
  snapEnabled: boolean;
  workbenchWidth: number;
  workbenchCollapsed: boolean;
}

export const SANDBOX_VIEW_PREFERENCES_KEY = "openslate.sandbox.view.v2";
// One right workbench (Structure | Properties) keeps the canvas at ≥65% of a
// wide Build area.
export const SANDBOX_WORKBENCH_MIN_WIDTH = 320;
export const SANDBOX_WORKBENCH_MAX_WIDTH = 400;
export const SANDBOX_WORKBENCH_DEFAULT_WIDTH = 360;

export const defaultSandboxViewPreferences: SandboxViewPreferences = {
  gridVisible: true,
  snapEnabled: true,
  workbenchWidth: SANDBOX_WORKBENCH_DEFAULT_WIDTH,
  workbenchCollapsed: false,
};

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeSandboxViewPreferences(
  value: unknown,
): SandboxViewPreferences {
  const stored =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  return {
    gridVisible: booleanOr(
      stored.gridVisible,
      defaultSandboxViewPreferences.gridVisible,
    ),
    snapEnabled: booleanOr(
      stored.snapEnabled,
      defaultSandboxViewPreferences.snapEnabled,
    ),
    // Tabs saved before the single workbench kept an inspector width.
    workbenchWidth: boundedNumber(
      stored.workbenchWidth ?? stored.inspectorWidth,
      defaultSandboxViewPreferences.workbenchWidth,
      SANDBOX_WORKBENCH_MIN_WIDTH,
      SANDBOX_WORKBENCH_MAX_WIDTH,
    ),
    workbenchCollapsed: booleanOr(
      stored.workbenchCollapsed ?? stored.inspectorCollapsed,
      defaultSandboxViewPreferences.workbenchCollapsed,
    ),
  };
}

export function loadSandboxViewPreferences(): SandboxViewPreferences {
  if (typeof window === "undefined") return defaultSandboxViewPreferences;
  try {
    const stored = window.sessionStorage.getItem(SANDBOX_VIEW_PREFERENCES_KEY);
    return normalizeSandboxViewPreferences(stored ? JSON.parse(stored) : null);
  } catch {
    return defaultSandboxViewPreferences;
  }
}

export function saveSandboxViewPreferences(
  preferences: SandboxViewPreferences,
): void {
  try {
    window.sessionStorage.setItem(
      SANDBOX_VIEW_PREFERENCES_KEY,
      JSON.stringify(preferences),
    );
  } catch {
    // View preferences are optional when tab storage is blocked or full.
  }
}

export function clearSandboxViewPreferences(): void {
  try {
    window.sessionStorage.removeItem(SANDBOX_VIEW_PREFERENCES_KEY);
  } catch {
    // Clearing Sandbox data still succeeds when optional tab storage is blocked.
  }
}
