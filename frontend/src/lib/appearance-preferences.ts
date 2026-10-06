export const DEFAULT_APPEARANCE_PREFERENCES = {
  mode: "light",
  reduceMotion: false,
} as const;

export type AppearanceMode = "light" | "dark";

export interface AppearancePreferences {
  mode: AppearanceMode;
  /**
   * Reduce motion in this browser, as the device's reduced-motion setting
   * does (fades stay, movement stops). Off follows the device setting.
   */
  reduceMotion: boolean;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// The light/dark key predates organization themes, so it keeps its old name.
const MODE_KEY = "openslate-theme";
// Stored only while reduce motion is on (public/theme-init.js reads it too).
const MOTION_KEY = "openslate-motion";
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
      reduceMotion: storage.getItem(MOTION_KEY) === "reduced",
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
  if (preferences.reduceMotion) root.dataset.motion = "reduced";
  else delete root.dataset.motion;
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
    if (preferences.reduceMotion) target.setItem(MOTION_KEY, "reduced");
    else target.removeItem(MOTION_KEY);
    RETIRED_KEYS.forEach((key) => target.removeItem(key));
  } catch {
    // Private browsing and blocked storage should not prevent appearance changes.
  }
}

/**
 * The organization's look. Themes change color, type, and materials only;
 * layout, behavior, and words stay the same. The owner picks one for the
 * whole organization. The server owns the saved choice; browser storage is
 * a validated cache used by the blocking prepaint script.
 */
export const ORGANIZATION_THEMES = [
  "slate",
  "whiteboard",
  "triplicate",
  "stockroom",
] as const;

export type OrganizationTheme = (typeof ORGANIZATION_THEMES)[number];

export const ORGANIZATION_THEME_KEY = "openslate-org-theme";

export function readOrganizationTheme(
  storage: Pick<Storage, "getItem"> | null | undefined,
): OrganizationTheme {
  try {
    const value = storage?.getItem(ORGANIZATION_THEME_KEY) ?? null;
    return isOneOf(value, ORGANIZATION_THEMES) ? value : "slate";
  } catch {
    return "slate";
  }
}

export function readBrowserOrganizationTheme(): OrganizationTheme {
  try {
    return readOrganizationTheme(window.localStorage);
  } catch {
    return "slate";
  }
}

/** Slate is the base token set, so it needs no attribute. */
export function applyOrganizationTheme(
  theme: OrganizationTheme,
  root: HTMLElement = document.documentElement,
): void {
  if (theme === "slate") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

export function persistOrganizationTheme(
  theme: OrganizationTheme,
  storage?: StorageLike | null,
): void {
  try {
    (storage ?? window.localStorage)?.setItem(ORGANIZATION_THEME_KEY, theme);
  } catch {
    // Blocked storage still applies the look for this page view.
  }
}
