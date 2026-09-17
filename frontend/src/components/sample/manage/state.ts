"use client";

import { useState } from "react";
import {
  useSampleState,
  useSampleStorage,
  useSampleRuntime,
  type SampleTransactionDraft,
} from "../sample-state";
import { initialManageSessions, type ManageSession } from "./sessions";
import type { SampleRuntime } from "../sample-runtime";
import { completeCollection } from "../sample-collections";
import { initialPeople } from "../access/model";
import {
  useSampleCommands,
  useSampleResource,
  sampleOperationMessage,
} from "../sample-async";

export type ManageSettings = {
  name: string;
  logo: string;
  locale: string;
  timezone: string;
  currency: string;
  week: string;
  hours: string;
  password: string;
  timeout: string;
  mfa: string;
  ips: string;
  schedule: string;
  retention: string;
  version: string;
  previous: string;
  tier: string;
  expiry: string;
};
export type ManageSection = "organization" | "security" | "backup";
export type ManageTab = ManageSection | "audit" | "updates" | "licensing";
export type ManageValidationErrors = Partial<
  Record<keyof ManageSettings, string>
>;
export type ManageSnapshot = {
  id: string;
  name: string;
  date: string;
  settings: ManageSettings;
};
export type ManageSnapshotDiff = {
  key: keyof ManageSettings;
  label: string;
  before: string;
  after: string;
};
export type ManageActivityEntry = {
  id: string;
  user: string;
  date: string;
  entity: string;
  action: string;
  target: string;
  before: string;
  after: string;
  source: "example" | "manage";
};
export type ManageActionResult = { ok: boolean; message: string; id?: string };

export const initialManageSettings: ManageSettings = {
  name: "Riverside Services",
  logo: "RS",
  locale: "English (Philippines)",
  timezone: "Asia/Manila",
  currency: "PHP",
  week: "Monday",
  hours: "09:00–18:00",
  password: "12 characters + mixed case",
  timeout: "60 minutes",
  mfa: "Optional",
  ips: "192.0.2.0/24",
  schedule: "Daily at 02:00",
  retention: "30 days",
  version: "1.4.2",
  previous: "",
  tier: "Team",
  expiry: "2027-09-11",
};
export const manageOptions = {
  logo: ["RS", "R", "Compass"],
  locale: ["English (Philippines)", "Filipino", "English (US)"],
  timezone: ["Asia/Manila", "UTC", "Asia/Singapore"],
  currency: ["PHP", "USD", "SGD"],
  week: ["Monday", "Sunday"],
  password: [
    "12 characters + mixed case",
    "16 characters + mixed case + number",
    "20-character passphrase",
  ],
  timeout: ["15 minutes", "30 minutes", "60 minutes", "8 hours"],
  mfa: ["Optional", "Required for administrators", "Required for everyone"],
  schedule: ["Disabled", "Daily at 02:00", "Weekly on Sunday at 02:00"],
  retention: ["7 days", "30 days", "90 days"],
};
export const manageSectionKeys: Record<
  ManageSection,
  (keyof ManageSettings)[]
> = {
  organization: [
    "name",
    "logo",
    "locale",
    "timezone",
    "currency",
    "week",
    "hours",
  ],
  security: ["password", "timeout", "mfa", "ips"],
  backup: ["schedule", "retention"],
};
export const manageSettingLabels: Record<keyof ManageSettings, string> = {
  name: "Organization name",
  logo: "Organization logo",
  locale: "Locale",
  timezone: "Timezone",
  currency: "Currency",
  week: "Week starts on",
  hours: "Business hours",
  password: "Password policy",
  timeout: "Session timeout",
  mfa: "Two-factor authentication",
  ips: "IP allow list",
  schedule: "Backup schedule",
  retention: "Retention period",
  version: "Current version",
  previous: "Rollback version",
  tier: "License tier",
  expiry: "License expiry",
};
export const initialManageSnapshots: ManageSnapshot[] = [
  {
    id: "sample-backup-initial",
    name: "Scheduled snapshot",
    date: "2026-09-11 02:00",
    settings: { ...initialManageSettings },
  },
  {
    id: "sample-backup-after-setup",
    name: "After workspace setup",
    date: "2026-09-10 02:00",
    settings: { ...initialManageSettings },
  },
  {
    id: "sample-backup-weekly",
    name: "Weekly operations checkpoint",
    date: "2026-09-07 02:00",
    settings: { ...initialManageSettings },
  },
  {
    id: "sample-backup-before-release",
    name: "Before release review",
    date: "2026-09-05 16:30",
    settings: { ...initialManageSettings, version: "1.4.2" },
  },
  {
    id: "sample-backup-security",
    name: "Security policy checkpoint",
    date: "2026-09-03 09:15",
    settings: { ...initialManageSettings, mfa: "Required for administrators" },
  },
  {
    id: "sample-backup-operations",
    name: "Operations handoff",
    date: "2026-09-01 17:45",
    settings: { ...initialManageSettings, hours: "08:00–17:00" },
  },
];
export const initialManageActivity: ManageActivityEntry[] = [
  {
    id: "sample-audit-1",
    user: "Mara Santos",
    date: "2026-09-11",
    entity: "Work orders",
    action: "Update",
    target: "WO-1042",
    before: "Status: Assigned",
    after: "Status: In progress",
    source: "example",
  },
  {
    id: "sample-audit-2",
    user: "Eli Cruz",
    date: "2026-09-10",
    entity: "Equipment",
    action: "Create",
    target: "EQ-0028",
    before: "No equipment record",
    after: "Pump · North depot · Active",
    source: "example",
  },
  {
    id: "sample-audit-3",
    user: "Mara Santos",
    date: "2026-09-09",
    entity: "Users",
    action: "Close",
    target: "Nina Reyes",
    before: "User: Active",
    after: "User: Deactivated",
    source: "example",
  },
  {
    id: "sample-audit-4",
    user: "Iris Tan",
    date: "2026-09-08",
    entity: "Customers",
    action: "Update",
    target: "CUS-031",
    before: "Segment: Standard",
    after: "Segment: Priority",
    source: "example",
  },
  {
    id: "sample-audit-5",
    user: "Paolo Lim",
    date: "2026-09-07",
    entity: "Work orders",
    action: "Close",
    target: "WO-1038",
    before: "Status: In progress",
    after: "Status: Closed",
    source: "example",
  },
  {
    id: "sample-audit-6",
    user: "Lian Ong",
    date: "2026-09-06",
    entity: "Reports",
    action: "Create",
    target: "Weekly operations",
    before: "No report",
    after: "Report: Operations · Weekly",
    source: "example",
  },
  {
    id: "sample-audit-7",
    user: "Mara Santos",
    date: "2026-09-05",
    entity: "Departments",
    action: "Update",
    target: "Commercial",
    before: "Lead: Mara Santos",
    after: "Lead: Paolo Lim",
    source: "example",
  },
  {
    id: "sample-audit-8",
    user: "Ravi Patel",
    date: "2026-09-04",
    entity: "Backup",
    action: "Create",
    target: "Scheduled snapshot",
    before: "No checkpoint",
    after: "Configuration snapshot saved",
    source: "example",
  },
  {
    id: "sample-audit-9",
    user: "Eli Cruz",
    date: "2026-09-03",
    entity: "Equipment",
    action: "Update",
    target: "EQ-0017",
    before: "Status: Maintenance",
    after: "Status: Active",
    source: "example",
  },
  {
    id: "sample-audit-10",
    user: "Nina Reyes",
    date: "2026-09-02",
    entity: "Users",
    action: "Invite",
    target: "Tomas Yu",
    before: "No user record",
    after: "Invitation: Pending",
    source: "example",
  },
];
type Drafts = Partial<Record<ManageSection, Partial<ManageSettings>>>;
export type ManageState = {
  settings: ManageSettings;
  backups: ManageSnapshot[];
  sessions: ManageSession[];
  history: string[];
  activity: ManageActivityEntry[];
  drafts: Drafts;
};
export const initialManageState: ManageState = {
  settings: initialManageSettings,
  backups: initialManageSnapshots,
  sessions: initialManageSessions,
  history: ["Installed version 1.4.2"],
  activity: initialManageActivity,
  drafts: {},
};

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
function decodeDrafts(value: unknown): Drafts {
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
function decodeBackups(value: unknown): ManageSnapshot[] {
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
    .replaceAll("sample sessions", "local sessions")
    .replaceAll("sample session", "session")
    .replaceAll("Sample version", "Version")
    .replaceAll("sample version", "version");
}

function decodeHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return initialManageState.history;
  return value.flatMap((item) =>
    typeof item === "string" ? [normalizeLegacyManageActivity(item)] : [],
  );
}

function decodeActivity(value: unknown): ManageActivityEntry[] {
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
export function diffManageSettings(
  before: ManageSettings,
  after: ManageSettings,
): ManageSnapshotDiff[] {
  return (Object.keys(initialManageSettings) as (keyof ManageSettings)[])
    .filter((key) => before[key] !== after[key])
    .map((key) => ({
      key,
      label: manageSettingLabels[key],
      before: before[key],
      after: after[key],
    }));
}
function dirty(state: ManageState, section: ManageSection): boolean {
  return manageSectionKeys[section].some(
    (key) =>
      state.drafts[section]?.[key] !== undefined &&
      state.drafts[section]?.[key] !== state.settings[key],
  );
}
function uniqueSnapshotName(backups: ManageSnapshot[], name: string): string {
  let candidate = name;
  let number = 2;
  while (backups.some((item) => item.name === candidate))
    candidate = `${name} ${number++}`;
  return candidate;
}
export type ManageCommand =
  | {
      type: "change";
      section: ManageSection;
      key: keyof ManageSettings;
      value: string;
    }
  | { type: "save" | "discard"; section: ManageSection }
  | { type: "create-snapshot"; name?: string }
  | { type: "rename-snapshot"; id: string; name: string }
  | { type: "delete-snapshot"; id: string }
  | { type: "restore-snapshot"; id: string; discardDrafts?: boolean }
  | { type: "reset"; discardDrafts?: boolean }
  | { type: "revoke-session"; id: string }
  | {
      type:
        | "revoke-all-sessions"
        | "apply-update"
        | "rollback-update"
        | "renew-license";
    }
  | { type: "activate-license"; key: string };

export function executeManageCommand(
  state: ManageState,
  command: ManageCommand,
  date = new Date().toISOString(),
  id = crypto.randomUUID(),
): { state: ManageState; result: ManageActionResult } {
  let next = state;
  const fail = (message: string) => ({ state, result: { ok: false, message } });
  const ok = (message: string) => ({
    state: next,
    result: { ok: true, message, id },
  });
  function record(
    entity: string,
    action: string,
    target: string,
    before: string,
    after: string,
  ) {
    next = {
      ...next,
      activity: [
        {
          id,
          user: "Workspace administrator",
          date,
          entity,
          action,
          target,
          before,
          after,
          source: "manage",
        },
        ...next.activity,
      ],
    };
  }
  function snapshot(name: string): ManageSnapshot {
    return {
      id: `${id}-snapshot`,
      name: uniqueSnapshotName(next.backups, name),
      date,
      settings: { ...next.settings },
    };
  }
  if (command.type === "change") {
    if (!manageSectionKeys[command.section].includes(command.key))
      return fail("That setting belongs to another section.");
    next = {
      ...state,
      drafts: {
        ...state.drafts,
        [command.section]: {
          ...state.drafts[command.section],
          [command.key]: command.value,
        },
      },
    };
    return ok("Unsaved changes.");
  }
  if (command.type === "discard" || command.type === "save") {
    if (command.type === "save") {
      const proposed = { ...state.settings, ...state.drafts[command.section] };
      const errors = validateManageSection(command.section, proposed);
      if (Object.keys(errors).length)
        return fail(Object.values(errors)[0] ?? "Check the settings.");
      const changes = diffManageSettings(state.settings, proposed);
      next = { ...state, settings: proposed };
      if (changes.length)
        record(
          command.section === "organization"
            ? "Organization"
            : command.section === "security"
              ? "Security"
              : "Backup preferences",
          "Update",
          command.section === "organization" ? proposed.name : command.section,
          changes.map((item) => `${item.label}: ${item.before}`).join("\n"),
          changes.map((item) => `${item.label}: ${item.after}`).join("\n"),
        );
    }
    const drafts = { ...next.drafts };
    delete drafts[command.section];
    next = { ...next, drafts };
    return ok(
      command.type === "save"
        ? "Settings saved. No live policy was changed."
        : "Section changes discarded.",
    );
  }
  if (command.type === "create-snapshot") {
    if (command.name !== undefined && !command.name.trim())
      return fail("Enter a snapshot name.");
    const backup = snapshot(command.name?.trim() ?? "Manual snapshot");
    next = { ...state, backups: [backup, ...state.backups] };
    record(
      "Configuration snapshots",
      "Create",
      backup.name,
      "No snapshot",
      "Saved Manage configuration only; unsaved drafts excluded.",
    );
    return ok(`Snapshot created: ${backup.name}.`);
  }
  if (
    command.type === "rename-snapshot" ||
    command.type === "delete-snapshot" ||
    command.type === "restore-snapshot"
  ) {
    const backup = state.backups.find((item) => item.id === command.id);
    if (!backup) return fail("That snapshot is no longer available.");
    if (command.type === "rename-snapshot") {
      const name = command.name.trim();
      if (!name) return fail("Enter a snapshot name.");
      if (
        state.backups.some(
          (item) => item.id !== command.id && item.name === name,
        )
      )
        return fail("A snapshot already uses this name.");
      next = {
        ...state,
        backups: state.backups.map((item) =>
          item.id === command.id ? { ...item, name } : item,
        ),
      };
      record("Configuration snapshots", "Rename", name, backup.name, name);
      return ok("Snapshot renamed.");
    }
    if (command.type === "delete-snapshot") {
      next = {
        ...state,
        backups: state.backups.filter((item) => item.id !== command.id),
      };
      record(
        "Configuration snapshots",
        "Delete",
        backup.name,
        "Snapshot available",
        "Selected configuration snapshot deleted",
      );
      return ok("Snapshot deleted.");
    }
  }
  if (command.type === "restore-snapshot" || command.type === "reset") {
    if (
      Object.keys(manageSectionKeys).some((section) =>
        dirty(state, section as ManageSection),
      ) &&
      !command.discardDrafts
    )
      return fail(
        "Choose whether to discard affected drafts before continuing.",
      );
    const backup =
      command.type === "restore-snapshot"
        ? state.backups.find((item) => item.id === command.id)
        : null;
    if (command.type === "restore-snapshot" && !backup)
      return fail("That snapshot is no longer available.");
    const recovery = snapshot(
      command.type === "reset"
        ? "Before configuration reset"
        : "Before restore",
    );
    const settings = backup
      ? { ...backup.settings }
      : { ...initialManageSettings };
    const changes = diffManageSettings(state.settings, settings);
    next = {
      ...state,
      settings,
      drafts: {},
      backups: [recovery, ...state.backups],
    };
    record(
      "Configuration snapshots",
      backup ? "Restore" : "Reset",
      backup?.name ?? "Manage configuration",
      changes.map((item) => `${item.label}: ${item.before}`).join("\n") ||
        "No setting differences",
      changes.map((item) => `${item.label}: ${item.after}`).join("\n") ||
        "No setting differences",
    );
    return ok(
      backup
        ? `Restored snapshot: ${backup.name}. Recovery snapshot saved.`
        : "Manage configuration reset. Recovery snapshot saved; other workspace data is unchanged.",
    );
  }
  if (
    command.type === "revoke-session" ||
    command.type === "revoke-all-sessions"
  ) {
    const removed = state.sessions.filter(
      (session) =>
        !session.current &&
        (command.type === "revoke-all-sessions" ||
          (command.type === "revoke-session" && session.id === command.id)),
    );
    if (!removed.length)
      return fail(
        "No remote sessions to end. The current session is protected.",
      );
    next = {
      ...state,
      sessions: state.sessions.filter(
        (session) => !removed.some((item) => item.id === session.id),
      ),
    };
    record(
      "Sessions",
      "End session",
      removed.map((item) => item.personName).join(", "),
      removed
        .map((item) => `${item.device} · ${item.browser} · ${item.location}`)
        .join("\n"),
      "Removed from this local session list; account authentication stays active.",
    );
    return ok(
      removed.length === 1
        ? "Session ended."
        : `${removed.length} remote sessions ended.`,
    );
  }
  if (command.type === "apply-update") {
    if (state.settings.version === "1.5.0")
      return fail("The version is already up to date.");
    next = {
      ...state,
      settings: {
        ...state.settings,
        previous: state.settings.version,
        version: "1.5.0",
      },
      history: ["Applied version 1.5.0", ...state.history],
    };
    record("Updates", "Apply", "Release", state.settings.version, "1.5.0");
    return ok("Update applied. No software was installed.");
  }
  if (command.type === "rollback-update") {
    if (!state.settings.previous)
      return fail("No rollback point is available.");
    next = {
      ...state,
      settings: {
        ...state.settings,
        version: state.settings.previous,
        previous: "",
      },
      history: [
        `Rolled back version to ${state.settings.previous}`,
        ...state.history,
      ],
    };
    record(
      "Updates",
      "Rollback",
      "Release",
      state.settings.version,
      state.settings.previous,
    );
    return ok("Update rolled back.");
  }
  if (command.type === "activate-license") {
    if (!["SAMPLE-TEAM-2026", "SAMPLE-BUSINESS-2026"].includes(command.key))
      return fail("Choose a bundled dummy license key.");
    const tier = command.key === "SAMPLE-BUSINESS-2026" ? "Business" : "Team";
    if (state.settings.tier === tier)
      return fail(`The ${tier} plan is already active.`);
    next = { ...state, settings: { ...state.settings, tier } };
    record("Licensing", "Activate", "License", state.settings.tier, tier);
    return ok(`${tier} license activated. No purchase was made.`);
  }
  if (command.type === "renew-license") {
    const old = state.settings.expiry;
    const renewed = new Date(`${old}T12:00:00Z`);
    const month = renewed.getUTCMonth();
    renewed.setUTCFullYear(renewed.getUTCFullYear() + 1);
    if (renewed.getUTCMonth() !== month) renewed.setUTCDate(0);
    const expiry = renewed.toISOString().slice(0, 10);
    next = { ...state, settings: { ...state.settings, expiry } };
    record("Licensing", "Renew", "License", old, expiry);
    return ok("License renewed for one year. No payment was made.");
  }
  return fail("That action is unavailable.");
}

const keys = {
  settings: "manage-settings",
  backups: "manage-backups",
  sessions: "manage-sessions",
  history: "manage-history",
  activity: "manage-activity-v1",
  drafts: "manage-drafts-v1",
} as const;
function readState(
  transaction: Pick<SampleTransactionDraft, "read">,
): ManageState {
  const { read } = transaction;
  return {
    settings: decodeManageSettings(
      read<Record<string, unknown>>(keys.settings, {}),
    ),
    backups: decodeBackups(read<unknown>(keys.backups, null)),
    sessions: read(keys.sessions, initialManageSessions),
    history: decodeHistory(
      read<unknown>(keys.history, initialManageState.history),
    ),
    activity: decodeActivity(read<unknown>(keys.activity, null)),
    drafts: decodeDrafts(read<Record<string, unknown>>(keys.drafts, {})),
  };
}

function applyManageRuntimeCommand(
  draft: SampleTransactionDraft,
  command: ManageCommand,
): ManageActionResult {
  const current = readState(draft);
  const outcome = executeManageCommand(current, command);
  if (!outcome.result.ok) return draft.reject(outcome.result);
  for (const key of Object.keys(keys) as (keyof ManageState)[])
    if (outcome.state[key] !== current[key])
      draft.update<unknown>(
        keys[key],
        initialManageState[key],
        outcome.state[key],
      );
  return outcome.result;
}

export function executeManageRuntimeCommand(
  runtime: SampleRuntime,
  command: ManageCommand,
  signal?: AbortSignal,
): Promise<ManageActionResult> {
  return runtime.execute((draft) => applyManageRuntimeCommand(draft, command), {
    keys: Object.values(keys),
    signal,
  });
}

export function useManageController() {
  const runtime = useSampleRuntime();
  const commands = useSampleCommands();
  const resource = useSampleResource({
    keys: [
      ...Object.values(keys).filter((key) => key !== keys.drafts),
      "access-people",
    ],
    queryKey: "manage",
    load: (signal) =>
      runtime.load(
        (source) => ({
          ...readState(source),
          people: source.read("access-people", initialPeople),
        }),
        { keys: [...Object.values(keys), "access-people"], signal },
      ),
  });
  // Drafts stay synchronous and at route lifetime while confirmed data loads.
  const [rawDrafts] = useSampleState<Record<string, unknown>>(keys.drafts, {});
  const { storageUnavailable } = useSampleStorage();
  const [checked, setChecked] = useState(false);
  const state: ManageState = {
    ...(resource.data ?? initialManageState),
    drafts: decodeDrafts(rawDrafts),
  };
  async function run(command: ManageCommand): Promise<ManageActionResult> {
    try {
      return await commands.run("manage", (signal) =>
        executeManageRuntimeCommand(runtime, command, signal),
      );
    } catch (error) {
      return {
        ok: false,
        message: sampleOperationMessage(
          error,
          "This change could not be saved. Try again.",
        ),
      };
    }
  }
  function local(command: ManageCommand) {
    if (commands.isPending()) return;
    runtime.commit((draft) => applyManageRuntimeCommand(draft, command));
  }
  return {
    ...state,
    resource,
    pending: commands.isPending(),
    people: resource.data?.people ?? [],
    collections: {
      sessions: completeCollection(state.sessions, "manage:sessions"),
      snapshots: completeCollection(state.backups, "manage:snapshots"),
      activity: completeCollection(state.activity, "manage:activity"),
    },
    snapshots: state.backups,
    storageUnavailable,
    hasDrafts: (Object.keys(manageSectionKeys) as ManageSection[]).some(
      (section) => dirty(state, section),
    ),
    updateAvailable: checked && state.settings.version !== "1.5.0",
    getDraft: (section: ManageSection): ManageSettings => ({
      ...state.settings,
      ...state.drafts[section],
    }),
    dirty: (section: ManageSection) => dirty(state, section),
    isDirty: (section: ManageSection) => dirty(state, section),
    errors: (section: ManageSection) =>
      validateManageSection(section, {
        ...state.settings,
        ...state.drafts[section],
      }),
    change: (
      section: ManageSection,
      key: keyof ManageSettings,
      value: string,
    ) => {
      local({ type: "change", section, key, value });
    },
    save: (section: ManageSection) => run({ type: "save", section }),
    discard: (section: ManageSection) => {
      local({ type: "discard", section });
    },
    createSnapshot: (name?: string) => run({ type: "create-snapshot", name }),
    renameSnapshot: (id: string, name: string) =>
      run({ type: "rename-snapshot", id, name }),
    deleteSnapshot: (id: string) => run({ type: "delete-snapshot", id }),
    snapshotDiff: (id: string) => {
      const snapshot = state.backups.find((item) => item.id === id);
      return snapshot
        ? diffManageSettings(state.settings, snapshot.settings)
        : [];
    },
    restoreSnapshot: (id: string, options?: { discardDrafts?: boolean }) =>
      run({ type: "restore-snapshot", id, ...options }),
    reset: (options?: { discardDrafts?: boolean }) =>
      run({ type: "reset", ...options }),
    revokeSession: (id: string) => run({ type: "revoke-session", id }),
    revokeAllSessions: () => run({ type: "revoke-all-sessions" }),
    checkForUpdate: async (): Promise<
      ManageActionResult & { available?: boolean }
    > => {
      try {
        const settings = await commands.run("manage", (signal) =>
          runtime.load(
            (source) => decodeManageSettings(source.read(keys.settings, {})),
            { keys: [keys.settings], signal },
          ),
        );
        setChecked(true);
        return {
          ok: true,
          available: settings.version !== "1.5.0",
          message: "Update check completed.",
        };
      } catch (error) {
        return {
          ok: false,
          message: sampleOperationMessage(
            error,
            "Could not check for updates. Try again.",
          ),
        };
      }
    },
    applyUpdate: () => run({ type: "apply-update" }),
    rollbackUpdate: () => run({ type: "rollback-update" }),
    activateLicense: (key: string) => run({ type: "activate-license", key }),
    renewLicense: () => run({ type: "renew-license" }),
    retentionPreview: () => {
      const days = Number.parseInt(state.settings.retention, 10);
      const cutoff = Date.now() - days * 86400000;
      const candidates = state.backups.filter(
        (item) =>
          Number.isFinite(Date.parse(item.date)) &&
          Date.parse(item.date) < cutoff,
      );
      return {
        days,
        candidates,
        count: candidates.length,
        schedule: state.settings.schedule,
        timezone: state.settings.timezone,
      };
    },
  };
}

export function downloadManageSnapshot(snapshot: ManageSnapshot): void {
  const blob = new Blob(
    [
      JSON.stringify(
        {
          format: "openslate.manage.sample",
          version: 1,
          scope:
            "Manage configuration only; excludes drafts, sessions, history and other workspace data",
          snapshot,
        },
        null,
        2,
      ),
    ],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${snapshot.id}.json`;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}
