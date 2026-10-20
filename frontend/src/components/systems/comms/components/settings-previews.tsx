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
import type { Person } from "../../shared/data/sample-people";
import { Action, Choice } from "../../shared/components/ui";
import type { Channel } from "../domain/view-model";
import type { CommsSettings } from "../domain/configuration";
import { useCommsRead } from "../state/runtime";
import { complete } from "../state/workspace-view";

export function MembershipPreview({
  channel,
  people,
  settings,
  roles,
  onRoleChange,
}: {
  channel?: Channel;
  people: Person[];
  settings: CommsSettings;
  roles: Record<string, "member" | "manager">;
  onRoleChange: (userId: string, role: "member" | "manager") => void;
}) {
  const [personId, setPersonId] = useState(people[0]?.id ?? "");
  const resource = useCommsRead(
    `membership:${channel?.id ?? "new"}:${personId}`,
    async (client, signal) => {
      if (!channel?.id) return null;
      const [person, viewer, members] = await Promise.all([
        client.checkPerson(channel.id, personId, { signal }),
        client.getCapabilities(channel.id, { signal }),
        complete((offset) =>
          client.listMembers(channel.id, { limit: 100, offset }, { signal }),
        ),
      ]);
      return {
        person,
        viewer,
        member: members.find((member) => member.user_id === personId),
      };
    },
  );
  return (
    <Card aria-label="Membership preview" className="w-full">
      <CardHeader className="p-4">
        <CardTitle>Membership preview</CardTitle>
        <CardDescription>
          Saved access is checked by the conversation client. Member-role
          changes save with this dialog.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-4">
        <Choice
          label="Preview membership for"
          value={personId}
          onChange={(event) => setPersonId(event.target.value)}
        >
          {people.map((person) => (
            <NativeSelectOption key={person.id} value={person.id}>
              {person.name}
            </NativeSelectOption>
          ))}
        </Choice>
        {resource.error && (
          <Alert role="alert" variant="destructive">
            Membership could not be checked.{" "}
            <Action onClick={resource.reload}>Try again</Action>
          </Alert>
        )}
        {!channel?.id && (
          <p className="text-muted-foreground text-xs">
            Save this channel before managing its members.
          </p>
        )}
        {resource.data && (
          <>
            <Alert>
              Saved access: {resource.data.person.conversation_level}.{" "}
              {resource.data.person.membership_role === "guest"
                ? "Guests are read-only."
                : "Capabilities follow the saved role and group grants."}
            </Alert>
            {resource.data.member &&
              resource.data.viewer.capabilities.manageChannel.allowed && (
                <Choice
                  label="Conversation role"
                  value={roles[personId] ?? resource.data.member.member_role}
                  onChange={(event) =>
                    onRoleChange(
                      personId,
                      event.target.value === "manager" ? "manager" : "member",
                    )
                  }
                >
                  <NativeSelectOption value="member">Member</NativeSelectOption>
                  <NativeSelectOption
                    value="manager"
                    disabled={resource.data.person.membership_role === "guest"}
                  >
                    Manager
                  </NativeSelectOption>
                </Choice>
              )}
          </>
        )}
        <div>
          <h4 className="text-xs font-semibold">Default membership preview</h4>
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            {people
              .filter((person) => settings.defaultMemberIds.includes(person.id))
              .map((person) => (
                <li key={person.id}>
                  {person.name} · Selected as a default member
                </li>
              ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

export function NotificationPreview({ settings }: { settings: CommsSettings }) {
  return (
    <Card aria-label="Notification preview" className="w-full">
      <CardHeader className="p-4">
        <CardTitle>Notification preview</CardTitle>
        <CardDescription>
          Appearance only. Desktop alerts and sounds are not emitted in this
          local example; live delivery remains deferred.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-4">
        <Alert>
          {settings.notificationPreview
            ? "A person mentioned you in a conversation."
            : "New activity in a conversation."}
        </Alert>
        <p className="text-muted-foreground text-xs">
          {settings.notificationSound
            ? "Sound preference on"
            : "Sound preference off"}{" "}
          ·{" "}
          {settings.notificationBadges
            ? "Badge preference on"
            : "Badge preference off"}{" "}
          · {settings.notificationMode}
        </p>
        {settings.quietHoursStart && (
          <p className="text-muted-foreground text-xs">
            Quiet hours: {settings.quietHoursStart}–{settings.quietHoursEnd}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
