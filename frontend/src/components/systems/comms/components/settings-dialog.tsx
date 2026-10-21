"use client";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useWorkspaceDisplayRegion } from "@/components/use-display-region";
import { useNotificationPermission } from "../state/use-notification-permission";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FieldGroup } from "@/components/ui/field";
import { NativeSelectOption } from "@/components/ui/native-select";
import { Alert } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import type { Person, Role } from "../../shared/data/sample-people";
import { useVerifiedWorkspaceUserId } from "../../shared/runtime/workspace-identity";
import { Action, Choice, Toggle } from "../../shared/components/ui";
import type { Category, Channel } from "../domain/view-model";
import type * as C from "../contract/types";
import { lockableCapabilitySchema } from "../contract/schemas";
import { ConfigurationFrame } from "./configuration-frame";
import { TextField } from "./message-shared";
import { useCommsConfiguration } from "../state/configuration-state";
import { useCommsClient } from "../state/client-context";
import {
  wirePreferences,
  wireScope,
  wireSettingKey,
  wireSettings,
} from "../state/settings-wire";
import {
  DEFAULT_COMMS_PREFERENCES,
  getCommsScope,
  resolveCommsSettings,
  type CommsScope,
  type CommsSettingKey,
  type CommsSettings,
} from "../domain/configuration";
import {
  PersonalFields,
  PERSONAL_ADVANCED_KEYS,
} from "./settings-personal-fields";
import { SettingsAdvanced } from "./settings-advanced";
import { MembershipPreview, NotificationPreview } from "./settings-previews";
import { changed, cleanSettings, settingsError } from "./settings-draft";
import {
  SettingsFields,
  SettingsLocks,
  SETTINGS_LABELS,
  SETTINGS_SECTIONS,
} from "./settings-fields";
import { PermissionFields, PermissionInspector } from "./permission-inspector";
import { GroupAccessSummary } from "./group-access-summary";
import {
  ConfirmActionDialog,
  type ConfirmActionRequest,
} from "./confirm-action-dialog";
import {
  messageFromCommsError,
  useCommsCommands,
  useCommsRead,
} from "../state/runtime";

export interface CommsSettingsDialogProps {
  scope: CommsScope | "personal";
  channels: Channel[];
  categories: Category[];
  people: Person[];
  roles: Role[];
  opener: HTMLElement | null;
  onClose: () => void;
  title?: string;
  overview?: ReactNode;
  overviewAdvanced?: ReactNode;
  access?: ReactNode;
  advancedMetadataCount?: number;
  additionalDirty?: boolean;
  onBeforeSave?: () => boolean | Promise<boolean>;
  onSaveMetadata?: (
    accepted: (scope: CommsScope) => void,
  ) => Promise<CommsScope>;
  onAfterSave?: () => void;
  saveLabel?: string;
  initialSubject?: string;
  initialTab?: string;
}

export function CommsSettingsDialog(props: CommsSettingsDialogProps) {
  const { requestCatalog, retryCatalog, catalogStatus } = useCommsClient();
  const personal = props.scope === "personal";
  const target: CommsScope =
    props.scope === "personal"
      ? { kind: "workspace", id: "workspace" }
      : props.scope;
  const [initialLocks, setInitialLocks] = useState<C.Capability[] | null>(null);
  const admission = useCommsRead(
    `settings-admission:${personal ? "personal" : `${target.kind}:${target.id}`}`,
    async (client, signal) => {
      if (personal || props.onSaveMetadata || target.kind === "category")
        return true;
      return target.kind === "channel"
        ? (await client.getCapabilities(target.id, { signal })).capabilities
            .manageChannel.allowed
        : (
            await client.getChannelCreationCheck(
              { kind: "workspace" },
              { signal },
            )
          ).membership_role === "admin";
    },
  );
  const locks = useCommsRead(
    "capability-locks",
    (client, signal) => client.getCapabilityLocks({ signal }),
    !personal && admission.data === true && initialLocks === null,
  );
  useEffect(() => {
    if (!personal && admission.data && initialLocks === null)
      requestCatalog?.();
  }, [personal, admission.data, initialLocks, requestCatalog]);
  useLayoutEffect(() => {
    if (initialLocks !== null || !admission.data) return;
    if (personal) setInitialLocks([]);
    else if (
      locks.data &&
      (catalogStatus === undefined || catalogStatus === "ready")
    )
      setInitialLocks(locks.data.data.capabilities);
  }, [initialLocks, admission.data, personal, locks.data, catalogStatus]);
  if (initialLocks === null) {
    const error = admission.error || locks.error || catalogStatus === "error";
    return (
      <ConfigurationFrame
        title={
          props.title ??
          (personal
            ? "My preferences"
            : target.kind === "workspace"
              ? "Workspace settings"
              : `${target.kind === "channel" ? "Channel" : "Category"} settings`)
        }
        opener={props.opener}
        onClose={props.onClose}
      >
        <div className="p-5">
          <Alert
            role={error || admission.data === false ? "alert" : "status"}
            variant={
              error || admission.data === false ? "destructive" : "default"
            }
          >
            {error
              ? "Settings data could not be loaded. Try again."
              : admission.data === false
                ? "You cannot manage settings for this scope."
                : "Loading settings data…"}
          </Alert>
          {error && (
            <Action
              onClick={() => {
                admission.reload();
                if (!personal && admission.data) {
                  if (locks.error) locks.reload();
                  if (catalogStatus === "error") retryCatalog?.();
                }
              }}
            >
              Try again
            </Action>
          )}
        </div>
      </ConfigurationFrame>
    );
  }
  return (
    <LoadedCommsSettingsDialog
      {...props}
      admission={admission}
      initialCapabilityLocks={initialLocks}
    />
  );
}

function LoadedCommsSettingsDialog({
  scope,
  channels,
  categories,
  people,
  opener,
  onClose,
  title,
  overview,
  overviewAdvanced,
  access,
  advancedMetadataCount = 0,
  additionalDirty = false,
  onBeforeSave,
  onSaveMetadata,
  onAfterSave,
  saveLabel,
  initialTab,
  admission,
  initialCapabilityLocks,
}: CommsSettingsDialogProps & {
  admission: ReturnType<typeof useCommsRead<boolean>>;
  initialCapabilityLocks: C.Capability[];
}) {
  const userId = useVerifiedWorkspaceUserId();
  const region = useWorkspaceDisplayRegion();
  const browserPermission = useNotificationPermission();
  const { client } = useCommsClient();
  const { run } = useCommsCommands();
  const [config] = useCommsConfiguration();
  const personal = scope === "personal";
  const target: CommsScope = personal
    ? { kind: "workspace", id: "workspace" }
    : scope;
  const [baseline] = useState(() =>
    structuredClone(getCommsScope(config, target)),
  );
  const [draft, setDraft] = useState(baseline);
  const [initialPreferences] = useState(() =>
    structuredClone(config.preferences[userId] ?? DEFAULT_COMMS_PREFERENCES),
  );
  const [preferences, setPreferences] = useState(initialPreferences);
  const [initialLocks] = useState({
    settings: config.lockedSettings,
    capabilities: initialCapabilityLocks,
  });
  const [lockedSettings, setLockedSettings] = useState(initialLocks.settings);
  const [lockedCapabilities, setLockedCapabilities] = useState(
    initialLocks.capabilities,
  );
  const confirmed = useRef(structuredClone(baseline));
  const confirmedPersonal = useRef(structuredClone(initialPreferences));
  const confirmedLocks = useRef(structuredClone(initialLocks));
  const savedTarget = useRef(target);
  const savedAnything = useRef(false);
  const [query, setQuery] = useState("");
  const [section, setSection] = useState(
    initialTab === "permissions"
      ? "permissions"
      : (initialTab ?? (personal ? "appearance" : "overview")),
  );
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const [inspect, setInspect] = useState(false);
  const [notificationPreview, setNotificationPreview] = useState(false);
  const [confirmReset, setConfirmReset] = useState<ConfirmActionRequest | null>(
    null,
  );
  const [error, setError] = useState("");
  const [memberRoles, setMemberRoles] = useState<
    Record<string, "member" | "manager">
  >({});
  const confirmedRoles = useRef<Record<string, "member" | "manager">>({});
  const [verticalTabs, setVerticalTabs] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 640px)");
    const update = () => setVerticalTabs(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const channel =
    target.kind === "channel"
      ? channels.find((item) => item.id === target.id)
      : undefined;
  const resolved =
    target.kind === "category"
      ? (config.resolved[`category:${target.id}`] ??
        resolveCommsSettings(config))
      : resolveCommsSettings(config, channel);
  const overrides = personal ? preferences.settings : draft.settings;
  const values = {
    ...resolved.values,
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([key]) =>
          (target.kind === "workspace" && !personal) ||
          !lockedSettings.includes(key as CommsSettingKey),
      ),
    ),
  };
  const dirty =
    additionalDirty ||
    Object.keys(memberRoles).length > 0 ||
    (personal
      ? changed(initialPreferences, preferences)
      : changed(baseline, draft) ||
        changed(initialLocks.settings, lockedSettings) ||
        changed(initialLocks.capabilities, lockedCapabilities));
  const currentLabel = personal
    ? "My preferences"
    : target.kind === "workspace"
      ? "Workspace settings"
      : `${target.kind === "channel" ? "Channel" : "Category"} settings`;
  function changeSetting<K extends CommsSettingKey>(
    key: K,
    value: CommsSettings[K],
  ) {
    if (personal && key === "desktopNotifications" && value === true)
      void browserPermission.request();
    if (personal)
      setPreferences((current) => ({
        ...current,
        settings: { ...current.settings, [key]: value },
      }));
    else
      setDraft((current) => ({
        ...current,
        settings: { ...current.settings, [key]: value },
      }));
  }
  function resetDefaults() {
    setError("");
    if (personal) setPreferences(structuredClone(DEFAULT_COMMS_PREFERENCES));
    else {
      setDraft({
        settings: {},
        capabilities: {
          scope: wireScope(target),
          everyone: {},
          group_grants: [],
        },
      });
      if (target.kind === "workspace") {
        setLockedSettings([]);
        setLockedCapabilities([]);
      }
    }
  }
  async function save() {
    const cleaned = cleanSettings(overrides);
    const invalid = settingsError({ ...values, ...cleaned });
    if (invalid) {
      setError(invalid);
      return false;
    }
    if (personal) {
      const shortcuts = Object.values(preferences.shortcuts)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      if (new Set(shortcuts).size !== shortcuts.length) {
        setError("Each keyboard shortcut must be unique.");
        setSection("shortcuts");
        return false;
      }
    }
    if (onBeforeSave && !(await onBeforeSave())) {
      setSection("overview");
      setQuery("");
      return false;
    }
    if (!client) {
      setError("Your organization must be verified before saving.");
      return false;
    }
    try {
      await run("settings:save", async () => {
        if (onSaveMetadata)
          savedTarget.current = await onSaveMetadata((accepted) => {
            savedTarget.current = accepted;
            savedAnything.current = true;
          });
        if (personal) {
          const desired = { ...preferences, settings: cleaned };
          if (
            changed(
              wirePreferences(confirmedPersonal.current),
              wirePreferences(desired),
            )
          ) {
            const current = await client.getPersonalPreferences();
            await client.setPersonalPreferences(wirePreferences(desired), {
              if_match: current.etag,
            });
            confirmedPersonal.current = {
              ...desired,
              favorites: confirmedPersonal.current.favorites,
              hiddenChannels: confirmedPersonal.current.hiddenChannels,
            };
            savedAnything.current = true;
          }
          for (const id of new Set([
            ...confirmedPersonal.current.favorites,
            ...preferences.favorites,
            ...confirmedPersonal.current.hiddenChannels,
            ...preferences.hiddenChannels,
          ])) {
            const starred = preferences.favorites.includes(id),
              hidden = preferences.hiddenChannels.includes(id);
            if (
              confirmedPersonal.current.favorites.includes(id) === starred &&
              confirmedPersonal.current.hiddenChannels.includes(id) === hidden
            )
              continue;
            const current = await client.getMemberPreferences(id);
            await client.updateMemberPreferences(
              id,
              { starred, hidden },
              { if_match: current.etag },
            );
            for (const [key, enabled] of [
              ["favorites", starred],
              ["hiddenChannels", hidden],
            ] as const)
              confirmedPersonal.current[key] = enabled
                ? [...new Set([...confirmedPersonal.current[key], id])]
                : confirmedPersonal.current[key].filter((item) => item !== id);
            savedAnything.current = true;
          }
        } else {
          const actualScope = wireScope(savedTarget.current);
          if (actualScope.kind === "channel")
            for (const [userId, role] of Object.entries(memberRoles)) {
              if (confirmedRoles.current[userId] === role) continue;
              const current = await client.getConversation(actualScope.id);
              await client.setMemberRole(
                actualScope.id,
                userId,
                { role },
                { if_match: current.etag },
              );
              confirmedRoles.current[userId] = role;
              savedAnything.current = true;
            }
          const removed = Object.keys(confirmed.current.settings).filter(
            (key) => key !== "dmRule" && !Object.hasOwn(cleaned, key),
          );
          let current = await client.getSettings(actualScope);
          if (removed.length) {
            current = await client.resetSettings(
              actualScope,
              { keys: removed.map(wireSettingKey) },
              { if_match: current.etag },
            );
            for (const key of removed)
              delete confirmed.current.settings[key as CommsSettingKey];
            savedAnything.current = true;
          }
          const remaining = Object.fromEntries(
            Object.entries(cleaned).filter(
              ([key, value]) =>
                key !== "dmRule" &&
                changed(
                  value,
                  confirmed.current.settings[key as CommsSettingKey],
                ),
            ),
          );
          if (Object.keys(remaining).length) {
            await client.updateSettings(actualScope, wireSettings(remaining), {
              if_match: current.etag,
            });
            confirmed.current.settings = {
              ...confirmed.current.settings,
              ...remaining,
            };
            savedAnything.current = true;
          }
          if (
            actualScope.kind === "workspace" &&
            changed(confirmed.current.settings.dmRule, cleaned.dmRule)
          ) {
            const policy = await client.getDirectPolicy();
            await client.setDirectPolicy(
              { dm_rule: cleaned.dmRule ?? "everyone" },
              { if_match: policy.etag },
            );
            confirmed.current.settings.dmRule = cleaned.dmRule;
            savedAnything.current = true;
          }
          const before = confirmed.current.capabilities,
            wanted = draft.capabilities;
          if (
            changed(before.everyone, wanted.everyone) ||
            changed(before.group_grants, wanted.group_grants)
          ) {
            const current =
              await client.getCapabilityConfiguration(actualScope);
            const everyone = { ...current.data.everyone };
            for (const key of new Set([
              ...Object.keys(before.everyone),
              ...Object.keys(wanted.everyone),
            ]) as Set<keyof C.CapabilityConfiguration["everyone"]>) {
              if (!changed(before.everyone[key], wanted.everyone[key]))
                continue;
              if (Object.hasOwn(wanted.everyone, key))
                everyone[key] = wanted.everyone[key];
              else delete everyone[key];
            }
            const identity = (
              row: C.CapabilityConfiguration["group_grants"][number],
            ) => `${row.group_id}:${row.capability}`;
            const removed = new Set(
              before.group_grants
                .filter(
                  (row) =>
                    !wanted.group_grants.some(
                      (next) => identity(next) === identity(row),
                    ),
                )
                .map(identity),
            );
            const grants = current.data.group_grants.filter(
              (row) => !removed.has(identity(row)),
            );
            for (const row of wanted.group_grants)
              if (
                !before.group_grants.some(
                  (old) => identity(old) === identity(row),
                ) &&
                !grants.some((old) => identity(old) === identity(row))
              )
                grants.push(row);
            await client.setCapabilityConfiguration(
              { scope: actualScope, everyone, group_grants: grants },
              { if_match: current.etag },
            );
            confirmed.current.capabilities = structuredClone(wanted);
            savedAnything.current = true;
          }
          if (
            actualScope.kind === "workspace" &&
            changed(confirmedLocks.current.settings, lockedSettings)
          ) {
            const current = await client.getSettings(actualScope);
            await client.setSettingsLocks(
              { keys: lockedSettings.map(wireSettingKey) },
              { if_match: current.etag },
            );
            confirmedLocks.current.settings = [...lockedSettings];
            savedAnything.current = true;
          }
          if (
            actualScope.kind === "workspace" &&
            changed(confirmedLocks.current.capabilities, lockedCapabilities)
          ) {
            const current = await client.getCapabilityLocks();
            await client.setCapabilityLocks(
              {
                capabilities: lockableCapabilitySchema
                  .array()
                  .parse(lockedCapabilities),
              },
              { if_match: current.etag },
            );
            confirmedLocks.current.capabilities = [...lockedCapabilities];
            savedAnything.current = true;
          }
        }
      });
    } catch (failure) {
      try {
        if (personal) await client.getPersonalPreferences();
        else {
          await client.getSettings(wireScope(savedTarget.current));
          await client.getCapabilityConfiguration(
            wireScope(savedTarget.current),
          );
        }
      } catch {
        /* Readback failure retains the draft and never replays a write. */
      }
      setError(
        savedAnything.current
          ? "Some changes were saved. Your unsaved changes are still here. Review them and try again."
          : messageFromCommsError(failure, "Changes could not be saved."),
      );
      return false;
    }
    onAfterSave?.();
    onClose();
    return true;
  }
  if (inspect)
    return (
      <PermissionInspector
        channel={channel}
        channels={channels}
        people={people}
        opener={opener}
        onBack={() => setInspect(false)}
      />
    );
  const sections = personal
    ? [
        { id: "appearance", label: "Appearance" },
        { id: "notifications", label: "Notifications" },
        { id: "navigation", label: "Navigation & panels" },
        { id: "shortcuts", label: "Shortcuts" },
      ]
    : [...SETTINGS_SECTIONS, { id: "permissions", label: "Access" }];
  const search = query.trim().toLowerCase();
  function visibleKeys(keys: CommsSettingKey[]) {
    return keys.filter(
      (key) =>
        (key !== "dmRule" || (!personal && target.kind === "workspace")) &&
        (!search ||
          `${SETTINGS_LABELS[key]} ${key}`.toLowerCase().includes(search)) &&
        (!modifiedOnly ||
          Object.hasOwn(overrides, key) ||
          lockedSettings.includes(key)),
    );
  }
  function fields(keys: CommsSettingKey[]) {
    const visible = visibleKeys(keys);
    return visible.length ? (
      <SettingsFields
        keys={visible}
        values={values}
        overrides={overrides}
        locked={lockedSettings}
        workspace={!personal && target.kind === "workspace"}
        people={people}
        onChange={changeSetting}
      />
    ) : null;
  }
  const capabilities = (query: string) => (
    <PermissionFields
      value={draft.capabilities}
      scope={wireScope(target)}
      locked={lockedCapabilities}
      search={query}
      modifiedOnly={modifiedOnly}
      onChange={(capabilities) =>
        setDraft((current) => ({ ...current, capabilities }))
      }
      onLock={(capability, locked) =>
        setLockedCapabilities((current) =>
          locked
            ? [...new Set([...current, capability])]
            : current.filter((item) => item !== capability),
        )
      }
    />
  );
  if (!admission.data)
    return (
      <ConfigurationFrame
        title={title ?? currentLabel}
        opener={opener}
        onClose={onClose}
      >
        <div className="p-5">
          <Alert role={admission.status === "loading" ? "status" : "alert"}>
            {admission.status === "loading"
              ? "Checking settings access…"
              : "You cannot manage settings for this scope."}
          </Alert>
          {admission.error && (
            <Action onClick={admission.reload}>Try again</Action>
          )}
        </div>
      </ConfigurationFrame>
    );
  const currentSection = SETTINGS_SECTIONS.find((item) => item.id === section);
  const searchableSections = personal
    ? SETTINGS_SECTIONS.filter((item) => item.id === "notifications")
    : SETTINGS_SECTIONS;
  const sectionKeys = search
    ? searchableSections.flatMap((item) => item.keys)
    : (currentSection?.keys ?? []);
  const commonKeys = search
    ? searchableSections.flatMap((item) => item.common)
    : (currentSection?.common ?? []);
  const advancedKeys = sectionKeys.filter((key) => !commonKeys.includes(key));
  const showPersonalFields =
    personal && (!!search || section !== "notifications");
  const advancedCount = showPersonalFields
    ? (search
        ? Object.values(PERSONAL_ADVANCED_KEYS).flat()
        : (PERSONAL_ADVANCED_KEYS[section] ?? [])
      ).filter((key) =>
        changed(preferences[key], DEFAULT_COMMS_PREFERENCES[key]),
      ).length +
      (search
        ? advancedKeys.filter((key) => Object.hasOwn(overrides, key)).length
        : 0)
    : new Set([
        ...advancedKeys.filter((key) => Object.hasOwn(overrides, key)),
        ...(!personal && target.kind === "workspace"
          ? sectionKeys.filter((key) => lockedSettings.includes(key))
          : []),
      ]).size;
  const capabilityCount = new Set([
    ...Object.keys(draft.capabilities.everyone),
    ...draft.capabilities.group_grants.map((grant) => grant.capability),
    ...lockedCapabilities,
  ]).size;
  const advanced = (children: ReactNode) => (
    <SettingsAdvanced
      searching={!!search}
      key={`${personal ? "personal" : target.kind}:${search ? "search" : section}`}
      storageKey={`openslate:comms:advanced:${client?.context.org_id}:${userId}:${personal ? "personal" : target.kind}:${search ? "search" : section}`}
      count={
        advancedCount +
        (!personal && (section === "permissions" || search)
          ? capabilityCount
          : 0) +
        (section === "overview" ? advancedMetadataCount : 0)
      }
    >
      {children}
    </SettingsAdvanced>
  );
  return (
    <ConfigurationFrame
      title={title ?? currentLabel}
      description={
        personal
          ? "Make OpenComms comfortable for you. Shared rules still apply."
          : target.kind === "workspace"
            ? "Defaults for every category and channel. Categories and channels can change them unless you lock a setting."
            : target.kind === "category"
              ? "Defaults for the channels in this category."
              : channel?.name
                ? `Settings for #${channel.name} only.`
                : "Choose the new channel's details and settings."
      }
      opener={opener}
      dirty={dirty}
      onClose={onClose}
      onSave={save}
      saveLabel={saveLabel}
      footer={
        <Action
          type="button"
          className="mr-auto"
          onClick={(event) =>
            setConfirmReset({
              title: `Reset ${personal ? "your preferences" : target.kind === "workspace" ? "workspace settings" : `these ${target.kind} settings`} to default?`,
              description: `This clears every section of this dialog back to its default. Nothing is saved until you select ${saveLabel ?? "Save changes"}.`,
              confirmLabel: "Reset to default",
              onConfirm: resetDefaults,
              opener: event.currentTarget,
            })
          }
        >
          Reset to default
        </Action>
      }
    >
      <div className="flex flex-wrap items-end gap-3 px-5 py-3 sm:px-6">
        <div className="min-w-0 flex-1">
          <TextField
            label="Search settings"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a setting…"
          />
        </div>
        <Toggle
          label="Modified only"
          checked={modifiedOnly}
          onCheckedChange={setModifiedOnly}
        />
      </div>
      <Separator />
      {error && (
        <div ref={errorRef} tabIndex={-1} className="px-6 py-3 outline-none">
          <Alert role="alert" variant="destructive">
            {error}
          </Alert>
        </div>
      )}
      <Tabs
        orientation={verticalTabs ? "vertical" : "horizontal"}
        value={search ? "search" : section}
        onValueChange={(value) => setSection(String(value))}
        className="gap-0 sm:grid sm:grid-cols-[190px_minmax(0,1fr)]"
      >
        {!verticalTabs && (
          <div className="px-5 pt-3">
            <Choice
              label="Settings section"
              value={section}
              onChange={(event) => {
                setSection(event.target.value);
                setQuery("");
              }}
            >
              {sections.map((item) => (
                <NativeSelectOption key={item.id} value={item.id}>
                  {item.label}
                </NativeSelectOption>
              ))}
            </Choice>
          </div>
        )}
        <TabsList
          aria-label="Settings sections"
          className="bg-muted/20 hidden max-w-full items-stretch justify-start rounded-none p-2 sm:sticky sm:top-0 sm:flex sm:flex-col sm:self-start sm:border-r"
        >
          {sections.map((item) => (
            <TabsTrigger
              key={item.id}
              value={item.id}
              type="button"
              onClick={() => setQuery("")}
              className="min-h-11 shrink-0 justify-start whitespace-nowrap sm:whitespace-normal"
            >
              {item.label}
            </TabsTrigger>
          ))}
          {search && (
            <TabsTrigger value="search" className="sr-only">
              Search results
            </TabsTrigger>
          )}
        </TabsList>
        <div className="min-w-0 px-5 py-4 sm:px-6">
          <TabsContent value={search ? "search" : section}>
            <FieldGroup>
              <div>
                <h3 className="text-sm font-semibold">
                  {search
                    ? "Search results"
                    : sections.find((item) => item.id === section)?.label}
                </h3>
                {!search && currentSection && (
                  <p className="text-muted-foreground mt-1 text-xs">
                    {currentSection.description}
                  </p>
                )}
              </div>
              {!search && !personal && section === "overview" && overview}
              {!search &&
                !personal &&
                section === "permissions" &&
                (access ?? (
                  <GroupAccessSummary
                    scope={target.kind}
                    channel={channel}
                    category={categories.find((item) => item.id === target.id)}
                    categories={categories}
                  />
                ))}
              {!personal && (section === "permissions" || search) && (
                <Action className="self-start" onClick={() => setInspect(true)}>
                  Check one person
                </Action>
              )}
              {showPersonalFields ? (
                <PersonalFields
                  preferences={preferences}
                  baseline={initialPreferences}
                  setPreferences={setPreferences}
                  section={search ? "all" : section}
                  search={search}
                  modifiedOnly={modifiedOnly}
                  channels={channels}
                  tier="common"
                />
              ) : (
                fields(commonKeys)
              )}
              {personal && search && fields(commonKeys)}
              {search && !visibleKeys(sectionKeys).length && !personal && (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No settings match these filters.</EmptyTitle>
                    <EmptyDescription>
                      Try another search or turn off Modified only.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
              {advanced(
                <>
                  {showPersonalFields ? (
                    <PersonalFields
                      preferences={preferences}
                      baseline={initialPreferences}
                      setPreferences={setPreferences}
                      section={search ? "all" : section}
                      search={search}
                      modifiedOnly={modifiedOnly}
                      channels={channels}
                      tier="advanced"
                    />
                  ) : (
                    fields(advancedKeys)
                  )}
                  {personal && search && fields(advancedKeys)}
                  {!personal &&
                    target.kind === "workspace" &&
                    visibleKeys(sectionKeys).length > 0 && (
                      <SettingsLocks
                        keys={visibleKeys(sectionKeys)}
                        locked={lockedSettings}
                        onLock={(key, locked) =>
                          setLockedSettings((current) =>
                            locked
                              ? [...new Set([...current, key])]
                              : current.filter((item) => item !== key),
                          )
                        }
                      />
                    )}
                  {!personal &&
                    (section === "permissions" || search) &&
                    capabilities(search)}
                  {!search &&
                    !personal &&
                    section === "overview" &&
                    overviewAdvanced}
                  {!search && !personal && section === "members" && channel && (
                    <MembershipPreview
                      channel={channel}
                      people={people}
                      settings={values}
                      roles={memberRoles}
                      onRoleChange={(id, role) =>
                        setMemberRoles((current) => ({
                          ...current,
                          [id]: role,
                        }))
                      }
                    />
                  )}
                </>,
              )}
              {personal && (
                <>
                  {(section === "notifications" ||
                    (!!search &&
                      visibleKeys(["desktopNotifications"]).length > 0)) && (
                    <section
                      aria-label="Browser notification permission"
                      className="flex flex-col gap-3"
                    >
                      <p className="text-muted-foreground text-sm">
                        Quiet hours use{" "}
                        {region?.timezone ??
                          "your regional time zone (loading…)"}
                        . Preferences belong to this organization; browser
                        permission applies to this site. Desktop alerts and
                        sounds are not emitted in this local example.
                      </p>
                      <p role="status" className="text-sm">
                        {browserPermission.message}
                      </p>
                      {values.desktopNotifications &&
                        browserPermission.permission === "default" && (
                          <Action
                            type="button"
                            className="self-start"
                            disabled={browserPermission.pending}
                            onClick={() => void browserPermission.request()}
                          >
                            Enable browser permission
                          </Action>
                        )}
                    </section>
                  )}
                  {section === "appearance" && (
                    <Link
                      href="/platform?section=account"
                      onClick={(event) => {
                        if (dirty) {
                          event.preventDefault();
                          setError(
                            "Save or cancel your changes before opening global settings.",
                          );
                        }
                      }}
                      className="text-sm underline underline-offset-4"
                    >
                      Global theme and presence settings
                    </Link>
                  )}
                  {section === "notifications" && (
                    <>
                      <Action
                        type="button"
                        onClick={() =>
                          setNotificationPreview(!notificationPreview)
                        }
                      >
                        Preview notification
                      </Action>
                      {notificationPreview && (
                        <NotificationPreview settings={values} />
                      )}
                      <Link
                        href="/platform?section=notifications"
                        onClick={(event) => {
                          if (dirty) {
                            event.preventDefault();
                            setError(
                              "Save or cancel your changes before opening the notification center.",
                            );
                          }
                        }}
                        className="text-sm underline underline-offset-4"
                      >
                        Open notification center
                      </Link>
                    </>
                  )}
                </>
              )}
            </FieldGroup>
          </TabsContent>
        </div>
      </Tabs>
      <ConfirmActionDialog
        request={confirmReset}
        onClose={() => setConfirmReset(null)}
      />
    </ConfigurationFrame>
  );
}
