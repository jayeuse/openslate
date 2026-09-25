import {
  type CommsScopeConfiguration,
  type CommsSettingKey,
  type CommsSettings,
} from "../domain/configuration";
import { SETTINGS_LABELS } from "./settings-fields";

export function changed(a: unknown, b: unknown) {
  return JSON.stringify(a) !== JSON.stringify(b);
}

export function mergeFields<T extends object>(
  current: T,
  baseline: T,
  draft: T,
): T {
  const result = { ...current };
  for (const key of new Set([
    ...Object.keys(baseline),
    ...Object.keys(draft),
  ]) as Set<keyof T>) {
    if (!changed(baseline[key], draft[key])) continue;
    if (Object.hasOwn(draft, key)) result[key] = draft[key];
    else delete result[key];
  }
  return result;
}

export function mergeScope(
  current: CommsScopeConfiguration,
  baseline: CommsScopeConfiguration,
  draft: CommsScopeConfiguration,
): CommsScopeConfiguration {
  const permissions = { ...current.permissions };
  for (const subject of new Set([
    ...Object.keys(baseline.permissions),
    ...Object.keys(draft.permissions),
  ])) {
    permissions[subject] = mergeFields(
      current.permissions[subject] ?? {},
      baseline.permissions[subject] ?? {},
      draft.permissions[subject] ?? {},
    );
  }
  return {
    settings: mergeFields(current.settings, baseline.settings, draft.settings),
    permissions,
  };
}

export function cleanSettings(
  settings: Partial<CommsSettings>,
): Partial<CommsSettings> {
  return Object.fromEntries(
    Object.entries(settings).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? [...new Set(value.map((item) => item.trim()).filter(Boolean))]
        : value,
    ]),
  );
}

export function settingsError(settings: Partial<CommsSettings>): string {
  for (const [key, value] of Object.entries(settings))
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) || value < 0 || !Number.isInteger(value))
    )
      return `${SETTINGS_LABELS[key as CommsSettingKey]} must be a whole number of zero or more.`;
  if (Boolean(settings.quietHoursStart) !== Boolean(settings.quietHoursEnd))
    return "Choose both the start and end of quiet hours.";
  if (
    settings.recordCardFields?.some(
      (field) =>
        !["title", "customer", "status", "assignee", "dueDate"].includes(field),
    )
  )
    return "Record card fields must be title, customer, status, assignee, or dueDate.";
  return "";
}
