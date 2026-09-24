"use client";

import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bookmark,
  BookmarkCheck,
  CalendarClock,
  Check,
  Eye,
  FileText,
  Megaphone,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Send,
  Settings2,
  Trash2,
  Undo2,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Textarea } from "@/components/ui/textarea";
import { SearchSelect } from "@/components/ui/search-select";
import { datetimeInputToUtc, formatDateTimeLocal } from "@/lib/date-time";
import type { SampleRecord } from "../../shared/data/sample-data";
import {
  BOARD_INPUT_LIMITS,
  BOARD_TIMEZONE,
  type BoardAnnouncement,
  type BoardAnnouncementRevision,
  type BoardAudience,
  type BoardAudienceLookup,
  type BoardPersonalState,
} from "../domain/model";
import {
  boardAudienceLabel,
  canViewBoardAudience,
  getAnnouncementLifecycle,
  type BoardViewer,
} from "../domain/content";
import {
  AudienceField,
  ContentAttachments,
  ContentFields,
  type BoardPerson,
} from "./content-fields";
import { BoardEmpty, ConfirmAction, EditSheet } from "./ui";
import { releaseLocalAttachment } from "../../shared/runtime/local-attachments";

export type BoardMutationResult =
  { ok: true; id?: string } | { ok: false; error: string };

export type AnnouncementAction =
  | {
      type: "publish";
      announcement: BoardAnnouncement;
      original?: BoardAnnouncement;
    }
  | {
      type: "schedule";
      announcement: BoardAnnouncement;
      original?: BoardAnnouncement;
    }
  | { type: "unpublish"; announcementId: string }
  | { type: "archive"; announcementId: string }
  | { type: "restore"; announcementId: string }
  | { type: "delete"; announcementId: string }
  | { type: "pin"; announcementId: string; pinned: boolean };

export type AnnouncementPersonalAction =
  | { type: "read"; announcementId: string; read: boolean }
  | { type: "bookmark"; announcementId: string; bookmarked: boolean };

export type AnnouncementFeedProps = {
  boardId: string;
  announcements: readonly BoardAnnouncement[];
  viewer: BoardViewer;
  people: readonly BoardPerson[];
  roles: readonly { id: string; name: string }[];
  departments: readonly string[];
  canEdit: boolean;
  canManage: boolean;
  preview?: boolean;
  timezone?: string;
  personal: BoardPersonalState;
  records?: readonly SampleRecord[];
  pending?: boolean;
  onSave: (
    announcement: BoardAnnouncement,
    original?: BoardAnnouncement,
  ) => Promise<BoardMutationResult>;
  onAction: (action: AnnouncementAction) => Promise<BoardMutationResult>;
  onPersonal: (
    change: AnnouncementPersonalAction,
  ) => Promise<BoardMutationResult>;
};

type FeedStatus = "published" | "drafts" | "archive";
type EditorMode = "edit" | "preview";
type Notice = { kind: "success" | "error"; message: string };

type AnnouncementDisplay = {
  title: string;
  body: string;
  attachments: BoardAnnouncement["attachments"];
  links: BoardAnnouncement["links"];
  audience: BoardAudience;
  publishedAt: string | null;
  expiresAt: string | null;
};

type FeedEntry = {
  announcement: BoardAnnouncement;
  lifecycle: ReturnType<typeof getAnnouncementLifecycle>;
  display: AnnouncementDisplay;
  isAuthor: boolean;
  hasDraft: boolean;
  showDraft: boolean;
};

const EMPTY_RECORDS: readonly SampleRecord[] = [];

export function AnnouncementFeed({
  boardId,
  announcements,
  viewer,
  people,
  roles,
  departments,
  canEdit,
  canManage,
  preview = false,
  timezone = BOARD_TIMEZONE,
  personal,
  records = EMPTY_RECORDS,
  pending = false,
  onSave,
  onAction,
  onPersonal,
}: AnnouncementFeedProps) {
  const [activeStatus, setActiveStatus] = useState<FeedStatus>("published");
  const [search, setSearch] = useState("");
  const [authorFilter, setAuthorFilter] = useState("all");
  const [now, setNow] = useState(() => new Date().toISOString());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editorDraft, setEditorDraft] = useState<BoardAnnouncement | null>(
    null,
  );
  const [editorOriginal, setEditorOriginal] =
    useState<BoardAnnouncement | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>("edit");
  const [editorIsNew, setEditorIsNew] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [editorInputError, setEditorInputError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<BoardAnnouncement | null>(
    null,
  );
  const editorDraftRef = useRef<BoardAnnouncement | null>(null);
  const editorOriginalRef = useRef<BoardAnnouncement | null>(null);
  const editorLifecycle = useRef(0);

  useEffect(() => {
    editorDraftRef.current = editorDraft;
    editorOriginalRef.current = editorOriginal;
  }, [editorDraft, editorOriginal]);

  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(new Date().toISOString()),
      60_000,
    );
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const generation = ++editorLifecycle.current;
    return () => {
      queueMicrotask(() => {
        if (editorLifecycle.current !== generation) return;
        releaseDraftAttachments(
          editorDraftRef.current,
          editorOriginalRef.current,
        );
      });
    };
  }, []);

  const audienceLookup: BoardAudienceLookup = {
    roles: roles.map(({ id, name }) => ({ id, name })),
    identities: people.map(({ id, name, active }) => ({ id, name, active })),
    departments: departments.map((name) => ({ id: slug(name), name })),
  };
  const editingAllowed = !pending && !preview && canEdit && viewer.active;
  const managingAllowed = !pending && !preview && canManage;
  const viewerName =
    people.find((person) => person.id === viewer.id)?.name ??
    "selected identity";

  const allEntries = announcements
    .filter((announcement) => announcement.boardId === boardId)
    .map((announcement) => {
      const lifecycle = getAnnouncementLifecycle(announcement, now);
      const isAuthor = announcement.authorId === viewer.id;
      const hasDraft =
        announcement.status === "draft" ||
        (announcement.status === "scheduled" &&
          timestampValue(announcement.publishAt) > timestampValue(now));
      const showDraft =
        hasDraft && (isAuthor || managingAllowed) && activeStatus === "drafts";
      return {
        announcement,
        lifecycle,
        isAuthor,
        hasDraft,
        showDraft,
        display: announcementDisplay(
          announcement,
          lifecycle.revision,
          showDraft,
        ),
      } satisfies FeedEntry;
    });

  function isVisibleToViewer(entry: FeedEntry, status: FeedStatus): boolean {
    const audience =
      status === "drafts"
        ? entry.announcement.audience
        : revisionAudience(
            entry.lifecycle.revision,
            entry.announcement.audience,
          );
    return canViewBoardAudience(audience, viewer, entry.announcement.authorId);
  }

  function canManageContent(entry: FeedEntry): boolean {
    return (
      canViewBoardAudience(
        entry.announcement.audience,
        viewer,
        entry.announcement.authorId,
      ) &&
      (!entry.announcement.publishedRevision ||
        canViewBoardAudience(
          entry.announcement.publishedRevision.audience,
          viewer,
          entry.announcement.authorId,
        ))
    );
  }

  function isInStatus(entry: FeedEntry, status: FeedStatus): boolean {
    if (!isVisibleToViewer(entry, status)) return false;
    const { announcement, lifecycle, isAuthor } = entry;
    const canSeePrivate = isAuthor || managingAllowed;
    if (status === "archive") {
      return announcement.status === "archived" && managingAllowed;
    }
    if (announcement.status === "archived") return false;
    if (status === "drafts") {
      return canSeePrivate && entry.hasDraft;
    }
    const lifecycleIsPublished =
      lifecycle.status === "published" || lifecycle.status === "expired";
    return lifecycleIsPublished && (lifecycle.visible || canSeePrivate);
  }

  const statusCounts = {
    published: allEntries.filter((entry) => isInStatus(entry, "published"))
      .length,
    drafts: allEntries.filter((entry) => isInStatus(entry, "drafts")).length,
    archive: allEntries.filter((entry) => isInStatus(entry, "archive")).length,
  };
  const query = search.trim().toLocaleLowerCase();
  const availableEntries = allEntries.filter((entry) =>
    isInStatus(entry, activeStatus),
  );
  const filteredEntries = availableEntries
    .filter((entry) =>
      authorFilter === "all"
        ? true
        : entry.announcement.authorId === authorFilter,
    )
    .filter((entry) => {
      if (!query) return true;
      const author = authorName(entry.announcement.authorId, people);
      const audience = boardAudienceLabel(
        entry.display.audience,
        audienceLookup,
      );
      return [entry.display.title, entry.display.body, author, audience].some(
        (value) => value.toLocaleLowerCase().includes(query),
      );
    })
    .sort(
      (left, right) =>
        Number(right.announcement.pinned) - Number(left.announcement.pinned) ||
        (activeStatus === "published"
          ? Number(
              personal.readAnnouncementIds.includes(left.announcement.id),
            ) -
            Number(personal.readAnnouncementIds.includes(right.announcement.id))
          : 0) ||
        timestampValue(
          right.display.publishedAt ?? right.announcement.updatedAt,
        ) -
          timestampValue(
            left.display.publishedAt ?? left.announcement.updatedAt,
          ) ||
        left.announcement.id.localeCompare(right.announcement.id),
    );

  const editorDirty =
    editorDraft !== null &&
    editorOriginal !== null &&
    !sameEditableContent(editorDraft, editorOriginal);
  const canCreate = editingAllowed;

  function setStatus(value: string) {
    setActiveStatus(value as FeedStatus);
    setSearch("");
    setAuthorFilter("all");
  }

  function openNewEditor() {
    const announcement = newAnnouncement(boardId, viewer.id);
    setEditorDraft(announcement);
    setEditorOriginal(cloneAnnouncement(announcement));
    setEditorIsNew(true);
    setEditorMode("edit");
    setEditorError("");
    setEditorInputError("");
  }

  function openExistingEditor(announcement: BoardAnnouncement) {
    const cloned = cloneAnnouncement(announcement);
    setEditorDraft(cloned);
    setEditorOriginal(cloneAnnouncement(cloned));
    setEditorIsNew(false);
    setEditorMode("edit");
    setEditorError("");
    setEditorInputError("");
  }

  function releaseDraftAttachments(
    draft: BoardAnnouncement | null = editorDraft,
    original: BoardAnnouncement | null = editorOriginal,
  ) {
    if (!draft) return;
    const originalIds = new Set(
      (original?.attachments ?? []).map((attachment) => attachment.id),
    );
    for (const attachment of draft.attachments) {
      if (!originalIds.has(attachment.id)) {
        releaseLocalAttachment(attachment.id);
      }
    }
  }

  function closeEditor(releaseAttachments = true) {
    if (releaseAttachments) releaseDraftAttachments();
    setEditorDraft(null);
    setEditorOriginal(null);
    setEditorError("");
    setEditorInputError("");
    setEditorMode("edit");
    setEditorIsNew(false);
  }

  function updateEditor(
    patch: Partial<
      Pick<
        BoardAnnouncement,
        | "title"
        | "body"
        | "audience"
        | "publishAt"
        | "expiresAt"
        | "attachments"
        | "links"
      >
    >,
  ) {
    setEditorDraft((current) => (current ? { ...current, ...patch } : current));
    setEditorError("");
    setEditorInputError("");
  }

  function mutationOriginal(): BoardAnnouncement | undefined {
    return editorIsNew ? undefined : (editorOriginal ?? undefined);
  }

  async function saveDraft() {
    if (!editorDraft) return false;
    if (pending) return false;
    if (editorDraft.boardId !== boardId) {
      setEditorError(
        "This draft belongs to another board. Return to that board before saving, or discard this draft.",
      );
      return false;
    }
    if (preview || !canEdit || !viewer.active) {
      setEditorError(
        "Leave read-only preview and choose an active identity before saving.",
      );
      return false;
    }
    if (editorInputError) return false;
    const validationError = validateAnnouncementDraft(editorDraft);
    if (validationError) {
      setEditorError(validationError);
      return false;
    }
    const saved = prepareDraft(editorDraft);
    const result = await safeMutation(() => onSave(saved, mutationOriginal()));
    if (!result.ok) {
      setEditorError(result.error);
      return false;
    }
    setNotice({
      kind: "success",
      message: editorIsNew ? "Draft saved." : "Draft changes saved.",
    });
    closeEditor(false);
    setActiveStatus("drafts");
    return true;
  }

  async function publishDraft() {
    if (!editorDraft) return;
    if (pending) return;
    if (editorDraft.boardId !== boardId) {
      setEditorError(
        "This draft belongs to another board. Return to that board before publishing, or discard this draft.",
      );
      return;
    }
    if (preview || !canEdit || !viewer.active) {
      setEditorError(
        "Leave read-only preview and choose an active identity before publishing.",
      );
      return;
    }
    if (editorInputError) return;
    const validationError = validateAnnouncementDraft(editorDraft);
    if (validationError) {
      setEditorError(validationError);
      return;
    }
    const saved = prepareDraft(editorDraft);
    const scheduled = isFutureTimestamp(saved.publishAt);
    const action: AnnouncementAction = scheduled
      ? { type: "schedule", announcement: saved, original: mutationOriginal() }
      : { type: "publish", announcement: saved, original: mutationOriginal() };
    const actionResult = await safeMutation(() => onAction(action));
    if (!actionResult.ok) {
      setEditorError(actionResult.error);
      return;
    }
    setNotice({
      kind: "success",
      message: scheduled
        ? "Announcement scheduled."
        : "Announcement published.",
    });
    closeEditor(false);
    setActiveStatus(scheduled ? "drafts" : "published");
  }

  async function runAction(action: AnnouncementAction, message: string) {
    if (pending || preview) return;
    const result = await safeMutation(() => onAction(action));
    if (!result.ok) {
      setNotice({ kind: "error", message: result.error });
      return;
    }
    setNotice({ kind: "success", message });
  }

  async function runPersonal(
    change: AnnouncementPersonalAction,
    message: string,
  ) {
    if (pending || preview || !viewer.active) return;
    const result = await safeMutation(() => onPersonal(change));
    if (!result.ok) {
      setNotice({ kind: "error", message: result.error });
      return;
    }
    setNotice({ kind: "success", message });
  }

  async function confirmDelete() {
    if (pending || !pendingDelete || preview || !canManage || !viewer.active)
      return;
    const result = await safeMutation(() =>
      onAction({ type: "delete", announcementId: pendingDelete.id }),
    );
    if (!result.ok) {
      setNotice({ kind: "error", message: result.error });
      return;
    }
    setNotice({ kind: "success", message: "Announcement deleted." });
    setPendingDelete(null);
  }

  const emptyState = emptyFeedState(
    allEntries,
    availableEntries,
    filteredEntries,
    activeStatus,
    search,
    authorFilter,
  );

  return (
    <section
      className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-5"
      aria-labelledby="announcements-title"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2
            id="announcements-title"
            className="text-xl font-semibold tracking-tight"
          >
            {activeStatus === "drafts"
              ? "Draft announcements"
              : activeStatus === "archive"
                ? "Archived announcements"
                : "Announcements"}
          </h2>
          {activeStatus === "published" && (
            <p className="text-muted-foreground mt-1 text-sm">
              {statusCounts.published}{" "}
              {statusCounts.published === 1 ? "update" : "updates"} ·{" "}
              {
                allEntries.filter(
                  (entry) =>
                    isInStatus(entry, "published") &&
                    entry.lifecycle.status === "published" &&
                    !personal.readAnnouncementIds.includes(
                      entry.announcement.id,
                    ),
                ).length
              }{" "}
              unread
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {activeStatus !== "published" && (
            <Button
              variant="ghost"
              className="min-h-11"
              onClick={() => setStatus("published")}
            >
              <ArrowLeft data-icon="inline-start" /> Back to announcements
            </Button>
          )}
          {(canCreate || managingAllowed || statusCounts.drafts > 0) && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="outline" className="min-h-11" />}
              >
                <Settings2 data-icon="inline-start" /> Manage announcements
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  {canCreate && (
                    <DropdownMenuItem
                      className="min-h-11"
                      onClick={openNewEditor}
                    >
                      <Megaphone /> New announcement
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    className="min-h-11"
                    onClick={() => setStatus("drafts")}
                  >
                    <FileText /> Drafts ({statusCounts.drafts})
                  </DropdownMenuItem>
                  {managingAllowed && (
                    <DropdownMenuItem
                      className="min-h-11"
                      onClick={() => setStatus("archive")}
                    >
                      <Archive /> Archive ({statusCounts.archive})
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>

      {preview ? (
        <Alert variant="warning">
          <p className="font-medium">Preview as {viewerName}</p>
          <p className="mt-1">
            You are viewing this board as another identity. Editing, publishing,
            and personal actions are disabled.
          </p>
        </Alert>
      ) : null}

      {notice ? (
        <Alert variant={notice.kind === "error" ? "destructive" : "success"}>
          {notice.message}
        </Alert>
      ) : null}

      <div className="flex min-w-0 flex-col gap-4">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(14rem,18rem)]">
          <Field>
            <FieldLabel htmlFor="announcement-search">
              Search announcements
            </FieldLabel>
            <InputGroup className="h-auto min-h-11">
              <InputGroupAddon>
                <Megaphone aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                id="announcement-search"
                value={search}
                onChange={(event) =>
                  setSearch(event.target.value.slice(0, 160))
                }
                placeholder="Search title, message, author, or audience"
              />
            </InputGroup>
          </Field>
          <SearchSelect
            label="Filter by author"
            value={authorFilter}
            options={[
              { value: "all", label: "All authors" },
              ...people.map((person) => ({
                value: person.id,
                label: person.name,
              })),
            ]}
            onValueChange={setAuthorFilter}
          />
        </div>
      </div>

      {filteredEntries.length === 0 &&
      activeStatus !== "published" &&
      !search.trim() &&
      authorFilter === "all" ? (
        <BoardEmpty
          title={
            activeStatus === "drafts"
              ? "No drafts yet"
              : "No archived announcements"
          }
          description={
            activeStatus === "drafts"
              ? "Start an announcement and save it as a draft."
              : "Announcements you archive will appear here."
          }
          icon={activeStatus === "drafts" ? <FileText /> : <Archive />}
        >
          {activeStatus === "drafts" && canCreate && (
            <Button className="min-h-11" onClick={openNewEditor}>
              <Megaphone data-icon="inline-start" /> New announcement
            </Button>
          )}
        </BoardEmpty>
      ) : emptyState === "first-use" ? (
        <BoardEmpty
          title="No announcements yet"
          description="Publish a short update when the team needs a shared source of truth."
          icon={<Megaphone aria-hidden="true" />}
        >
          {canCreate ? (
            <Button className="min-h-11" onClick={openNewEditor}>
              <Megaphone data-icon="inline-start" />
              Create announcement
            </Button>
          ) : null}
        </BoardEmpty>
      ) : emptyState === "filtered" ? (
        <BoardEmpty
          title="No announcements match"
          description="Try a different search or clear the current filters."
          icon={<Eye aria-hidden="true" />}
        >
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => {
              setSearch("");
              setAuthorFilter("all");
            }}
          >
            Clear filters
          </Button>
        </BoardEmpty>
      ) : emptyState === "permission" ? (
        <BoardEmpty
          title="No announcements available"
          description="Published updates will appear here when this identity has access to them."
          icon={<Eye aria-hidden="true" />}
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-4">
          {filteredEntries.map((entry) => (
            <AnnouncementCard
              key={`${activeStatus}-${entry.announcement.id}`}
              entry={entry}
              timezone={timezone}
              people={people}
              audienceLookup={audienceLookup}
              records={records}
              canEdit={
                !pending &&
                !preview &&
                canViewBoardAudience(
                  entry.announcement.audience,
                  viewer,
                  entry.announcement.authorId,
                ) &&
                (canManage || (canEdit && entry.isAuthor))
              }
              canManage={managingAllowed && canManageContent(entry)}
              preview={preview}
              viewerActive={viewer.active}
              read={personal.readAnnouncementIds.includes(
                entry.announcement.id,
              )}
              bookmarked={personal.bookmarkedAnnouncementIds.includes(
                entry.announcement.id,
              )}
              onEdit={() => openExistingEditor(entry.announcement)}
              onDelete={() => setPendingDelete(entry.announcement)}
              onAction={runAction}
              onPersonal={runPersonal}
            />
          ))}
        </div>
      )}

      {editorDraft ? (
        <EditSheet
          open
          title={editorIsNew ? "New announcement" : "Edit announcement"}
          description={
            editorMode === "preview"
              ? "Review exactly what readers will see before you save or publish."
              : "Save a private draft, then preview or publish it when the message is ready."
          }
          dirty={editorDirty}
          pending={pending}
          onClose={() => closeEditor(true)}
        >
          <AnnouncementEditor
            draft={editorDraft}
            originalAttachments={editorOriginal?.attachments ?? []}
            timezone={timezone}
            mode={editorMode}
            error={editorError}
            records={records}
            people={people}
            roles={roles}
            departments={departments}
            canPublish={
              !preview &&
              (canManage || (canEdit && editorDraft.authorId === viewer.id))
            }
            onModeChange={setEditorMode}
            onChange={updateEditor}
            onDateTimeError={(message) => {
              setEditorInputError(message);
              setEditorError(message);
            }}
            onSave={saveDraft}
            onPublish={publishDraft}
          />
        </EditSheet>
      ) : null}

      <ConfirmAction
        open={pendingDelete !== null}
        title="Delete this announcement?"
        description={
          pendingDelete
            ? `“${pendingDelete.title}” and its draft content will be permanently removed from this browser tab.`
            : "This announcement will be permanently removed from this browser tab."
        }
        action="Delete announcement"
        phrase={pendingDelete?.title}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          void confirmDelete();
        }}
        disabled={pending}
      />
    </section>
  );
}

type AnnouncementCardProps = {
  entry: FeedEntry;
  timezone: string;
  people: readonly BoardPerson[];
  audienceLookup: BoardAudienceLookup;
  records: readonly SampleRecord[];
  canEdit: boolean;
  canManage: boolean;
  preview: boolean;
  viewerActive: boolean;
  read: boolean;
  bookmarked: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onAction: (action: AnnouncementAction, message: string) => void;
  onPersonal: (change: AnnouncementPersonalAction, message: string) => void;
};

function AnnouncementCard({
  entry,
  timezone,
  people,
  audienceLookup,
  records,
  canEdit,
  canManage,
  preview,
  viewerActive,
  read,
  bookmarked,
  onEdit,
  onDelete,
  onAction,
  onPersonal,
}: AnnouncementCardProps) {
  const { announcement, lifecycle, display, showDraft } = entry;
  const titleId = `announcement-title-${announcement.id}`;
  const statusLabel = announcementStatusLabel(entry);
  const statusVariant = announcementStatusVariant(entry);
  const canPersonalize =
    !preview && viewerActive && lifecycle.status === "published";
  const hasManageActions = canManage;
  const hasActions = canEdit || hasManageActions;

  return (
    <Card className="w-full" aria-labelledby={titleId}>
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {statusLabel !== "Published" && (
              <Badge variant={statusVariant}>{statusLabel}</Badge>
            )}
            {!read && lifecycle.status === "published" && !showDraft && (
              <Badge variant="secondary">Unread</Badge>
            )}
            {announcement.pinned ? (
              <Badge variant="secondary">
                <Pin aria-hidden="true" />
                Pinned
              </Badge>
            ) : null}
            <Badge variant="outline">
              {boardAudienceLabel(display.audience, audienceLookup)}
            </Badge>
          </div>
          <CardTitle id={titleId} className="text-xl tracking-tight">
            {display.title}
          </CardTitle>
          <CardDescription className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{authorName(announcement.authorId, people)}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={display.publishedAt ?? announcement.updatedAt}>
              {formatDateTime(
                display.publishedAt ?? announcement.updatedAt,
                timezone,
              )}
            </time>
          </CardDescription>
        </div>

        {hasActions ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-11 shrink-0"
                  aria-label={`Actions for ${display.title}`}
                />
              }
            >
              <MoreHorizontal aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              aria-label={`Actions for ${display.title}`}
            >
              {canEdit ? (
                <DropdownMenuItem onClick={onEdit}>
                  <Pencil aria-hidden="true" />
                  Edit announcement
                </DropdownMenuItem>
              ) : null}
              {canManage ? (
                <DropdownMenuItem
                  onClick={() =>
                    onAction(
                      {
                        type: "pin",
                        announcementId: announcement.id,
                        pinned: !announcement.pinned,
                      },
                      announcement.pinned
                        ? "Announcement unpinned."
                        : "Announcement pinned.",
                    )
                  }
                >
                  {announcement.pinned ? (
                    <PinOff aria-hidden="true" />
                  ) : (
                    <Pin aria-hidden="true" />
                  )}
                  {announcement.pinned
                    ? "Unpin announcement"
                    : "Pin announcement"}
                </DropdownMenuItem>
              ) : null}
              {canManage && lifecycle.status === "published" && !showDraft ? (
                <DropdownMenuItem
                  onClick={() =>
                    onAction(
                      { type: "unpublish", announcementId: announcement.id },
                      "Announcement unpublished.",
                    )
                  }
                >
                  <Undo2 aria-hidden="true" />
                  Unpublish announcement
                </DropdownMenuItem>
              ) : null}
              {canManage && announcement.status !== "archived" ? (
                <DropdownMenuItem
                  onClick={() =>
                    onAction(
                      { type: "archive", announcementId: announcement.id },
                      "Announcement archived.",
                    )
                  }
                >
                  <Archive aria-hidden="true" />
                  Archive announcement
                </DropdownMenuItem>
              ) : null}
              {canManage && announcement.status === "archived" ? (
                <DropdownMenuItem
                  onClick={() =>
                    onAction(
                      { type: "restore", announcementId: announcement.id },
                      "Announcement restored.",
                    )
                  }
                >
                  <ArchiveRestore aria-hidden="true" />
                  Restore announcement
                </DropdownMenuItem>
              ) : null}
              {canManage ? <DropdownMenuSeparator /> : null}
              {canManage && announcement.status === "archived" ? (
                <DropdownMenuItem variant="destructive" onClick={onDelete}>
                  <Trash2 aria-hidden="true" />
                  Delete announcement
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        {showDraft ? (
          <Alert variant="warning">
            <p className="font-medium">Draft view</p>
            <p className="mt-1">
              {announcement.publishedRevision
                ? "Readers continue to see the last published version until this draft is published."
                : "Only people in this draft's audience who can edit or manage the board can see it."}
            </p>
          </Alert>
        ) : null}
        <p className="max-w-[72ch] text-base leading-7 whitespace-pre-wrap">
          {display.body}
        </p>
        {display.attachments.length > 0 || display.links.length > 0 ? (
          <div className="border-border/70 flex flex-col gap-3 border-t pt-4">
            <p className="text-muted-foreground flex items-center gap-2 text-xs font-medium tracking-wide uppercase">
              <FileText aria-hidden="true" />
              Supporting information
            </p>
            <ContentAttachments
              attachments={display.attachments}
              links={display.links}
              records={records}
            />
          </div>
        ) : null}
      </CardContent>

      {(canPersonalize ||
        display.expiresAt ||
        lifecycle.status === "scheduled") && (
        <CardFooter className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {canPersonalize ? (
              <>
                <Button
                  type="button"
                  variant={read ? "secondary" : "outline"}
                  className="min-h-11"
                  aria-pressed={read}
                  onClick={() =>
                    onPersonal(
                      {
                        type: "read",
                        announcementId: announcement.id,
                        read: !read,
                      },
                      read ? "Marked as unread." : "Marked as read.",
                    )
                  }
                >
                  <Check data-icon="inline-start" />
                  {read ? "Read" : "Mark as read"}
                </Button>
                <Button
                  type="button"
                  variant={bookmarked ? "secondary" : "ghost"}
                  className="min-h-11"
                  aria-pressed={bookmarked}
                  onClick={() =>
                    onPersonal(
                      {
                        type: "bookmark",
                        announcementId: announcement.id,
                        bookmarked: !bookmarked,
                      },
                      bookmarked
                        ? "Bookmark removed."
                        : "Announcement bookmarked.",
                    )
                  }
                >
                  {bookmarked ? (
                    <BookmarkCheck data-icon="inline-start" />
                  ) : (
                    <Bookmark data-icon="inline-start" />
                  )}
                  {bookmarked ? "Bookmarked" : "Bookmark"}
                </Button>
              </>
            ) : null}
          </div>
          {(display.expiresAt || lifecycle.status === "scheduled") && (
            <p className="text-muted-foreground text-sm">
              {display.expiresAt
                ? `Expires ${formatDateTime(display.expiresAt, timezone)}`
                : `Scheduled ${formatDateTime(announcement.publishAt, timezone)}`}
            </p>
          )}
        </CardFooter>
      )}
    </Card>
  );
}

type AnnouncementEditorProps = {
  draft: BoardAnnouncement;
  originalAttachments: readonly BoardAnnouncement["attachments"][number][];
  timezone: string;
  mode: EditorMode;
  error: string;
  records: readonly SampleRecord[];
  people: readonly BoardPerson[];
  roles: readonly { id: string; name: string }[];
  departments: readonly string[];
  canPublish: boolean;
  onModeChange: (mode: EditorMode) => void;
  onChange: (
    patch: Partial<
      Pick<
        BoardAnnouncement,
        | "title"
        | "body"
        | "audience"
        | "publishAt"
        | "expiresAt"
        | "attachments"
        | "links"
      >
    >,
  ) => void;
  onDateTimeError: (message: string) => void;
  onSave: () => void | Promise<unknown>;
  onPublish: () => void | Promise<unknown>;
};

function AnnouncementEditor({
  draft,
  originalAttachments,
  timezone,
  mode,
  error,
  records,
  people,
  roles,
  departments,
  canPublish,
  onModeChange,
  onChange,
  onDateTimeError,
  onSave,
  onPublish,
}: AnnouncementEditorProps) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onSave();
  }

  function updateDateTime(field: "publishAt" | "expiresAt", value: string) {
    if (!value) {
      onChange({ [field]: null });
      return;
    }
    try {
      onChange({ [field]: datetimeInputToUtc(value, timezone) });
    } catch (cause) {
      onDateTimeError(
        cause instanceof Error
          ? cause.message
          : "Choose a valid time in the workspace timezone.",
      );
    }
  }

  if (mode === "preview") {
    return (
      <div className="flex flex-col gap-5">
        <Alert variant="default">
          <p className="font-medium">Reader preview</p>
          <p className="mt-1">
            This shows the current draft. Publishing is a separate action.
          </p>
        </Alert>
        <Card>
          <CardHeader>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge variant="warning">Draft preview</Badge>
              <Badge variant="outline">
                {boardAudienceLabel(draft.audience, {
                  roles,
                  identities: people,
                  departments: departments.map((name) => ({
                    id: slug(name),
                    name,
                  })),
                })}
              </Badge>
            </div>
            <CardTitle className="text-xl tracking-tight">
              {draft.title || "Untitled announcement"}
            </CardTitle>
            <CardDescription>Preview message</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <p className="text-sm leading-7 whitespace-pre-wrap">
              {draft.body || "Your announcement message will appear here."}
            </p>
            {draft.attachments.length > 0 || draft.links.length > 0 ? (
              <ContentAttachments
                attachments={draft.attachments}
                links={draft.links}
                records={records}
              />
            ) : null}
          </CardContent>
        </Card>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-fit"
          onClick={() => onModeChange("edit")}
        >
          <Pencil data-icon="inline-start" />
          Back to editing
        </Button>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={submit}>
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      {draft.publishedRevision ? (
        <Alert variant="warning">
          <p className="font-medium">Published version stays visible</p>
          <p className="mt-1">
            Saving this update creates a draft. Readers keep seeing the
            published version until you publish again.
          </p>
        </Alert>
      ) : null}
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="announcement-editor-title">Title</FieldLabel>
          <Input
            id="announcement-editor-title"
            className="min-h-11"
            value={draft.title}
            maxLength={BOARD_INPUT_LIMITS.maxAnnouncementTitle}
            onChange={(event) => onChange({ title: event.target.value })}
            aria-invalid={Boolean(error && !draft.title.trim())}
          />
          <FieldDescription>
            Use a short headline people can scan quickly.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="announcement-editor-body">Message</FieldLabel>
          <Textarea
            id="announcement-editor-body"
            className="min-h-40"
            value={draft.body}
            maxLength={BOARD_INPUT_LIMITS.maxAnnouncementBody}
            onChange={(event) => onChange({ body: event.target.value })}
            aria-invalid={Boolean(error && !draft.body.trim())}
          />
          <FieldDescription>
            Keep the request, decision, or next step clear in the first few
            lines.
          </FieldDescription>
        </Field>
        <AudienceField
          value={draft.audience}
          onChange={(audience) => onChange({ audience })}
          people={people}
          roles={roles}
          departments={departments}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="announcement-editor-publish-at">
              Publish time
            </FieldLabel>
            <Input
              id="announcement-editor-publish-at"
              className="min-h-11"
              type="datetime-local"
              value={toDateTimeLocal(draft.publishAt, timezone)}
              onChange={(event) =>
                updateDateTime("publishAt", event.target.value)
              }
            />
            <FieldDescription>
              Leave empty to publish immediately.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="announcement-editor-expires-at">
              Expiration time
            </FieldLabel>
            <Input
              id="announcement-editor-expires-at"
              className="min-h-11"
              type="datetime-local"
              value={toDateTimeLocal(draft.expiresAt, timezone)}
              onChange={(event) =>
                updateDateTime("expiresAt", event.target.value)
              }
            />
            <FieldDescription>
              Optional. The published message disappears after this time.
            </FieldDescription>
          </Field>
        </div>
        <p className="text-muted-foreground text-xs">
          Times use the workspace timezone: {timezone}.
        </p>
        <ContentFields
          attachments={draft.attachments}
          originalAttachments={originalAttachments}
          links={draft.links}
          records={records}
          onChange={onChange}
        />
      </FieldGroup>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <div className="flex flex-wrap gap-2">
          <Button type="submit" className="min-h-11">
            <FileText data-icon="inline-start" />
            Save draft
          </Button>
          {canPublish ? (
            <Button
              type="button"
              variant="secondary"
              className="min-h-11"
              onClick={onPublish}
            >
              {isFutureTimestamp(draft.publishAt) ? (
                <CalendarClock data-icon="inline-start" />
              ) : (
                <Send data-icon="inline-start" />
              )}
              {isFutureTimestamp(draft.publishAt) ? "Schedule" : "Publish now"}
            </Button>
          ) : null}
        </div>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={() => onModeChange("preview")}
        >
          <Eye data-icon="inline-start" />
          Preview
        </Button>
      </div>
    </form>
  );
}

function announcementDisplay(
  announcement: BoardAnnouncement,
  revision: BoardAnnouncementRevision | null,
  showDraft: boolean,
): AnnouncementDisplay {
  if (showDraft || !revision) {
    return {
      title: announcement.title,
      body: announcement.body,
      attachments: announcement.attachments,
      links: announcement.links,
      audience: announcement.audience,
      publishedAt: announcement.publishAt,
      expiresAt: announcement.expiresAt,
    };
  }
  return {
    title: revision.title,
    body: revision.body,
    attachments: revision.attachments,
    links: revision.links,
    audience: revisionAudience(revision, announcement.audience),
    publishedAt: revision.publishedAt,
    expiresAt: revisionExpiresAt(revision, announcement.expiresAt),
  };
}

function announcementStatusLabel(entry: FeedEntry): string {
  if (entry.showDraft) {
    return entry.announcement.status === "scheduled" ? "Scheduled" : "Draft";
  }
  if (entry.lifecycle.status === "expired") return "Expired";
  if (entry.lifecycle.status === "archived") return "Archived";
  if (entry.lifecycle.status === "scheduled") return "Scheduled";
  return "Published";
}

function announcementStatusVariant(
  entry: FeedEntry,
): "default" | "secondary" | "success" | "warning" | "destructive" | "outline" {
  if (entry.showDraft || entry.lifecycle.status === "scheduled")
    return "warning";
  if (entry.lifecycle.status === "expired") return "outline";
  if (entry.lifecycle.status === "archived") return "secondary";
  return "success";
}

function emptyFeedState(
  allEntries: readonly FeedEntry[],
  availableEntries: readonly FeedEntry[],
  filteredEntries: readonly FeedEntry[],
  status: FeedStatus,
  search: string,
  authorFilter: string,
): "first-use" | "filtered" | "permission" | "none" {
  if (filteredEntries.length > 0) return "none";
  if (search.trim() || authorFilter !== "all") return "filtered";
  if (status === "published" && allEntries.length === 0) return "first-use";
  if (availableEntries.length === 0) return "permission";
  return "filtered";
}

function newAnnouncement(boardId: string, authorId: string): BoardAnnouncement {
  const timestamp = new Date().toISOString();
  return {
    id: createId("sample-announcement"),
    boardId,
    authorId,
    title: "",
    body: "",
    audience: { kind: "everyone" },
    status: "draft",
    publishAt: null,
    expiresAt: null,
    pinned: false,
    attachments: [],
    links: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    publishedRevision: null,
  };
}

function cloneAnnouncement(announcement: BoardAnnouncement): BoardAnnouncement {
  return {
    ...announcement,
    attachments: announcement.attachments.map((attachment) => ({
      ...attachment,
    })),
    links: announcement.links.map((link) => ({ ...link })),
    publishedRevision: announcement.publishedRevision
      ? {
          ...announcement.publishedRevision,
          attachments: announcement.publishedRevision.attachments.map(
            (attachment) => ({
              ...attachment,
            }),
          ),
          links: announcement.publishedRevision.links.map((link) => ({
            ...link,
          })),
        }
      : null,
  };
}

function prepareDraft(announcement: BoardAnnouncement): BoardAnnouncement {
  return {
    ...cloneAnnouncement(announcement),
    title: announcement.title.trim(),
    body: announcement.body.trim(),
    status: "draft",
    updatedAt: new Date().toISOString(),
  };
}

function validateAnnouncementDraft(
  announcement: BoardAnnouncement,
): string | null {
  if (!announcement.title.trim())
    return "Add a title before saving this announcement.";
  if (!announcement.body.trim())
    return "Add a message before saving this announcement.";
  if (announcement.title.length > BOARD_INPUT_LIMITS.maxAnnouncementTitle)
    return `The title must be ${BOARD_INPUT_LIMITS.maxAnnouncementTitle} characters or fewer.`;
  if (announcement.body.length > BOARD_INPUT_LIMITS.maxAnnouncementBody)
    return `The message must be ${BOARD_INPUT_LIMITS.maxAnnouncementBody} characters or fewer.`;
  if (
    announcement.publishAt &&
    announcement.expiresAt &&
    timestampValue(announcement.expiresAt) <=
      timestampValue(announcement.publishAt)
  )
    return "Expiration must be after the publish time.";
  return null;
}

function sameEditableContent(
  left: BoardAnnouncement,
  right: BoardAnnouncement,
): boolean {
  return (
    left.title === right.title &&
    left.body === right.body &&
    JSON.stringify(left.audience) === JSON.stringify(right.audience) &&
    left.publishAt === right.publishAt &&
    left.expiresAt === right.expiresAt &&
    JSON.stringify(left.attachments) === JSON.stringify(right.attachments) &&
    JSON.stringify(left.links) === JSON.stringify(right.links)
  );
}

function revisionAudience(
  revision: BoardAnnouncementRevision | null,
  fallback: BoardAudience,
): BoardAudience {
  if (!revision || typeof revision !== "object" || !("audience" in revision)) {
    return fallback;
  }
  const value: unknown = revision.audience;
  return isBoardAudience(value) ? value : fallback;
}

function revisionExpiresAt(
  revision: BoardAnnouncementRevision,
  fallback: string | null,
): string | null {
  if (!("expiresAt" in revision)) return fallback;
  const value: unknown = revision.expiresAt;
  return typeof value === "string" ? value : value === null ? null : fallback;
}

function isBoardAudience(value: unknown): value is BoardAudience {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false;
  }
  const kind = value.kind;
  if (kind === "everyone" || kind === "private") return true;
  return (
    (kind === "role" || kind === "identity" || kind === "department") &&
    "id" in value &&
    typeof value.id === "string" &&
    value.id.length > 0
  );
}

function authorName(authorId: string, people: readonly BoardPerson[]): string {
  return (
    people.find((person) => person.id === authorId)?.name ?? "Unknown author"
  );
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}

function createId(prefix: string): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}`;
}

function timestampValue(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).valueOf();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function formatDateTime(
  value: string | null | undefined,
  timezone = BOARD_TIMEZONE,
): string {
  const timestamp = timestampValue(value);
  if (!timestamp) return "unknown time";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(timestamp);
  } catch {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: BOARD_TIMEZONE,
    }).format(timestamp);
  }
}

function toDateTimeLocal(value: string | null, timezone: string): string {
  return formatDateTimeLocal(value, timezone);
}

function isFutureTimestamp(value: string | null): boolean {
  return Boolean(value) && timestampValue(value) > Date.now();
}

async function safeMutation(
  callback: () => Promise<BoardMutationResult>,
): Promise<BoardMutationResult> {
  try {
    return await callback();
  } catch {
    return {
      ok: false,
      error: "The announcement could not be updated. Try again.",
    };
  }
}
