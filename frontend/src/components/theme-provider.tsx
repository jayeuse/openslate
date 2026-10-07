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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyAppearancePreferences,
  applyDeviceAppearancePreferences,
  DEFAULT_APPEARANCE_PREFERENCES,
  DEFAULT_DEVICE_APPEARANCE,
  persistAppearancePreferences,
  persistDeviceAppearancePreferences,
  readBrowserAppearancePreferences,
  readBrowserDeviceAppearancePreferences,
  type AppearanceMode,
  type DeviceAppearancePreferences,
  type MotionPreference,
} from "@/lib/appearance-preferences";
import {
  saveUserPreferences,
  preferencesNeedSessionRecheck,
  userPreferencesKey,
  userPreferencesOptions,
  type UserPreferencesPatch,
  type UserPreferences,
} from "@/lib/user-theme-preferences";
import { Button } from "@/components/ui/button";
import { requestSessionRecheck } from "@/lib/auth-api";
import {
  useVerifiedWorkspaceUserId,
  useWorkspaceInteractionSuspended,
} from "@/components/systems/shared/runtime/workspace-identity";

let accountPreferencesOwner: symbol | null = null;
let confirmedAccountPreferences: UserPreferences | null = null;

function applyAccountAppearance() {
  const preference = confirmedAccountPreferences;
  applyAppearancePreferences(
    preference
      ? {
          mode: preference.theme,
          reduceMotion: preference.appearance.motion === "reduce",
        }
      : DEFAULT_APPEARANCE_PREFERENCES,
  );
}

/** The existing public initializer owns bootstrap caches only before sign-in. */
export function ThemeProvider() {
  useEffect(() => {
    const apply = () => {
      if (accountPreferencesOwner) return;
      applyAppearancePreferences(readBrowserAppearancePreferences());
      applyDeviceAppearancePreferences(
        readBrowserDeviceAppearancePreferences(),
      );
    };
    const sync = (event: StorageEvent) => {
      if (
        event.key === null ||
        [
          "openslate-theme",
          "openslate-motion",
          "openslate-text-size",
          "openslate-density",
        ].includes(event.key)
      )
        apply();
    };
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    apply();
    window.addEventListener("storage", sync);
    media.addEventListener("change", apply);
    return () => {
      window.removeEventListener("storage", sync);
      media.removeEventListener("change", apply);
    };
  }, []);
  return null;
}

type PreferencesContextValue = {
  mode: AppearanceMode | undefined;
  motion: MotionPreference | undefined;
  keyboardShortcuts: boolean | undefined;
  loading: boolean;
  saving: boolean;
  disabled: boolean;
  error: string | null;
  device: DeviceAppearancePreferences;
  deviceStorageAvailable: boolean;
  setMode: (mode: AppearanceMode) => void;
  setMotion: (motion: MotionPreference) => void;
  setKeyboardShortcuts: (enabled: boolean) => void;
  setDevice: (next: Partial<DeviceAppearancePreferences>) => void;
  retry: () => void;
};
const PreferencesContext = createContext<PreferencesContextValue | null>(null);
export function useUserPreferences(): PreferencesContextValue {
  const preference = useContext(PreferencesContext);
  if (!preference) throw new Error("Preferences require a verified account");
  return preference;
}

/** One verified account, inside its existing QueryClient and interaction gate. */
export function UserPreferencesProvider({ children }: { children: ReactNode }) {
  const userId = useVerifiedWorkspaceUserId();
  const suspended = useWorkspaceInteractionSuspended();
  const client = useQueryClient();
  const query = useQuery(userPreferencesOptions(userId));
  const owner = useRef(Symbol("user-preferences"));
  const live = useRef(false);
  const interactionSuspended = useRef(suspended);
  const writePending = useRef(false);
  const recheckedError = useRef<unknown>(null);
  const readAfterVerification = useRef(false);
  const [verifying, setVerifying] = useState(false);
  const [acceptedPreferences, setAcceptedPreferences] =
    useState<UserPreferences | null>(null);
  const observedRead = useRef({
    dataUpdatedAt: query.dataUpdatedAt,
    errorUpdatedAt: query.errorUpdatedAt,
  });
  const [device, setDeviceState] = useState<DeviceAppearancePreferences>(
    DEFAULT_DEVICE_APPEARANCE,
  );
  const [deviceStorageAvailable, setDeviceStorageAvailable] = useState(true);
  useLayoutEffect(() => {
    interactionSuspended.current = suspended;
  }, [suspended]);
  const ownsAppearance = useCallback(
    () => live.current && accountPreferencesOwner === owner.current,
    [],
  );
  const mutation = useMutation({
    mutationFn: async (patch: UserPreferencesPatch) => {
      await client.cancelQueries({
        queryKey: userPreferencesKey(userId),
        exact: true,
      });
      if (!ownsAppearance() || interactionSuspended.current)
        throw new DOMException("Preference command cancelled", "AbortError");
      return saveUserPreferences(userId, patch);
    },
    retry: false,
  });

  useLayoutEffect(() => {
    const token = owner.current;
    live.current = true;
    accountPreferencesOwner = token;
    confirmedAccountPreferences = null;
    applyAccountAppearance();
    const browserDevice = readBrowserDeviceAppearancePreferences();
    setDeviceState(browserDevice);
    applyDeviceAppearancePreferences(browserDevice);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      if (live.current && accountPreferencesOwner === token)
        applyAccountAppearance();
    };
    media.addEventListener("change", sync);
    return () => {
      live.current = false;
      media.removeEventListener("change", sync);
      if (accountPreferencesOwner === token) {
        accountPreferencesOwner = null;
        confirmedAccountPreferences = null;
        applyAppearancePreferences(readBrowserAppearancePreferences());
      }
    };
  }, []);

  useEffect(() => {
    const readCompleted =
      query.dataUpdatedAt !== observedRead.current.dataUpdatedAt ||
      query.errorUpdatedAt !== observedRead.current.errorUpdatedAt;
    observedRead.current = {
      dataUpdatedAt: query.dataUpdatedAt,
      errorUpdatedAt: query.errorUpdatedAt,
    };
    if (!ownsAppearance()) return;
    if (suspended) {
      if (readCompleted) {
        readAfterVerification.current = true;
        setVerifying(true);
      }
      return;
    }
    if (readAfterVerification.current) {
      readAfterVerification.current = false;
      setVerifying(true);
      void query.refetch().finally(() => {
        if (ownsAppearance()) {
          if (interactionSuspended.current)
            readAfterVerification.current = true;
          setVerifying(false);
        }
      });
      return;
    }
    if (verifying || !query.data || query.error) return;
    confirmedAccountPreferences = query.data;
    setAcceptedPreferences(query.data);
    const appearance = {
      mode: query.data.theme,
      reduceMotion: query.data.appearance.motion === "reduce",
    };
    persistAppearancePreferences(appearance);
    applyAppearancePreferences(appearance);
  }, [
    suspended,
    query.data,
    query.dataUpdatedAt,
    query.error,
    query.errorUpdatedAt,
    query.refetch,
    verifying,
    ownsAppearance,
  ]);

  const failure = mutation.error ?? query.error;
  useEffect(() => {
    if (
      !ownsAppearance() ||
      suspended ||
      !preferencesNeedSessionRecheck(failure) ||
      recheckedError.current === failure
    )
      return;
    recheckedError.current = failure;
    requestSessionRecheck();
  }, [failure, suspended, ownsAppearance]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (!ownsAppearance()) return;
      if (
        event.key === null ||
        ["openslate-text-size", "openslate-density"].includes(event.key)
      ) {
        const next = readBrowserDeviceAppearancePreferences();
        setDeviceState(next);
        applyDeviceAppearancePreferences(next);
      }
      if (
        (event.key === null ||
          ["openslate-theme", "openslate-motion"].includes(event.key)) &&
        !interactionSuspended.current &&
        !writePending.current
      )
        void query.refetch();
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [query.refetch, ownsAppearance]);

  const error = mutation.error
    ? "Preferences could not be saved. Retry to reload your saved preferences."
    : query.error
      ? "Preferences could not be loaded. Try again."
      : null;
  function save(patch: UserPreferencesPatch) {
    if (
      !ownsAppearance() ||
      interactionSuspended.current ||
      writePending.current ||
      verifying ||
      !query.data ||
      !acceptedPreferences ||
      error
    )
      return;
    writePending.current = true;
    void mutation
      .mutateAsync(patch)
      .then((preference) => {
        if (!ownsAppearance()) return;
        if (interactionSuspended.current) {
          readAfterVerification.current = true;
          return;
        }
        client.setQueryData(userPreferencesKey(userId), preference);
      })
      .catch(() => {
        /* Explicit read retry; never repeat a write automatically. */
      })
      .finally(() => {
        writePending.current = false;
      });
  }
  function retry() {
    if (
      !ownsAppearance() ||
      interactionSuspended.current ||
      writePending.current ||
      verifying
    )
      return;
    setVerifying(true);
    mutation.reset();
    void query.refetch().finally(() => {
      if (!ownsAppearance()) return;
      if (interactionSuspended.current) readAfterVerification.current = true;
      setVerifying(false);
    });
  }
  function setDevice(next: Partial<DeviceAppearancePreferences>) {
    if (!ownsAppearance()) return;
    const values = { ...device, ...next };
    setDeviceState(values);
    applyDeviceAppearancePreferences(values);
    setDeviceStorageAvailable(persistDeviceAppearancePreferences(values));
  }
  return (
    <PreferencesContext.Provider
      value={{
        mode: acceptedPreferences?.theme,
        motion: acceptedPreferences?.appearance.motion,
        keyboardShortcuts: acceptedPreferences?.appearance.keyboard_shortcuts,
        loading: query.isPending || verifying,
        saving: mutation.isPending,
        disabled:
          !acceptedPreferences ||
          suspended ||
          query.isPending ||
          mutation.isPending ||
          verifying ||
          Boolean(error),
        error,
        device,
        deviceStorageAvailable,
        setMode: (mode) => {
          if (mode !== query.data?.theme) save({ theme: mode });
        },
        setMotion: (motion) => {
          if (motion !== query.data?.appearance.motion)
            save({ appearance: { motion } });
        },
        setKeyboardShortcuts: (enabled) => {
          if (enabled !== query.data?.appearance.keyboard_shortcuts)
            save({ appearance: { keyboard_shortcuts: enabled } });
        },
        setDevice,
        retry,
      }}
    >
      {children}
    </PreferencesContext.Provider>
  );
}

export function UserPreferencesStatus() {
  const preference = useUserPreferences();
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
          Retry preferences
        </Button>
      </div>
    );
  if (!preference.loading && !preference.saving) return null;
  return (
    <p role="status" className="text-muted-foreground text-sm">
      {preference.saving ? "Saving preferences…" : "Loading preferences…"}
    </p>
  );
}
