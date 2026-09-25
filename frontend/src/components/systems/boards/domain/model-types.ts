import type {
  AudienceRef,
  OpenViewModuleId,
  OpenViewWidget,
} from "../../openview/domain/model";

/**
 * Boards is still a local synthetic sample, but its stored shape is designed
 * around the same stable identifiers and explicit lifecycle fields that the
 * connected screen will eventually consume.
 */
export const DEFAULT_BOARD_ID = "sample-board-organization";
export const BOARD_SNAPSHOT_DATE = "2026-09-14";
export const BOARD_TIMEZONE = "Asia/Manila";
export const BOARD_DEFAULT_RECURRENCE_END_DATE = "2026-12-31";
export const BOARD_UNRESOLVED_PREFIX = "unresolved-board:";

export const BOARD_SECTIONS = [
  "overview",
  "calendar",
  "announcements",
] as const;
export type BoardSection = (typeof BOARD_SECTIONS)[number];
export type BoardStatus = "active" | "archived";
export type BoardRecurrence = "none" | "daily" | "weekly" | "monthly";
export type BoardAnnouncementStatus =
  "draft" | "published" | "scheduled" | "archived";
export type BoardCalendarView = "agenda" | "month";

export type BoardAudience = AudienceRef | { kind: "department"; id: string };
export type BoardAudienceLookup = {
  roles?: readonly { id: string; name: string }[];
  identities?: readonly {
    id: string;
    name: string;
    active?: boolean;
  }[];
  departments?: readonly { id: string; name: string }[];
};

export type BoardWidget = OpenViewWidget & {
  /** Legacy Boards and Access projections still read this alias. */
  permission: string;
};

export type Board = {
  id: string;
  name: string;
  description: string;
  department: string;
  status: BoardStatus;
  defaultSection: BoardSection;
  visibleRoleIds: string[];
  widgets: BoardWidget[];
  createdAt: string;
  updatedAt: string;
  /** Compatibility aliases for the pre-model Boards and Access screens. */
  roles?: string[];
  permission?: string;
};

/**
 * A fully decoded Board includes the old aliases so legacy Access consumers
 * can continue to inspect a model snapshot during the migration.
 */
export type SampleBoard = Board & {
  roles: string[];
  permission: string;
};

export type BoardAttachment = {
  id: string;
  name: string;
  size: number;
  type: string;
};

export type BoardLink = {
  id: string;
  url: string;
  label: string;
  recordId?: string;
};

export type BoardEvent = {
  id: string;
  boardId: string;
  authorId: string;
  title: string;
  details: string;
  location: string;
  start: string;
  end: string;
  allDay: boolean;
  timezone: string;
  audience: BoardAudience;
  recurrence: BoardRecurrence;
  endDate: string | null;
  attachments: BoardAttachment[];
  links: BoardLink[];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  /** Legacy Calendar editor aliases. */
  date?: string;
  visibility?: string;
  recordId?: string;
};

export type BoardAnnouncementRevision = {
  id: string;
  authorId: string;
  title: string;
  body: string;
  audience: BoardAudience;
  expiresAt: string | null;
  publishedAt: string;
  createdAt: string;
  updatedAt: string;
  attachments: BoardAttachment[];
  links: BoardLink[];
};

export type BoardAnnouncement = {
  id: string;
  boardId: string;
  authorId: string;
  title: string;
  body: string;
  audience: BoardAudience;
  status: BoardAnnouncementStatus;
  publishAt: string | null;
  expiresAt: string | null;
  pinned: boolean;
  attachments: BoardAttachment[];
  links: BoardLink[];
  createdAt: string;
  updatedAt: string;
  publishedRevision: BoardAnnouncementRevision | null;
  /** Legacy announcement editor aliases. */
  expires?: string;
  draft?: boolean;
  published?: boolean;
};

/** The old module called this value Announcement; keep that import stable. */
export type Announcement = BoardAnnouncement;

export type BoardRecordPlacement = {
  id: string;
  boardId: string;
  recordId: string;
  moduleId: OpenViewModuleId;
  position: number;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BoardReminder = {
  id: string;
  eventId: string;
  identityId: string;
  occurrenceStart: string;
  dueAt: string;
  status: "pending" | "dismissed" | "fired";
  createdAt: string;
};

export type BoardPersonalState = {
  identityId: string;
  favoriteBoardIds: string[];
  homeBoardId: string | null;
  calendarView: BoardCalendarView;
  readAnnouncementIds: string[];
  bookmarkedAnnouncementIds: string[];
  reminders: BoardReminder[];
};

export type BoardActivityEntry = {
  id: string;
  boardId: string;
  actorId: string;
  action: string;
  targetType: "board" | "widget" | "event" | "announcement" | "placement";
  targetId: string;
  detail: string;
  createdAt: string;
};

export type BoardTemplate = {
  id: string;
  name: string;
  description: string;
  department: string;
  defaultSection: BoardSection;
  widgets: BoardWidget[];
  createdAt: string;
  updatedAt: string;
};

export type BoardReference = Pick<Board, "id" | "name">;
export type BoardDecodeOptions = {
  boards?: readonly BoardReference[];
  audienceLookup?: BoardAudienceLookup;
};

export const BOARD_ATTACHMENT_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain",
  "text/csv",
] as const;

export const BOARD_INPUT_LIMITS = {
  maxBoards: 50,
  maxBoardName: 80,
  maxBoardDescription: 240,
  maxWidgets: 12,
  maxWidgetName: 80,
  maxWidgetFields: 24,
  maxFilterClauses: 8,
  maxEvents: 500,
  maxEventTitle: 100,
  maxEventDetails: 4000,
  maxAnnouncements: 500,
  maxAnnouncementTitle: 100,
  maxAnnouncementBody: 2000,
  maxAttachments: 5,
  maxAttachmentBytes: 10 * 1024 * 1024,
  maxLinks: 20,
  maxActivity: 100,
  maxTemplates: 50,
  maxTemplateName: 80,
} as const;

/** Alias used by callers that describe these as model limits. */
export const BOARD_LIMITS = BOARD_INPUT_LIMITS;
