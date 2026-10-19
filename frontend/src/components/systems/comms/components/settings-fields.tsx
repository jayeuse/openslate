"use client";
import { NativeSelectOption } from "@/components/ui/native-select";

import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import type { Person } from "../../shared/data/sample-people";
import { useCommsClient } from "../state/client-context";
import { useCommsRead } from "../state/runtime";
import { complete } from "../state/workspace-view";
import { Choice, Toggle } from "../../shared/components/ui";
import { TextField } from "./ui";
import type { CommsSettingKey, CommsSettings } from "../domain/configuration";

export const SETTINGS_SECTIONS: {
  id: string;
  label: string;
  description: string;
  keys: CommsSettingKey[];
  common: CommsSettingKey[];
}[] = [
  {
    id: "overview",
    label: "Overview",
    description: "Set the tone and defaults for conversations.",
    keys: [],
    common: [],
  },
  {
    id: "messaging",
    label: "Messaging",
    description: "Control composition and message changes.",
    keys: [
      "mode",
      "slowModeSeconds",
      "formatting",
      "linkPreviews",
      "allowedReactions",
      "mentionLimit",
    ],
    common: ["mode"],
  },
  {
    id: "threads",
    label: "Threads",
    description: "Choose how conversations branch and stay visible.",
    keys: ["autoArchiveDays", "defaultThreadSubscription", "threadBranches"],
    common: [],
  },
  {
    id: "members",
    label: "Members",
    description: "Assign responsibility and set membership rules.",
    keys: ["joinRule", "defaultMemberIds", "dmRule"],
    common: [],
  },
  {
    id: "notifications",
    label: "Notifications",
    description:
      "Shared notification defaults. Personal choices can reduce interruptions.",
    keys: [
      "notificationMode",
      "keywords",
      "notifyFollowedThreads",
      "quietHoursStart",
      "quietHoursEnd",
      "notificationSound",
      "notificationBadges",
      "notificationPreview",
      "desktopNotifications",
    ],
    common: ["notificationMode"],
  },
  {
    id: "files",
    label: "Files and records",
    description: "Choose permitted attachments and record card information.",
    keys: [
      "allowedFileTypes",
      "maxFileSizeMb",
      "filePreviews",
      "fileDownloads",
      "allowedRecordModules",
      "requireRecordLink",
      "recordCardFields",
      "pinnedRecordId",
    ],
    common: ["allowedFileTypes", "maxFileSizeMb"],
  },
  {
    id: "moderation",
    label: "Posting and history",
    description:
      "Lock the channel, limit who can post, and set how long messages are kept. In this example, nothing is deleted automatically.",
    keys: [
      "editWindowMinutes",
      "deleteWindowMinutes",
      "locked",
      "restrictedPersonIds",
      "restrictionUntil",
      "allowExport",
    ],
    common: ["editWindowMinutes", "deleteWindowMinutes"],
  },
];
export const SETTINGS_LABELS: Record<CommsSettingKey, string> = {
  mode: "Channel mode",
  editWindowMinutes: "Edit window (minutes)",
  deleteWindowMinutes: "Delete window (minutes)",
  slowModeSeconds: "Slow mode (seconds)",
  formatting: "Allow message formatting",
  linkPreviews: "Show link previews",
  allowedReactions: "Allowed reactions",
  mentionLimit: "Mentions per message",
  autoArchiveDays: "Auto-archive after (days)",
  defaultThreadSubscription: "Follow threads by default",
  threadBranches: "Thread branches in sidebar",
  joinRule: "Channel joining",
  defaultMemberIds: "Default members",
  dmRule: "Direct message access",
  notificationMode: "Notify me about",
  keywords: "Notification keywords",
  notifyFollowedThreads: "Notify followed threads",
  quietHoursStart: "Quiet hours start",
  quietHoursEnd: "Quiet hours end",
  notificationSound: "Notification sound",
  notificationBadges: "Notification badges",
  notificationPreview: "Message notification previews",
  desktopNotifications: "Desktop notifications",
  allowedFileTypes: "Allowed file types",
  maxFileSizeMb: "Maximum file size (MB)",
  filePreviews: "File previews",
  fileDownloads: "Allow file downloads",
  allowedRecordModules: "Allowed record modules",
  requireRecordLink: "Require a linked record",
  recordCardFields: "Record card fields",
  locked: "Lock channel posting",
  restrictedPersonIds: "Restricted people",
  restrictionUntil: "Posting restriction ends",
  allowExport: "Allow history export",
  pinnedRecordId: "Pinned record",
};
const hints: Partial<Record<CommsSettingKey, string>> = {
  mode: "Announcements reserve new messages for managers. Thread-first channels guide replies into threads.",
  editWindowMinutes: "0 means no time limit; this is the default.",
  deleteWindowMinutes: "0 means no time limit.",
  slowModeSeconds:
    "0 turns slow mode off. Applies to new messages and thread replies.",
  mentionLimit: "0 means no limit. Mention permissions still apply.",
  allowedReactions:
    "Separate emoji with commas. Leave empty to disable reactions.",
  autoArchiveDays:
    "0 disables auto-archive. Review the impact before applying the setting.",
  allowedFileTypes:
    "Comma-separated extensions: pdf, png, jpg, jpeg, docx, xlsx, pptx. Empty uses the platform allowlist.",
  maxFileSizeMb:
    "At most 10 MB. Zero uses the platform's 10 MB limit. File bytes remain in this local sample session.",
  allowedRecordModules:
    "Choose allowed record modules. Empty permits every module you can read.",
  recordCardFields: "Choose which details appear on linked record cards.",
  pinnedRecordId: "Keep one record within reach of everyone in this channel.",
  restrictionUntil:
    "Leave empty for no expiry. Applies to the selected restricted people.",
  keywords: "Separate words or phrases with commas.",
};
const choices: Partial<Record<CommsSettingKey, [string, string][]>> = {
  mode: [
    ["normal", "Normal conversation"],
    ["announcements", "Announcements"],
    ["thread-first", "Thread-first"],
  ],
  threadBranches: [
    ["all", "All threads"],
    ["followed", "Followed threads"],
    ["none", "Hide thread branches"],
  ],
  joinRule: [
    ["open", "Open joining"],
    ["request", "Request approval"],
    ["invite", "Invite only"],
  ],
  dmRule: [
    ["everyone", "Everyone"],
    ["shared-channel", "People sharing a channel"],
    ["none", "No new direct messages"],
  ],
  notificationMode: [
    ["all", "All messages"],
    ["mentions", "Mentions only"],
    ["none", "No notifications"],
  ],
};
export function SettingsFields({
  keys,
  values,
  overrides,
  locked,
  workspace,
  people,
  onChange,
}: {
  keys: CommsSettingKey[];
  values: CommsSettings;
  overrides: Partial<CommsSettings>;
  locked: CommsSettingKey[];
  workspace: boolean;
  people: Person[];
  onChange: <K extends CommsSettingKey>(
    key: K,
    value: CommsSettings[K],
  ) => void;
}) {
  const { catalog } = useCommsClient();
  const linked = useCommsRead("settings-records", (client, signal) =>
    complete((offset) =>
      client.listLinkedRecords({ limit: 100, offset }, { signal }),
    ),
  );
  const records = [
    ...new Map(
      (linked.data ?? [])
        .filter((record) => record.state === "available")
        .map((record) => [record.record_id, record]),
    ).values(),
  ];
  return (
    <FieldGroup>
      {keys.map((key, index) => {
        const value = values[key];
        const selectedValues: readonly string[] = Array.isArray(value)
          ? value
          : [];
        const label = SETTINGS_LABELS[key];
        const disabled = !workspace && locked.includes(key);
        const override = Object.hasOwn(overrides, key);
        return (
          <Field
            key={key}
            data-disabled={disabled || undefined}
            className="pb-4 last:pb-0"
          >
            {key === "pinnedRecordId" ? (
              <Choice
                label={label}
                value={String(value)}
                disabled={disabled}
                onChange={(event) => onChange(key, event.target.value)}
              >
                <NativeSelectOption value="">
                  No pinned record
                </NativeSelectOption>
                {records.map((record) => (
                  <NativeSelectOption
                    key={record.record_id}
                    value={record.record_id}
                  >
                    {record.title}
                  </NativeSelectOption>
                ))}
              </Choice>
            ) : key === "recordCardFields" || key === "allowedRecordModules" ? (
              <FieldSet disabled={disabled} className="rounded-md border px-3">
                <FieldLegend className="px-1 text-sm font-medium">
                  {label}
                </FieldLegend>
                {(key === "recordCardFields"
                  ? catalog.fields.map((field) => [field.id, field.label])
                  : catalog.modules.map((module) => [module.id, module.name])
                ).map(([field, name]) => (
                  <Toggle
                    key={field}
                    label={name}
                    checked={selectedValues.includes(field)}
                    onCheckedChange={(checked) =>
                      onChange(
                        key,
                        checked
                          ? [...(Array.isArray(value) ? value : []), field]
                          : (Array.isArray(value) ? value : []).filter(
                              (item) => item !== field,
                            ),
                      )
                    }
                  />
                ))}
              </FieldSet>
            ) : ["defaultMemberIds", "restrictedPersonIds"].includes(key) ? (
              <FieldSet disabled={disabled} className="rounded-md border px-3">
                <FieldLegend className="px-1 text-sm font-medium">
                  {label}
                </FieldLegend>
                {people.map((person) => (
                  <Toggle
                    key={person.id}
                    label={`${person.name}${person.active ? "" : " (inactive)"}`}
                    checked={selectedValues.includes(person.id)}
                    onCheckedChange={(checked) =>
                      onChange(
                        key,
                        checked
                          ? [...(Array.isArray(value) ? value : []), person.id]
                          : (Array.isArray(value) ? value : []).filter(
                              (id) => id !== person.id,
                            ),
                      )
                    }
                  />
                ))}
              </FieldSet>
            ) : choices[key] ? (
              <Choice
                label={label}
                value={String(value)}
                disabled={disabled}
                onChange={(event) =>
                  onChange(key, event.target.value as CommsSettings[typeof key])
                }
              >
                {choices[key]?.map(([id, name]) => (
                  <NativeSelectOption key={id} value={id}>
                    {name}
                  </NativeSelectOption>
                ))}
              </Choice>
            ) : typeof value === "boolean" ? (
              <Toggle
                control="switch"
                label={label}
                checked={value}
                disabled={disabled}
                onCheckedChange={(checked) => onChange(key, checked)}
              />
            ) : key === "restrictionUntil" ? (
              <TextField
                label={label}
                type="datetime-local"
                disabled={disabled}
                value={
                  value
                    ? new Date(
                        Number(value) -
                          new Date(Number(value)).getTimezoneOffset() * 60000,
                      )
                        .toISOString()
                        .slice(0, 16)
                    : ""
                }
                onChange={(event) =>
                  onChange(
                    key,
                    event.target.value
                      ? new Date(event.target.value).getTime()
                      : 0,
                  )
                }
              />
            ) : (
              <TextField
                label={label}
                disabled={disabled}
                type={
                  typeof value === "number"
                    ? "number"
                    : key === "quietHoursStart" || key === "quietHoursEnd"
                      ? "time"
                      : "text"
                }
                min={typeof value === "number" ? 0 : undefined}
                step={typeof value === "number" ? 1 : undefined}
                value={Array.isArray(value) ? value.join(",") : String(value)}
                onChange={(event) =>
                  onChange(
                    key,
                    typeof value === "number"
                      ? Number(event.target.value)
                      : Array.isArray(value)
                        ? event.target.value.split(",")
                        : event.target.value,
                  )
                }
              />
            )}
            {hints[key] && (
              <FieldDescription className="text-xs">
                {hints[key]}
              </FieldDescription>
            )}
            {/* Only a value that differs from what it inherits gets a label. */}
            {(disabled || override) && (
              <span className="text-muted-foreground text-xs">
                {disabled ? "Locked by workspace" : "Customized here"}
              </span>
            )}
            {index < keys.length - 1 && <Separator />}
          </Field>
        );
      })}
    </FieldGroup>
  );
}

export function SettingsLocks({
  keys,
  locked,
  onLock,
}: {
  keys: CommsSettingKey[];
  locked: CommsSettingKey[];
  onLock: (key: CommsSettingKey, value: boolean) => void;
}) {
  return (
    <FieldSet>
      <FieldLegend>Workspace locks</FieldLegend>
      {keys
        .filter((key) => key !== "dmRule")
        .map((key) => (
          <Toggle
            key={key}
            control="switch"
            label={`Lock ${SETTINGS_LABELS[key].replace(/^Lock /, "")} for categories and channels`}
            checked={locked.includes(key)}
            onCheckedChange={(value) => onLock(key, value)}
          />
        ))}
    </FieldSet>
  );
}
