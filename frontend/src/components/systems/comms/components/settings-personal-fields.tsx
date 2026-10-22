"use client";

import { NativeSelectOption } from "@/components/ui/native-select";
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
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Choice, Toggle } from "../../shared/components/ui";
import { TextField } from "./ui";
import type { Channel } from "../domain/view-model";
import {
  DEFAULT_COMMS_PREFERENCES,
  type CommsPreferences,
} from "../domain/configuration";
import { changed } from "./settings-draft";

export type PersonalFieldsProps = {
  preferences: CommsPreferences;
  baseline: CommsPreferences;
  setPreferences: (
    action: (value: CommsPreferences) => CommsPreferences,
  ) => void;
  section: string;
  search: string;
  modifiedOnly: boolean;
  channels: Channel[];
  tier?: "common" | "advanced" | "all";
};

export const PERSONAL_ADVANCED_KEYS: Record<
  string,
  (keyof CommsPreferences)[]
> = {
  appearance: ["timestamps", "groupMessages", "avatars", "previews"],
  navigation: ["channelWidth", "memberWidth", "threadWidth"],
  shortcuts: ["shortcuts"],
};

export function PersonalFields({
  preferences,
  baseline,
  setPreferences,
  section,
  search,
  modifiedOnly,
  channels,
  tier = "all",
}: PersonalFieldsProps) {
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
      {section === "appearance" && tier === "advanced" && (
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
      {section === "navigation" && tier === "advanced" && (
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
            (tier === "all" ||
              (PERSONAL_ADVANCED_KEYS[control.section]?.includes(control.key) ??
                false) ===
                (tier === "advanced")) &&
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
      {tier !== "advanced" &&
        (section === "navigation" ||
          (section === "all" && /favorite|hidden|channel/.test(search))) && (
          <>
            {["favorites", "hiddenChannels"].map((key) => (
              <FieldSet key={key} className="rounded-md border px-3">
                <FieldLegend className="px-1 text-sm font-medium">
                  {key === "favorites"
                    ? "Favorite channels"
                    : "Hidden channels"}
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
                          : current[
                              key as "favorites" | "hiddenChannels"
                            ].filter((id) => id !== channel.id),
                      }))
                    }
                  />
                ))}
              </FieldSet>
            ))}
          </>
        )}
      {tier !== "common" &&
        (section === "shortcuts" ||
          (section === "all" &&
            /shortcut|search|new message/.test(search))) && (
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
