"use client";
import { NativeSelectOption } from "@/components/ui/native-select";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Field,
  FieldGroup,
  FieldSet,
  FieldLegend,
  FieldLabel,
} from "@/components/ui/field";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageHeader,
} from "@/components/ui/message";
import {
  Attachment,
  AttachmentContent,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Slider } from "@/components/ui/slider";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import type { Person, Role } from "../access/model";
import { type SampleTransactionDraft } from "../sample-state";
import { Action, Choice, Toggle } from "../ui";
import { TextField } from "./ui";
import { OPEN_PERMISSIONS, type Category, type Channel } from "./model";
import { ConfigurationFrame } from "./configuration-frame";
import {
  DEFAULT_PLATFORM_PREFERENCES,
  useCommsConfiguration,
  useCommsPlatformPreferences,
} from "./configuration-state";
import { previewCommsNotification } from "./notification-policy";
import {
  DEFAULT_COMMS_PREFERENCES,
  getCommsScope,
  patchCommsScope,
  resolveCommsSettings,
  resolveCommsPermission,
  type CommsConfiguration,
  type CommsPreferences,
  type CommsScope,
  type CommsScopeConfiguration,
  type CommsSettingKey,
  type CommsSettings,
} from "./configuration";
import {
  SettingsFields,
  SETTINGS_LABELS,
  SETTINGS_SECTIONS,
} from "./settings-fields";
import { PermissionFields, PermissionInspector } from "./permission-inspector";
import {
  COMMS_CONFIGURATION_KEY,
  messageFromCommsError,
  readCommsConfiguration,
  stageCommsConfiguration,
  useCommsCommands,
} from "./runtime";

const PERSON_ID = "sample-eli";
function changed(a: unknown, b: unknown) {
  return JSON.stringify(a) !== JSON.stringify(b);
}
function mergeFields<T extends object>(current: T, baseline: T, draft: T): T {
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
function mergeScope(
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
function cleanSettings(
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
function settingsError(settings: Partial<CommsSettings>): string {
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
        SETTINGS_SECTIONS[0],
        { id: "permissions", label: "Advanced Permissions" },
        ...SETTINGS_SECTIONS.slice(1),
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
          : "Configure conversation defaults, permissions, and channel behavior."
      }
      opener={opener}
      dirty={dirty}
      onClose={onClose}
      onSave={save}
      saveLabel={saveLabel}
      footer={
        <Action type="button" className="mr-auto" onClick={resetDefaults}>
          Reset to default
        </Action>
      }
    >
      <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-end sm:px-6">
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
          className="bg-muted/20 max-w-full items-stretch justify-start overflow-x-auto rounded-none border-b p-2 sm:flex-col sm:border-r sm:border-b-0"
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
                    href="/platform#account"
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
                      href="/platform#notifications"
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
    </ConfigurationFrame>
  );
}

function MembershipPreview({
  config,
  channel,
  categories,
  people,
  settings,
}: {
  config: CommsConfiguration;
  channel?: Channel;
  categories: Category[];
  people: Person[];
  settings: CommsSettings;
}) {
  const [personId, setPersonId] = useState(
    () =>
      people.find(
        (person) =>
          person.active &&
          person.id !== PERSON_ID &&
          person.id !== settings.ownerId &&
          !settings.defaultMemberIds.includes(person.id),
      )?.id ??
      people[0]?.id ??
      "",
  );
  const person = people.find((item) => item.id === personId);
  const access = resolveCommsPermission(
    config,
    { person, channel, categories },
    "viewChannel",
  );
  const inviteAccess = resolveCommsPermission(
    config,
    {
      person: people.find((item) => item.id === PERSON_ID),
      channel,
      categories,
    },
    "invite",
  );
  const membership = [...config.invites]
    .reverse()
    .find(
      (invite) =>
        invite.channelId === channel?.id &&
        invite.personId === personId &&
        invite.status !== "declined",
    );
  const defaultMember = settings.defaultMemberIds.includes(personId);
  const assigned =
    personId === PERSON_ID ||
    personId === settings.ownerId ||
    settings.moderatorIds.includes(personId);
  let path = "Can join without an invitation.";
  if (!access.allowed)
    path = "Cannot join with the current access permissions.";
  else if (channel?.archived)
    path = "This channel is archived. Restore it before adding members.";
  else if (assigned)
    path = "Included through an owner or moderator assignment.";
  else if (defaultMember) path = "Would join by default.";
  else if (membership?.status === "accepted")
    path = "An accepted local membership record exists.";
  else if (membership?.status === "pending")
    path =
      membership.type === "request"
        ? "A local join request is awaiting approval."
        : "A local invitation is awaiting acceptance.";
  else if (settings.joinRule === "request")
    path = "Can request to join; approval is required.";
  else if (settings.joinRule === "invite")
    path = "An invitation is required before joining.";
  const defaults = people.filter((item) =>
    settings.defaultMemberIds.includes(item.id),
  );
  return (
    <Card aria-label="Membership preview" className="w-full">
      <CardHeader className="p-4">
        <CardTitle>Membership preview</CardTitle>
        <CardDescription>
          Preview the current draft. This does not add members or send
          invitations.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-4">
        <Choice
          label="Preview membership for"
          value={personId}
          onChange={(event) => setPersonId(event.target.value)}
        >
          {people.map((item) => (
            <NativeSelectOption key={item.id} value={item.id}>
              {item.name}
              {item.active ? "" : " (inactive)"}
            </NativeSelectOption>
          ))}
        </Choice>
        <Alert>{path}</Alert>
        <p className="text-muted-foreground text-xs">
          Access: {access.allowed ? "Allowed" : "Denied"} · {access.reason}
        </p>
        <p className="text-muted-foreground text-xs">
          Your invitation permission:{" "}
          {inviteAccess.allowed ? "Allowed" : "Denied"}. Manage existing local
          invitations and requests in Channel management.
        </p>
        <Separator />
        <div>
          <h4 className="text-xs font-semibold">Default membership preview</h4>
          {!defaults.length ? (
            <Empty className="p-3">
              <EmptyHeader>
                <EmptyDescription>
                  No default members selected.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="mt-2 flex flex-col gap-1 text-xs">
              {defaults.map((item) => {
                const permission = resolveCommsPermission(
                  config,
                  { person: item, channel, categories },
                  "viewChannel",
                );
                return (
                  <li key={item.id}>
                    {item.name} ·{" "}
                    {permission.allowed
                      ? "Would join by default"
                      : "Excluded by access permissions"}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function NotificationPreview({
  result,
}: {
  result: ReturnType<typeof previewCommsNotification>;
}) {
  return (
    <Card aria-label="Notification preview" className="w-full">
      <CardHeader className="p-4">
        <CardTitle>Notification preview</CardTitle>
        <CardDescription>
          Preview only. No notification is delivered.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-4">
        <Alert>{result.allowed ? result.title : result.reason}</Alert>
        <p className="text-muted-foreground text-xs">
          {result.sound ? "Sound on" : "Silent"} ·{" "}
          {result.badge ? "Badge on" : "No badge"} ·{" "}
          {result.digest ? "Digest delivery" : "Immediate delivery"}
        </p>
      </CardContent>
    </Card>
  );
}

function PersonalFields({
  preferences,
  baseline,
  setPreferences,
  section,
  search,
  modifiedOnly,
  channels,
}: {
  preferences: CommsPreferences;
  baseline: CommsPreferences;
  setPreferences: (
    action: (value: CommsPreferences) => CommsPreferences,
  ) => void;
  section: string;
  search: string;
  modifiedOnly: boolean;
  channels: Channel[];
}) {
  const controls: {
    key: keyof CommsPreferences;
    label: string;
    section: string;
    options?: [string, string][];
  }[] = [
    {
      key: "density",
      label: "Message density",
      section: "appearance",
      options: [
        ["comfortable", "Comfortable"],
        ["compact", "Compact"],
      ],
    },
    {
      key: "textSize",
      label: "Text size",
      section: "appearance",
      options: [
        ["small", "Small"],
        ["medium", "Medium"],
        ["large", "Large"],
      ],
    },
    {
      key: "timestamps",
      label: "Timestamps",
      section: "appearance",
      options: [
        ["time", "Time only"],
        ["full", "Date and time"],
        ["none", "Hidden"],
      ],
    },
    {
      key: "groupMessages",
      label: "Group consecutive messages",
      section: "appearance",
    },
    { key: "avatars", label: "Show avatars", section: "appearance" },
    { key: "previews", label: "Show message previews", section: "appearance" },
    {
      key: "sendShortcut",
      label: "Send shortcut",
      section: "shortcuts",
      options: [
        ["enter", "Enter to send"],
        ["ctrl-enter", "Ctrl/⌘ + Enter to send"],
      ],
    },
    {
      key: "channelWidth",
      label: "Channel panel width (pixels)",
      section: "navigation",
    },
    {
      key: "memberWidth",
      label: "Member panel width (pixels)",
      section: "navigation",
    },
    {
      key: "threadWidth",
      label: "Thread panel width (pixels)",
      section: "navigation",
    },
  ];
  return (
    <FieldGroup>
      {section === "appearance" && (
        <Card aria-label="Appearance preview" className="w-full">
          <CardHeader className="p-4">
            <CardTitle>Appearance preview</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            <Message
              style={{
                fontSize:
                  preferences.textSize === "small"
                    ? 12
                    : preferences.textSize === "large"
                      ? 16
                      : 14,
                paddingBlock: preferences.density === "compact" ? 0 : 8,
              }}
            >
              {preferences.avatars && (
                <MessageAvatar className="self-start">
                  <Avatar aria-hidden="true">
                    <AvatarFallback>MS</AvatarFallback>
                  </Avatar>
                </MessageAvatar>
              )}
              <MessageContent
                style={{ gap: preferences.density === "compact" ? 0 : 8 }}
              >
                <MessageHeader className="gap-2 px-0">
                  <strong>Mara Santos</strong>
                  {preferences.timestamps !== "none" && (
                    <span>
                      {preferences.timestamps === "full"
                        ? "Sep 11 · 10:42"
                        : "10:42"}
                    </span>
                  )}
                </MessageHeader>
                <p>The inspection is ready for review.</p>
                {!preferences.groupMessages && (
                  <MessageHeader className="px-0">Mara Santos</MessageHeader>
                )}
                <p>I attached the latest checklist.</p>
                {preferences.previews && (
                  <Attachment size="sm">
                    <AttachmentContent>
                      <AttachmentTitle>
                        Checklist · linked record preview
                      </AttachmentTitle>
                    </AttachmentContent>
                  </Attachment>
                )}
              </MessageContent>
            </Message>
          </CardContent>
        </Card>
      )}
      {section === "navigation" && (
        <Card aria-label="Panel layout preview" className="w-full">
          <CardHeader className="p-4">
            <CardTitle>Panel layout preview</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 p-4">
            <div className="flex h-12 gap-1" aria-hidden="true">
              <div
                className="bg-muted rounded"
                style={{ flex: preferences.channelWidth }}
              />
              <div
                className="bg-background rounded border"
                style={{ flex: 360 }}
              />
              <div
                className="bg-muted rounded"
                style={{ flex: preferences.threadWidth }}
              />
            </div>
            <p className="text-muted-foreground text-xs">
              Channels: {preferences.channelWidth}px · Members:{" "}
              {preferences.memberWidth}px · Thread: {preferences.threadWidth}px
            </p>
            <p className="text-muted-foreground text-xs">
              Saved widths are preferred desktop sizes. Panels shrink to keep
              messages usable on narrower screens; mobile uses one panel at a
              time.
            </p>
          </CardContent>
        </Card>
      )}
      {controls
        .filter(
          (control) =>
            (section === "all" || control.section === section) &&
            (!search || control.label.toLowerCase().includes(search)) &&
            (!modifiedOnly ||
              changed(
                preferences[control.key],
                DEFAULT_COMMS_PREFERENCES[control.key],
              )),
        )
        .map((control) => {
          const value = preferences[control.key];
          return (
            <div key={control.key} className="flex flex-col gap-2">
              {control.options ? (
                <Choice
                  label={control.label}
                  value={String(value)}
                  onChange={(event) =>
                    setPreferences((current) => ({
                      ...current,
                      [control.key]: event.target.value,
                    }))
                  }
                >
                  {control.options.map(([id, label]) => (
                    <NativeSelectOption key={id} value={id}>
                      {label}
                    </NativeSelectOption>
                  ))}
                </Choice>
              ) : typeof value === "boolean" ? (
                <Toggle
                  control="switch"
                  label={control.label}
                  checked={value}
                  onCheckedChange={(checked) =>
                    setPreferences((current) => ({
                      ...current,
                      [control.key]: checked,
                    }))
                  }
                />
              ) : (
                <Field>
                  <div className="flex items-center justify-between gap-3">
                    <FieldLabel>{control.label}</FieldLabel>
                    <span className="text-muted-foreground text-sm tabular-nums">
                      {String(value)} px
                    </span>
                  </div>
                  <Slider
                    className="my-3"
                    min={control.key === "threadWidth" ? 320 : 200}
                    max={control.key === "threadWidth" ? 560 : 360}
                    step={10}
                    value={[Number(value)]}
                    onValueChange={(next) =>
                      setPreferences((current) => ({
                        ...current,
                        [control.key]: Array.isArray(next) ? next[0] : next,
                      }))
                    }
                  />
                  <div className="text-muted-foreground flex justify-between text-xs">
                    <span>{control.key === "threadWidth" ? 320 : 200} px</span>
                    <span>{control.key === "threadWidth" ? 560 : 360} px</span>
                  </div>
                </Field>
              )}
            </div>
          );
        })}
      {(section === "navigation" ||
        (section === "all" && /favorite|hidden|channel/.test(search))) && (
        <>
          {["favorites", "hiddenChannels"].map((key) => (
            <FieldSet key={key} className="rounded-md border px-3">
              <FieldLegend className="px-1 text-sm font-medium">
                {key === "favorites" ? "Favorite channels" : "Hidden channels"}
              </FieldLegend>
              {channels.map((channel) => (
                <Toggle
                  key={channel.id}
                  label={`#${channel.name}`}
                  checked={preferences[
                    key as "favorites" | "hiddenChannels"
                  ].includes(channel.id)}
                  onCheckedChange={(checked) =>
                    setPreferences((current) => ({
                      ...current,
                      [key]: checked
                        ? [
                            ...current[key as "favorites" | "hiddenChannels"],
                            channel.id,
                          ]
                        : current[key as "favorites" | "hiddenChannels"].filter(
                            (id) => id !== channel.id,
                          ),
                    }))
                  }
                />
              ))}
            </FieldSet>
          ))}
        </>
      )}
      {(section === "shortcuts" ||
        (section === "all" && /shortcut|search|new message/.test(search))) && (
        <>
          {Object.entries(preferences.shortcuts).map(([key, value]) => (
            <TextField
              key={key}
              label={
                key === "search"
                  ? "Search shortcut"
                  : key === "newMessage"
                    ? "New message shortcut"
                    : key
              }
              value={value}
              onChange={(event) =>
                setPreferences((current) => ({
                  ...current,
                  shortcuts: {
                    ...current.shortcuts,
                    [key]: event.target.value,
                  },
                }))
              }
            />
          ))}
          <p className="text-muted-foreground text-xs">
            Use combinations such as Ctrl+K, Alt+N, or Meta+K. Leave empty to
            disable a shortcut.
          </p>
        </>
      )}
      {section === "all" && !search && !changed(baseline, preferences) && (
        <p className="text-muted-foreground text-xs">
          Your saved preferences are shown.
        </p>
      )}
    </FieldGroup>
  );
}
