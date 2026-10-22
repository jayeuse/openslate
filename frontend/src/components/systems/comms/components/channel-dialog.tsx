"use client";
import { NativeSelectOption } from "@/components/ui/native-select";

import { useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Alert } from "@/components/ui/alert";
import { Textarea } from "@/components/ui/textarea";
import type { Person, Role } from "../../shared/data/sample-people";
import { CommsSettingsDialog } from "./settings-dialog";
import {
  CategoryDepartmentChoice,
  ChannelScopeChoice,
  ChannelScopeSummary,
  categoryNote as noteForCategory,
  compatibleCategories,
  creationCategories,
  useCategoryDepartments,
  useChannelDepartments,
  withDefaultDepartment,
} from "./channel-scope";
import { Action, Choice } from "../../shared/components/ui";
import { TextField } from "./ui";
import type { Category, Channel } from "../domain/view-model";
import { useCommsClient } from "../state/client-context";
import type {
  Bootstrap,
  ChannelPatch,
  Conversation,
  ConversationSummary,
} from "../contract/types";
import { useQueryClient } from "@tanstack/react-query";
import { querySettled } from "../adapters/comms-queries";

/** A just-created conversation's summary: nothing read, nothing unread. */
function newConversationSummary(
  conversation: Conversation,
): ConversationSummary {
  return {
    conversation,
    preferences: {
      notify: "all",
      mute: { kind: "off" },
      starred: false,
      hidden: false,
      manual_unread: false,
    },
    last_read_seq: 0,
    high_water_seq: 0,
    unread_count: 0,
    mention_count: 0,
    first_unread_seq: null,
  };
}
import type { CommsScope } from "../domain/configuration-model";

type EditorProps = {
  opener: HTMLElement;
  roles: Role[];
  people?: Person[];
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
  const { client, catalog, scope: queryScope } = useCommsClient();
  const cache = useQueryClient();
  const [draft, setDraft] = useState(() => ({
    ...props.value,
    id: props.value.id || crypto.randomUUID(),
  }));
  const [initialDraft] = useState(draft);
  const [beforeId, setBeforeId] = useState("unchanged");
  const [error, setError] = useState("");
  const [departmentError, setDepartmentError] = useState("");
  const [categoryNote, setCategoryNote] = useState("");
  const [categoryError, setCategoryError] = useState("");
  const categoryErrorId = useId();
  const nameId = useId();
  const nameErrorId = useId();
  const departmentErrorId = useId();
  const categoryNoteId = useId();
  const departments = useChannelDepartments();
  const categoryDepartments = useCategoryDepartments();
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
  const confirmedCategoryName = useRef(props.value.name);
  const people = props.people;
  const creating = !props.value.id;
  // The derived channel is what the dialog shows and saves. A department the
  // viewer cannot create in (a category's department they do not manage) is
  // cleared once the offered departments are known, and a new department
  // channel with one possible department starts in it.
  const drafted = "categoryId" in draft ? draft : undefined;
  const offered =
    drafted &&
    creating &&
    departments.status === "ready" &&
    drafted.departmentId &&
    !departments.options.some((item) => item.id === drafted.departmentId)
      ? { ...drafted, departmentId: "" }
      : drafted;
  const scoped =
    offered && creating
      ? withDefaultDepartment(offered, departments.options, departments.admin)
      : offered;
  // A new channel goes only where it may be created (D44 A7/A8); a saved
  // channel keeps showing its current category even if it no longer fits.
  const choices = !scoped
    ? { categories: [], noCategory: true }
    : creating
      ? creationCategories(scoped, props.categories, departments.placement)
      : {
          categories: props.categories.filter(
            (item) =>
              item.id === scoped.categoryId ||
              compatibleCategories(scoped, props.categories).includes(item),
          ),
          noCategory: true,
        };
  const fitted =
    scoped &&
    creating &&
    scoped.categoryId &&
    !choices.categories.some((item) => item.id === scoped.categoryId)
      ? { ...scoped, categoryId: "" }
      : scoped;
  const channel =
    fitted &&
    creating &&
    !fitted.categoryId &&
    !choices.noCategory &&
    choices.categories.length === 1
      ? { ...fitted, categoryId: choices.categories[0].id }
      : fitted;
  // Opened from a category that cannot hold the new channel: say why it reset.
  const resetFrom =
    creating &&
    drafted?.categoryId &&
    channel?.categoryId !== drafted.categoryId
      ? props.categories.find((item) => item.id === drafted.categoryId)
      : undefined;
  const shownCategoryNote =
    categoryNote ||
    (resetFrom && channel
      ? noteForCategory(resetFrom, channel, catalog.departments)
      : "");
  // A new category of a member who manages one department starts in it.
  const category =
    !("categoryId" in draft) &&
    creating &&
    !draft.departmentId &&
    !categoryDepartments.admin &&
    categoryDepartments.options.length === 1
      ? { ...draft, departmentId: categoryDepartments.options[0].id }
      : draft;
  const channels = channel
    ? [...props.channels.filter((item) => item.id !== channel.id), channel]
    : props.channels;
  const categories = channel
    ? props.categories
    : [...props.categories.filter((item) => item.id !== draft.id), category];
  function saveMetadata() {
    const name = draft.name.trim();
    if (!name) {
      setError("Enter a name.");
      return false;
    }
    // A category may have no department; it then holds organization channels.
    if (channel?.scope === "department" && !channel.departmentId) {
      setDepartmentError("Choose a department.");
      return false;
    }
    if (channel && creating && !choices.noCategory && !channel.categoryId) {
      setCategoryError("Choose a category.");
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
    const saved = channel ? { ...channel, name } : { ...category, name };
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
    if (pending.kind === "channel" && "categoryId" in value) {
      const details = {
        name: value.name,
        topic: value.description,
        category_id: value.categoryId || null,
      };
      if (!savedId.current) {
        // The scope is fixed at creation; the API adds the creator's row.
        const created = await client.createChannel({
          ...details,
          ...(value.scope === "department"
            ? {
                scope: "department" as const,
                department_id: value.departmentId,
              }
            : { scope: "organization" as const }),
          position: props.channels.length,
        });
        savedId.current = created.data.id;
        // The new channel opens from this response; the follow-up bootstrap
        // read replaces the seeded row.
        if (queryScope) {
          // A bootstrap read in flight settles first (its other waiters keep
          // their result), so it cannot overwrite the seed afterwards.
          await querySettled(cache, queryScope.keys.bootstrap);
          cache.setQueryData<Bootstrap>(queryScope.keys.bootstrap, (current) =>
            current &&
            !current.conversations.some(
              (row) => row.conversation.id === created.data.id,
            )
              ? {
                  ...current,
                  conversations: [
                    ...current.conversations,
                    newConversationSummary(created.data),
                  ],
                }
              : current,
          );
        }
        confirmedDetails.current = JSON.stringify(details);
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
          !current || value.name !== confirmedCategoryName.current
            ? value.name
            : current.data.name,
        position: current?.data.position ?? props.categories.length,
        // The department is chosen once, when the category is created.
        department_id: current
          ? current.data.department_id
          : value.departmentId || null,
      };
      if (!current) {
        savedId.current = (await client.createCategory(details)).data.id;
        confirmedCategoryName.current = value.name;
        accepted(scope());
      } else if (confirmedCategoryName.current !== value.name) {
        await client.updateCategory(savedId.current, details, {
          if_match: current.etag,
        });
        confirmedCategoryName.current = value.name;
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
      unsavedChannel={creating}
      advancedMetadataCount={
        Number(beforeId !== "unchanged") +
        Number(
          !!channel &&
            !creating &&
            channel.archived !==
              ("archived" in props.value && props.value.archived),
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
          {!channel && creating && (
            <CategoryDepartmentChoice
              category={category}
              error={departmentError}
              errorId={departmentErrorId}
              onChange={(departmentId) => {
                setDepartmentError("");
                setDraft({ ...category, departmentId });
              }}
            />
          )}
          {channel && (
            <>
              {creating ? (
                <ChannelScopeChoice
                  channel={channel}
                  categories={props.categories}
                  departmentError={departmentError}
                  departmentErrorId={departmentErrorId}
                  onChange={(next, note) => {
                    setDepartmentError("");
                    setCategoryError("");
                    setCategoryNote(note);
                    if (next.categoryId !== channel.categoryId)
                      setBeforeId("unchanged");
                    setDraft(next);
                  }}
                />
              ) : (
                <ChannelScopeSummary channel={channel} />
              )}
              <Choice
                label="Category"
                value={channel.categoryId}
                aria-invalid={!!categoryError}
                aria-describedby={
                  [
                    shownCategoryNote ? categoryNoteId : "",
                    categoryError ? categoryErrorId : "",
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
                onChange={(event) => {
                  setCategoryNote("");
                  setCategoryError("");
                  setDraft({ ...channel, categoryId: event.target.value });
                  setBeforeId("unchanged");
                }}
              >
                {choices.noCategory ? (
                  <NativeSelectOption value="">No category</NativeSelectOption>
                ) : (
                  !channel.categoryId && (
                    <NativeSelectOption value="">
                      Choose a category
                    </NativeSelectOption>
                  )
                )}
                {choices.categories.map((item) => (
                  <NativeSelectOption key={item.id} value={item.id}>
                    {item.name}
                  </NativeSelectOption>
                ))}
              </Choice>
              {categoryError && (
                <p
                  id={categoryErrorId}
                  role="alert"
                  className="text-destructive -mt-3 text-sm"
                >
                  {categoryError}
                </p>
              )}
              {/* Always present, so a later note is announced politely. */}
              <p
                id={categoryNoteId}
                role="status"
                className={cn(
                  "text-muted-foreground -mt-3 text-sm",
                  !shownCategoryNote && "sr-only",
                )}
              >
                {shownCategoryNote}
              </p>
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
            </>
          )}
        </FieldGroup>
      }
    />
  );
}
