"use client";
import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FieldGroup } from "@/components/ui/field";
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
import { Action, Toggle } from "../../shared/components/ui";
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
import { PersonalFields } from "./settings-personal-fields";
import { MembershipPreview, NotificationPreview } from "./settings-previews";
import { changed, cleanSettings, settingsError } from "./settings-draft";
import {
  SettingsFields,
  SETTINGS_LABELS,
  SETTINGS_SECTIONS,
} from "./settings-fields";
import { PermissionFields, PermissionInspector } from "./permission-inspector";
import { GroupAccessSummary } from "./group-access-summary";
import {
  ConfirmActionDialog,
  type ConfirmActionRequest,
} from "./confirm-action-dialog";
import { messageFromCommsError, useCommsCommands } from "../state/runtime";

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
  overviewEnd?: ReactNode;
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

export function CommsSettingsDialog({
  scope,
  channels,
  categories,
  people,
  opener,
  onClose,
  title,
  overview,
  overviewEnd,
  additionalDirty = false,
  onBeforeSave,
  onSaveMetadata,
  onAfterSave,
  saveLabel,
  initialSubject,
  initialTab,
}: CommsSettingsDialogProps) {
  const userId = useVerifiedWorkspaceUserId();
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
    capabilities: config.lockedCapabilities,
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
    : [...SETTINGS_SECTIONS, { id: "permissions", label: "Permissions" }];
  const search = query.trim().toLowerCase();
  function fields(keys: CommsSettingKey[]) {
    const visible = keys.filter(
      (key) =>
        (key !== "dmRule" || (!personal && target.kind === "workspace")) &&
        (!search ||
          `${SETTINGS_LABELS[key]} ${key}`.toLowerCase().includes(search)) &&
        (!modifiedOnly || Object.hasOwn(overrides, key)),
    );
    return visible.length ? (
      <SettingsFields
        keys={visible}
        values={values}
        overrides={overrides}
        locked={lockedSettings}
        workspace={!personal && target.kind === "workspace"}
        people={people}
        onChange={changeSetting}
        onLock={(key, locked) =>
          setLockedSettings((current) =>
            locked
              ? [...new Set([...current, key])]
              : current.filter((item) => item !== key),
          )
        }
      />
    ) : (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No settings match these filters.</EmptyTitle>
          <EmptyDescription>
            Try another search or turn off Modified only.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
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
      onInspect={() => setInspect(true)}
    />
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
      <div className="flex items-end gap-3 px-5 py-4 sm:px-6">
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
        <TabsList
          aria-label="Settings sections"
          className="bg-muted/20 max-w-full items-stretch justify-start overflow-x-auto rounded-none border-b p-2 sm:sticky sm:top-0 sm:flex-col sm:self-start sm:border-r sm:border-b-0"
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
        <div className="min-w-0 px-5 py-5 sm:px-6">
          {search ? (
            <TabsContent value="search">
              <h3 className="mb-4 text-sm font-semibold">Search results</h3>
              {personal ? (
                <PersonalFields
                  preferences={preferences}
                  baseline={initialPreferences}
                  setPreferences={setPreferences}
                  section="all"
                  search={search}
                  modifiedOnly={modifiedOnly}
                  channels={channels}
                />
              ) : (
                fields(SETTINGS_SECTIONS.flatMap((item) => item.keys))
              )}
              {!personal && <div className="mt-6">{capabilities(search)}</div>}
              {personal &&
                fields(
                  SETTINGS_SECTIONS.find((item) => item.id === "notifications")!
                    .keys,
                )}
            </TabsContent>
          ) : personal ? (
            <TabsContent value={section}>
              <FieldGroup>
                {section === "notifications" ? (
                  fields(
                    SETTINGS_SECTIONS.find(
                      (item) => item.id === "notifications",
                    )!.keys,
                  )
                ) : (
                  <PersonalFields
                    preferences={preferences}
                    baseline={initialPreferences}
                    setPreferences={setPreferences}
                    section={section}
                    search=""
                    modifiedOnly={modifiedOnly}
                    channels={channels}
                  />
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
              </FieldGroup>
            </TabsContent>
          ) : section === "permissions" ? (
            <TabsContent value="permissions" className="flex flex-col gap-6">
              <GroupAccessSummary
                scope={target.kind}
                channel={channel}
                category={categories.find((item) => item.id === target.id)}
                categories={categories}
                onChangeGroups={
                  overview && target.kind !== "workspace"
                    ? () => setSection("overview")
                    : undefined
                }
              />
              <details
                open={Boolean(initialSubject)}
                className="group/exceptions border-card-edge rounded-[calc(var(--radius)*1.25)] border"
              >
                <summary className="hover:bg-muted focus-visible:outline-ring flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-[calc(var(--radius)*1.25)] px-3 text-sm font-semibold outline-none focus-visible:outline-2 [&::-webkit-details-marker]:hidden">
                  <ChevronRight
                    aria-hidden="true"
                    className="text-muted-foreground size-4 shrink-0 transition-transform duration-(--motion-fast) group-open/exceptions:rotate-90 motion-reduce:transition-none"
                  />
                  <span className="mr-auto">Capabilities by group</span>
                  <span className="text-muted-foreground text-xs font-normal">
                    Advanced
                  </span>
                </summary>
                <div className="border-t p-3">{capabilities("")}</div>
              </details>
            </TabsContent>
          ) : (
            <TabsContent value={section}>
              <FieldGroup>
                <div>
                  <h3 className="text-sm font-semibold">
                    {
                      SETTINGS_SECTIONS.find((item) => item.id === section)
                        ?.label
                    }
                  </h3>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {
                      SETTINGS_SECTIONS.find((item) => item.id === section)
                        ?.description
                    }
                  </p>
                </div>
                {section === "overview" && overview}
                {section === "members" && (
                  <MembershipPreview
                    channel={channel}
                    people={people}
                    settings={values}
                    roles={memberRoles}
                    onRoleChange={(id, role) =>
                      setMemberRoles((current) => ({ ...current, [id]: role }))
                    }
                  />
                )}
                {fields(
                  SETTINGS_SECTIONS.find((item) => item.id === section)?.keys ??
                    [],
                )}
                {section === "overview" && overviewEnd}
              </FieldGroup>
            </TabsContent>
          )}
        </div>
      </Tabs>
      <ConfirmActionDialog
        request={confirmReset}
        onClose={() => setConfirmReset(null)}
      />
    </ConfigurationFrame>
  );
}
