export const DEFAULT_APPEARANCE_PREFERENCES = {
  mode: "light",
} as const;

export type AppearanceMode = "light" | "dark";

export interface AppearancePreferences {
  mode: AppearanceMode;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// The light/dark key predates organization themes, so it keeps its old name.
const MODE_KEY = "openslate-theme";
// Accent and corner style became part of the organization theme; the global
// density setting was never wired to any component.
const RETIRED_KEYS = [
  "openslate-accent",
  "openslate-radius",
  "openslate-density",
] as const;

const isOneOf = <T extends string>(
  value: string | null,
  values: readonly T[],
): value is T => value !== null && values.includes(value as T);

export function readAppearancePreferences(
  storage: Pick<Storage, "getItem"> | null | undefined,
): AppearancePreferences {
  if (!storage) {
    return DEFAULT_APPEARANCE_PREFERENCES;
  }

  try {
    const mode = storage.getItem(MODE_KEY);

    return {
      mode: isOneOf(mode, ["light", "dark"])
        ? mode
        : DEFAULT_APPEARANCE_PREFERENCES.mode,
    };
  } catch {
    return DEFAULT_APPEARANCE_PREFERENCES;
  }
}

export function readBrowserAppearancePreferences(): AppearancePreferences {
  try {
    return readAppearancePreferences(window.localStorage);
  } catch {
    return DEFAULT_APPEARANCE_PREFERENCES;
  }
}

export function applyAppearancePreferences(
  preferences: AppearancePreferences,
  root: HTMLElement = document.documentElement,
): void {
  root.classList.toggle("dark", preferences.mode === "dark");
  delete root.dataset.accent;
  delete root.dataset.density;
  delete root.dataset.radius;
}

export function persistAppearancePreferences(
  preferences: AppearancePreferences,
  storage?: StorageLike | null,
): void {
  try {
    const target = storage ?? window.localStorage;
    if (!target) {
      return;
    }
    target.setItem(MODE_KEY, preferences.mode);
    RETIRED_KEYS.forEach((key) => target.removeItem(key));
  } catch {
    // Private browsing and blocked storage should not prevent appearance changes.
  }
}
