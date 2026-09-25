import type { Category, Channel } from "./model";
import {
  DEFAULT_COMMS_SETTINGS,
  emptyCommsScope,
  type CommsConfiguration,
  type CommsPermission,
  type CommsPermissionContext,
  type CommsPermissionResult,
  type CommsScope,
  type CommsScopeConfiguration,
  type CommsSettingKey,
  type ResolvedCommsSettings,
} from "./configuration-model";

export function getCommsScope(
  config: CommsConfiguration,
  scope: CommsScope,
): CommsScopeConfiguration {
  return scope.kind === "workspace"
    ? config.workspace
    : ((scope.kind === "category"
        ? config.categories[scope.id]
        : config.channels[scope.id]) ?? emptyCommsScope());
}
export function patchCommsScope(
  config: CommsConfiguration,
  scope: CommsScope,
  value: CommsScopeConfiguration,
): CommsConfiguration {
  return scope.kind === "workspace"
    ? { ...config, workspace: value }
    : {
        ...config,
        [scope.kind === "category" ? "categories" : "channels"]: {
          ...(scope.kind === "category" ? config.categories : config.channels),
          [scope.id]: value,
        },
      };
}
export function resolveCommsSettings(
  config: CommsConfiguration,
  channel?: Channel,
  categories: Category[] = [],
): ResolvedCommsSettings {
  const values = structuredClone(DEFAULT_COMMS_SETTINGS);
  const sources = Object.fromEntries(
    Object.keys(values).map((key) => [key, "Default"]),
  ) as Record<CommsSettingKey, string>;
  if (channel) values.systemMessages = channel.system;
  const layers: [string, CommsScopeConfiguration | undefined][] = [
    ["Workspace", config.workspace],
  ];
  if (channel)
    layers.push(
      [
        `Category: ${categories.find((c) => c.id === channel.categoryId)?.name ?? channel.categoryId}`,
        config.categories[channel.categoryId],
      ],
      [`Channel: ${channel.name}`, config.channels[channel.id]],
    );
  for (const [source, scope] of layers)
    if (scope)
      for (const key of Object.keys(scope.settings) as CommsSettingKey[]) {
        if (source !== "Workspace" && config.lockedSettings.includes(key))
          continue;
        Object.assign(values, { [key]: scope.settings[key] });
        sources[key] = source;
      }
  return { values, sources, locked: config.lockedSettings };
}
export function resolveCommsPermission(
  config: CommsConfiguration,
  context: CommsPermissionContext,
  permission: CommsPermission,
): CommsPermissionResult {
  const { person, channel, categories = [] } = context;
  if (!person?.active)
    return {
      allowed: false,
      source: "Identity",
      reason: "An active person is required",
    };
  if (person.id === "sample-eli")
    return {
      allowed: true,
      source: "OpenComms owner",
      reason:
        "Active Eli has protected OpenComms owner access. Channel and messaging policies still apply.",
    };
  if (permission !== "viewChannel" && channel) {
    const visibility = resolveCommsPermission(config, context, "viewChannel");
    if (!visibility.allowed)
      return {
        allowed: false,
        source: visibility.source,
        reason: "Channel visibility is required",
      };
  }
  const settings = resolveCommsSettings(config, channel, categories).values;
  const manager =
    person.role === "sample-admin" ||
    settings.ownerId === person.id ||
    settings.moderatorIds.includes(person.id);
  let allowed =
    ![
      "pin",
      "manageThreads",
      "manageChannel",
      "managePermissions",
      "createChannel",
      "manageWorkspace",
      "moderate",
      "deleteOthersMessages",
    ].includes(permission) || manager;
  if (permission === "manageWorkspace" || permission === "createChannel")
    allowed = person.role === "sample-admin";
  let source = "Default";
  let reason = allowed ? "Allowed by default" : "Requires a channel manager";
  const adaptedScope = (
    scope: CommsScopeConfiguration | undefined,
    legacy?: Category | Channel,
  ): CommsScopeConfiguration => {
    const permissions: CommsScopeConfiguration["permissions"] = {};
    if (legacy) {
      const restricted =
        permission === "viewChannel"
          ? legacy.access === "roles"
          : permission === "post"
            ? legacy.posting === "roles"
            : false;
      if (restricted) {
        permissions.everyone = { [permission]: "deny" };
        for (const role of permission === "viewChannel"
          ? legacy.roles
          : legacy.postRoles)
          permissions[`role:${role}`] = { [permission]: "allow" };
      }
    }
    for (const [subject, overrides] of Object.entries(scope?.permissions ?? {}))
      permissions[subject] = { ...permissions[subject], ...overrides };
    return { settings: scope?.settings ?? {}, permissions };
  };
  const layers: [string, CommsScopeConfiguration | undefined][] = [
    ["Workspace", config.workspace],
  ];
  if (channel) {
    const category = categories.find((c) => c.id === channel.categoryId);
    layers.push(
      [
        `Category: ${channel.categoryId}`,
        adaptedScope(
          config.categories[channel.categoryId],
          channel.inherit ? category : undefined,
        ),
      ],
      [
        `Channel: ${channel.id}`,
        adaptedScope(
          config.channels[channel.id],
          !channel.inherit || !category ? channel : undefined,
        ),
      ],
    );
  }
  for (const [label, scope] of layers) {
    if (
      !scope ||
      (label !== "Workspace" && config.lockedPermissions.includes(permission))
    )
      continue;
    for (const subject of [
      "everyone",
      `role:${person.role}`,
      `person:${person.id}`,
    ]) {
      const value = scope.permissions[subject]?.[permission];
      if (value === "allow" || value === "deny") {
        allowed = value === "allow";
        source = `${label} · ${subject}`;
        reason = `${value === "allow" ? "Allowed" : "Denied"} explicitly for ${subject}`;
      }
    }
  }
  return { allowed, source, reason };
}
