"use client";

import {
  createElement,
  useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { ChevronDown, FileText, Plus, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
  drafts: BoardPost[];
  offset: number;
  total: number;
  hasMore: boolean;
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
  displayed: BoardPost | null;
};

export function ServerBoardPostEditorDisplay({
  boardId,
  view,
  onNew,
  onSelect,
  onChange,
  onSave,
  onPublish,
  onSchedule,
  onCancelSchedule,
  onScheduleTimeChange,
  onRetry,
  onClose,
  onPage,
  onAttachmentBusyChange,
  onRecordLinkBusyChange,
  refreshAttachmentVersions,
  canArchiveSelected = false,
  onArchive,
  showNewButton = true,
}: {
  boardId: string;
  view: PostEditorView;
  onNew: () => void;
  onSelect: (draft: BoardPost) => void;
  onChange: (form: PostEditorForm) => void;
  onSave: () => void;
  onPublish: () => void;
  onSchedule: () => void;
  onCancelSchedule: () => void;
  onScheduleTimeChange: (value: string) => void;
  onRetry: () => void;
  onClose: () => void;
  onPage: (offset: number) => void;
  onAttachmentBusyChange: (busy: boolean) => void;
  onRecordLinkBusyChange: (busy: boolean) => void;
  refreshAttachmentVersions: () => Promise<BoardAttachmentVersions>;
  canArchiveSelected?: boolean;
  onArchive?: () => void;
  showNewButton?: boolean;
}) {
  const heading = createElement(
    "h2",
    { className: "text-lg font-semibold" },
    "Editable posts",
  );
  if (!view.active || view.status === "denied") {
    return createElement(
      "section",
      { "aria-label": "Manage posts", className: "min-w-0" },
      heading,
      createElement(
        "p",
        { className: "text-muted-foreground mt-2 text-sm" },
        !view.active
          ? "This Board is archived and read-only."
          : "Post editing is unavailable. Check your Board access.",
      ),
    );
  }
  if (view.status === "loading" || view.status === "error") {
    return createElement(
      "section",
      { "aria-label": "Manage posts", className: "min-w-0" },
      heading,
      createElement(
        "p",
        {
          role: view.status === "error" ? "alert" : "status",
          className: "mt-2 text-sm",
        },
        view.status === "loading"
          ? "Loading editable posts…"
          : (view.error ?? "Editable posts are unavailable."),
      ),
      view.status === "error"
        ? createElement(
            "button",
            {
              type: "button",
              onClick: onRetry,
              className:
                "border-border bg-card text-foreground focus-visible:outline-ring mt-3 min-h-11 rounded-md border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2",
            },
            "Retry",
          )
        : null,
    );
  }
  if (!view.canEdit) {
    return createElement(
      "section",
      { "aria-label": "Manage posts", className: "min-w-0" },
      heading,
      createElement(
        "p",
        { className: "text-muted-foreground mt-2 text-sm" },
        "You need Board edit access to manage posts.",
      ),
    );
  }
  const form = view.form;
  const selected = view.selected;
  const valid =
    form !== null &&
    form.title.trim().length > 0 &&
    form.title.trim().length <= 100 &&
    form.body.trim().length > 0 &&
    form.body.trim().length <= 2000 &&
    validPostLinks(form.links);
  const actionClass =
    "bg-primary text-primary-foreground focus-visible:outline-ring min-h-11 rounded-md px-4 text-sm font-medium hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";
  const secondaryClass =
    "border-border bg-card text-foreground focus-visible:outline-ring min-h-11 rounded-md border px-4 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";
  return createElement(
    "section",
    { "aria-label": "Manage posts", className: "min-w-0 space-y-4" },
    createElement(
      "div",
      { className: "flex flex-wrap items-center justify-between gap-3" },
      heading,
      createElement(
        "div",
        { className: "flex flex-wrap gap-2" },
        createElement(
          "button",
          {
            type: "button",
            onClick: onRetry,
            disabled: view.pending,
            className: secondaryClass,
          },
          "Refresh posts",
        ),
        showNewButton
          ? createElement(
              "button",
              {
                type: "button",
                onClick: onNew,
                disabled: view.pending || view.dirty || view.scheduleDirty,
                className: secondaryClass,
              },
              "New post",
            )
          : null,
      ),
    ),
    view.error
      ? createElement(
          "p",
          { role: "alert", className: "text-destructive text-sm" },
          view.error,
        )
      : null,
    view.conflict
      ? createElement(
          "p",
          { role: "alert", className: "text-muted-foreground text-sm" },
          "This draft changed elsewhere. Your text, links, pin and expiry are kept. Copy them if needed, then discard changes and choose the latest draft.",
        )
      : null,
    view.notice
      ? createElement(
          "p",
          { role: "status", className: "text-muted-foreground text-sm" },
          view.notice,
        )
      : null,
    view.displayed
      ? createElement(
          "article",
          {
            "aria-label": "Published revision",
            className: "border-border bg-card rounded-xl border p-4",
          },
          createElement(
            "h3",
            { className: "font-semibold break-words" },
            view.displayed.title,
          ),
          createElement(
            "p",
            { className: "mt-2 whitespace-pre-wrap break-words text-sm" },
            view.displayed.body,
          ),
          view.displayed.links.length > 0
            ? createElement(
                "ul",
                { className: "mt-3 space-y-2" },
                ...view.displayed.links.map((link, index) =>
                  createElement(
                    "li",
                    { key: `${index}:${link.url}`, className: "min-w-0" },
                    createElement(
                      "a",
                      {
                        href: link.url,
                        target: "_blank",
                        rel: "noopener noreferrer",
                        className:
                          "text-primary focus-visible:outline-ring break-all underline focus-visible:outline-2 focus-visible:outline-offset-2",
                      },
                      link.label,
                    ),
                  ),
                ),
              )
            : null,
          createElement(HydratedBoardAttachments, {
            key: `published-attachments:${view.displayed.id}`,
            access: "read",
            target: {
              kind: "post",
              boardId: view.displayed.boardId,
              contentId: view.displayed.id,
              view: "published",
            },
          }),
          createElement(HydratedBoardRecordLinks, {
            key: `published-record-links:${view.displayed.id}`,
            access: "read",
            target: {
              kind: "post",
              boardId: view.displayed.boardId,
              contentId: view.displayed.id,
              view: "published",
            },
          }),
        )
      : null,
    createElement(
      "div",
      {
        className:
          "grid min-w-0 gap-5 lg:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)]",
      },
      createElement(
        "div",
        { className: "min-w-0" },
        createElement(
          "h3",
          { className: "text-sm font-medium" },
          `Posts (${view.total})`,
        ),
        view.drafts.length === 0
          ? createElement(
              "p",
              { className: "text-muted-foreground mt-2 text-sm" },
              "No editable posts on this page. Create one to begin.",
            )
          : createElement(
              "ul",
              { className: "mt-2 space-y-2" },
              ...view.drafts.map((item) =>
                createElement(
                  "li",
                  { key: item.id },
                  createElement(
                    "button",
                    {
                      type: "button",
                      onClick: () => onSelect(item),
                      disabled:
                        view.pending || view.dirty || view.scheduleDirty,
                      "aria-current":
                        selected?.id === item.id ? "true" : undefined,
                      className:
                        "border-border bg-card text-foreground focus-visible:outline-ring min-h-11 w-full rounded-md border px-3 py-2 text-left text-sm break-words focus-visible:outline-2 focus-visible:outline-offset-2",
                    },
                    item.title,
                    item.status === "scheduled"
                      ? " · Scheduled"
                      : item.status === "published"
                        ? " · Published"
                        : "",
                  ),
                ),
              ),
            ),
        view.total > 25 || view.offset > 0
          ? createElement(
              "nav",
              {
                "aria-label": "Editable post pages",
                className: "mt-3 flex flex-wrap items-center gap-2",
              },
              createElement(
                "button",
                {
                  type: "button",
                  onClick: () => onPage(Math.max(0, view.offset - 25)),
                  disabled: view.pending || view.offset === 0,
                  className: secondaryClass,
                },
                "Previous",
              ),
              createElement(
                "span",
                { className: "text-muted-foreground text-sm" },
                `Page ${Math.floor(view.offset / 25) + 1}`,
              ),
              createElement(
                "button",
                {
                  type: "button",
                  onClick: () => onPage(view.offset + 25),
                  disabled: view.pending || !view.hasMore,
                  className: secondaryClass,
                },
                "Next",
              ),
            )
          : null,
      ),
      form
        ? createElement(
            "form",
            {
              className:
                "border-border bg-card min-w-0 space-y-4 rounded-xl border p-4 sm:p-5",
              onSubmit: (event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                onSave();
              },
            },
            createElement(
              "h3",
              { className: "font-semibold" },
              selected ? "Edit post" : "New draft",
            ),
            selected?.status === "scheduled"
              ? createElement(
                  "p",
                  { className: "text-muted-foreground text-sm" },
                  "Saving this draft cancels its scheduled publication. Publishing now publishes immediately.",
                )
              : null,
            createElement(
              "div",
              { className: "space-y-2" },
              createElement(
                "label",
                {
                  htmlFor: "board-post-title",
                  className: "text-sm font-medium",
                },
                "Title",
              ),
              createElement("input", {
                id: "board-post-title",
                type: "text",
                required: true,
                maxLength: 100,
                value: form.title,
                disabled: view.pending,
                onChange: (event: ChangeEvent<HTMLInputElement>) =>
                  onChange({ ...form, title: event.currentTarget.value }),
                className:
                  "border-input bg-background text-foreground focus-visible:outline-ring min-h-11 w-full rounded-md border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2",
              }),
            ),
            createElement(
              "div",
              { className: "space-y-2" },
              createElement(
                "label",
                {
                  htmlFor: "board-post-body",
                  className: "text-sm font-medium",
                },
                "Message",
              ),
              createElement("textarea", {
                id: "board-post-body",
                required: true,
                maxLength: 2000,
                value: form.body,
                disabled: view.pending,
                rows: 7,
                onChange: (event: ChangeEvent<HTMLTextAreaElement>) =>
                  onChange({ ...form, body: event.currentTarget.value }),
                className:
                  "border-input bg-background text-foreground focus-visible:outline-ring min-h-32 w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2",
              }),
            ),
            createElement(
              "div",
              { className: "space-y-3" },
              createElement(
                "h4",
                { className: "text-sm font-medium" },
                "External links",
              ),
              createElement(
                "p",
                { className: "text-muted-foreground text-sm" },
                "Up to 20 HTTP or HTTPS links. Do not include sign-in details in a URL.",
              ),
              ...form.links.map((link, index) =>
                createElement(
                  "div",
                  {
                    key: index,
                    className:
                      "border-border grid min-w-0 gap-3 rounded-md border p-3 sm:grid-cols-2",
                  },
                  createElement(
                    "label",
                    { className: "space-y-1 text-sm" },
                    createElement(
                      "span",
                      null,
                      `External link ${index + 1} label`,
                    ),
                    createElement("input", {
                      type: "text",
                      value: link.label,
                      maxLength: 100,
                      disabled: view.pending,
                      onChange: (event: ChangeEvent<HTMLInputElement>) =>
                        onChange({
                          ...form,
                          links: form.links.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, label: event.currentTarget.value }
                              : item,
                          ),
                        }),
                      className:
                        "border-input bg-background text-foreground focus-visible:outline-ring min-h-11 w-full rounded-md border px-3 focus-visible:outline-2 focus-visible:outline-offset-2",
                    }),
                  ),
                  createElement(
                    "label",
                    { className: "space-y-1 text-sm" },
                    createElement(
                      "span",
                      null,
                      `External link ${index + 1} URL`,
                    ),
                    createElement("input", {
                      type: "url",
                      value: link.url,
                      maxLength: 2048,
                      disabled: view.pending,
                      onChange: (event: ChangeEvent<HTMLInputElement>) =>
                        onChange({
                          ...form,
                          links: form.links.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, url: event.currentTarget.value }
                              : item,
                          ),
                        }),
                      className:
                        "border-input bg-background text-foreground focus-visible:outline-ring min-h-11 w-full rounded-md border px-3 focus-visible:outline-2 focus-visible:outline-offset-2",
                    }),
                  ),
                  createElement(
                    "button",
                    {
                      type: "button",
                      "aria-label": `Remove link ${index + 1}`,
                      disabled: view.pending,
                      onClick: () =>
                        onChange({
                          ...form,
                          links: form.links.filter(
                            (_, itemIndex) => itemIndex !== index,
                          ),
                        }),
                      className: secondaryClass,
                    },
                    "Remove link",
                  ),
                ),
              ),
              createElement(
                "button",
                {
                  type: "button",
                  disabled: view.pending || form.links.length >= 20,
                  onClick: () =>
                    onChange({
                      ...form,
                      links: [...form.links, { label: "", url: "" }],
                    }),
                  className: secondaryClass,
                },
                "Add link",
              ),
            ),
            view.canManage
              ? createElement(
                  "label",
                  {
                    htmlFor: "board-post-pinned",
                    className:
                      "flex min-h-11 items-center gap-3 text-sm font-medium",
                  },
                  createElement(Checkbox, {
                    id: "board-post-pinned",
                    checked: form.pinned,
                    disabled: view.pending || view.conflict,
                    onCheckedChange: (checked: boolean) =>
                      onChange({ ...form, pinned: checked }),
                  }),
                  "Pin to top",
                )
              : null,
            createElement(
              "div",
              { className: "space-y-2" },
              createElement(
                "label",
                {
                  htmlFor: "board-post-expires-on",
                  className: "text-sm font-medium",
                },
                "Expires on",
              ),
              createElement(
                "p",
                {
                  id: "board-post-expiry-help",
                  className: "text-muted-foreground text-sm",
                },
                `Times use ${view.deviceTimeZone} and are sent to the server in UTC. Leave blank for no expiry.`,
              ),
              createElement("input", {
                id: "board-post-expires-on",
                type: "datetime-local",
                step: "1",
                value: form.expiresLocal,
                disabled: view.pending || view.conflict,
                "aria-describedby": view.expiryError
                  ? "board-post-expiry-help board-post-expiry-error"
                  : "board-post-expiry-help",
                "aria-invalid": view.expiryError ? "true" : undefined,
                onChange: (event: ChangeEvent<HTMLInputElement>) =>
                  onChange({
                    ...form,
                    expiresLocal: event.currentTarget.value,
                  }),
                className:
                  "border-input bg-background text-foreground focus-visible:outline-ring min-h-11 w-full rounded-md border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2",
              }),
              view.expiryError
                ? createElement(
                    "p",
                    {
                      id: "board-post-expiry-error",
                      role: "alert",
                      className: "text-destructive text-sm",
                    },
                    view.expiryError,
                  )
                : null,
            ),
            selected?.status === "published"
              ? createElement(
                  "p",
                  { className: "text-muted-foreground text-sm" },
                  "Save your changes as a draft before managing attachments and Record links.",
                )
              : selected && selected.postRevision !== null
                ? createElement(HydratedBoardAttachments, {
                    key: `draft-attachments:${selected.id}`,
                    access: "edit",
                    target: {
                      kind: "post",
                      boardId,
                      contentId: selected.id,
                      view: "draft",
                    },
                    versions: {
                      boardRevision: selected.boardRevision,
                      contentRevision: selected.postRevision,
                    },
                    refreshVersions: refreshAttachmentVersions,
                    onBusyChange: onAttachmentBusyChange,
                    locked: view.conflict || view.pending,
                  })
                : createElement(
                    "p",
                    { className: "text-muted-foreground text-sm" },
                    "Save this draft before adding attachments.",
                  ),
            selected?.status === "published"
              ? null
              : selected && selected.postRevision !== null
                ? createElement(HydratedBoardRecordLinks, {
                    key: `draft-record-links:${selected.id}`,
                    access: "edit",
                    target: {
                      kind: "post",
                      boardId,
                      contentId: selected.id,
                      view: "draft",
                    },
                    versions: {
                      boardRevision: selected.boardRevision,
                      contentRevision: selected.postRevision,
                    },
                    refreshVersions: refreshAttachmentVersions,
                    onBusyChange: onRecordLinkBusyChange,
                    locked: view.conflict || view.pending,
                  })
                : createElement(
                    "p",
                    { className: "text-muted-foreground text-sm" },
                    "Save this draft before linking Records.",
                  ),
            createElement(
              "div",
              { className: "border-border space-y-3 rounded-md border p-3" },
              createElement(
                "h4",
                { className: "text-sm font-medium" },
                "Scheduled publication",
              ),
              selected
                ? createElement(
                    "div",
                    { className: "space-y-2" },
                    createElement(
                      "p",
                      {
                        id: "board-post-schedule-help",
                        className: "text-muted-foreground text-sm",
                      },
                      `Times use ${view.deviceTimeZone} and are sent to the server in UTC. Local times skipped by a clock change cannot be scheduled.`,
                    ),
                    createElement(
                      "label",
                      {
                        htmlFor: "board-post-scheduled-for",
                        className: "text-sm font-medium",
                      },
                      "Publication date and time",
                    ),
                    createElement("input", {
                      id: "board-post-scheduled-for",
                      type: "datetime-local",
                      step: "1",
                      value: view.scheduleLocal,
                      disabled: view.pending || view.conflict,
                      "aria-describedby": view.scheduleError
                        ? "board-post-schedule-help board-post-schedule-error"
                        : "board-post-schedule-help",
                      "aria-invalid": view.scheduleError ? "true" : undefined,
                      onChange: (event: ChangeEvent<HTMLInputElement>) =>
                        onScheduleTimeChange(event.currentTarget.value),
                      className:
                        "border-input bg-background text-foreground focus-visible:outline-ring min-h-11 w-full rounded-md border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2",
                    }),
                    view.scheduleError
                      ? createElement(
                          "p",
                          {
                            id: "board-post-schedule-error",
                            role: "alert",
                            className: "text-destructive text-sm",
                          },
                          view.scheduleError,
                        )
                      : null,
                    view.dirty
                      ? createElement(
                          "p",
                          { className: "text-muted-foreground text-sm" },
                          "Save or discard your changes before scheduling this publication.",
                        )
                      : null,
                  )
                : createElement(
                    "p",
                    { className: "text-muted-foreground text-sm" },
                    "Save this draft before choosing a publication time.",
                  ),
            ),
            createElement(
              "div",
              { className: "flex flex-wrap gap-2" },
              createElement(
                "button",
                {
                  type: "submit",
                  disabled:
                    view.pending ||
                    view.conflict ||
                    !valid ||
                    (selected !== null && !view.dirty),
                  className: actionClass,
                },
                view.pending ? "Working…" : "Save draft",
              ),
              selected
                ? createElement(
                    "button",
                    {
                      type: "button",
                      onClick: onPublish,
                      disabled:
                        view.pending ||
                        view.conflict ||
                        view.dirty ||
                        view.scheduleDirty ||
                        !valid,
                      className: secondaryClass,
                    },
                    "Publish now",
                  )
                : null,
              selected && selected.postRevision !== null
                ? createElement(
                    "button",
                    {
                      type: "button",
                      onClick: onSchedule,
                      disabled:
                        view.pending ||
                        view.conflict ||
                        view.dirty ||
                        !view.scheduleLocal ||
                        (selected.status === "scheduled" &&
                          !view.scheduleDirty),
                      className: secondaryClass,
                    },
                    selected.status === "scheduled"
                      ? "Reschedule publication"
                      : "Schedule publication",
                  )
                : null,
              selected?.status === "scheduled"
                ? createElement(
                    "button",
                    {
                      type: "button",
                      onClick: onCancelSchedule,
                      disabled:
                        view.pending ||
                        view.conflict ||
                        view.dirty ||
                        view.scheduleDirty,
                      className: secondaryClass,
                    },
                    "Cancel scheduled publication",
                  )
                : null,
              canArchiveSelected && selected && onArchive
                ? createElement(
                    "button",
                    {
                      type: "button",
                      onClick: onArchive,
                      disabled:
                        view.pending ||
                        view.conflict ||
                        view.dirty ||
                        view.scheduleDirty,
                      className: secondaryClass,
                    },
                    "Archive post",
                  )
                : null,
              createElement(
                "button",
                {
                  type: "button",
                  onClick: onClose,
                  disabled: view.pending,
                  className: secondaryClass,
                },
                view.dirty || view.scheduleDirty ? "Discard changes" : "Close",
              ),
            ),
            view.dirty
              ? createElement(
                  "p",
                  { className: "text-muted-foreground text-sm" },
                  selected
                    ? "Save changes before publishing or choosing another draft."
                    : "Save or discard this draft before choosing another.",
                )
              : view.scheduleDirty
                ? createElement(
                    "p",
                    { className: "text-muted-foreground text-sm" },
                    "Apply or discard the publication time change before publishing or choosing another draft.",
                  )
                : null,
          )
        : createElement(
            "p",
            {
              className:
                "border-border text-muted-foreground rounded-xl border border-dashed p-5 text-sm",
            },
            "Choose a draft or create a new post.",
          ),
    ),
  );
}

export function ServerBackedBoardPostEditor({
  boardId,
  boardRevision,
  boardStatus,
  refreshKey,
  onPublished,
  onDraftStateChange,
}: {
  boardId: string;
  boardRevision: number;
  boardStatus: "active" | "archived";
  refreshKey: number;
  onPublished?: (boardId: string) => void;
  onDraftStateChange?: (
    boardId: string,
    dirty: boolean,
    pending: boolean,
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const editor = useServerBoardPostEditor({
    boardId,
    boardRevision,
    boardStatus,
    refreshKey,
    onPublished,
  });
  useEffect(() => {
    onDraftStateChange?.(
      boardId,
      editor.view.dirty || editor.view.scheduleDirty,
      editor.view.pending,
    );
  }, [
    boardId,
    editor.view.dirty,
    editor.view.scheduleDirty,
    editor.view.pending,
    onDraftStateChange,
  ]);
  useEffect(
    () => () => onDraftStateChange?.(boardId, false, false),
    [boardId, onDraftStateChange],
  );
  const view = editor.view;
  const canEdit = view.active && view.status === "ready" && view.canEdit;
  const hasUnsavedChanges = view.dirty || view.scheduleDirty;

  function requestClose() {
    if (view.pending) return;
    if (hasUnsavedChanges) {
      setDiscardOpen(true);
      return;
    }
    editor.close();
    setOpen(false);
  }

  function discardChanges() {
    if (view.pending) return;
    editor.close();
    setDiscardOpen(false);
    setOpen(false);
  }

  return (
    <>
      {canEdit ? (
        <div className="inline-flex items-stretch">
          <Button
            type="button"
            variant="default"
            className="min-h-11 rounded-r-none"
            disabled={view.pending || hasUnsavedChanges}
            onClick={() => {
              editor.newDraft();
              setOpen(true);
            }}
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
            New post
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="default"
                  size="icon"
                  className="border-primary-foreground/20 min-h-11 min-w-11 rounded-l-none border-l"
                  aria-label="More post actions"
                  disabled={view.pending}
                />
              }
            >
              <ChevronDown aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" aria-label="Post actions">
              <DropdownMenuItem
                disabled={view.pending}
                onClick={() => setOpen(true)}
              >
                <FileText aria-hidden="true" />
                Edit drafts
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : !open && !view.active ? (
        <p className="text-muted-foreground text-sm">
          This Board is archived and read-only.
        </p>
      ) : !open && view.status === "loading" ? (
        <p role="status" className="text-muted-foreground text-sm">
          Checking post editing access…
        </p>
      ) : !open && view.status === "error" ? (
        <Alert variant="destructive">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{view.error ?? "Editable posts are unavailable."}</span>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={editor.retry}
            >
              Retry
            </Button>
          </div>
        </Alert>
      ) : !open && (view.status === "denied" || !view.canEdit) ? (
        <p className="text-muted-foreground text-sm">
          Post editing is unavailable. Check your Board access.
        </p>
      ) : null}
      <Sheet
        open={open}
        dismissible={!view.pending}
        onOpenChange={(nextOpen) => {
          if (nextOpen) setOpen(true);
          else requestClose();
        }}
      >
        <SheetContent
          side="right"
          className="w-full max-w-none gap-6 overflow-y-auto sm:max-w-5xl"
        >
          <SheetHeader className="pr-12">
            <SheetTitle>Post editor</SheetTitle>
            <SheetDescription>
              Create a post or choose an existing one you can edit.
            </SheetDescription>
          </SheetHeader>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close post editor"
            className="absolute top-3 right-3 size-11"
            disabled={view.pending}
            onClick={requestClose}
          >
            <X aria-hidden="true" />
          </Button>
          <ServerBoardPostEditorDisplay
            boardId={boardId}
            view={view}
            onNew={editor.newDraft}
            onSelect={editor.selectDraft}
            onChange={editor.changeForm}
            onSave={() => {
              void editor.save();
            }}
            onPublish={() => {
              void editor.publish();
            }}
            onSchedule={() => {
              void editor.schedule();
            }}
            onCancelSchedule={() => {
              void editor.cancelSchedule();
            }}
            onScheduleTimeChange={editor.changeScheduleTime}
            onRetry={editor.retry}
            onClose={requestClose}
            onPage={editor.page}
            onAttachmentBusyChange={editor.setAttachmentPending}
            onRecordLinkBusyChange={editor.setRecordLinkPending}
            refreshAttachmentVersions={editor.refreshAttachmentVersions}
            canArchiveSelected={editor.canArchiveSelected}
            onArchive={() => setArchiveOpen(true)}
          />
        </SheetContent>
      </Sheet>
      <ConfirmAction
        open={discardOpen}
        title="Discard unsaved post changes?"
        description="Your unsaved title, message, schedule, and links will be discarded. Saved post content will stay unchanged."
        action="Discard changes"
        onCancel={() => setDiscardOpen(false)}
        onConfirm={discardChanges}
        disabled={view.pending}
      />
      <ConfirmAction
        open={archiveOpen && editor.canArchiveSelected}
        title="Archive post?"
        description={`Archive “${view.selected?.title ?? "this post"}”? Readers will no longer see it. Its edit history stays, and a Board manager can restore it.`}
        action="Archive post"
        onCancel={() => setArchiveOpen(false)}
        onConfirm={() => {
          setArchiveOpen(false);
          void editor.archiveSelected();
        }}
        disabled={
          view.pending ||
          view.conflict ||
          view.dirty ||
          view.scheduleDirty ||
          !editor.canArchiveSelected
        }
      />
    </>
  );
}
