"use client";
import { NativeSelectOption } from "@/components/ui/native-select";

import { useId, useRef, useState } from "react";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Alert } from "@/components/ui/alert";
import { Textarea } from "@/components/ui/textarea";
import type { Person, Role } from "../../shared/data/sample-people";
import { CommsSettingsDialog } from "./settings-dialog";
import { GroupAccessField } from "./group-access-field";
import { GroupAccessSummary } from "./group-access-summary";
import { Action, Choice } from "../../shared/components/ui";
import { TextField } from "./ui";
import type { Category, Channel } from "../domain/view-model";
import { useCommsClient } from "../state/client-context";
import type { GroupAccess, ChannelPatch } from "../contract/types";
import type { CommsScope } from "../domain/configuration-model";

type EditorProps = {
  opener: HTMLElement;
  roles: Role[];
  people: Person[];
  categories: Category[];
  onClose: () => void;
  onAcceptedChannelSave?: (id: string) => void;
  channels: Channel[];
} & (
  | {
      kind: "channel";
      value: Channel;
      existing: { id: string; name: string }[];
    }
  | {
      kind: "category";
      value: Category;
      existing: { id: string; name: string }[];
    }
);

export function ChannelDialog(props: EditorProps) {
  const { client } = useCommsClient();
  const [draft, setDraft] = useState(() => ({
    ...props.value,
    id: props.value.id || crypto.randomUUID(),
  }));
  const [initialDraft] = useState(draft);
  const [beforeId, setBeforeId] = useState("unchanged");
  const [error, setError] = useState("");
  const nameId = useId();
  const nameErrorId = useId();
  const pendingSave = useRef<
    | { kind: "channel"; value: Channel; beforeId: string }
    | { kind: "category"; value: Category; beforeId: string }
    | null
  >(null);
  const acceptedChannelId = useRef<string | null>(null);
  const savedId = useRef(props.value.id);
  const confirmedDetails = useRef(
    "categoryId" in props.value
      ? JSON.stringify({
          name: props.value.name,
          topic: props.value.description,
          category_id: props.value.categoryId || null,
        })
      : "",
  );
  const confirmedCategory = useRef({
    name: props.value.name,
    groupId: "groupId" in props.value ? props.value.groupId : undefined,
    groupAccess: props.value.groupAccess,
  });
  const confirmedAccess = useRef(
    "groupAccess" in props.value ? JSON.stringify(props.value.groupAccess) : "",
  );
  const people = props.people;
  const creating = !props.value.id;
  const channel = "categoryId" in draft ? draft : undefined;
  const channels = channel
    ? [...props.channels.filter((item) => item.id !== channel.id), channel]
    : props.channels;
  const categories = channel
    ? props.categories
    : [...props.categories.filter((item) => item.id !== draft.id), draft];
  function saveMetadata() {
    const name = draft.name.trim();
    if (!name) {
      setError("Enter a name.");
      return false;
    }
    if (
      props.existing.some(
        (item) =>
          item.id !== (savedId.current || draft.id) &&
          item.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      setError("This name is already in use.");
      return false;
    }
    const saved = { ...draft, name };
    if (props.kind === "channel" && "categoryId" in saved)
      pendingSave.current = { kind: "channel", value: saved, beforeId };
    else if (props.kind === "category" && !("categoryId" in saved))
      pendingSave.current = { kind: "category", value: saved, beforeId };
    else {
      setError("The editor draft is invalid.");
      return false;
    }
    return true;
  }
  async function stageMetadata(
    accepted: (scope: CommsScope) => void,
  ): Promise<CommsScope> {
    if (!client) throw new Error("Organization is not admitted");
    const pending = pendingSave.current;
    pendingSave.current = null;
    if (!pending) throw new Error("No editor changes prepared");
    const value = pending.value;
    const scope = () => ({ kind: pending.kind, id: savedId.current });
    const access = (rows: Record<string, string>): GroupAccess[] =>
      Object.entries(rows).flatMap(([group_id, level]) =>
        level === "read" || level === "post"
          ? [
              group_id === "everyone"
                ? { subject: "everyone" as const, level }
                : { subject: "group" as const, group_id, level },
            ]
          : [],
      );
    if (pending.kind === "channel" && "categoryId" in value) {
      const details = {
        name: value.name,
        topic: value.description,
        category_id: value.categoryId || null,
      };
      if (!savedId.current) {
        const defaults = value.categoryId
          ? (await client.getCategory(value.categoryId)).data.default_access
          : [{ subject: "everyone" as const, level: "post" as const }];
        const created = await client.createChannel({
          ...details,
          scope: "groups",
          access: value.groupAccess ? access(value.groupAccess) : defaults,
          position: props.channels.length,
        });
        savedId.current = created.data.id;
        confirmedDetails.current = JSON.stringify(details);
        confirmedAccess.current = JSON.stringify(value.groupAccess);
        accepted(scope());
      } else if (confirmedDetails.current !== JSON.stringify(details)) {
        const current = await client.getConversation(savedId.current);
        const previous: ChannelPatch = JSON.parse(confirmedDetails.current);
        const patch: ChannelPatch = {};
        if (previous.name !== details.name) patch.name = details.name;
        if (previous.topic !== details.topic) patch.topic = details.topic;
        if (previous.category_id !== details.category_id)
          patch.category_id = details.category_id;
        await client.updateChannel(savedId.current, patch, {
          if_match: current.etag,
        });
        confirmedDetails.current = JSON.stringify(details);
        accepted(scope());
      }
      if (
        value.groupAccess &&
        confirmedAccess.current !== JSON.stringify(value.groupAccess)
      ) {
        const current = await client.getConversation(savedId.current);
        await client.setChannelAccess(
          savedId.current,
          { access: access(value.groupAccess) },
          { if_match: current.etag },
        );
        confirmedAccess.current = JSON.stringify(value.groupAccess);
        accepted(scope());
      }
      const current = await client.getConversation(savedId.current);
      if ((current.data.archived_at !== null) !== value.archived) {
        await (
          value.archived
            ? client.archiveConversation
            : client.restoreConversation
        )(savedId.current, { if_match: current.etag });
        accepted(scope());
      }
      acceptedChannelId.current = savedId.current;
    } else if (pending.kind === "category" && !("categoryId" in value)) {
      const current = savedId.current
        ? await client.getCategory(savedId.current)
        : null;
      const details = {
        name:
          !current || value.name !== confirmedCategory.current.name
            ? value.name
            : current.data.name,
        position: current?.data.position ?? props.categories.length,
        department_id: current?.data.department_id ?? null,
        default_access:
          current &&
          JSON.stringify(value.groupAccess) ===
            JSON.stringify(confirmedCategory.current.groupAccess) &&
          value.groupId === confirmedCategory.current.groupId
            ? current.data.default_access
            : value.groupAccess
              ? access(value.groupAccess)
              : value.groupId
                ? [
                    {
                      subject: "group" as const,
                      group_id: value.groupId,
                      level: "post" as const,
                    },
                  ]
                : [{ subject: "everyone" as const, level: "post" as const }],
      };
      if (!current) {
        savedId.current = (await client.createCategory(details)).data.id;
        confirmedCategory.current = {
          name: value.name,
          groupId: value.groupId,
          groupAccess: value.groupAccess,
        };
        accepted(scope());
      } else if (
        confirmedCategory.current.name !== value.name ||
        confirmedCategory.current.groupId !== value.groupId ||
        JSON.stringify(confirmedCategory.current.groupAccess) !==
          JSON.stringify(value.groupAccess)
      ) {
        await client.updateCategory(savedId.current, details, {
          if_match: current.etag,
        });
        confirmedCategory.current = {
          name: value.name,
          groupId: value.groupId,
          groupAccess: value.groupAccess,
        };
        accepted(scope());
      }
    }
    if (pending.beforeId !== "unchanged") {
      const current = await client.bootstrap();
      const ordered: { id: string; position: number }[] =
        pending.kind === "category"
          ? current.categories.map((row) => row.category)
          : current.conversations.flatMap(({ conversation: row }) =>
              row.kind === "channel" &&
              "categoryId" in value &&
              row.category_id === (value.categoryId || null)
                ? [{ id: row.id, position: row.position }]
                : [],
            );
      const moving = ordered.find((row) => row.id === savedId.current);
      if (moving) {
        const remaining = ordered.filter((row) => row.id !== moving.id);
        const index = remaining.findIndex((row) => row.id === pending.beforeId);
        remaining.splice(index < 0 ? remaining.length : index, 0, moving);
        for (const [position, row] of remaining.entries()) {
          if (row.position === position) continue;
          if (pending.kind === "channel") {
            const latest = await client.getConversation(row.id);
            await client.updateChannel(
              row.id,
              { position },
              { if_match: latest.etag },
            );
          } else {
            const latest = await client.getCategory(row.id);
            await client.updateCategory(
              row.id,
              {
                name: latest.data.name,
                department_id: latest.data.department_id,
                default_access: latest.data.default_access,
                position,
              },
              { if_match: latest.etag },
            );
          }
          accepted(scope());
        }
      }
    }
    return scope();
  }
  return (
    <CommsSettingsDialog
      scope={{ kind: props.kind, id: draft.id }}
      title={
        creating
          ? `Create ${props.kind}`
          : `${props.kind === "channel" ? "Channel" : "Category"} settings`
      }
      channels={channels}
      categories={categories}
      people={people}
      roles={props.roles}
      opener={props.opener}
      onClose={props.onClose}
      onBeforeSave={saveMetadata}
      onSaveMetadata={stageMetadata}
      onAfterSave={() => {
        const id = acceptedChannelId.current;
        acceptedChannelId.current = null;
        if (id) props.onAcceptedChannelSave?.(id);
      }}
      additionalDirty={
        JSON.stringify(draft) !== JSON.stringify(initialDraft) ||
        beforeId !== "unchanged"
      }
      saveLabel={creating ? `Create ${props.kind}` : "Save changes"}
      advancedMetadataCount={
        Number(beforeId !== "unchanged") +
        Number(
          !!channel &&
            !creating &&
            channel.archived !==
              ("archived" in props.value && props.value.archived),
        )
      }
      access={
        channel && channel.scope !== "groups" && !creating ? (
          <GroupAccessSummary
            scope="channel"
            channel={channel}
            categories={props.categories}
          />
        ) : (
          <GroupAccessField
            subject={draft}
            categories={props.categories}
            people={people}
            onChange={(groupAccess) => setDraft({ ...draft, groupAccess })}
          />
        )
      }
      overviewAdvanced={
        <>
          <Choice
            label={channel ? "Channel order" : "Category order"}
            value={beforeId}
            onChange={(event) => setBeforeId(event.target.value)}
          >
            <NativeSelectOption value="unchanged">
              Keep current position
            </NativeSelectOption>
            {(channel
              ? props.channels.filter(
                  (item) => item.categoryId === channel.categoryId,
                )
              : props.categories
            )
              .filter((item) => item.id !== draft.id)
              .map((item) => (
                <NativeSelectOption key={item.id} value={item.id}>
                  Before {channel ? "#" : ""}
                  {item.name}
                </NativeSelectOption>
              ))}
            <NativeSelectOption value="">At the end</NativeSelectOption>
          </Choice>
          {channel && !creating ? (
            <div className="flex flex-col items-start gap-2 border-t pt-4">
              <Action
                type="button"
                onClick={() =>
                  setDraft({ ...channel, archived: !channel.archived })
                }
              >
                {channel.archived ? "Restore channel" : "Archive channel"}
              </Action>
              <p className="text-muted-foreground text-xs">
                {channel.archived ===
                ("archived" in props.value && props.value.archived)
                  ? channel.archived
                    ? "This channel is archived. Restoring it lets people post again."
                    : "Archiving keeps messages and pauses posting."
                  : channel.archived
                    ? "This channel will be archived when you save. Messages stay available."
                    : "This channel will be restored when you save."}
              </p>
            </div>
          ) : undefined}
        </>
      }
      overview={
        <FieldGroup>
          {error && (
            <Alert id={nameErrorId} role="alert" variant="destructive">
              {error}
            </Alert>
          )}
          <TextField
            id={nameId}
            aria-invalid={!!error}
            aria-describedby={error ? nameErrorId : undefined}
            label={channel ? "Channel name" : "Category name"}
            autoFocus
            value={draft.name}
            required
            onChange={(event) => {
              setError("");
              setDraft({ ...draft, name: event.target.value });
            }}
          />
          {channel && (
            <>
              <Field>
                <FieldLabel htmlFor="channel-topic">Channel topic</FieldLabel>
                <Textarea
                  id="channel-topic"
                  value={channel.description}
                  onChange={(event) =>
                    setDraft({ ...channel, description: event.target.value })
                  }
                  rows={3}
                  className="max-h-48 min-h-24 resize-y"
                />
              </Field>
              <Choice
                label="Category"
                value={channel.categoryId}
                onChange={(event) => {
                  setDraft({ ...channel, categoryId: event.target.value });
                  setBeforeId("unchanged");
                }}
              >
                {props.categories.map((item) => (
                  <NativeSelectOption key={item.id} value={item.id}>
                    {item.name}
                  </NativeSelectOption>
                ))}
              </Choice>
            </>
          )}
        </FieldGroup>
      }
    />
  );
}
