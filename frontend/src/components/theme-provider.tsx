"use client";

import { useEffect } from "react";
import {
  applyAppearancePreferences,
  applyOrganizationTheme,
  readBrowserAppearancePreferences,
  readBrowserOrganizationTheme,
} from "@/lib/appearance-preferences";

export function ThemeProvider() {
  useEffect(() => {
    // A change in another tab (light/dark or the organization look) arrives
    // as a storage event, so every open tab follows it.
    const apply = () => {
      applyAppearancePreferences(readBrowserAppearancePreferences());
      applyOrganizationTheme(readBrowserOrganizationTheme());
    };
    apply();
    window.addEventListener("storage", apply);
    return () => window.removeEventListener("storage", apply);
  }, []);
  return null;
}
