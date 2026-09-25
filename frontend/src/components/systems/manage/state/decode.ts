import {
  initialManageActivity,
  initialManageSettings,
  initialManageSnapshots,
  initialManageState,
  manageOptions,
  manageSectionKeys,
  manageSettingLabels,
  type ManageActivityEntry,
  type ManageSection,
  type ManageSettings,
  type ManageSnapshot,
  type ManageState,
  type ManageValidationErrors,
} from "./model";

type Drafts = ManageState["drafts"];

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function validateManageSection(
  section: ManageSection,
  values: ManageSettings,
): ManageValidationErrors {
  const errors: ManageValidationErrors = {};
  for (const key of manageSectionKeys[section]) {
    if (
      key in manageOptions &&
      !(manageOptions[key as keyof typeof manageOptions] as string[]).includes(
        values[key],
      )
    )
      errors[key] = `Choose a valid ${manageSettingLabels[key].toLowerCase()}.`;
  }
  if (section === "organization") {
    if (!values.name.trim()) errors.name = "Enter an organization name.";
    const hours =
      /^([01]\d|2[0-3]):([0-5]\d)\s*[–-]\s*([01]\d|2[0-3]):([0-5]\d)$/.exec(
        values.hours,
      );
    if (
      !hours ||
      Number(hours[1]) * 60 + Number(hours[2]) >=
        Number(hours[3]) * 60 + Number(hours[4])
    )
      errors.hours =
        "Use a same-day range such as 09:00–18:00, with closing time after opening time.";
  }
  if (
    section === "security" &&
    values.ips
      .split(",")
      .some(
        (item) =>
          item.trim() &&
          !/^192\.0\.2\.(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])(?:\/(?:[0-9]|[12][0-9]|3[0-2]))?$/.test(
            item.trim(),
          ),
      )
  )
    errors.ips =
      "Use comma-separated documentation IPv4 addresses in 192.0.2.0/24, optionally with a CIDR prefix.";
  return errors;
}
export function decodeManageSettings(value: unknown): ManageSettings {
  const raw = object(value);
  const settings = { ...initialManageSettings };
  if (!raw) return settings;
  for (const key of Object.keys(settings) as (keyof ManageSettings)[])
    if (typeof raw[key] === "string") settings[key] = raw[key];
  for (const section of Object.keys(manageSectionKeys) as ManageSection[])
    for (const key of Object.keys(
      validateManageSection(section, settings),
    ) as (keyof ManageSettings)[])
      settings[key] = initialManageSettings[key];
  if (!["Team", "Business"].includes(settings.tier))
    settings.tier = initialManageSettings.tier;
  if (!["1.4.2", "1.5.0"].includes(settings.version))
    settings.version = initialManageSettings.version;
  if (!["", "1.4.2", "1.5.0"].includes(settings.previous))
    settings.previous = "";
  if (!validDate(settings.expiry))
    settings.expiry = initialManageSettings.expiry;
  return settings;
}
export function decodeDrafts(value: unknown): Drafts {
  const raw = object(value);
  const drafts: Drafts = {};
  if (!raw) return drafts;
  for (const section of Object.keys(manageSectionKeys) as ManageSection[]) {
    const draft = object(raw[section]);
    if (!draft) continue;
    const fields: Partial<ManageSettings> = {};
    for (const key of manageSectionKeys[section])
      if (typeof draft[key] === "string") fields[key] = draft[key];
    drafts[section] = fields;
  }
  return drafts;
}
export function decodeBackups(value: unknown): ManageSnapshot[] {
  if (!Array.isArray(value)) return initialManageSnapshots;
  const ids = new Set<string>();
  return value.flatMap((entry) => {
    const item = object(entry);
    if (
      !item ||
      typeof item.id !== "string" ||
      !item.id ||
      ids.has(item.id) ||
      typeof item.name !== "string" ||
      typeof item.date !== "string" ||
      !object(item.settings)
    )
      return [];
    ids.add(item.id);
    return [
      {
        id: item.id,
        name: item.name,
        date: item.date,
        settings: decodeManageSettings(item.settings),
      },
    ];
  });
}
function normalizeLegacyManageActivity(value: string): string {
  return value
    .replaceAll("Sample administrator", "Workspace administrator")
    .replaceAll("Sample license", "License")
    .replaceAll("sample license", "license")
    .replaceAll("Sample release", "Release")
    .replaceAll("sample release", "release")
    .replaceAll("Sample snapshot", "Snapshot")
    .replaceAll("sample snapshot", "snapshot")
    .replaceAll("Sample settings", "Settings")
    .replaceAll("sample settings", "settings")
    .replaceAll("Sample session", "Session")
    .replaceAll("sample sessions", "device sessions")
    .replaceAll("sample session", "session")
    .replaceAll("Sample version", "Version")
    .replaceAll("sample version", "version");
}

export function decodeHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return initialManageState.history;
  return value.flatMap((item) =>
    typeof item === "string" ? [normalizeLegacyManageActivity(item)] : [],
  );
}

export function decodeActivity(value: unknown): ManageActivityEntry[] {
  if (!Array.isArray(value)) return initialManageActivity;
  const ids = new Set<string>();
  return value.flatMap((entry) => {
    const item = object(entry);
    if (
      !item ||
      !["example", "manage"].includes(String(item.source)) ||
      ![
        "id",
        "user",
        "date",
        "entity",
        "action",
        "target",
        "before",
        "after",
      ].every((key) => typeof item[key] === "string") ||
      ids.has(String(item.id))
    )
      return [];
    ids.add(String(item.id));
    const source = item.source === "manage" ? "manage" : "example";
    const normalize =
      source === "manage"
        ? normalizeLegacyManageActivity
        : (text: string) => text;
    return [
      {
        id: String(item.id),
        user: normalize(String(item.user)),
        date: String(item.date),
        entity: normalize(String(item.entity)),
        action: normalize(String(item.action)),
        target: normalize(String(item.target)),
        before: normalize(String(item.before)),
        after: normalize(String(item.after)),
        source,
      },
    ];
  });
}
