import { expect, test } from "@playwright/test";
import {
  resolveSettings,
  updateSettings,
  resetSettings,
} from "@/components/systems/comms/domain/settings";
import { policyFixture } from "./memory-fixture";

test("canonical defaults and metadata exclude retired policy and keep common settings small", () => {
  const { world } = policyFixture();
  const result = resolveSettings(world, { kind: "workspace" });
  expect(result.effective).toMatchObject({
    edit_window_minutes: 0,
    delete_window_minutes: 0,
    link_previews: false,
    max_file_size_mb: 0,
    allowed_file_types: [],
  });
  expect(
    result.metadata
      .filter((m) => m.tier === "common")
      .map((m) => m.key)
      .sort(),
  ).toEqual([
    "allowed_file_types",
    "delete_window_minutes",
    "edit_window_minutes",
    "max_file_size_mb",
    "mode",
    "notification_mode",
  ]);
  expect(result.sources.mode).toEqual({ kind: "default" });
  expect(result).toHaveProperty("dm_rule", "everyone");
});

test("settings preserve explicit empty values, lock workspace values and recompute after moves", () => {
  const { world, channel, category } = policyFixture();
  const scope = { kind: "channel", id: channel.id } as const;
  world.configuration.workspace = {
    settings: {
      formatting: false,
      edit_window_minutes: 12,
      keywords: ["dispatch"],
    },
    capabilities: {
      scope: { kind: "workspace" },
      everyone: {},
      group_grants: [],
    },
  };
  world.configuration[`category:${category.id}`] = {
    settings: { edit_window_minutes: 5, link_previews: true },
    capabilities: {
      scope: { kind: "category", id: category.id },
      everyone: {},
      group_grants: [],
    },
  };
  world.configuration[`channel:${channel.id}`] = {
    settings: { formatting: true, edit_window_minutes: 0, keywords: [] },
    capabilities: { scope, everyone: {}, group_grants: [] },
  };
  world.setting_locks = ["formatting"];
  let result = resolveSettings(world, scope);
  expect(result.effective).toMatchObject({
    formatting: false,
    edit_window_minutes: 0,
    keywords: [],
    link_previews: true,
  });
  expect(result.sources.formatting).toEqual({ kind: "workspace" });
  expect(result.sources.edit_window_minutes).toEqual(scope);
  channel.category_id = null;
  result = resolveSettings(world, scope);
  expect(result.effective.link_previews).toBe(false);
  expect(result.sources.link_previews).toEqual({ kind: "default" });
});

test("settings writes reject invalid references and locked fields without mutating state; reset is selective", () => {
  const { world, channel } = policyFixture();
  const scope = { kind: "channel", id: channel.id } as const;
  const before = structuredClone(world);
  const foreignId = "71000000-0000-4000-8000-000000000099";
  for (const input of [
    { default_member_ids: [foreignId] },
    { allowed_record_modules: [foreignId] },
    { record_card_fields: [foreignId] },
    { pinned_record_id: foreignId },
    { quiet_hours_start: "22:00" },
    { dm_rule: "none" },
  ])
    expect(() => updateSettings(world, scope, input)).toThrow("refused");
  expect(world).toEqual(before);
  const valid = updateSettings(world, scope, {
    formatting: false,
    keywords: ["dispatch"],
  });
  world.configuration[`channel:${channel.id}`] = valid;
  world.setting_locks = ["formatting"];
  expect(() => updateSettings(world, scope, { formatting: true })).toThrow(
    "refused",
  );
  const reset = resetSettings(world, scope, { keys: ["keywords"] });
  expect(reset.settings).toEqual({ formatting: false });
  expect(world.configuration[`channel:${channel.id}`]?.settings).toEqual({
    formatting: false,
    keywords: ["dispatch"],
  });
});

test("reset never silently removes an unselected quiet-hour endpoint", () => {
  const { world } = policyFixture();
  world.configuration.workspace = updateSettings(
    world,
    { kind: "workspace" },
    {
      quiet_hours_start: "22:00",
      quiet_hours_end: "06:00",
      keywords: ["keep"],
    },
  );
  expect(() =>
    resetSettings(
      world,
      { kind: "workspace" },
      { keys: ["quiet_hours_start"] },
    ),
  ).toThrow("refused");
  expect(
    resetSettings(
      world,
      { kind: "workspace" },
      { keys: ["quiet_hours_start", "quiet_hours_end"] },
    ).settings,
  ).toEqual({ keywords: ["keep"] });
});

test("tolerant stored reads discard malformed fields without widening strict write admission", () => {
  const { world } = policyFixture();
  world.configuration.workspace = {
    settings: JSON.parse(
      '{"formatting":false,"max_file_size_mb":11,"quiet_hours_start":"22:00","quiet_hours_end":"","oldPermission":true}',
    ),
    capabilities: {
      scope: { kind: "workspace" },
      everyone: {},
      group_grants: [],
    },
  };
  const result = resolveSettings(world, { kind: "workspace" });
  expect(result.effective).toMatchObject({
    formatting: false,
    max_file_size_mb: 0,
    quiet_hours_start: "",
    quiet_hours_end: "",
  });
  expect(result.effective).not.toHaveProperty("oldPermission");
  expect(() =>
    updateSettings(world, { kind: "workspace" }, { max_file_size_mb: 11 }),
  ).toThrow("refused");
});
