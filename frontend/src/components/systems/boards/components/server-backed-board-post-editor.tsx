"use client";

import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { AdvancedSection } from "@/components/ui/advanced-section";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DialogFrameFooter,
  DialogFrameHeader,
  dialogFrameContentClass,
} from "@/components/ui/dialog-frame";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { BoardPost } from "../adapters/board-posts-api";
import type { BoardAttachmentVersions } from "../adapters/board-files-api";
import { HydratedBoardAttachments } from "./server-backed-board-attachments";
import { HydratedBoardRecordLinks } from "./hydrated-board-record-links";
import {
  useServerBoardPostEditor,
  validPostLinks,
} from "../hooks/use-server-board-post-editor";
import type { PostEditorForm } from "../hooks/post-editor-state";
import { ConfirmAction } from "./ui";
export type { PostEditorForm };

export type PostEditorView = {
  status: "loading" | "ready" | "error" | "denied";
  active: boolean;
  canEdit: boolean;
  canManage: boolean;
  selected: BoardPost | null;
  form: PostEditorForm | null;
  dirty: boolean;
  scheduleDirty: boolean;
  scheduleLocal: string;
  deviceTimeZone: string;
  scheduleError: string | null;
  expiryError: string | null;
  conflict: boolean;
  pending: boolean;
  error: string | null;
  notice: string | null;
};

export type PostEditor = ReturnType<typeof useServerBoardPostEditor>;
export type PostEditorStep = "save" | "publish" | "schedule";

const control = "min-h-11 xl:min-h-8";

function scheduledLabel(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

/** Why Publish cannot act yet, or null when it can. */
export function publishBlockedReason(view: PostEditorView): string | null {
  const form = view.form;
  if (view.conflict) return "Review the latest version first.";
  if (!form || !form.title.trim() || !form.body.trim())
    return "Add a title and a message.";
  if (form.title.trim().length > 100 || form.body.trim().length > 2000)
    return "Shorten the title or the message.";
  if (!validPostLinks(form.links)) return "Fix the link labels and URLs.";
  return null;
}

/**
 * The post editor's body and footer (BR13), inside the shared dialog frame:
 * Title, Message, Files, Links and Linked records, then a closed Advanced
 * block (Pin to top, Expires on). The footer keeps the save state, the one
 * consequence line, a quiet Save draft, Schedule…, and Publish.
 */
export function ServerBoardPostEditorDisplay({
  boardId,
  view,
  audience,
  scheduleOpen,
  running = null,
  onToggleSchedule,
  onChange,
  onSave,
  onPublish,
  onSchedule,
  onCancelSchedule,
  onScheduleTimeChange,
  onRetry,
  onAttachmentBusyChange,
  onRecordLinkBusyChange,
  refreshAttachmentVersions,
}: {
  boardId: string;
  view: PostEditorView;
  /** "Everyone who reads Sales sees this post." */
  audience: string;
  scheduleOpen: boolean;
  /** The step under way, whose button shows its pending label. */
  running?: PostEditorStep | null;
  onToggleSchedule: () => void;
  onChange: (form: PostEditorForm) => void;
  onSave: () => void;
  onPublish: () => void;
  onSchedule: () => void;
  onCancelSchedule: () => void;
  onScheduleTimeChange: (value: string) => void;
  onRetry: () => void;
  onAttachmentBusyChange: (busy: boolean) => void;
  onRecordLinkBusyChange: (busy: boolean) => void;
  refreshAttachmentVersions: () => Promise<BoardAttachmentVersions>;
}) {
  if (!view.active || view.status === "denied")
    return (
      <p className="text-muted-foreground text-sm">
        {!view.active
          ? "Archived boards are read-only."
          : "You can no longer edit posts on this board."}
      </p>
    );
  if (!view.canEdit || !view.form) {
    if (view.status === "error")
      return (
        <Alert
          variant="destructive"
          className="flex flex-wrap items-center gap-3"
        >
          <span>{view.error ?? "Posts could not be loaded."}</span>
          <Button
            type="button"
            variant="outline"
            className={control}
            onClick={onRetry}
          >
            Retry
          </Button>
        </Alert>
      );
    return (
      <p role="status" className="text-muted-foreground text-sm">
        Opening the post…
      </p>
    );
  }
  const form = view.form;
  const selected = view.selected;
  const locked = view.pending || view.conflict;
  // Files and record links belong to a saved draft; a published post is
  // saved as a draft first, as today.
  const draftTarget =
    selected &&
    selected.postRevision !== null &&
    selected.status !== "published"
      ? selected
      : null;
  const versions = draftTarget
    ? {
        boardRevision: draftTarget.boardRevision,
        contentRevision: draftTarget.postRevision as number,
      }
    : null;
  const blocked = publishBlockedReason(view);
  // An unchanged draft has nothing to save; a published post saves as a
  // draft even unchanged.
  const saveBlocked =
    blocked ??
    (selected !== null && !view.dirty && selected.status !== "published"
      ? "No changes to save."
      : null);
  const advancedSet = (form.pinned ? 1 : 0) + (form.expiresLocal ? 1 : 0);
  const saveState = view.pending
    ? null
    : view.dirty
      ? "Unsaved changes"
      : selected?.status === "scheduled" && selected.publishAt
        ? `Publishes ${scheduledLabel(selected.publishAt)}`
        : selected?.status === "draft"
          ? "Draft saved"
          : null;

  return (
    <form
      className="flex min-h-0 flex-col gap-4"
      noValidate
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        onPublish();
      }}
    >
      {view.conflict ? (
        <Alert role="alert" variant="destructive">
          <span className="block font-medium">
            Someone changed this post first.
          </span>
          Your text is kept. Copy it, then close and edit the latest version.
        </Alert>
      ) : view.error ? (
        <Alert role="alert" variant="destructive">
          {view.error}
        </Alert>
      ) : null}
      <Field className="gap-1.5">
        <FieldLabel htmlFor="board-post-title">Title</FieldLabel>
        <Input
          id="board-post-title"
          required
          maxLength={100}
          value={form.title}
          disabled={view.pending}
          onChange={(event) =>
            onChange({ ...form, title: event.currentTarget.value })
          }
        />
      </Field>
      <Field className="gap-1.5">
        <FieldLabel htmlFor="board-post-body">Message</FieldLabel>
        <Textarea
          id="board-post-body"
          required
          maxLength={2000}
          rows={7}
          value={form.body}
          disabled={view.pending}
          data-long-text=""
          className="min-h-32"
          onChange={(event) =>
            onChange({ ...form, body: event.currentTarget.value })
          }
        />
      </Field>
      <section aria-label="Files" className="flex min-w-0 flex-col gap-2">
        <p data-slot="field-label" className="text-xs font-medium">
          Files
        </p>
        {draftTarget && versions ? (
          <HydratedBoardAttachments
            key={`draft-attachments:${draftTarget.id}`}
            access="edit"
            target={{
              kind: "post",
              boardId,
              contentId: draftTarget.id,
              view: "draft",
            }}
            versions={versions}
            refreshVersions={refreshAttachmentVersions}
            onBusyChange={onAttachmentBusyChange}
            locked={locked}
          />
        ) : (
          <DisabledReason reason={view.pending ? null : blocked}>
            <Button
              type="button"
              variant="outline"
              className={cn(control, "self-start")}
              disabled={view.pending}
              onClick={onSave}
            >
              Save draft to attach
            </Button>
          </DisabledReason>
        )}
      </section>
      <section aria-label="Links" className="flex min-w-0 flex-col gap-2">
        <p data-slot="field-label" className="text-xs font-medium">
          Links
        </p>
        {form.links.map((link, index) => (
          <div
            key={index}
            className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] sm:items-end"
          >
            <Field className="gap-1.5">
              <FieldLabel htmlFor={`board-post-link-${index}-label`}>
                {`Link ${index + 1} label`}
              </FieldLabel>
              <Input
                id={`board-post-link-${index}-label`}
                value={link.label}
                maxLength={100}
                disabled={view.pending}
                onChange={(event) =>
                  onChange({
                    ...form,
                    links: form.links.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, label: event.currentTarget.value }
                        : item,
                    ),
                  })
                }
              />
            </Field>
            <Field className="gap-1.5">
              <FieldLabel htmlFor={`board-post-link-${index}-url`}>
                {`Link ${index + 1} URL`}
              </FieldLabel>
              <Input
                id={`board-post-link-${index}-url`}
                type="url"
                value={link.url}
                maxLength={2048}
                disabled={view.pending}
                onChange={(event) =>
                  onChange({
                    ...form,
                    links: form.links.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, url: event.currentTarget.value }
                        : item,
                    ),
                  })
                }
              />
            </Field>
            <Button
              type="button"
              variant="ghost"
              className={control}
              aria-label={`Remove link ${index + 1}`}
              disabled={view.pending}
              onClick={() =>
                onChange({
                  ...form,
                  links: form.links.filter(
                    (_, itemIndex) => itemIndex !== index,
                  ),
                })
              }
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          className={cn(control, "self-start")}
          disabled={view.pending || form.links.length >= 20}
          onClick={() =>
            onChange({
              ...form,
              links: [...form.links, { label: "", url: "" }],
            })
          }
        >
          <Plus aria-hidden="true" />
          Add link
        </Button>
      </section>
      <section
        aria-label="Linked records"
        className="flex min-w-0 flex-col gap-2"
      >
        <p data-slot="field-label" className="text-xs font-medium">
          Linked records
        </p>
        {draftTarget && versions ? (
          <HydratedBoardRecordLinks
            key={`draft-record-links:${draftTarget.id}`}
            access="edit"
            target={{
              kind: "post",
              boardId,
              contentId: draftTarget.id,
              view: "draft",
            }}
            versions={versions}
            refreshVersions={refreshAttachmentVersions}
            onBusyChange={onRecordLinkBusyChange}
            locked={locked}
          />
        ) : (
          <DisabledReason reason={view.pending ? null : blocked}>
            <Button
              type="button"
              variant="outline"
              className={cn(control, "self-start")}
              disabled={view.pending}
              onClick={onSave}
            >
              Save draft to link
            </Button>
          </DisabledReason>
        )}
      </section>
      <AdvancedSection
        storageKey="boards-post-editor"
        setCount={advancedSet}
        forceOpen={view.expiryError !== null}
      >
        <div className="flex min-w-0 flex-col gap-3">
          <DisabledReason
            reason={view.canManage ? null : "Only board managers pin posts."}
          >
            <label
              htmlFor="board-post-pinned"
              className="flex min-h-11 items-center gap-3 text-sm font-medium xl:min-h-8"
            >
              <Checkbox
                id="board-post-pinned"
                checked={form.pinned}
                disabled={locked || !view.canManage}
                onCheckedChange={(checked: boolean) =>
                  onChange({ ...form, pinned: checked })
                }
              />
              Pin to top
            </label>
          </DisabledReason>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="board-post-expires-on">Expires on</FieldLabel>
            <Input
              id="board-post-expires-on"
              type="datetime-local"
              step="1"
              value={form.expiresLocal}
              disabled={locked}
              aria-invalid={view.expiryError ? "true" : undefined}
              aria-describedby={
                view.expiryError ? "board-post-expiry-error" : undefined
              }
              onChange={(event) =>
                onChange({ ...form, expiresLocal: event.currentTarget.value })
              }
            />
            {view.expiryError ? (
              <p
                id="board-post-expiry-error"
                role="alert"
                className="text-danger-text text-sm"
              >
                {view.expiryError}
              </p>
            ) : null}
          </Field>
        </div>
      </AdvancedSection>
      <DialogFrameFooter>
        {scheduleOpen ? (
          <div
            id="board-post-schedule-row"
            className="flex min-w-0 flex-wrap items-end gap-2"
          >
            <Field className="min-w-0 flex-1 gap-1.5">
              <FieldLabel htmlFor="board-post-scheduled-for">
                Publish at
              </FieldLabel>
              <div className="flex min-w-0 items-center gap-2">
                <Input
                  id="board-post-scheduled-for"
                  type="datetime-local"
                  step="1"
                  value={view.scheduleLocal}
                  disabled={locked}
                  aria-invalid={view.scheduleError ? "true" : undefined}
                  aria-describedby={
                    view.scheduleError
                      ? "board-post-schedule-zone board-post-schedule-error"
                      : "board-post-schedule-zone"
                  }
                  onChange={(event) =>
                    onScheduleTimeChange(event.currentTarget.value)
                  }
                />
                <span
                  id="board-post-schedule-zone"
                  className="text-muted-foreground shrink-0 text-xs"
                >
                  {view.deviceTimeZone}
                </span>
              </div>
            </Field>
            <Button
              type="button"
              variant="outline"
              className={control}
              disabled={locked || !view.scheduleLocal || blocked !== null}
              onClick={onSchedule}
            >
              {running === "schedule"
                ? "Scheduling…"
                : selected?.status === "scheduled"
                  ? "Reschedule"
                  : "Schedule"}
            </Button>
            {view.scheduleError ? (
              <p
                id="board-post-schedule-error"
                role="alert"
                className="text-danger-text w-full text-sm"
              >
                {view.scheduleError}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span role="status" className="inline-flex shrink-0">
            {saveState ? (
              <Badge variant="outline" className="shrink-0">
                {saveState}
              </Badge>
            ) : null}
          </span>
          {selected?.status === "scheduled" ? (
            <DisabledReason
              reason={
                view.dirty || view.scheduleDirty
                  ? "Save or discard your changes first."
                  : null
              }
            >
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 px-2 xl:min-h-7"
                disabled={locked}
                onClick={onCancelSchedule}
              >
                Cancel schedule
              </Button>
            </DisabledReason>
          ) : null}
          <span className="text-muted-foreground min-w-0">{audience}</span>
          <span role="status" className="text-muted-foreground min-w-0">
            {view.pending ? "" : (view.notice ?? "")}
          </span>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <DisabledReason reason={view.pending ? null : saveBlocked} stable>
            <Button
              type="button"
              variant="outline"
              className={control}
              disabled={view.pending}
              onClick={onSave}
            >
              {running === "save" ? "Saving…" : "Save draft"}
            </Button>
          </DisabledReason>
          <Button
            type="button"
            variant="outline"
            className={control}
            aria-expanded={scheduleOpen}
            aria-controls={scheduleOpen ? "board-post-schedule-row" : undefined}
            disabled={view.pending}
            onClick={onToggleSchedule}
          >
            Schedule…
          </Button>
          <DisabledReason reason={view.pending ? null : blocked} stable>
            <Button type="submit" className={control} disabled={view.pending}>
              {running === "publish" ? "Publishing…" : "Publish"}
            </Button>
          </DisabledReason>
        </div>
      </DialogFrameFooter>
    </form>
  );
}

/**
 * New post and Edit open this dialog (BR13). It asks before discarding
 * changes; it stays open after Save draft and Schedule, and closes after
 * Publish.
 */
export function BoardPostEditorDialog({
  boardId,
  editor,
  open,
  mode,
  audience,
  onClose,
  onPublished,
}: {
  boardId: string;
  editor: PostEditor;
  open: boolean;
  /** How it was opened: New post keeps its title after a first save. */
  mode: "new" | "edit";
  audience: string;
  onClose: () => void;
  onPublished: (postId: string) => void;
}) {
  const [discardOpen, setDiscardOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  // Which button's step is under way, for its pending label.
  const [running, setRunning] = useState<PostEditorStep | null>(null);
  const run = (step: PostEditorStep, work: () => Promise<unknown>) => {
    setRunning(step);
    void work().finally(() => setRunning(null));
  };
  const view = editor.view;
  const changed = view.dirty || view.scheduleDirty;

  function close() {
    editor.close();
    setDiscardOpen(false);
    setScheduleOpen(false);
    onClose();
  }

  function requestClose() {
    if (view.pending) return;
    if (changed && view.canEdit) setDiscardOpen(true);
    else close();
  }

  return (
    <>
      <Dialog
        open={open}
        dismissible={!view.pending}
        onOpenChange={(next) => {
          if (!next) requestClose();
        }}
      >
        <DialogContent className={cn(dialogFrameContentClass, "max-w-2xl")}>
          <DialogFrameHeader
            title={
              <DialogTitle>
                {mode === "new" ? "New post" : "Edit post"}
              </DialogTitle>
            }
            closeLabel="Close post editor"
            closeDisabled={view.pending}
            onClose={requestClose}
          />
          {open ? (
            <ServerBoardPostEditorDisplay
              boardId={boardId}
              view={view}
              audience={audience}
              scheduleOpen={
                scheduleOpen || view.selected?.status === "scheduled"
              }
              onToggleSchedule={() => setScheduleOpen((value) => !value)}
              onChange={editor.changeForm}
              running={view.pending ? running : null}
              onSave={() => run("save", editor.save)}
              onPublish={() =>
                run("publish", async () => {
                  const postId = await editor.publish();
                  if (postId === null) return;
                  setScheduleOpen(false);
                  onPublished(postId);
                })
              }
              onSchedule={() => run("schedule", editor.schedule)}
              onCancelSchedule={() => {
                setScheduleOpen(false);
                void editor.cancelSchedule();
              }}
              onScheduleTimeChange={editor.changeScheduleTime}
              onRetry={editor.retry}
              onAttachmentBusyChange={editor.setAttachmentPending}
              onRecordLinkBusyChange={editor.setRecordLinkPending}
              refreshAttachmentVersions={editor.refreshAttachmentVersions}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <ConfirmAction
        open={discardOpen}
        title="Discard unsaved post changes?"
        description="Your changes to this post will be lost."
        action="Discard changes"
        disabled={view.pending}
        onCancel={() => setDiscardOpen(false)}
        onConfirm={close}
      />
    </>
  );
}
