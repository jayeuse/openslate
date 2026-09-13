import { expect, test } from "@playwright/test";
import {
  decodeManageSettings,
  executeManageCommand,
  initialManageSettings,
  initialManageState,
  type ManageCommand,
  type ManageState,
} from "../../src/components/sample/manage/state";
import { buildActivityCsv } from "../../src/components/sample/manage/audit";

function run(state: ManageState, command: ManageCommand, id = "test-action") {
  return executeManageCommand(state, command, "2026-09-12T12:00:00Z", id);
}

test("saving one section keeps another draft and records only the saved changes", () => {
  let state = run(initialManageState, {
    type: "change",
    section: "organization",
    key: "name",
    value: "Unfinished",
  }).state;
  state = run(state, {
    type: "change",
    section: "security",
    key: "mfa",
    value: "Required for everyone",
  }).state;
  const saved = run(state, { type: "save", section: "security" });
  expect(saved.result.ok).toBe(true);
  expect(saved.state.settings.name).toBe(initialManageSettings.name);
  expect(saved.state.settings.mfa).toBe("Required for everyone");
  expect(saved.state.drafts.organization?.name).toBe("Unfinished");
  expect(saved.state.drafts.security).toBeUndefined();
  expect(saved.state.activity[0]?.after).toContain("Required for everyone");
  expect(saved.state.activity[0]?.after).not.toContain("Unfinished");
});

test("invalid settings keep their draft and never append activity or change committed settings", () => {
  const changed = run(initialManageState, {
    type: "change",
    section: "organization",
    key: "hours",
    value: "18:00–09:00",
  }).state;
  const saved = run(changed, { type: "save", section: "organization" });
  expect(saved.result.ok).toBe(false);
  expect(saved.state).toBe(changed);
  expect(saved.state.activity).toBe(initialManageState.activity);
  expect(saved.state.drafts.organization?.hours).toBe("18:00–09:00");
  expect(
    run(initialManageState, {
      type: "change",
      section: "security",
      key: "name",
      value: "Wrong section",
    }).result.ok,
  ).toBe(false);
});

test("snapshot restore preserves a recovery point and requires a decision about unfinished drafts", () => {
  let state = run(
    initialManageState,
    { type: "create-snapshot", name: "Before edit" },
    "before",
  ).state;
  state = run(state, {
    type: "change",
    section: "organization",
    key: "name",
    value: "Saved organization",
  }).state;
  state = run(state, { type: "save", section: "organization" }, "save").state;
  state = run(state, {
    type: "change",
    section: "security",
    key: "mfa",
    value: "Required for everyone",
  }).state;
  const blocked = run(state, {
    type: "restore-snapshot",
    id: "before-snapshot",
  });
  expect(blocked.result.ok).toBe(false);
  expect(blocked.state).toBe(state);
  const restored = run(
    state,
    { type: "restore-snapshot", id: "before-snapshot", discardDrafts: true },
    "restore",
  );
  expect(restored.state.settings.name).toBe(initialManageSettings.name);
  expect(restored.state.backups[0]?.settings.name).toBe("Saved organization");
  expect(restored.state.backups[0]?.settings.mfa).toBe("Optional");
  expect(restored.state.drafts).toEqual({});
  expect(restored.state.sessions).toBe(state.sessions);
  expect(restored.state.history).toBe(state.history);
});

test("snapshot creation uses saved settings and rename/delete target only the selected snapshot", () => {
  const draft = run(initialManageState, {
    type: "change",
    section: "organization",
    key: "name",
    value: "Not saved",
  }).state;
  const created = run(
    draft,
    { type: "create-snapshot", name: "Named" },
    "created",
  );
  expect(created.state.backups[0]?.settings.name).toBe(
    initialManageSettings.name,
  );
  const renamed = run(
    created.state,
    { type: "rename-snapshot", id: "created-snapshot", name: "Renamed" },
    "rename",
  );
  expect(renamed.state.backups[0]?.name).toBe("Renamed");
  const deleted = run(
    renamed.state,
    { type: "delete-snapshot", id: "created-snapshot" },
    "delete",
  );
  expect(deleted.state.backups).toEqual(initialManageState.backups);
  expect(deleted.state.drafts).toEqual(draft.drafts);
});

test("reset only resets settings and protects snapshot, session, and activity history", () => {
  const modified = {
    ...initialManageState,
    settings: { ...initialManageSettings, name: "Changed", tier: "Business" },
  };
  const reset = run(modified, { type: "reset" }, "reset");
  expect(reset.state.settings).toEqual(initialManageSettings);
  expect(reset.state.sessions).toBe(modified.sessions);
  expect(reset.state.backups[0]?.settings).toEqual(modified.settings);
  expect(reset.state.activity.slice(1)).toEqual(modified.activity);
});

test("session revocation protects current and remains removed through unrelated commands", () => {
  const current = initialManageState.sessions.find((item) => item.current);
  const rejected = run(initialManageState, {
    type: "revoke-session",
    id: current?.id ?? "",
  });
  expect(rejected.result.ok).toBe(false);
  const revoked = run(initialManageState, { type: "revoke-all-sessions" });
  expect(revoked.state.sessions).toEqual([current]);
  const updated = run(revoked.state, { type: "apply-update" }, "update");
  expect(updated.state.sessions).toEqual([current]);
});

test("updates guard duplicates and section saves do not overwrite newer release or license state", () => {
  let state = run(initialManageState, {
    type: "change",
    section: "organization",
    key: "name",
    value: "New name",
  }).state;
  state = run(state, { type: "apply-update" }, "update").state;
  expect(run(state, { type: "apply-update" }).result.ok).toBe(false);
  state = run(
    state,
    { type: "activate-license", key: "SAMPLE-BUSINESS-2026" },
    "license",
  ).state;
  state = run(state, { type: "save", section: "organization" }, "save").state;
  expect(state.settings).toMatchObject({
    name: "New name",
    version: "1.5.0",
    previous: "1.4.2",
    tier: "Business",
  });
  state = run(state, { type: "rollback-update" }, "rollback").state;
  expect(state.settings.version).toBe("1.4.2");
  expect(run(state, { type: "rollback-update" }).result.ok).toBe(false);
});

test("stored configuration repairs invalid fields while preserving valid legacy values", () => {
  const settings = decodeManageSettings({
    ...initialManageSettings,
    name: "Keep me",
    timezone: "Invalid/Zone",
    expiry: "not-a-date",
    currency: "EUR",
  });
  expect(settings.name).toBe("Keep me");
  expect(settings.timezone).toBe("Asia/Manila");
  expect(settings.expiry).toBe(initialManageSettings.expiry);
  expect(settings.currency).toBe("PHP");
});

test("renewal handles leap-day expiry without rolling into March", () => {
  const state = {
    ...initialManageState,
    settings: { ...initialManageSettings, expiry: "2028-02-29" },
  };
  expect(run(state, { type: "renew-license" }).state.settings.expiry).toBe(
    "2029-02-28",
  );
});

test("CSV export quotes multiline text and neutralizes spreadsheet formulas", () => {
  const csv = buildActivityCsv([
    {
      id: "csv",
      user: "\t=1+1",
      date: "2026-09-12",
      entity: "Organization",
      action: "Update",
      target: "+SUM(1,2)",
      before: 'A "quoted" name\nSecond line',
      after: "@formula",
      source: "manage",
    },
  ]);
  expect(csv).toContain('"\'\t=1+1"');
  expect(csv).toContain('"\'+SUM(1,2)"');
  expect(csv).toContain('"A ""quoted"" name\nSecond line"');
  expect(csv).toContain('"\'@formula"');
  expect(csv).toContain("Manage change");
});
