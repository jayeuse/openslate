"use client";
import {
  NativeSelectOption,
  NativeSelectOptGroup,
} from "@/components/ui/native-select";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { Badge } from "@/components/ui/badge";
import { FieldGroup } from "@/components/ui/field";
import type { Person, Role } from "../../shared/data/sample-people";
import { Action, Choice, Toggle } from "../../shared/components/ui";
import { ConfigurationFrame } from "./configuration-frame";
import {
  COMMS_PERMISSIONS,
  resolveCommsPermission,
  type CommsConfiguration,
  type CommsPermission,
  type CommsScopeConfiguration,
  type PermissionOverride,
} from "../domain/configuration";
import type { Category, Channel } from "../domain/model";

export const PERMISSION_LABELS: Record<CommsPermission, string> = {
  viewChannel: "View channel",
  viewHistory: "View message history",
  post: "Start new messages",
  reply: "Reply to messages",
  createThread: "Create threads",
  manageThreads: "Manage threads",
  react: "Add reactions",
  mentionPeople: "Mention people",
  mentionRoles: "Mention roles",
  mentionEveryone: "Mention everyone",
  attachFiles: "Attach files",
  downloadFiles: "Download files",
  linkRecords: "Link records",
  pin: "Pin messages",
  editMessages: "Edit messages",
  deleteMessages: "Delete messages",
  deleteOthersMessages: "Delete other people’s messages",
  invite: "Invite people",
  manageChannel: "Manage channel",
  managePermissions: "Manage permissions",
  createChannel: "Create channels",
  manageWorkspace: "Manage workspace",
  exportHistory: "Export history",
  moderate: "Moderate conversations",
};

export function PermissionFields({
  value,
  roles,
  people,
  locked,
  workspace,
  search,
  modifiedOnly,
  initialSubject = "everyone",
  onChange,
  onLock,
  onInspect,
}: {
  value: CommsScopeConfiguration["permissions"];
  roles: Role[];
  people: Person[];
  locked: CommsPermission[];
  workspace: boolean;
  search: string;
  modifiedOnly: boolean;
  initialSubject?: string;
  onChange: (
    subject: string,
    permission: CommsPermission,
    value: PermissionOverride,
  ) => void;
  onLock: (permission: CommsPermission, value: boolean) => void;
  onInspect: () => void;
}) {
  const [subject, setSubject] = useState(initialSubject);
  const permissions = COMMS_PERMISSIONS.filter(
    (permission) =>
      PERMISSION_LABELS[permission]
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (!modifiedOnly ||
        (value[subject]?.[permission] &&
          value[subject][permission] !== "inherit")),
  );
  return (
    <FieldGroup>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground max-w-md text-xs">
          Access is decided from the workspace down to the channel. At each
          level, a rule for a person beats a rule for their role, which beats
          the rule for everyone. Inherit uses the broader rule.
        </p>
        <Action type="button" onClick={onInspect}>
          Inspect effective access
        </Action>
      </div>
      <Choice
        label="Permissions for"
        value={subject}
        onChange={(event) => setSubject(event.target.value)}
      >
        <NativeSelectOption value="everyone">Everyone</NativeSelectOption>
        <NativeSelectOptGroup label="Roles">
          {roles.map((role) => (
            <NativeSelectOption key={role.id} value={`role:${role.id}`}>
              {role.name}
            </NativeSelectOption>
          ))}
        </NativeSelectOptGroup>
        <NativeSelectOptGroup label="People">
          {people.map((person) => (
            <NativeSelectOption key={person.id} value={`person:${person.id}`}>
              {person.name}
              {person.active ? "" : " (inactive)"}
            </NativeSelectOption>
          ))}
        </NativeSelectOptGroup>
      </Choice>
      {subject === "person:sample-eli" && (
        <Alert>
          Eli owns OpenComms, so Eli always has every permission here. Channel
          locks and message limits still apply.
        </Alert>
      )}
      {!permissions.length && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No permissions match these filters.</EmptyTitle>
            <EmptyDescription>
              Try another search or turn off Modified only.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {permissions.map((permission, index) => (
        <div key={permission} className="flex flex-col gap-2 pb-3">
          <Choice
            label={PERMISSION_LABELS[permission]}
            disabled={!workspace && locked.includes(permission)}
            value={value[subject]?.[permission] ?? "inherit"}
            onChange={(event) =>
              onChange(
                subject,
                permission,
                event.target.value as PermissionOverride,
              )
            }
          >
            <NativeSelectOption value="inherit">Inherit</NativeSelectOption>
            <NativeSelectOption value="allow">Allow</NativeSelectOption>
            <NativeSelectOption value="deny">Deny</NativeSelectOption>
          </Choice>
          <p className="text-muted-foreground text-xs">
            {!workspace && locked.includes(permission)
              ? "Locked by workspace"
              : value[subject]?.[permission] &&
                  value[subject][permission] !== "inherit"
                ? "Set here"
                : "Not set here, so a broader rule applies"}
          </p>
          {workspace && (
            <Toggle
              control="switch"
              label={`Lock ${PERMISSION_LABELS[permission]} for categories and channels`}
              checked={locked.includes(permission)}
              onCheckedChange={(checked) => onLock(permission, checked)}
            />
          )}
          {index < permissions.length - 1 && <Separator />}
        </div>
      ))}
    </FieldGroup>
  );
}

export function PermissionInspector({
  config,
  channel,
  channels,
  categories,
  people,
  opener,
  onBack,
}: {
  config: CommsConfiguration;
  channel?: Channel;
  channels: Channel[];
  categories: Category[];
  people: Person[];
  opener: HTMLElement | null;
  onBack: () => void;
}) {
  const [personId, setPersonId] = useState("sample-eli");
  const [channelId, setChannelId] = useState(channel?.id ?? "");
  const selectedChannel =
    channel ?? channels.find((item) => item.id === channelId);
  const person = people.find((item) => item.id === personId);
  return (
    <ConfigurationFrame
      title="Effective access"
      description="See what one person can do with your unsaved changes. This does not sign you in as them."
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
          {people.map((item) => (
            <NativeSelectOption key={item.id} value={item.id}>
              {item.name}
              {item.active ? "" : " (inactive)"}
            </NativeSelectOption>
          ))}
        </Choice>
        {!channel && (
          <Choice
            label="Inspect channel"
            value={channelId}
            onChange={(event) => setChannelId(event.target.value)}
          >
            <NativeSelectOption value="">Workspace defaults</NativeSelectOption>
            {channels.map((item) => (
              <NativeSelectOption key={item.id} value={item.id}>
                #{item.name}
              </NativeSelectOption>
            ))}
          </Choice>
        )}
        {(() => {
          const results = COMMS_PERMISSIONS.map((permission) => ({
            permission,
            result: resolveCommsPermission(
              config,
              { person, channel: selectedChannel, categories },
              permission,
            ),
          }));
          // One reason for every row (the owner rule) is said once, above.
          const sharedReason = results.every(
            ({ result }) => result.reason === results[0]?.result.reason,
          )
            ? results[0]?.result.reason
            : undefined;
          return (
            <>
              {sharedReason && <Alert>{sharedReason}</Alert>}
              <div className="flex flex-col">
                {results.map(({ permission, result }, index) => {
                  return (
                    <div key={permission} className="grid gap-2 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-sm font-medium">
                          {PERMISSION_LABELS[permission]}
                        </h3>
                        <Badge
                          variant={result.allowed ? "secondary" : "outline"}
                        >
                          {result.allowed ? "Allowed" : "Denied"}
                        </Badge>
                      </div>
                      {!sharedReason && (
                        <p className="text-muted-foreground text-xs">
                          {result.reason}
                        </p>
                      )}
                      <p className="text-muted-foreground text-xs break-words">
                        Source: {result.source}
                      </p>
                      {index < COMMS_PERMISSIONS.length - 1 && <Separator />}
                    </div>
                  );
                })}
              </div>
            </>
          );
        })()}
      </FieldGroup>
    </ConfigurationFrame>
  );
}
