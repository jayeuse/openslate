"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getWorkspaceAppearance } from "@/components/systems/manage/adapters/workspace-api";
import {
  applyOrganizationTheme,
  ORGANIZATION_THEME_KEY,
  persistOrganizationTheme,
  readBrowserOrganizationTheme,
  type OrganizationTheme,
} from "@/lib/appearance-preferences";

type OrganizationThemeState = {
  theme: OrganizationTheme;
  getCommittedTheme: () => OrganizationTheme;
  confirm: (theme: OrganizationTheme) => void;
  preview: (owner: symbol, theme: OrganizationTheme) => void;
  release: (owner: symbol) => void;
};
const OrganizationThemeContext = createContext<OrganizationThemeState | null>(
  null,
);

export function useOrganizationTheme(): OrganizationThemeState {
  const value = useContext(OrganizationThemeContext);
  if (!value) throw new Error("Organization theme requires the root provider");
  return value;
}

/** The installation's public palette and one owner-local unsaved preview. */
export function OrganizationThemeProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [theme, setTheme] = useState<OrganizationTheme>("slate");
  const committed = useRef<OrganizationTheme>("slate");
  const preview = useRef<{ owner: symbol; theme: OrganizationTheme } | null>(
    null,
  );
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const live = useRef(false);

  // Stable methods let an editor own its preview without effect cleanup caused
  // by a committed value changing. Async commands read the current baseline.
  const getCommittedTheme = useCallback(() => committed.current, []);
  const confirm = useCallback((next: OrganizationTheme) => {
    generation.current += 1;
    request.current?.abort();
    committed.current = next;
    setTheme(next);
    persistOrganizationTheme(next);
    applyOrganizationTheme(preview.current?.theme ?? next);
  }, []);
  const showPreview = useCallback((owner: symbol, next: OrganizationTheme) => {
    preview.current = { owner, theme: next };
    applyOrganizationTheme(next);
  }, []);
  const release = useCallback((owner: symbol) => {
    if (preview.current?.owner !== owner) return;
    preview.current = null;
    applyOrganizationTheme(committed.current);
  }, []);

  useLayoutEffect(() => {
    const cached = readBrowserOrganizationTheme();
    committed.current = cached;
    setTheme(cached);
    applyOrganizationTheme(preview.current?.theme ?? cached);
  }, []);

  useEffect(() => {
    live.current = true;
    const refresh = () => {
      const epoch = ++generation.current;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      void getWorkspaceAppearance(controller.signal)
        .then((appearance) => {
          if (
            live.current &&
            generation.current === epoch &&
            !controller.signal.aborted
          )
            confirm(appearance.theme);
        })
        .catch(() => {
          // Keep the validated cache (or Slate) on a failed public read.
        });
    };
    const sync = (event: StorageEvent) => {
      if (event.key === null || event.key === ORGANIZATION_THEME_KEY) refresh();
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", sync);
    return () => {
      live.current = false;
      generation.current += 1;
      request.current?.abort();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", sync);
    };
  }, [confirm]);

  return (
    <OrganizationThemeContext.Provider
      value={{
        theme,
        getCommittedTheme,
        confirm,
        preview: showPreview,
        release,
      }}
    >
      {children}
    </OrganizationThemeContext.Provider>
  );
}
