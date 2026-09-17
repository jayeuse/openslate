"use client";
import { NativeSelectOption } from "@/components/ui/native-select";

import { useRef, useState } from "react";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Alert } from "@/components/ui/alert";
import { Textarea } from "@/components/ui/textarea";
import { initialPeople, type Person, type Role } from "../access/model";
import { useSampleState, type SampleTransactionDraft } from "../sample-state";
import { CommsSettingsDialog } from "./settings-dialog";
import { Action, Choice } from "../ui";
import { TextField } from "./ui";
import { OPEN_PERMISSIONS, type Category, type Channel } from "./model";

type EditorProps = {
  opener: HTMLElement;
  roles: Role[];
  categories: Category[];
  onClose: () => void;
  onAcceptedChannelSave?: (id: string) => void;
  channels: Channel[];
} & (
  | {
      kind: "channel";
      value: Channel;
      existing: { id: string; name: string }[];
      onSave: (
        value: Channel,
        beforeId: string,
        draft?: SampleTransactionDraft,
      ) => void;
    }
  | {
      kind: "category";
      value: Category;
      existing: { id: string; name: string }[];
      onSave: (
        value: Category,
        beforeId: string,
        draft?: SampleTransactionDraft,
      ) => void;
    }
);

export function ChannelDialog(props: EditorProps) {
  const [draft, setDraft] = useState(() => ({
    ...props.value,
    id: props.value.id || `sample-${props.kind}-${crypto.randomUUID()}`,
  }));
  const [initialDraft] = useState(draft);
  const [beforeId, setBeforeId] = useState("unchanged");
  const [error, setError] = useState("");
  const pendingSave = useRef<
    | { kind: "channel"; value: Channel; beforeId: string }
    | { kind: "category"; value: Category; beforeId: string }
    | null
  >(null);
  const acceptedChannelId = useRef<string | null>(null);
  const [people] = useSampleState<Person[]>("access-people", initialPeople);
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
          item.id !== draft.id &&
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
  function stageMetadata(draftState: SampleTransactionDraft) {
    const pending = pendingSave.current;
    pendingSave.current = null;
    if (!pending) return;
    if (pending.kind === "channel" && props.kind === "channel") {
      props.onSave(pending.value, pending.beforeId, draftState);
      acceptedChannelId.current = pending.value.id;
    } else if (pending.kind === "category" && props.kind === "category")
      props.onSave(pending.value, pending.beforeId, draftState);
  }
  return (
    <CommsSettingsDialog
      scope={{ kind: props.kind, id: draft.id }}
      title={`${creating ? "Create" : "Edit"} ${props.kind}`}
      channels={channels}
      categories={categories}
      people={people}
      roles={props.roles}
      opener={props.opener}
      onClose={props.onClose}
      onBeforeSave={saveMetadata}
      onBeforeSaveTransaction={stageMetadata}
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
      overview={
        <FieldGroup>
          {error && (
            <Alert role="alert" variant="destructive">
              {error}
            </Alert>
          )}
          <TextField
            label={channel ? "Channel name" : "Category name"}
            autoFocus
            value={draft.name}
            required
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
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
          {channel && !creating && (
            <div className="flex flex-col items-start gap-2">
              <Action
                type="button"
                onClick={() =>
                  setDraft({ ...channel, archived: !channel.archived })
                }
              >
                {channel.archived ? "Restore channel" : "Archive channel"}
              </Action>
              <p className="text-muted-foreground text-xs">
                {channel.archived
                  ? "This channel will be archived when you save. Messages stay available."
                  : "Archiving keeps messages and pauses posting."}
              </p>
            </div>
          )}
        </FieldGroup>
      }
    />
  );
}

export function newChannel(categoryId: string): Channel {
  return {
    id: "",
    name: "",
    description: "",
    categoryId,
    inherit: true,
    archived: false,
    system: true,
    ...OPEN_PERMISSIONS,
  };
}
