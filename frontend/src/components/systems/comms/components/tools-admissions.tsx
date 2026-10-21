"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { FieldGroup } from "@/components/ui/field";
import { NativeSelectOption } from "@/components/ui/native-select";
import { Choice } from "../../shared/components/ui";
import { useCommsWorkspaceView } from "../state/use-comms-workspace";
import { useCommsMessageAuthors } from "../state/use-comms-message-authors";
import { complete } from "../state/workspace-view";
import {
  messageFromCommsError,
  useCommsCommands,
  useCommsRead,
} from "../state/runtime";
import { ConfigurationFrame } from "./configuration-frame";
import { ToolAdvanced } from "./tool-advanced";
import type { Admission } from "../contract/types";
import type { CommsToolsDialogProps } from "./tools-dialog";

export function AdmissionTools({
  opener,
  onClose,
  embedded,
}: CommsToolsDialogProps) {
  const { channels, people, checks } = useCommsWorkspaceView();
  const { run, isPending } = useCommsCommands();
  const managed = channels.filter(
    (room) =>
      room.scope === "members" &&
      checks[room.id]?.capabilities.manageChannel.allowed,
  );
  const [channelId, setChannelId] = useState(managed[0]?.id ?? "");
  const [personId, setPersonId] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const resource = useCommsRead(
    `admissions:${managed.map((room) => room.id).join(":")}`,
    async (client, signal) =>
      (
        await Promise.all(
          managed.map((room) =>
            complete((offset) =>
              client.listAdmissions(
                room.id,
                { limit: 100, offset },
                { signal },
              ),
            ),
          ),
        )
      ).flat(),
  );
  // Requesters are not members yet: name them through the authorized person card.
  const requesters = useCommsMessageAuthors(
    (resource.data ?? [])
      .filter((row) => row.kind === "request" && row.status === "pending")
      .map((row) => ({ org_id: row.org_id, author_id: row.user_id })),
    people,
  );
  async function decide(row: Admission, decision: "accept" | "decline") {
    setError("");
    setStatus("");
    try {
      await run(`admission:${row.id}`, async (client, signal) => {
        const current = await client.getAdmission(row.conversation_id, row.id, {
          signal,
        });
        await client.decideAdmission(
          row.conversation_id,
          row.id,
          { decision },
          { signal, if_match: current.etag },
        );
      });
      resource.reload();
    } catch (failure) {
      setError(
        messageFromCommsError(failure, "The request could not be updated."),
      );
    }
  }
  async function invite() {
    setError("");
    setStatus("");
    try {
      await run("admission-invite", (client, signal) =>
        client.invitePerson(channelId, { user_id: personId }, { signal }),
      );
      setStatus("Invitation created.");
      resource.reload();
    } catch (failure) {
      setError(
        messageFromCommsError(
          failure,
          "The invitation could not be created. Your choices are still here.",
        ),
      );
    }
  }
  return (
    <ConfigurationFrame
      embedded={embedded}
      className="max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-11"
      title="Join requests"
      opener={opener}
      onClose={onClose}
    >
      <FieldGroup className="p-5 sm:p-6">
        {(error || resource.error) && (
          <Alert role="alert" variant="destructive">
            {error || "Requests could not be loaded."}
            {resource.error && (
              <Button onClick={resource.reload}>Try again</Button>
            )}
          </Alert>
        )}
        {status && (
          <Alert role="status" variant="success">
            {status}
          </Alert>
        )}
        <p className="text-muted-foreground text-sm">
          Review requests for private channels you manage. Decisions use current
          saved access.
        </p>
        {resource.data
          ?.filter((row) => row.kind === "request")
          .map((row) => {
            const name =
              people.find((person) => person.id === row.user_id)?.name ??
              requesters.get(row.user_id) ??
              "Unavailable person";
            return (
              <article
                key={row.id}
                aria-label={`Request from ${name}`}
                className="flex flex-col gap-3 border-b pb-4"
              >
                <h3 className="text-sm font-semibold">
                  {name} · #
                  {
                    channels.find((room) => room.id === row.conversation_id)
                      ?.name
                  }
                </h3>
                <p className="text-sm">{row.status}</p>
                {row.status === "pending" && (
                  <div className="flex gap-2">
                    <Button
                      disabled={isPending()}
                      onClick={() => void decide(row, "accept")}
                    >
                      Approve
                    </Button>
                    <Button
                      variant="outline"
                      disabled={isPending()}
                      onClick={() => void decide(row, "decline")}
                    >
                      Decline
                    </Button>
                  </div>
                )}
              </article>
            );
          })}
        {resource.data &&
          !resource.data.some((row) => row.kind === "request") && (
            <p>No join requests.</p>
          )}
        <ToolAdvanced tool="admissions">
          <Choice
            label="Invitation channel"
            value={channelId}
            onChange={(event) => setChannelId(event.target.value)}
          >
            <NativeSelectOption value="">
              Select a private channel
            </NativeSelectOption>
            {managed.map((room) => (
              <NativeSelectOption key={room.id} value={room.id}>
                #{room.name}
              </NativeSelectOption>
            ))}
          </Choice>
          <Choice
            label="Invite person"
            value={personId}
            onChange={(event) => setPersonId(event.target.value)}
          >
            <NativeSelectOption value="">Select a person</NativeSelectOption>
            {people.map((person) => (
              <NativeSelectOption key={person.id} value={person.id}>
                {person.name}
              </NativeSelectOption>
            ))}
          </Choice>
          <Button
            disabled={isPending() || !channelId || !personId}
            onClick={() => void invite()}
          >
            Invite person
          </Button>
        </ToolAdvanced>
      </FieldGroup>
    </ConfigurationFrame>
  );
}
