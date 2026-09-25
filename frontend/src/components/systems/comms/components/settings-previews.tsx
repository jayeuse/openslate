"use client";

import { useState } from "react";
import { NativeSelectOption } from "@/components/ui/native-select";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Empty, EmptyHeader, EmptyDescription } from "@/components/ui/empty";
import type { Person } from "../../access/domain/model";
import { Choice } from "../../shared/components/ui";
import type { Category, Channel } from "../domain/model";
import {
  resolveCommsPermission,
  type CommsConfiguration,
  type CommsSettings,
} from "../domain/configuration";
import { previewCommsNotification } from "../domain/notification-policy";

const PERSON_ID = "sample-eli";

export type MembershipPreviewProps = {
  config: CommsConfiguration;
  channel?: Channel;
  categories: Category[];
  people: Person[];
  settings: CommsSettings;
};

export function MembershipPreview({
  config,
  channel,
  categories,
  people,
  settings,
}: MembershipPreviewProps) {
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
    path = "An accepted membership record exists.";
  else if (membership?.status === "pending")
    path =
      membership.type === "request"
        ? "A join request is awaiting approval."
        : "An invitation is awaiting acceptance.";
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
          {inviteAccess.allowed ? "Allowed" : "Denied"}. Manage existing
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

export function NotificationPreview({
  result,
}: {
  result: ReturnType<typeof previewCommsNotification>;
}) {
  return (
    <Card aria-label="Notification preview" className="w-full">
      <CardHeader className="p-4">
        <CardTitle>Notification preview</CardTitle>
        <CardDescription>No notification is delivered.</CardDescription>
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
