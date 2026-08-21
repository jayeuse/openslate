"use client";

import { useEffect } from "react";

export function ThemeProvider() {
  useEffect(() => {
    const stored = window.localStorage.getItem("openslate-theme");
    const theme = stored === "dark" || stored === "light" ? stored : "light";
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.dataset.accent =
      window.localStorage.getItem("openslate-accent") ?? "cobalt";
    document.documentElement.dataset.density =
      window.localStorage.getItem("openslate-density") ?? "comfortable";
    document.documentElement.dataset.radius =
      window.localStorage.getItem("openslate-radius") ?? "subtle";
  }, []);
  return null;
}
