import {
  BOARD_ATTACHMENT_TYPES,
  BOARD_INPUT_LIMITS,
  type Board,
  type BoardActivityEntry,
  type BoardAnnouncement,
  type BoardAudience,
  type BoardAudienceLookup,
  type BoardEvent,
  type BoardPersonalState,
  type BoardRecordPlacement,
  type BoardTemplate,
} from "./model";
import {
  exportBoardConfiguration,
  parseBoardConfiguration,
} from "../adapters/portability";
import {
  canViewBoardAudience,
  getAnnouncementLifecycle,
  type BoardViewer,
  validateBoardEvent,
  validateBoardAnnouncement,
} from "./content";
import { safeBoardUrl } from "../adapters/files";

export type BoardsState = {
  boards: Board[];
  events: BoardEvent[];
  announcements: BoardAnnouncement[];
  placements: BoardRecordPlacement[];
  personal: Record<string, BoardPersonalState>;
  templates: BoardTemplate[];
  activity: BoardActivityEntry[];
};
export type BoardMutationResult =
  { ok: true; id?: string } | { ok: false; error: string };
export type BoardCommand =
  | { type: "create-board"; board: Board }
  | { type: "save-board"; original: Board; draft: Board }
  | {
      type: "board-action";
      boardId: string;
      action: "archive" | "restore" | "delete";
    }
  | { type: "save-event"; event: BoardEvent; original?: BoardEvent }
  | {
      type: "event-action";
      boardId: string;
      eventId: string;
      action: "archive" | "restore" | "delete";
    }
  | {
      type: "save-announcement";
      announcement: BoardAnnouncement;
      original?: BoardAnnouncement;
      intent: "draft" | "publish" | "schedule";
    }
  | {
      type: "announcement-action";
      boardId: string;
      announcementId: string;
      action: "pin" | "unpin" | "unpublish" | "archive" | "restore" | "delete";
    }
  | { type: "place-record"; placement: BoardRecordPlacement }
  | { type: "remove-placement"; boardId: string; placementId: string }
  | { type: "personal"; value: BoardPersonalState }
  | { type: "save-template"; template: BoardTemplate }
  | { type: "delete-template"; templateId: string };
export type BoardCommandContext = {
  actorId: string;
  preview: boolean;
  now: string;
  id: string;
  viewer: BoardViewer;
  can: (
    boardId: string | null,
    permission: "view" | "edit" | "manage",
  ) => boolean;
  audienceLookup: BoardAudienceLookup;
  recordIds: readonly string[];
};
export type BoardCommandOutcome = {
  state: BoardsState;
  result: BoardMutationResult;
};
export function executeBoardCommand(
  state: BoardsState,
  command: BoardCommand,
  context: BoardCommandContext,
): BoardCommandOutcome {
  const fail = (error: string): BoardCommandOutcome => ({
    state,
    result: { ok: false, error },
  });
  if (context.preview)
    return fail("Leave the read-only preview before making changes.");
  const actor = context.audienceLookup.identities?.find(
    (person) => person.id === context.actorId,
  );
  if (!actor || actor.active === false)
    return fail(
      "This identity is unavailable. Choose an active identity in Access.",
    );
  if (context.viewer.id !== context.actorId || !context.viewer.active)
    return fail(
      "This identity is unavailable. Choose an active identity in Access.",
    );
  function canViewAudience(audience: BoardAudience, authorId: string): boolean {
    return canViewBoardAudience(audience, context.viewer, authorId);
  }
  function canViewAnnouncementDraft(announcement: BoardAnnouncement): boolean {
    return canViewAudience(announcement.audience, announcement.authorId);
  }
  function canViewAnnouncementWhole(announcement: BoardAnnouncement): boolean {
    const revision = getAnnouncementLifecycle(
      announcement,
      context.now,
    ).revision;
    return (
      canViewAnnouncementDraft(announcement) &&
      (revision === null ||
        canViewAudience(revision.audience, announcement.authorId))
    );
  }
  function success(
    next: BoardsState,
    boardId: string,
    action: string,
    targetType: BoardActivityEntry["targetType"],
    targetId: string,
    detail: string,
  ): BoardCommandOutcome {
    return {
      state: {
        ...next,
        activity: [
          {
            id: context.id,
            boardId,
            actorId: context.actorId,
            action,
            targetType,
            targetId,
            detail,
            createdAt: context.now,
          },
          ...next.activity,
        ].slice(0, 100),
      },
      result: { ok: true, id: targetId },
    };
  }
  function validAudience(audience: BoardAudience): boolean {
    if (audience.kind === "private") return !audience.unresolved;
    if (audience.kind === "everyone") return true;
    if (audience.kind === "role")
      return (
        context.audienceLookup.roles?.some((role) => role.id === audience.id) ??
        false
      );
    if (audience.kind === "department")
      return (
        context.audienceLookup.departments?.some(
          (department) => department.id === audience.id,
        ) ?? false
      );
    return (
      context.audienceLookup.identities?.some(
        (person) => person.id === audience.id && person.active !== false,
      ) ?? false
    );
  }
  function validContent(
    content: Pick<BoardEvent, "links" | "attachments" | "audience">,
  ): boolean {
    return (
      validAudience(content.audience) &&
      content.links.length <= BOARD_INPUT_LIMITS.maxLinks &&
      content.attachments.length <= 5 &&
      content.attachments.every(
        (file) =>
          file.id.length > 0 &&
          file.name.trim().length > 0 &&
          file.name.length <= 240 &&
          BOARD_ATTACHMENT_TYPES.some((type) => type === file.type) &&
          Number.isSafeInteger(file.size) &&
          file.size >= 0 &&
          file.size <= 10 * 1024 * 1024,
      ) &&
      content.links.every((link) =>
        link.recordId
          ? context.recordIds.includes(link.recordId)
          : safeBoardUrl(link.url) !== null,
      )
    );
  }
  function boardWritable(
    boardId: string,
    permission: "edit" | "manage",
  ): Board | undefined {
    return state.boards.find(
      (board) =>
        board.id === boardId &&
        board.status === "active" &&
        context.can(boardId, "view") &&
        (context.can(boardId, permission) || context.can(boardId, "manage")),
    );
  }
  if (command.type === "personal") {
    if (command.value.identityId !== context.actorId)
      return fail("Personal settings belong to the current identity.");
    const previous = state.personal[context.actorId];
    const newlyPersonalized = new Set([
      ...command.value.readAnnouncementIds.filter(
        (id) => !previous?.readAnnouncementIds.includes(id),
      ),
      ...command.value.bookmarkedAnnouncementIds.filter(
        (id) => !previous?.bookmarkedAnnouncementIds.includes(id),
      ),
    ]);
    for (const announcementId of newlyPersonalized) {
      const announcement = state.announcements.find(
        (item) => item.id === announcementId,
      );
      const board = state.boards.find(
        (item) => item.id === announcement?.boardId,
      );
      const lifecycle = announcement
        ? getAnnouncementLifecycle(announcement, context.now)
        : null;
      if (
        !announcement ||
        !board ||
        board.status !== "active" ||
        !context.can(board.id, "view") ||
        lifecycle?.status !== "published" ||
        !lifecycle.visible ||
        !lifecycle.revision ||
        !canViewAudience(lifecycle.revision.audience, announcement.authorId)
      )
        return fail("This announcement is no longer available.");
    }
    return {
      state: {
        ...state,
        personal: { ...state.personal, [context.actorId]: command.value },
      },
      result: { ok: true },
    };
  }
  if (command.type === "create-board") {
    if (!context.can(null, "manage"))
      return fail("Board creation requires manage access.");
    if (state.boards.length >= BOARD_INPUT_LIMITS.maxBoards)
      return fail(
        "Archive and remove an unused board before creating another.",
      );
    if (
      !command.board.name.trim() ||
      command.board.name.length > 80 ||
      state.boards.some((board) => board.id === command.board.id)
    )
      return fail("Enter a board name up to 80 characters and try again.");
    if (!parseBoardConfiguration(exportBoardConfiguration(command.board)).ok)
      return fail(
        "The board configuration contains unavailable fields or sources.",
      );
    const board = {
      ...command.board,
      visibleRoleIds: [],
      roles: [],
      permission: "Administrators only",
      status: "active" as const,
      createdAt: context.now,
      updatedAt: context.now,
    };
    return success(
      { ...state, boards: [...state.boards, board] },
      board.id,
      "Created board",
      "board",
      board.id,
      board.name,
    );
  }
  if (command.type === "save-board") {
    const current = boardWritable(command.original.id, "edit");
    if (!current || command.draft.id !== current.id)
      return fail(
        "This board is unavailable, archived, or no longer editable.",
      );
    const keys = [
      "name",
      "description",
      "department",
      "defaultSection",
      "visibleRoleIds",
      "widgets",
    ] as const;
    const changed = keys.filter(
      (key) =>
        JSON.stringify(command.original[key]) !==
        JSON.stringify(command.draft[key]),
    );
    if (
      changed.some((key) => key !== "widgets") &&
      !context.can(current.id, "manage")
    )
      return fail("Board settings require manage access.");
    if (
      changed.some(
        (key) =>
          JSON.stringify(current[key]) !==
          JSON.stringify(command.original[key]),
      )
    )
      return fail(
        "This board changed while you were editing. Keep your draft open, then reload the latest board before saving.",
      );
    if (
      !command.draft.name.trim() ||
      command.draft.name.length > 80 ||
      command.draft.description.length > BOARD_INPUT_LIMITS.maxBoardDescription
    )
      return fail("Check the board name and description lengths.");
    if (
      command.draft.visibleRoleIds.some(
        (id) => !context.audienceLookup.roles?.some((role) => role.id === id),
      ) ||
      command.draft.widgets.some((widget) => !validAudience(widget.audience))
    )
      return fail("Choose available roles and widget audiences before saving.");
    if (!parseBoardConfiguration(exportBoardConfiguration(command.draft)).ok)
      return fail(
        "Check the widget sources, fields, filters, and 12-widget limit.",
      );
    const next = { ...current, updatedAt: context.now };
    for (const key of changed)
      Object.assign(next, { [key]: structuredClone(command.draft[key]) });
    if (changed.includes("visibleRoleIds"))
      next.roles = (context.audienceLookup.roles ?? [])
        .filter((role) => next.visibleRoleIds.includes(role.id))
        .map((role) => role.name);
    return success(
      {
        ...state,
        boards: state.boards.map((board) =>
          board.id === current.id ? next : board,
        ),
      },
      current.id,
      "Saved board",
      "board",
      current.id,
      current.name,
    );
  }
  if (command.type === "board-action") {
    const board = state.boards.find((item) => item.id === command.boardId);
    if (!board || !context.can(board.id, "manage"))
      return fail(
        "This board is unavailable or cannot be managed by this identity.",
      );
    if (command.action !== "delete") {
      const status = command.action === "archive" ? "archived" : "active";
      return success(
        {
          ...state,
          boards: state.boards.map((item) =>
            item.id === board.id
              ? { ...item, status, updatedAt: context.now }
              : item,
          ),
        },
        board.id,
        command.action === "archive" ? "Archived board" : "Restored board",
        "board",
        board.id,
        board.name,
      );
    }
    if (board.status !== "archived")
      return fail("Archive this board before permanently deleting it.");
    const announcementIds = new Set(
      state.announcements
        .filter((item) => item.boardId === board.id)
        .map((item) => item.id),
    );
    const eventIds = new Set(
      state.events
        .filter((item) => item.boardId === board.id)
        .map((item) => item.id),
    );
    const personal = Object.fromEntries(
      Object.entries(state.personal).map(([id, value]) => [
        id,
        {
          ...value,
          favoriteBoardIds: value.favoriteBoardIds.filter(
            (item) => item !== board.id,
          ),
          homeBoardId:
            value.homeBoardId === board.id ? null : value.homeBoardId,
          readAnnouncementIds: value.readAnnouncementIds.filter(
            (item) => !announcementIds.has(item),
          ),
          bookmarkedAnnouncementIds: value.bookmarkedAnnouncementIds.filter(
            (item) => !announcementIds.has(item),
          ),
          reminders: value.reminders.filter(
            (item) => !eventIds.has(item.eventId),
          ),
        },
      ]),
    );
    return success(
      {
        ...state,
        boards: state.boards.filter((item) => item.id !== board.id),
        events: state.events.filter((item) => item.boardId !== board.id),
        announcements: state.announcements.filter(
          (item) => item.boardId !== board.id,
        ),
        placements: state.placements.filter(
          (item) => item.boardId !== board.id,
        ),
        personal,
      },
      board.id,
      "Deleted board",
      "board",
      board.id,
      board.name,
    );
  }
  if (command.type === "save-event") {
    const event = command.event;
    if (!boardWritable(event.boardId, "edit"))
      return fail("This board is archived or you cannot edit its events.");
    const existing = state.events.find((item) => item.id === event.id);
    if (existing?.archived)
      return fail("Restore this archived event before editing it.");
    if (existing && !canViewAudience(existing.audience, existing.authorId))
      return fail("This event is unavailable or you cannot change it.");
    if (
      existing &&
      (existing.boardId !== event.boardId ||
        (existing.authorId !== context.actorId &&
          !context.can(event.boardId, "manage")))
    )
      return fail(
        "You can edit your own events. Managing another author's event requires manage access.",
      );
    if (
      command.original &&
      (!existing || existing.updatedAt !== command.original.updatedAt)
    )
      return fail(
        "This event changed or was removed. Reopen it before saving.",
      );
    const validation = validateBoardEvent(event);
    if (!validation.ok) return fail(validation.error);
    if (!validContent(event))
      return fail("Choose available audience, files, and links before saving.");
    if (!existing && state.events.length >= BOARD_INPUT_LIMITS.maxEvents)
      return fail("Remove an unused event before creating another.");
    const next = {
      ...event,
      authorId: existing?.authorId ?? context.actorId,
      createdAt: existing?.createdAt ?? context.now,
      updatedAt: context.now,
    };
    return success(
      {
        ...state,
        events: existing
          ? state.events.map((item) => (item.id === event.id ? next : item))
          : [...state.events, next],
      },
      event.boardId,
      existing ? "Updated event" : "Created event",
      "event",
      event.id,
      event.title,
    );
  }
  if (command.type === "event-action") {
    if (!context.can(command.boardId, "manage"))
      return fail(
        "Archiving, restoring, and deleting events requires manage access.",
      );
    const event = state.events.find(
      (item) => item.id === command.eventId && item.boardId === command.boardId,
    );
    if (
      !event ||
      !boardWritable(command.boardId, "edit") ||
      !canViewAudience(event.audience, event.authorId) ||
      (event.authorId !== context.actorId &&
        !context.can(command.boardId, "manage"))
    )
      return fail("This event is unavailable or you cannot change it.");
    if (command.action === "delete" && !event.archived)
      return fail("Archive this event before deleting it permanently.");
    const personal =
      command.action === "delete"
        ? Object.fromEntries(
            Object.entries(state.personal).map(([identityId, value]) => [
              identityId,
              {
                ...value,
                reminders: value.reminders.filter(
                  (item) => item.eventId !== event.id,
                ),
              },
            ]),
          )
        : state.personal;
    return success(
      {
        ...state,
        events:
          command.action === "delete"
            ? state.events.filter((item) => item.id !== event.id)
            : state.events.map((item) =>
                item.id === event.id
                  ? {
                      ...item,
                      archived: command.action === "archive",
                      updatedAt: context.now,
                    }
                  : item,
              ),
        personal,
      },
      command.boardId,
      `${command.action === "delete" ? "Deleted" : command.action === "archive" ? "Archived" : "Restored"} event`,
      "event",
      event.id,
      event.title,
    );
  }
  if (command.type === "save-announcement") {
    const announcement = command.announcement;
    if (!boardWritable(announcement.boardId, "edit"))
      return fail("This board is archived or you cannot publish here.");
    const existing = state.announcements.find(
      (item) => item.id === announcement.id,
    );
    if (existing?.status === "archived")
      return fail("Restore this archived announcement before editing it.");
    if (existing && !canViewAnnouncementDraft(existing))
      return fail("This announcement is unavailable or you cannot change it.");
    if (
      existing &&
      (existing.boardId !== announcement.boardId ||
        (existing.authorId !== context.actorId &&
          !context.can(announcement.boardId, "manage")))
    )
      return fail(
        "You can publish your own announcements. Moderating another author requires manage access.",
      );
    if (
      command.original &&
      (!existing || existing.updatedAt !== command.original.updatedAt)
    )
      return fail(
        "This announcement changed or was removed. Reopen it before saving.",
      );
    const validation = validateBoardAnnouncement(
      announcement,
      command.intent,
      context.now,
    );
    if (!validation.ok) return fail(validation.error);
    if (!validContent(announcement))
      return fail("Choose available audience, files, and links before saving.");
    if (
      !existing &&
      state.announcements.length >= BOARD_INPUT_LIMITS.maxAnnouncements
    )
      return fail("Remove an unused announcement before creating another.");
    const authorId = existing?.authorId ?? context.actorId;
    const next: BoardAnnouncement = {
      ...announcement,
      authorId,
      pinned: context.can(announcement.boardId, "manage")
        ? announcement.pinned
        : (existing?.pinned ?? false),
      status:
        command.intent === "publish"
          ? "published"
          : command.intent === "schedule"
            ? "scheduled"
            : "draft",
      publishAt:
        command.intent === "publish" ? context.now : announcement.publishAt,
      createdAt: existing?.createdAt ?? context.now,
      updatedAt: context.now,
      publishedRevision:
        command.intent === "publish"
          ? {
              id: `${announcement.id}:${context.id}`,
              authorId,
              title: announcement.title,
              body: announcement.body,
              audience: announcement.audience,
              expiresAt: announcement.expiresAt,
              publishedAt: context.now,
              createdAt: existing?.createdAt ?? context.now,
              updatedAt: context.now,
              attachments: structuredClone(announcement.attachments),
              links: structuredClone(announcement.links),
            }
          : existing
            ? getAnnouncementLifecycle(existing, context.now).revision
            : null,
    };
    return success(
      {
        ...state,
        announcements: existing
          ? state.announcements.map((item) =>
              item.id === announcement.id ? next : item,
            )
          : [...state.announcements, next],
      },
      announcement.boardId,
      command.intent === "publish"
        ? "Published announcement"
        : command.intent === "schedule"
          ? "Scheduled announcement"
          : "Saved draft",
      "announcement",
      announcement.id,
      announcement.title,
    );
  }
  if (command.type === "announcement-action") {
    if (
      ["archive", "restore", "delete"].includes(command.action) &&
      !context.can(command.boardId, "manage")
    )
      return fail("Announcement lifecycle changes require manage access.");
    const item = state.announcements.find(
      (entry) =>
        entry.id === command.announcementId &&
        entry.boardId === command.boardId,
    );
    if (
      !item ||
      !boardWritable(command.boardId, "edit") ||
      !canViewAnnouncementWhole(item) ||
      (item.authorId !== context.actorId &&
        !context.can(command.boardId, "manage"))
    )
      return fail("This announcement is unavailable or you cannot change it.");
    if (
      (command.action === "pin" || command.action === "unpin") &&
      !context.can(command.boardId, "manage")
    )
      return fail("Pinning announcements requires manage access.");
    if (command.action === "delete" && item.status !== "archived")
      return fail("Archive this announcement before deleting it permanently.");
    const next = { ...item, updatedAt: context.now };
    if (command.action === "pin" || command.action === "unpin")
      next.pinned = command.action === "pin";
    else if (command.action === "restore") {
      next.status = item.publishedRevision ? "published" : "draft";
      next.publishAt = item.publishedRevision?.publishedAt ?? null;
    } else if (command.action === "unpublish") {
      next.status = "draft";
      next.publishedRevision = null;
      next.publishAt = null;
    } else if (command.action === "archive") {
      next.publishedRevision = getAnnouncementLifecycle(
        item,
        context.now,
      ).revision;
      next.status = "archived";
    }
    return success(
      {
        ...state,
        announcements:
          command.action === "delete"
            ? state.announcements.filter((entry) => entry.id !== item.id)
            : state.announcements.map((entry) =>
                entry.id === item.id ? next : entry,
              ),
      },
      command.boardId,
      `${command.action[0].toUpperCase()}${command.action.slice(1)} announcement`,
      "announcement",
      item.id,
      item.title,
    );
  }
  if (command.type === "place-record") {
    const placement = command.placement;
    if (
      !boardWritable(placement.boardId, "edit") ||
      !context.recordIds.includes(placement.recordId)
    )
      return fail("This board or record is unavailable.");
    if (
      state.placements.some(
        (item) =>
          item.boardId === placement.boardId &&
          item.recordId === placement.recordId,
      )
    )
      return fail("This record is already on the board.");
    const nextPlacement = {
      ...placement,
      position: state.placements.filter(
        (item) => item.boardId === placement.boardId,
      ).length,
      updatedAt: context.now,
    };
    return success(
      { ...state, placements: [...state.placements, nextPlacement] },
      placement.boardId,
      "Added record",
      "placement",
      placement.id,
      placement.recordId,
    );
  }
  if (command.type === "remove-placement") {
    const placement = state.placements.find(
      (item) =>
        item.id === command.placementId && item.boardId === command.boardId,
    );
    if (!placement || !boardWritable(command.boardId, "edit"))
      return fail("This record placement is unavailable or cannot be edited.");
    return success(
      {
        ...state,
        placements: state.placements.filter((item) => item.id !== placement.id),
      },
      command.boardId,
      "Removed record",
      "placement",
      placement.id,
      placement.recordId,
    );
  }
  if (!context.can(null, "manage"))
    return fail("Template management requires manage access.");
  if (command.type === "save-template") {
    if (
      !command.template.name.trim() ||
      command.template.name.length > 80 ||
      !parseBoardConfiguration(exportBoardConfiguration(command.template)).ok
    )
      return fail("Check the template name and widget configuration.");
    const template = {
      ...command.template,
      widgets: command.template.widgets.map((widget) => ({
        ...widget,
        audience: { kind: "private" as const },
        permission: "Only me",
      })),
    };
    return {
      state: {
        ...state,
        templates: [
          ...state.templates.filter((item) => item.id !== template.id),
          template,
        ].slice(-BOARD_INPUT_LIMITS.maxTemplates),
      },
      result: { ok: true, id: template.id },
    };
  }
  return {
    state: {
      ...state,
      templates: state.templates.filter(
        (item) => item.id !== command.templateId,
      ),
    },
    result: { ok: true },
  };
}
