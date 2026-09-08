export const DEFAULT_APPEARANCE_PREFERENCES = {
  theme: "light",
  accent: "cobalt",
  density: "comfortable",
  radius: "subtle",
} as const;

export type AppearanceTheme = "light" | "dark";
export type AppearanceAccent = "cobalt" | "indigo" | "emerald" | "neutral";
export type AppearanceDensity = "comfortable" | "compact";
export type AppearanceRadius = "square" | "subtle" | "rounded";

export interface AppearancePreferences {
  theme: AppearanceTheme;
  accent: AppearanceAccent;
  density: AppearanceDensity;
  radius: AppearanceRadius;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

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
    const theme = storage.getItem("openslate-theme");
    const accent = storage.getItem("openslate-accent");
    const density = storage.getItem("openslate-density");
    const radius = storage.getItem("openslate-radius");

    return {
      theme: isOneOf(theme, ["light", "dark"])
        ? theme
        : DEFAULT_APPEARANCE_PREFERENCES.theme,
      accent: isOneOf(accent, ["cobalt", "indigo", "emerald", "neutral"])
        ? accent
        : DEFAULT_APPEARANCE_PREFERENCES.accent,
      density: isOneOf(density, ["comfortable", "compact"])
        ? density
        : DEFAULT_APPEARANCE_PREFERENCES.density,
      radius: isOneOf(radius, ["square", "subtle", "rounded"])
        ? radius
        : DEFAULT_APPEARANCE_PREFERENCES.radius,
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
  root.classList.toggle("dark", preferences.theme === "dark");
  root.dataset.accent = preferences.accent;
  root.dataset.density = preferences.density;
  root.dataset.radius = preferences.radius;
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
    target.setItem("openslate-theme", preferences.theme);
    target.setItem("openslate-accent", preferences.accent);
    target.setItem("openslate-density", preferences.density);
    target.setItem("openslate-radius", preferences.radius);
  } catch {
    // Private browsing and blocked storage should not prevent appearance changes.
  }
}
