"use client";
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
import { previewCommsNotification } from "../domain/notification-policy";
import { type SampleTransactionDraft } from "../../shared/runtime/sample-state";
import { Action, Toggle } from "../../shared/components/ui";
import { TextField } from "./ui";
import { OPEN_PERMISSIONS, type Category, type Channel } from "../domain/model";
import { ConfigurationFrame } from "./configuration-frame";
import {
  DEFAULT_PLATFORM_PREFERENCES,
  useCommsConfiguration,
  useCommsPlatformPreferences,
} from "../state/configuration-state";
import {
  DEFAULT_COMMS_PREFERENCES,
  getCommsScope,
  patchCommsScope,
  resolveCommsSettings,
  type CommsConfiguration,
  type CommsScope,
  type CommsScopeConfiguration,
  type CommsSettingKey,
  type CommsSettings,
} from "../domain/configuration";
import { PersonalFields } from "./settings-personal-fields";
import { MembershipPreview, NotificationPreview } from "./settings-previews";
import {
  changed,
  cleanSettings,
  mergeFields,
  mergeScope,
  settingsError,
} from "./settings-draft";
import {
  SettingsFields,
  SETTINGS_LABELS,
  SETTINGS_SECTIONS,
} from "./settings-fields";
import { PermissionFields, PermissionInspector } from "./permission-inspector";
import {
  ConfirmActionDialog,
  type ConfirmActionRequest,
} from "./confirm-action-dialog";
import {
  COMMS_CONFIGURATION_KEY,
  messageFromCommsError,
  readCommsConfiguration,
  stageCommsConfiguration,
  useCommsCommands,
} from "../state/runtime";

const PERSON_ID = "sample-eli";

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
  additionalDirty?: boolean;
  onBeforeSave?: () => boolean | Promise<boolean>;
  onBeforeSaveTransaction?: (draft: SampleTransactionDraft) => void;
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
  roles,
  opener,
  onClose,
  title,
  overview,
  additionalDirty = false,
  onBeforeSave,
  onBeforeSaveTransaction,
  onAfterSave,
  saveLabel,
  initialSubject,
  initialTab,
}: CommsSettingsDialogProps) {
  const personal = scope === "personal";
  const target: CommsScope = personal
    ? { kind: "workspace", id: "workspace" }
    : scope;
  const [config] = useCommsConfiguration();
  const { run } = useCommsCommands();
  const [baseline] = useState(() =>
    structuredClone(getCommsScope(config, target)),
  );
  const [draft, setDraft] = useState(baseline);
  const [confirmReset, setConfirmReset] = useState<ConfirmActionRequest | null>(
    null,
  );
  const [initialPreferences] = useState(() =>
    structuredClone(config.preferences[PERSON_ID] ?? DEFAULT_COMMS_PREFERENCES),
  );
  const [preferences, setPreferences] = useState(initialPreferences);
  const [initialLockedSettings] = useState(config.lockedSettings);
  const [lockedSettings, setLockedSettings] = useState(config.lockedSettings);
  const [initialLockedPermissions] = useState(config.lockedPermissions);
  const [lockedPermissions, setLockedPermissions] = useState(
    config.lockedPermissions,
  );
  const [platformPreferences] = useCommsPlatformPreferences();
  const [initialPlatformPreferences] = useState(platformPreferences);
  const [platformDraft, setPlatformDraft] = useState(platformPreferences);
  const [section, setSection] = useState(
    initialTab ?? (personal ? "appearance" : "overview"),
  );
  const [query, setQuery] = useState("");
  const [verticalTabs, setVerticalTabs] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 640px)");
    const update = () => setVerticalTabs(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const [inspect, setInspect] = useState(false);
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const [notificationPreview, setNotificationPreview] = useState(false);
  const channel =
    target.kind === "channel"
      ? channels.find((item) => item.id === target.id)
      : target.kind === "category"
        ? {
            ...OPEN_PERMISSIONS,
            id: "",
            name: "",
            categoryId: target.id,
            description: "",
            inherit: true,
            archived: false,
            system: true,
          }
        : undefined;
  const previewConfig = {
    ...patchCommsScope(config, target, draft),
    lockedSettings,
    lockedPermissions,
  };
  const resolved = resolveCommsSettings(previewConfig, channel, categories);
  const values = { ...resolved.values };
  if (personal)
    for (const key of Object.keys(preferences.settings) as CommsSettingKey[]) {
      if (!lockedSettings.includes(key))
        Object.assign(values, { [key]: preferences.settings[key] });
    }
  const notificationResult = previewCommsNotification({
    config: personal
      ? {
          ...previewConfig,
          preferences: {
            ...previewConfig.preferences,
            [PERSON_ID]: preferences,
          },
        }
      : previewConfig,
    platformPreferences: platformDraft,
    person: people.find((person) => person.id === PERSON_ID),
    channel,
    categories,
    event: {
      kind: "thread",
      text: "Mara Santos mentioned you in a followed conversation.",
      mentioned: true,
      followedThread: true,
    },
  });
  const overrides = personal ? preferences.settings : draft.settings;
  const dirty =
    additionalDirty ||
    (personal
      ? changed(initialPreferences, preferences) ||
        changed(initialPlatformPreferences, platformDraft)
      : changed(baseline, draft) ||
        changed(initialLockedSettings, lockedSettings) ||
        changed(initialLockedPermissions, lockedPermissions));
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
    if (personal) {
      setPreferences(structuredClone(DEFAULT_COMMS_PREFERENCES));
      setPlatformDraft({ threads: true, records: true, digest: false });
      return;
    }
    if (target.kind === "workspace") {
      setDraft({ settings: {}, permissions: {} });
      setLockedSettings([]);
      setLockedPermissions([]);
      return;
    }
    const permissions: CommsScopeConfiguration["permissions"] = {};
    for (const [subject, overrides] of Object.entries(draft.permissions)) {
      permissions[subject] = Object.fromEntries(
        Object.keys(overrides).map((permission) => [permission, "inherit"]),
      );
    }
    const legacy =
      target.kind === "category"
        ? categories.find((item) => item.id === target.id)
        : channel && !channel.inherit
          ? channel
          : undefined;
    if (legacy) {
      for (const [permission, restricted, allowedRoles] of [
        ["viewChannel", legacy.access === "roles", legacy.roles],
        ["post", legacy.posting === "roles", legacy.postRoles],
      ] as const) {
        if (!restricted) continue;
        for (const subject of [
          "everyone",
          ...allowedRoles.map((id) => `role:${id}`),
        ])
          permissions[subject] = {
            ...permissions[subject],
            [permission]: "inherit",
          };
      }
    }
    setDraft({ settings: {}, permissions });
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
      if (
        !Number.isInteger(preferences.channelWidth) ||
        preferences.channelWidth < 200 ||
        preferences.channelWidth > 360 ||
        !Number.isInteger(preferences.memberWidth) ||
        preferences.memberWidth < 200 ||
        preferences.memberWidth > 360 ||
        !Number.isInteger(preferences.threadWidth) ||
        preferences.threadWidth < 320 ||
        preferences.threadWidth > 560
      ) {
        setError(
          "Channel and member widths must be 200–360 pixels; thread width must be 320–560 pixels.",
        );
        setSection("navigation");
        return false;
      }
    }
    if (onBeforeSave && !(await onBeforeSave())) {
      setSection("overview");
      setQuery("");
      return false;
    }
    const result = await run(
      `settings:save:${target.kind}:${target.id}`,
      (transaction) => {
        const current = readCommsConfiguration(transaction);
        if (personal) {
          const live =
            current.preferences[PERSON_ID] ?? DEFAULT_COMMS_PREFERENCES;
          stageCommsConfiguration(transaction, (value) => ({
            ...value,
            preferences: {
              ...value.preferences,
              [PERSON_ID]: {
                ...mergeFields(live, initialPreferences, preferences),
                settings: mergeFields(
                  live.settings,
                  initialPreferences.settings,
                  cleaned,
                ),
                shortcuts: mergeFields(
                  live.shortcuts,
                  initialPreferences.shortcuts,
                  preferences.shortcuts,
                ),
              },
            },
          }));
        } else {
          const before = getCommsScope(current, target);
          const after = mergeScope(before, baseline, {
            ...draft,
            settings: cleaned,
          });
          const next: CommsConfiguration = {
            ...patchCommsScope(current, target, after),
            lockedSettings: changed(initialLockedSettings, lockedSettings)
              ? lockedSettings
              : current.lockedSettings,
            lockedPermissions: changed(
              initialLockedPermissions,
              lockedPermissions,
            )
              ? lockedPermissions
              : current.lockedPermissions,
          };
          if (
            changed(before, after) ||
            changed(current.lockedSettings, next.lockedSettings) ||
            changed(current.lockedPermissions, next.lockedPermissions)
          )
            next.history = [
              ...current.history,
              {
                id: crypto.randomUUID(),
                created: Date.now(),
                actorId: PERSON_ID,
                label: `Updated ${title ?? currentLabel}`,
                scope: target,
                before,
                after,
                ...(target.kind === "workspace"
                  ? {
                      beforeLocks: {
                        settings: current.lockedSettings,
                        permissions: current.lockedPermissions,
                      },
                      afterLocks: {
                        settings: next.lockedSettings,
                        permissions: next.lockedPermissions,
                      },
                    }
                  : {}),
              },
            ];
          transaction.update(COMMS_CONFIGURATION_KEY, null, next);
        }
        onBeforeSaveTransaction?.(transaction);
        if (personal && changed(initialPlatformPreferences, platformDraft))
          transaction.update(
            "platformNotificationPreferences",
            DEFAULT_PLATFORM_PREFERENCES,
            (current) =>
              mergeFields(current, initialPlatformPreferences, platformDraft),
          );
        return true;
      },
      [
        COMMS_CONFIGURATION_KEY,
        "platformNotificationPreferences",
        ...(onBeforeSaveTransaction
          ? ["commsChannels", "commsCategories"]
          : []),
      ],
    ).catch((error: unknown) => {
      setError(messageFromCommsError(error, "Changes could not be saved."));
      return false;
    });
    if (!result) return false;
    onAfterSave?.();
    onClose();
    return true;
  }
  if (inspect)
    return (
      <PermissionInspector
        config={previewConfig}
        channel={channel}
        channels={channels}
        categories={categories}
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
    : [
        // Everyday behavior first; who may do what comes last.
        ...SETTINGS_SECTIONS,
        { id: "permissions", label: "Permissions" },
      ];
  const search = query.trim().toLowerCase();
  function fields(keys: CommsSettingKey[]) {
    const visible = keys.filter(
      (key) =>
        (key !== "dmRule" || target.kind === "workspace") &&
        (!search ||
          `${SETTINGS_LABELS[key]} ${key}`.toLowerCase().includes(search)) &&
        (!modifiedOnly || Object.hasOwn(overrides, key)),
    );
    return visible.length ? (
      <SettingsFields
        keys={visible}
        values={values}
        overrides={overrides}
        sources={resolved.sources}
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
  return (
    <ConfigurationFrame
      title={title ?? currentLabel}
      description={
        personal
          ? "Make OpenComms comfortable for you. Shared rules still apply."
          : target.kind === "workspace"
            ? "Defaults for every category and channel. Categories and channels can change them unless you lock a setting."
            : target.kind === "category"
              ? "Defaults for the channels in this category. A channel can change them unless the workspace locks a setting."
              : `Settings for #${channels.find((item) => item.id === target.id)?.name ?? "this channel"} only.`
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
              title: `Reset ${
                personal
                  ? "your preferences"
                  : target.kind === "workspace"
                    ? "workspace settings"
                    : `these ${target.kind} settings`
              } to default?`,
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
          onCheckedChange={(checked) => setModifiedOnly(checked)}
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
              {!personal && (
                <div className="mt-6">
                  <PermissionFields
                    initialSubject={initialSubject}
                    value={draft.permissions}
                    roles={roles}
                    people={people}
                    locked={lockedPermissions}
                    workspace={target.kind === "workspace"}
                    search={search}
                    modifiedOnly={modifiedOnly}
                    onChange={(subject, permission, value) =>
                      setDraft((current) => ({
                        ...current,
                        permissions: {
                          ...current.permissions,
                          [subject]: {
                            ...current.permissions[subject],
                            [permission]: value,
                          },
                        },
                      }))
                    }
                    onLock={(permission, locked) =>
                      setLockedPermissions((current) =>
                        locked
                          ? [...new Set([...current, permission])]
                          : current.filter((item) => item !== permission),
                      )
                    }
                    onInspect={() => setInspect(true)}
                  />
                </div>
              )}
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
                  <>
                    <p className="text-muted-foreground text-xs">
                      These preferences extend your shared notification center.
                    </p>
                    <Toggle
                      control="switch"
                      label="Thread reply notifications"
                      checked={platformDraft.threads}
                      onCheckedChange={(checked) =>
                        setPlatformDraft({
                          ...platformDraft,
                          threads: checked,
                        })
                      }
                    />
                    <Toggle
                      control="switch"
                      label="Record update notifications"
                      checked={platformDraft.records}
                      onCheckedChange={(checked) =>
                        setPlatformDraft({
                          ...platformDraft,
                          records: checked,
                        })
                      }
                    />
                    <Toggle
                      control="switch"
                      label="Daily digest"
                      checked={platformDraft.digest}
                      onCheckedChange={(checked) =>
                        setPlatformDraft({
                          ...platformDraft,
                          digest: checked,
                        })
                      }
                    />
                    {fields(
                      SETTINGS_SECTIONS.find(
                        (item) => item.id === "notifications",
                      )!.keys,
                    )}
                  </>
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
                      <NotificationPreview result={notificationResult} />
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
            <TabsContent value="permissions">
              <PermissionFields
                initialSubject={initialSubject}
                value={draft.permissions}
                roles={roles}
                people={people}
                locked={lockedPermissions}
                workspace={target.kind === "workspace"}
                search=""
                modifiedOnly={modifiedOnly}
                onChange={(subject, permission, value) =>
                  setDraft((current) => ({
                    ...current,
                    permissions: {
                      ...current.permissions,
                      [subject]: {
                        ...current.permissions[subject],
                        [permission]: value,
                      },
                    },
                  }))
                }
                onLock={(permission, locked) =>
                  setLockedPermissions((current) =>
                    locked
                      ? [...new Set([...current, permission])]
                      : current.filter((item) => item !== permission),
                  )
                }
                onInspect={() => setInspect(true)}
              />
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
                    config={previewConfig}
                    channel={channel}
                    categories={categories}
                    people={people}
                    settings={values}
                  />
                )}
                {section === "members" && target.kind !== "workspace" && (
                  <p className="text-muted-foreground text-xs">
                    Workspace settings control who can start direct messages.
                  </p>
                )}
                {fields(
                  SETTINGS_SECTIONS.find((item) => item.id === section)?.keys ??
                    [],
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
                      <NotificationPreview result={notificationResult} />
                    )}
                  </>
                )}
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
