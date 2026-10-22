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
import { Action, Choice } from "../../shared/components/ui";
import type { Channel } from "../domain/view-model";
import { LevelBadge } from "./member-level";
import type { CommsSettings } from "../domain/configuration";
import { useCommsRead } from "../state/runtime";
import { complete } from "../state/workspace-view";

/**
 * A channel's readers with their level. Manager rows are the only rows with a
 * role to change: a reader can become a manager, a manager row can go back to
 * the reader's own level. Admins, department managers and the creator manage
 * by their role, so they have no action here.
 */
export function MembershipPreview({
  channel,
  saved,
  roles,
  onRoleChange,
}: {
  channel: Channel;
  saved: boolean;
  roles: Record<string, "member" | "manager">;
  onRoleChange: (userId: string, role: "member" | "manager") => void;
}) {
  const members = useCommsRead(
    `members:${saved ? channel.id : "new"}`,
    async (client, signal) =>
      saved
        ? {
            members: await complete((offset) =>
              client.listMembers(
                channel.id,
                { limit: 100, offset },
                { signal },
              ),
            ),
            viewer: await client.getCapabilities(channel.id, { signal }),
          }
        : null,
  );
  const [personId, setPersonId] = useState("");
  const chosen =
    members.data?.members.find((member) => member.user_id === personId) ??
    members.data?.members[0];
  const person = useCommsRead(
    `membership:${saved ? channel.id : "new"}:${chosen?.user_id ?? ""}`,
    async (client, signal) =>
      saved && chosen && members.data?.viewer.capabilities.manageChannel.allowed
        ? client.checkPerson(channel.id, chosen.user_id, { signal })
        : null,
  );
  if (!saved)
    return (
      <p className="text-muted-foreground text-sm">
        Save this channel to see who can use it.
      </p>
    );
  const check = person.data;
  const source = check?.manager_source ?? null;
  const roleNote = !check
    ? ""
    : check.access_source.kind === "admin"
      ? "Admins manage every channel."
      : source === "creator"
        ? "Created this channel, so manages it."
        : source === "department_manager"
          ? "Manages this channel through a department role."
          : check.membership_role === "guest"
            ? "Guests can only read."
            : "";
  const roleChangeable =
    !!check &&
    !roleNote &&
    (source === "membership_manager" || check.conversation_level !== "manage");
  return (
    <section aria-label="Channel members" className="flex flex-col gap-4">
      {members.error && (
        <Alert role="alert" variant="destructive">
          Members could not be loaded.{" "}
          <Action onClick={members.reload}>Try again</Action>
        </Alert>
      )}
      {members.data && (
        <ul
          aria-label="People who can use this channel"
          className="border-card-edge divide-y overflow-hidden rounded-lg border"
        >
          {members.data.members.map((member) => (
            <li
              key={member.user_id}
              className="flex min-h-11 items-center justify-between gap-3 px-3 py-2"
            >
              <span className="min-w-0">
                <bdi className="block truncate text-sm font-medium">
                  {member.display_name}
                </bdi>
                <bdi className="text-muted-foreground block truncate text-xs">
                  {member.departments.map((item) => item.name).join(", ") ||
                    "No department"}
                </bdi>
              </span>
              <LevelBadge level={member.level} />
            </li>
          ))}
        </ul>
      )}
      {members.data?.viewer.capabilities.manageChannel.allowed &&
        members.data.members.length > 0 && (
          <Card aria-label="Channel managers" className="w-full">
            <CardHeader className="p-4">
              <CardTitle>Channel managers</CardTitle>
              <CardDescription>
                A manager can change this channel and its settings. Role changes
                save with this dialog.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 p-4">
              <Choice
                label="Person"
                value={chosen?.user_id ?? ""}
                onChange={(event) => setPersonId(event.target.value)}
              >
                {members.data.members.map((member) => (
                  <NativeSelectOption
                    key={member.user_id}
                    value={member.user_id}
                  >
                    {member.display_name}
                  </NativeSelectOption>
                ))}
              </Choice>
              {person.error && (
                <Alert role="alert" variant="destructive">
                  This person could not be checked.{" "}
                  <Action onClick={person.reload}>Try again</Action>
                </Alert>
              )}
              {roleNote && (
                <p className="text-muted-foreground text-sm">{roleNote}</p>
              )}
              {roleChangeable && chosen && (
                <Choice
                  label="Channel role"
                  value={
                    roles[chosen.user_id] ??
                    (source === "membership_manager" ? "manager" : "member")
                  }
                  onChange={(event) =>
                    onRoleChange(
                      chosen.user_id,
                      event.target.value === "manager" ? "manager" : "member",
                    )
                  }
                >
                  <NativeSelectOption value="member">
                    Not a manager
                  </NativeSelectOption>
                  <NativeSelectOption value="manager">
                    Manager
                  </NativeSelectOption>
                </Choice>
              )}
            </CardContent>
          </Card>
        )}
    </section>
  );
}

export function NotificationPreview({ settings }: { settings: CommsSettings }) {
  return (
    <Card aria-label="Notification preview" className="w-full">
      <CardHeader className="p-4">
        <CardTitle>Notification preview</CardTitle>
        <CardDescription>
          Desktop alerts show the kind of activity and, for channels, the
          channel name. They never show message text.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-4">
        <Alert>
          {settings.notificationPreview
            ? "Mention in operations"
            : "New activity in OpenComms"}
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
