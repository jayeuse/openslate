"use client";

import { useEffect } from "react";
import {
  applyAppearancePreferences,
  readBrowserAppearancePreferences,
} from "@/lib/appearance-preferences";

export function ThemeProvider() {
  useEffect(() => {
    const apply = () =>
      applyAppearancePreferences(readBrowserAppearancePreferences());
    apply();
    window.addEventListener("storage", apply);
    return () => window.removeEventListener("storage", apply);
  }, []);
  return null;
}
