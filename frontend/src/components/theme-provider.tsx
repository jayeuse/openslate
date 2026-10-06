"use client";

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyAppearancePreferences,
  persistAppearancePreferences,
  readBrowserAppearancePreferences,
  type AppearanceMode,
} from "@/lib/appearance-preferences";
import {
  saveUserTheme,
  themeNeedsSessionRecheck,
  userThemeKey,
  userThemeOptions,
} from "@/lib/user-theme-preferences";
import { Button } from "@/components/ui/button";
import { requestSessionRecheck } from "@/lib/auth-api";
import {
  useVerifiedWorkspaceUserId,
  useWorkspaceInteractionSuspended,
} from "@/components/systems/shared/runtime/workspace-identity";

// The root browser initializer stays available before sign-in. While a
// verified account owns the DOM, browser mode events cannot override it.
let accountThemeOwner: symbol | null = null;
let confirmedAccountMode: AppearanceMode | null = null;

function applyBrowserAppearance() {
  const browser = readBrowserAppearancePreferences();
  applyAppearancePreferences({
    ...browser,
    mode: accountThemeOwner ? (confirmedAccountMode ?? "light") : browser.mode,
  });
}

export function ThemeProvider() {
  useEffect(() => {
    applyBrowserAppearance();
    window.addEventListener("storage", applyBrowserAppearance);
    return () => window.removeEventListener("storage", applyBrowserAppearance);
  }, []);
  return null;
}

type UserThemePreference = {
  mode: AppearanceMode | undefined;
  loading: boolean;
  saving: boolean;
  disabled: boolean;
  error: string | null;
  setMode: (mode: AppearanceMode) => void;
  retry: () => void;
};

const UserThemeContext = createContext<UserThemePreference | null>(null);

export function useUserThemePreference(): UserThemePreference {
  const preference = useContext(UserThemeContext);
  if (!preference) throw new Error("Theme requires a verified account");
  return preference;
}

/** Mounted inside the existing account-keyed QueryClient, never the auth gate. */
export function UserThemeProvider({ children }: { children: ReactNode }) {
  const userId = useVerifiedWorkspaceUserId();
  const suspended = useWorkspaceInteractionSuspended();
  const client = useQueryClient();
  const query = useQuery(userThemeOptions(userId));
  const owner = useRef(Symbol("user-theme"));
  const live = useRef(false);
  const interactionSuspended = useRef(suspended);
  useLayoutEffect(() => {
    interactionSuspended.current = suspended;
  }, [suspended]);
  const writePending = useRef(false);
  const recheckedError = useRef<unknown>(null);
  const readAfterVerification = useRef(false);
  const mutation = useMutation({
    mutationFn: async (mode: AppearanceMode) => {
      // An older read must not replace the confirmed write in this cache.
      await client.cancelQueries({
        queryKey: userThemeKey(userId),
        exact: true,
      });
      return saveUserTheme(userId, mode);
    },
    retry: false,
  });

  useEffect(() => {
    const token = owner.current;
    live.current = true;
    accountThemeOwner = token;
    confirmedAccountMode = null;
    applyBrowserAppearance();
    return () => {
      live.current = false;
      if (accountThemeOwner === token) {
        accountThemeOwner = null;
        confirmedAccountMode = null;
        applyBrowserAppearance();
      }
    };
  }, []);

  useEffect(() => {
    if (suspended || accountThemeOwner !== owner.current) return;
    if (query.data) {
      confirmedAccountMode = query.data.theme;
      // Local motion may have applied successfully even if browser
      // storage rejected the write. A server response owns color mode only.
      persistAppearancePreferences({
        mode: query.data.theme,
        reduceMotion: document.documentElement.dataset.motion === "reduced",
      });
      document.documentElement.classList.toggle(
        "dark",
        query.data.theme === "dark",
      );
    }
    if (readAfterVerification.current) {
      readAfterVerification.current = false;
      void query.refetch();
    }
  }, [suspended, query.data, query.refetch]);

  const failure = mutation.error ?? query.error;
  useEffect(() => {
    if (
      suspended ||
      !themeNeedsSessionRecheck(failure) ||
      recheckedError.current === failure
    )
      return;
    recheckedError.current = failure;
    requestSessionRecheck();
  }, [failure, suspended]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== null && event.key !== "openslate-theme") return;
      if (!interactionSuspended.current && !writePending.current)
        void query.refetch();
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [query.refetch]);

  const error = mutation.error
    ? "Theme could not be saved. Retry to reload your saved preference."
    : query.error
      ? "Theme could not be loaded. Try again."
      : null;

  function setMode(mode: AppearanceMode) {
    if (
      suspended ||
      writePending.current ||
      !query.data ||
      error ||
      mode === query.data.theme
    )
      return;
    writePending.current = true;
    void mutation
      .mutateAsync(mode)
      .then((preference) => {
        if (!live.current || accountThemeOwner !== owner.current) return;
        if (interactionSuspended.current) {
          readAfterVerification.current = true;
          return;
        }
        client.setQueryData(userThemeKey(userId), preference);
      })
      .catch(() => {
        // The shared status below offers an explicit read retry. No write retries.
      })
      .finally(() => {
        writePending.current = false;
      });
  }

  function retry() {
    if (suspended || writePending.current) return;
    mutation.reset();
    void query.refetch();
  }

  return (
    <UserThemeContext.Provider
      value={{
        mode: query.data?.theme,
        loading: query.isPending,
        saving: mutation.isPending,
        disabled:
          suspended || query.isPending || mutation.isPending || Boolean(error),
        error,
        setMode,
        retry,
      }}
    >
      {children}
    </UserThemeContext.Provider>
  );
}

export function UserThemeStatus() {
  const preference = useUserThemePreference();
  if (preference.error)
    return (
      <div className="space-y-2">
        <p role="alert" className="text-destructive text-sm">
          {preference.error}
        </p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={preference.retry}
          disabled={preference.loading || preference.saving}
        >
          Retry theme
        </Button>
      </div>
    );
  if (!preference.loading && !preference.saving) return null;
  return (
    <p role="status" className="text-muted-foreground text-sm">
      {preference.saving ? "Saving theme…" : "Loading theme…"}
    </p>
  );
}
