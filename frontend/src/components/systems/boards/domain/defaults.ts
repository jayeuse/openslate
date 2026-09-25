import { getModuleDefinition } from "../../openview/domain/model";
import type { OpenViewWidget } from "../../openview/domain/model";
import {
  DEFAULT_BOARD_ID,
  BOARD_SNAPSHOT_DATE,
  BOARD_TIMEZONE,
  BOARD_DEFAULT_RECURRENCE_END_DATE,
} from "./model-types";
import type {
  BoardWidget,
  SampleBoard,
  BoardEvent,
  BoardAnnouncementRevision,
  BoardAnnouncement,
  BoardRecordPlacement,
  BoardPersonalState,
  BoardActivityEntry,
  BoardTemplate,
} from "./model-types";

const timestampFallback = `${BOARD_SNAPSHOT_DATE}T00:00:00.000Z`;

export function defaultWidget(
  id: string,
  type: OpenViewWidget["type"],
  size: OpenViewWidget["size"],
  pinned: boolean,
): BoardWidget {
  const moduleDefinition = getModuleDefinition("service-requests");
  return {
    id,
    name:
      type === "summary"
        ? "Request summary"
        : type === "workload"
          ? "Team workload"
          : type === "records"
            ? "OpenView records"
            : "Operations chart",
    type,
    moduleId: "service-requests",
    size,
    audience: { kind: "everyone" },
    refresh: "manual",
    pinned,
    fields: moduleDefinition.fields.slice(0, 3).map((field) => field.id),
    filters: { logic: "and", clauses: [] },
    metric: "count",
    visualization: "bar",
    permission: "Everyone",
  };
}

export const INITIAL_BOARDS: SampleBoard[] = [
  {
    id: DEFAULT_BOARD_ID,
    name: "Organization board",
    description: "A shared view of priorities, work, and important updates.",
    department: "Organization",
    status: "active",
    defaultSection: "overview",
    visibleRoleIds: ["sample-admin", "sample-member"],
    roles: ["Administrator", "Member"],
    permission: "Members can view",
    widgets: [
      defaultWidget("sample-board-summary", "summary", "half", true),
      defaultWidget("sample-board-workload", "workload", "half", false),
    ],
    createdAt: timestampFallback,
    updatedAt: timestampFallback,
  },
];

export const INITIAL_EVENTS: BoardEvent[] = [
  {
    id: "sample-event-briefing",
    boardId: DEFAULT_BOARD_ID,
    authorId: "sample-mara",
    title: "Operations weekly briefing",
    details: "Review open work and the next handoff.",
    location: "Operations room",
    start: BOARD_SNAPSHOT_DATE,
    end: BOARD_SNAPSHOT_DATE,
    allDay: true,
    timezone: BOARD_TIMEZONE,
    audience: { kind: "everyone" },
    recurrence: "weekly",
    endDate: BOARD_DEFAULT_RECURRENCE_END_DATE,
    attachments: [],
    links: [],
    archived: false,
    createdAt: timestampFallback,
    updatedAt: timestampFallback,
    date: BOARD_SNAPSHOT_DATE,
    visibility: "Organization",
  },
];

const initialAnnouncementRevision: BoardAnnouncementRevision = {
  id: "sample-announcement-welcome:published",
  authorId: "sample-mara",
  title: "Review request owners before the weekly briefing",
  body: "Request owners: Check your assigned requests in Overview. Confirm the owner and due date for each item, then raise blocked handoffs with your team before the next operations briefing.",
  audience: { kind: "everyone" },
  expiresAt: null,
  publishedAt: timestampFallback,
  createdAt: timestampFallback,
  updatedAt: timestampFallback,
  attachments: [],
  links: [],
};

export const INITIAL_ANNOUNCEMENTS: BoardAnnouncement[] = [
  {
    id: "sample-announcement-welcome",
    boardId: DEFAULT_BOARD_ID,
    authorId: "sample-mara",
    title: initialAnnouncementRevision.title,
    body: initialAnnouncementRevision.body,
    audience: { kind: "everyone" },
    status: "published",
    publishAt: timestampFallback,
    expiresAt: null,
    pinned: true,
    attachments: [],
    links: [],
    createdAt: timestampFallback,
    updatedAt: timestampFallback,
    publishedRevision: initialAnnouncementRevision,
    expires: "",
    draft: false,
    published: true,
  },
];

export const INITIAL_RECORD_PLACEMENTS: BoardRecordPlacement[] = [];
export const INITIAL_PERSONAL_STATE: BoardPersonalState = {
  identityId: "sample-mara",
  favoriteBoardIds: [],
  homeBoardId: null,
  calendarView: "month",
  readAnnouncementIds: [],
  bookmarkedAnnouncementIds: [],
  reminders: [],
};
export const INITIAL_BOARD_ACTIVITY: BoardActivityEntry[] = [];
export const INITIAL_BOARD_TEMPLATES: BoardTemplate[] = [];

// Lowercase aliases follow existing sample-model naming while uppercase
// exports make the defaults easy to discover from adapters and tests.
export const initialBoards = INITIAL_BOARDS;
export const initialEvents = INITIAL_EVENTS;
export const initialAnnouncements = INITIAL_ANNOUNCEMENTS;
export const initialRecordPlacements = INITIAL_RECORD_PLACEMENTS;
export const initialPersonalState = INITIAL_PERSONAL_STATE;
export const initialBoardActivity = INITIAL_BOARD_ACTIVITY;
export const initialBoardTemplates = INITIAL_BOARD_TEMPLATES;
