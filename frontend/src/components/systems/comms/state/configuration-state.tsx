"use client";
import {
  createContext,
  useCallback,
  useContext,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useSampleState } from "../../shared/runtime/sample-state";
import { useCommsCommands } from "./runtime";
import {
  normalizeCommsConfiguration,
  type CommsConfiguration,
} from "../domain/configuration";

export type CommsConfigurationSetter = (
  action: SetStateAction<CommsConfiguration>,
) => Promise<CommsConfiguration>;

const resolvedConfiguration = createContext<CommsConfiguration | null>(null);
export type CommsPlatformPreferences = {
  threads: boolean;
  records: boolean;
  digest: boolean;
};
export const DEFAULT_PLATFORM_PREFERENCES: CommsPlatformPreferences = {
  threads: true,
  records: true,
  digest: false,
};
const resolvedPlatformPreferences =
  createContext<CommsPlatformPreferences | null>(null);

/**
 * Supplies the configuration snapshot resolved by the Comms resource to all
 * nested editors and readers. Consumers outside the Comms page continue to
 * use the persisted sample state fallback below.
 */
export function CommsConfigurationProvider({
  value,
  children,
}: {
  value: CommsConfiguration;
  children: ReactNode;
}) {
  return (
    <resolvedConfiguration.Provider value={value}>
      {children}
    </resolvedConfiguration.Provider>
  );
}

export function CommsPlatformPreferencesProvider({
  value,
  children,
}: {
  value: CommsPlatformPreferences;
  children: ReactNode;
}) {
  return (
    <resolvedPlatformPreferences.Provider value={value}>
      {children}
    </resolvedPlatformPreferences.Provider>
  );
}

function normalizePlatformPreferences(raw: unknown): CommsPlatformPreferences {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return DEFAULT_PLATFORM_PREFERENCES;
  const value = raw as Record<string, unknown>;
  return {
    threads:
      typeof value.threads === "boolean"
        ? value.threads
        : DEFAULT_PLATFORM_PREFERENCES.threads,
    records:
      typeof value.records === "boolean"
        ? value.records
        : DEFAULT_PLATFORM_PREFERENCES.records,
    digest:
      typeof value.digest === "boolean"
        ? value.digest
        : DEFAULT_PLATFORM_PREFERENCES.digest,
  };
}

export function useCommsConfiguration(): [
  CommsConfiguration,
  CommsConfigurationSetter,
] {
  const { run } = useCommsCommands();
  const resolved = useContext(resolvedConfiguration);
  const [raw] = useSampleState<unknown>("comms-configuration", null);
  // The page provider supplies the resource snapshot once it is ready. The
  // persisted sample state is only the stable first-render fallback for
  // consumers mounted outside that provider.
  const value = resolved ?? normalizeCommsConfiguration(raw);
  const setValue = useCallback<CommsConfigurationSetter>(
    (action) =>
      run(
        "comms-configuration",
        (draft) => {
          const current = normalizeCommsConfiguration(
            draft.read<unknown>("comms-configuration", null),
          );
          const next = normalizeCommsConfiguration(
            typeof action === "function" ? action(current) : action,
          );
          draft.update("comms-configuration", null, next);
          return next;
        },
        ["comms-configuration"],
      ),
    [run],
  );
  return [value, setValue];
}

export function useCommsPlatformPreferences(): [CommsPlatformPreferences] {
  const resolved = useContext(resolvedPlatformPreferences);
  const [raw] = useSampleState<unknown>(
    "platformNotificationPreferences",
    DEFAULT_PLATFORM_PREFERENCES,
  );
  return [resolved ?? normalizePlatformPreferences(raw)];
}
