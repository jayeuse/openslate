import {
  initialManageSettings,
  manageSectionKeys,
  manageSettingLabels,
  type ManageActionResult,
  type ManageSection,
  type ManageSettings,
  type ManageSnapshot,
  type ManageSnapshotDiff,
  type ManageState,
} from "./model";
import { validateManageSection } from "./decode";

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
export function dirty(state: ManageState, section: ManageSection): boolean {
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
      "Removed from the displayed session list; account authentication stays active.",
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
