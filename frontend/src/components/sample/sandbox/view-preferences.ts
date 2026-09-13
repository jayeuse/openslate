export type DesignerPane = "Structure" | "Canvas" | "Inspector";

export interface SandboxViewPreferences {
  gridVisible: boolean;
  snapEnabled: boolean;
  structureWidth: number;
  inspectorWidth: number;
  structureCollapsed: boolean;
  inspectorCollapsed: boolean;
  mobilePane: DesignerPane;
}

export const SANDBOX_VIEW_PREFERENCES_KEY = "openslate.sample.sandbox.view.v1";
export const SANDBOX_STRUCTURE_PANEL_MIN_WIDTH = 320;
export const SANDBOX_STRUCTURE_PANEL_MAX_WIDTH = 420;
export const SANDBOX_INSPECTOR_PANEL_MIN_WIDTH = 450;
export const SANDBOX_INSPECTOR_PANEL_MAX_WIDTH = 480;

export const defaultSandboxViewPreferences: SandboxViewPreferences = {
  gridVisible: true,
  snapEnabled: true,
  structureWidth: SANDBOX_STRUCTURE_PANEL_MIN_WIDTH,
  inspectorWidth: SANDBOX_INSPECTOR_PANEL_MIN_WIDTH,
  structureCollapsed: false,
  inspectorCollapsed: false,
  mobilePane: "Structure",
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

function paneOr(value: unknown): DesignerPane {
  return value === "Canvas" || value === "Inspector" || value === "Structure"
    ? value
    : defaultSandboxViewPreferences.mobilePane;
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
    structureWidth: boundedNumber(
      stored.structureWidth,
      defaultSandboxViewPreferences.structureWidth,
      SANDBOX_STRUCTURE_PANEL_MIN_WIDTH,
      SANDBOX_STRUCTURE_PANEL_MAX_WIDTH,
    ),
    inspectorWidth: boundedNumber(
      stored.inspectorWidth,
      defaultSandboxViewPreferences.inspectorWidth,
      SANDBOX_INSPECTOR_PANEL_MIN_WIDTH,
      SANDBOX_INSPECTOR_PANEL_MAX_WIDTH,
    ),
    structureCollapsed: booleanOr(
      stored.structureCollapsed,
      defaultSandboxViewPreferences.structureCollapsed,
    ),
    inspectorCollapsed: booleanOr(
      stored.inspectorCollapsed,
      defaultSandboxViewPreferences.inspectorCollapsed,
    ),
    mobilePane: paneOr(stored.mobilePane),
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
