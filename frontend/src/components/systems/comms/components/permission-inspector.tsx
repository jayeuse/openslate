"use client";
import { useState } from "react";
import { NativeSelectOption } from "@/components/ui/native-select";
import { Alert } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { FieldGroup } from "@/components/ui/field";
import type { Person } from "../../shared/data/sample-people";
import { Action, Choice, Toggle } from "../../shared/components/ui";
import { ConfigurationFrame } from "./configuration-frame";
import type { Channel } from "../domain/view-model";
import type * as C from "../contract/types";
import {
  capabilitySchema,
  capabilityDefaults,
  capabilityGroupScopes,
  everyoneCapabilitySchema,
  lockableCapabilitySchema,
} from "../contract/schemas";
import { useCommsClient } from "../state/client-context";
import { useCommsRead } from "../state/runtime";

export const PERMISSION_LABELS: Record<C.Capability, string> = {
  react: "Add reactions",
  reply: "Reply to messages",
  createThread: "Create threads",
  attachFiles: "Attach files",
  linkRecords: "Link records",
  mentionChannel: "Mention channel and here",
  pin: "Pin messages",
  manageThreads: "Manage threads",
  deleteOthersMessages: "Delete other people’s messages",
  moderate: "Moderate conversations",
  manageChannel: "Manage channel",
  createChannel: "Create channels",
  manageWorkspace: "Manage workspace",
};
export function PermissionFields({
  value,
  scope,
  locked,
  search,
  modifiedOnly,
  onChange,
  onLock,
}: {
  value: C.CapabilityConfiguration;
  scope: C.SettingsScope;
  locked: C.Capability[];
  search: string;
  modifiedOnly: boolean;
  onChange: (value: C.CapabilityConfiguration) => void;
  onLock: (key: C.Capability, value: boolean) => void;
}) {
  const { groups } = useCommsClient();
  const [subject, setSubject] = useState("everyone");
  const capabilities = capabilitySchema.options.filter(
    (key) =>
      PERMISSION_LABELS[key].toLowerCase().includes(search.toLowerCase()) &&
      (!modifiedOnly || subject === "everyone"
        ? !modifiedOnly || Object.hasOwn(value.everyone, key)
        : value.group_grants.some(
            (row) => row.group_id === subject && row.capability === key,
          )),
  );
  return (
    <FieldGroup>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground max-w-md text-xs">
          Groups add capabilities. There are no person grants or deny rules.
          Guests remain read-only.
        </p>
      </div>
      <Choice
        label="Capabilities for"
        value={subject}
        onChange={(event) => setSubject(event.target.value)}
      >
        <NativeSelectOption value="everyone">Everyone</NativeSelectOption>
        {groups.map((group) => (
          <NativeSelectOption key={group.id} value={group.id}>
            {group.name}
          </NativeSelectOption>
        ))}
      </Choice>
      {capabilities.map((capability, index) => {
        const everyone = everyoneCapabilitySchema.safeParse(capability);
        const grantable = capabilityGroupScopes[capability].includes(
          scope.kind,
        );
        const disabled =
          scope.kind !== "workspace" && locked.includes(capability);
        return (
          <div key={capability} className="flex flex-col gap-2 pb-3">
            {subject === "everyone" && everyone.success ? (
              <Choice
                label={PERMISSION_LABELS[capability]}
                disabled={disabled}
                value={
                  value.everyone[everyone.data] === undefined
                    ? "inherit"
                    : value.everyone[everyone.data]
                      ? "enabled"
                      : "disabled"
                }
                onChange={(event) => {
                  const next = { ...value.everyone };
                  if (event.target.value === "inherit")
                    delete next[everyone.data];
                  else next[everyone.data] = event.target.value === "enabled";
                  onChange({ ...value, everyone: next });
                }}
              >
                <NativeSelectOption value="inherit">Inherit</NativeSelectOption>
                <NativeSelectOption value="enabled">Enabled</NativeSelectOption>
                <NativeSelectOption value="disabled">
                  Disabled
                </NativeSelectOption>
              </Choice>
            ) : subject !== "everyone" && grantable ? (
              <Toggle
                label={PERMISSION_LABELS[capability]}
                checked={value.group_grants.some(
                  (row) =>
                    row.group_id === subject && row.capability === capability,
                )}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  onChange({
                    ...value,
                    group_grants: [
                      ...value.group_grants.filter(
                        (row) =>
                          row.group_id !== subject ||
                          row.capability !== capability,
                      ),
                      ...(checked ? [{ group_id: subject, capability }] : []),
                    ],
                  })
                }
              />
            ) : (
              <p className="text-sm">
                <strong>{PERMISSION_LABELS[capability]}</strong> · Default:{" "}
                {capabilityDefaults[capability].replaceAll("_", " ")}. Not
                grantable here.
              </p>
            )}
            {disabled && (
              <p className="text-muted-foreground text-xs">
                Locked by workspace
              </p>
            )}
            {scope.kind === "workspace" &&
              lockableCapabilitySchema.safeParse(capability).success && (
                <Toggle
                  control="switch"
                  label={`Lock ${PERMISSION_LABELS[capability]} for categories and channels`}
                  checked={locked.includes(capability)}
                  onCheckedChange={(checked) => onLock(capability, checked)}
                />
              )}
            {index < capabilities.length - 1 && <Separator />}
          </div>
        );
      })}
    </FieldGroup>
  );
}

export function PermissionInspector({
  channel,
  channels,
  people,
  opener,
  onBack,
}: {
  channel?: Channel;
  channels: Channel[];
  people: Person[];
  opener: HTMLElement | null;
  onBack: () => void;
}) {
  const { client } = useCommsClient();
  const [personId, setPersonId] = useState(client?.context.user_id ?? "");
  const [channelId, setChannelId] = useState(
    channel?.id ?? channels[0]?.id ?? "",
  );
  const resource = useCommsRead(
    `inspect:${channelId}:${personId}`,
    (client, signal) => client.checkPerson(channelId, personId, { signal }),
  );
  return (
    <ConfigurationFrame
      title="Effective access"
      description="Check saved access for one person. Unsaved changes do not change their permissions."
      closeLabel="Back to settings"
      opener={opener}
      onClose={onBack}
      footer={
        <Action type="button" onClick={onBack}>
          Back to settings
        </Action>
      }
    >
      <FieldGroup className="p-5 sm:p-6">
        <Choice
          label="Check access for"
          value={personId}
          onChange={(event) => setPersonId(event.target.value)}
        >
          {people.map((person) => (
            <NativeSelectOption key={person.id} value={person.id}>
              {person.name}
            </NativeSelectOption>
          ))}
        </Choice>
        {!channel && (
          <Choice
            label="Inspect channel"
            value={channelId}
            onChange={(event) => setChannelId(event.target.value)}
          >
            {channels.map((item) => (
              <NativeSelectOption key={item.id} value={item.id}>
                #{item.name}
              </NativeSelectOption>
            ))}
          </Choice>
        )}
        {resource.error && (
          <Alert role="alert" variant="destructive">
            Access could not be checked.{" "}
            <Action onClick={resource.reload}>Try again</Action>
          </Alert>
        )}
        {resource.data && (
          <>
            <Alert>
              Conversation access: {resource.data.conversation_level}.
              Membership: {resource.data.membership_role}.
            </Alert>
            <div className="flex flex-col">
              {capabilitySchema.options.map((capability, index) => {
                const decision = resource.data!.capabilities[capability];
                const source = decision.source;
                return (
                  <div key={capability} className="grid gap-2 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-medium">
                        {PERMISSION_LABELS[capability]}
                      </h3>
                      <Badge
                        variant={decision.allowed ? "secondary" : "outline"}
                      >
                        {decision.allowed ? "Allowed" : "Denied"}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground text-xs break-words">
                      Source: {source.kind.replaceAll("_", " ")}
                      {"group_name" in source ? ` · ${source.group_name}` : ""}
                      {"scope" in source ? ` · ${source.scope.kind}` : ""}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {source.kind === "guest_cap"
                        ? "Guests are read-only; group grants cannot enable writing."
                        : source.kind === "admin"
                          ? "Organization administrators manage settings in this organization."
                          : source.kind === "manager"
                            ? `Conversation manager: ${source.reason.replaceAll("_", " ")}.`
                            : source.kind === "default"
                              ? `Default for ${source.basis.replaceAll("_", " ")}.`
                              : source.kind === "group_grant"
                                ? "This group's grant turns this on here and everywhere inside it."
                                : source.kind === "workspace_lock"
                                  ? "The workspace lock fixes the inherited capability value."
                                  : source.kind === "everyone"
                                    ? "The most specific Everyone setting determines this default."
                                    : source.kind === "department_manager"
                                      ? "Department management grants this capability for that department's channels."
                                      : source.reason.replaceAll("_", " ")}
                    </p>
                    {index < capabilitySchema.options.length - 1 && (
                      <Separator />
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </FieldGroup>
    </ConfigurationFrame>
  );
}
