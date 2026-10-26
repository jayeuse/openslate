import {
  archiveBoardEvent,
  createBoardEvent,
  previewBoardEventPurge,
  purgeBoardEvent,
  listBoardEventOccurrences,
  listBoardEvents,
  listMyBoardEvents,
  readBoardEvent,
  restoreBoardEvent,
  updateBoardEvent,
} from "../../../src/components/systems/boards/adapters/board-events-api";
import {
  attachBoardFile,
  detachBoardFile,
  downloadBoardAttachment,
  listBoardAttachments,
  reserveBoardFile,
  uploadBoardFile,
} from "../../../src/components/systems/boards/adapters/board-files-api";
import { listBoardPostAuthors } from "../../../src/components/systems/boards/adapters/board-post-author-api";
import { getBoardPostManageState } from "../../../src/components/systems/boards/adapters/board-post-manage-state-api";
import {
  archiveBoardPost,
  createBoardPost,
  deleteBoardPost,
  listBoardPostRevisions,
  listBoardPosts,
  publishBoardPost,
  readBoardPost,
  readBoardPostRevision,
  restoreBoardPost,
  scheduleBoardPost,
  unpublishBoardPost,
  updateBoardPost,
} from "../../../src/components/systems/boards/adapters/board-posts-api";
import {
  addBoardRecordLink,
  listBoardRecordLinks,
  removeBoardRecordLink,
} from "../../../src/components/systems/boards/adapters/board-record-links-api";
import { describeContracts } from "./openapi-contract";

const boardId = "00000000-0000-4000-8000-000000000001";
const eventId = "00000000-0000-4000-8000-000000000002";
const postId = "00000000-0000-4000-8000-000000000003";
const fileId = "00000000-0000-4000-8000-000000000004";
const recordId = "00000000-0000-4000-8000-000000000005";
const linkId = "00000000-0000-4000-8000-000000000006";
const revisionId = "00000000-0000-4000-8000-000000000007";
const userId = "00000000-0000-4000-8000-000000000008";
const publicationKey = "00000000-0000-4000-8000-000000000009";

const versions = { boardRevision: 2, contentRevision: 3 };
const eventTarget = { kind: "event", boardId, contentId: eventId } as const;
const draftPostTarget = {
  kind: "post",
  boardId,
  contentId: postId,
  view: "draft",
} as const;
const link = { label: "Manual", url: "https://example.com/" };
const startAt = "2026-01-02T03:00:00Z";

// Overrides below keep the frontend's cross-field rules true: echoed ids,
// page counts that match the items, a timed one-off event, a draft post,
// links with real URLs, and a ready file on this Board.
const page = { limit: 25, offset: 0, count: 1, total: 1, has_more: false };
const timedEvent = {
  id: eventId,
  board_id: boardId,
  links: [link],
  all_day: false,
  start_date: null,
  end_date: null,
  start_at: startAt,
  end_at: "2026-01-02T04:00:00Z",
  recurrence: "none",
  repeat_until: null,
};
const occurrence = {
  id: `${eventId}:${startAt}`,
  event_id: eventId,
  start: startAt,
  end: "2026-01-02T04:00:00Z",
  date: "2026-01-02",
  event: timedEvent,
};
const nextOccurrence = {
  id: `${eventId}:2026-02-02T03:00:00Z`,
  event_id: eventId,
  start: "2026-02-02T03:00:00Z",
  end: "2026-02-02T04:00:00Z",
  date: "2026-02-02",
};
const draftPost = {
  id: postId,
  board_id: boardId,
  links: [link],
  status: "draft",
  publish_at: null,
  post_revision: 1,
  publication_number: null,
  published_at: null,
};
const readyFile = {
  // Board file routes serve only Board attachments; the backend enum is shared.
  purpose: "board_attachment",
  id: fileId,
  board_id: boardId,
  state: "ready",
  record_id: null,
  department_id: null,
  is_deleted: false,
};
const recordLink = { record_id: recordId, available: false, url: null };

describeContracts("Boards: events, posts, files and record links", [
  {
    name: "listBoardEvents",
    run: () =>
      listBoardEvents(boardId, {
        limit: 25,
        offset: 0,
        sortBy: "title",
        sortOrder: "asc",
        archived: "all",
        search: "pump",
      }),
    responses: {
      "GET /api/boards/{board_id}/events": {
        items: [timedEvent],
        pagination: page,
      },
    },
  },
  {
    name: "listMyBoardEvents",
    run: () => listMyBoardEvents(boardId, { search: "pump" }),
    responses: {
      "GET /api/boards/{board_id}/events/mine": {
        items: [timedEvent],
        pagination: page,
      },
    },
  },
  {
    name: "readBoardEvent",
    run: () => readBoardEvent(boardId, eventId),
    responses: { "GET /api/boards/{board_id}/events/{event_id}": timedEvent },
  },
  {
    name: "createBoardEvent",
    run: () =>
      createBoardEvent(boardId, {
        boardRevision: 2,
        title: "Pump check",
        details: "Monthly",
        location: "Plant room",
        links: [link],
        allDay: false,
        startAt,
        endAt: "2026-01-02T04:00:00Z",
        timezoneName: "Asia/Manila",
        recurrence: "weekly",
        repeatUntil: "2026-03-01",
        reminders: ["15m"],
      }),
  },
  {
    name: "updateBoardEvent",
    run: () =>
      updateBoardEvent(boardId, eventId, {
        boardRevision: 2,
        eventRevision: 3,
        title: "Pump check",
        details: "Monthly",
        location: "Plant room",
        links: [link],
        allDay: true,
        startDate: "2026-01-02",
        endDate: "2026-01-03",
        startAt: null,
        endAt: null,
        timezoneName: "Asia/Manila",
        recurrence: "none",
        repeatUntil: null,
        reminders: ["1d"],
      }),
    responses: {
      "PATCH /api/boards/{board_id}/events/{event_id}": { id: eventId },
    },
  },
  {
    name: "archiveBoardEvent",
    run: () => archiveBoardEvent(boardId, eventId, 2, 3),
    responses: {
      "POST /api/boards/{board_id}/events/{event_id}/archive": { id: eventId },
    },
  },
  {
    name: "restoreBoardEvent",
    run: () => restoreBoardEvent(boardId, eventId, 2, 3),
    responses: {
      "POST /api/boards/{board_id}/events/{event_id}/restore": { id: eventId },
    },
  },
  {
    name: "previewBoardEventPurge",
    run: () => previewBoardEventPurge(boardId, eventId),
    responses: {
      "POST /api/boards/{board_id}/events/{event_id}/purge/preview": {
        impact: {
          target_type: "board_event",
          target_id: eventId,
          operation: "purge",
          impact_digest: "a".repeat(64),
        },
        confirmation_name: "Planning",
        last_successful_backup_at: null,
      },
    },
  },
  {
    name: "purgeBoardEvent",
    run: () =>
      purgeBoardEvent(boardId, eventId, {
        token: "token",
        confirmationName: "Planning",
        password: "password",
      }),
    responses: {
      "POST /api/boards/{board_id}/events/{event_id}/purge": {
        impact: {
          target_type: "board_event",
          target_id: eventId,
          operation: "purge",
          impact_digest: "a".repeat(64),
        },
      },
    },
  },
  {
    name: "listBoardEventOccurrences",
    run: () =>
      listBoardEventOccurrences(boardId, {
        windowStart: "2026-01-01",
        windowEnd: "2026-01-31",
        limit: 100,
        offset: 0,
        search: "pump",
      }),
    responses: {
      "GET /api/boards/{board_id}/events/occurrences": {
        items: [occurrence],
        next_occurrence: nextOccurrence,
        pagination: page,
      },
    },
  },
  {
    name: "listBoardPosts",
    run: () =>
      listBoardPosts(boardId, {
        view: "draft",
        limit: 25,
        offset: 0,
        sortBy: "title",
        sortOrder: "asc",
        search: "notice",
        authorId: userId,
      }),
    responses: {
      "GET /api/boards/{board_id}/posts": {
        items: [draftPost],
        pagination: page,
      },
    },
  },
  {
    name: "readBoardPost",
    run: () => readBoardPost(boardId, postId, "draft"),
    responses: { "GET /api/boards/{board_id}/posts/{post_id}": draftPost },
  },
  {
    name: "createBoardPost",
    run: () =>
      createBoardPost(boardId, {
        boardRevision: 2,
        title: "Notice",
        body: "Closed on Friday",
        links: [link],
        expiresAt: "2026-02-01T00:00:00Z",
        pinned: true,
      }),
  },
  {
    name: "updateBoardPost",
    run: () =>
      updateBoardPost(boardId, postId, {
        boardRevision: 2,
        postRevision: 3,
        title: "Notice",
        body: "Closed on Friday",
        links: [link],
        expiresAt: null,
        pinned: false,
      }),
    responses: {
      "PATCH /api/boards/{board_id}/posts/{post_id}": { id: postId },
    },
  },
  {
    name: "scheduleBoardPost",
    run: () =>
      scheduleBoardPost(boardId, postId, {
        boardRevision: 2,
        postRevision: 3,
        publishAt: "2026-02-01T00:00:00Z",
      }),
    responses: {
      "POST /api/boards/{board_id}/posts/{post_id}/schedule": { id: postId },
    },
  },
  {
    name: "publishBoardPost",
    run: () =>
      publishBoardPost(boardId, postId, {
        boardRevision: 2,
        postRevision: 3,
        publicationKey,
      }),
    responses: {
      "POST /api/boards/{board_id}/posts/{post_id}/publish": {
        post_id: postId,
        publication_key: publicationKey,
      },
    },
  },
  {
    name: "unpublishBoardPost",
    run: () => unpublishBoardPost(boardId, postId, 2, 3),
    responses: {
      "POST /api/boards/{board_id}/posts/{post_id}/unpublish": { id: postId },
    },
  },
  {
    name: "archiveBoardPost",
    run: () => archiveBoardPost(boardId, postId, 2, 3),
    responses: {
      "POST /api/boards/{board_id}/posts/{post_id}/archive": { id: postId },
    },
  },
  {
    name: "restoreBoardPost",
    run: () => restoreBoardPost(boardId, postId, 2, 3),
    responses: {
      "POST /api/boards/{board_id}/posts/{post_id}/restore": { id: postId },
    },
  },
  {
    name: "deleteBoardPost",
    run: () => deleteBoardPost(boardId, postId, 2, 3),
    // An archived outcome keeps the post revision; only a deletion drops it.
    responses: {
      "DELETE /api/boards/{board_id}/posts/{post_id}": {
        id: postId,
        outcome: "archived",
        post_revision: 4,
      },
    },
  },
  {
    name: "listBoardPostRevisions",
    run: () => listBoardPostRevisions(boardId, postId),
    responses: {
      "GET /api/boards/{board_id}/posts/{post_id}/revisions": {
        post_id: postId,
        items: [{ post_id: postId }],
      },
    },
  },
  {
    name: "readBoardPostRevision",
    run: () => readBoardPostRevision(boardId, postId, revisionId),
    responses: {
      "GET /api/boards/{board_id}/posts/{post_id}/revisions/{revision_id}": {
        id: revisionId,
        post_id: postId,
        links: [link],
      },
    },
  },
  {
    name: "listBoardPostAuthors",
    run: () => listBoardPostAuthors(boardId),
    responses: {
      // Echo the requested page and keep counts consistent with its generated item.
      "GET /api/boards/{board_id}/post-authors": { pagination: page },
    },
  },
  {
    name: "getBoardPostManageState",
    run: () => getBoardPostManageState(boardId, postId),
    responses: {
      // The backend declares status as a plain string; the frontend names the four states.
      "GET /api/boards/{board_id}/posts/{post_id}/manage-state": {
        id: postId,
        status: "draft",
      },
    },
  },
  {
    name: "reserveBoardFile",
    run: () =>
      reserveBoardFile(boardId, { filename: "manual.pdf", expectedSize: 2048 }),
    responses: { "POST /api/boards/{board_id}/files": readyFile },
  },
  {
    name: "uploadBoardFile",
    run: () => uploadBoardFile(boardId, fileId, new Blob(["pdf"])),
    responses: {
      "PUT /api/boards/{board_id}/files/{file_id}/content": readyFile,
    },
  },
  {
    name: "listBoardAttachments",
    run: () =>
      listBoardAttachments(
        { ...draftPostTarget, view: "published" },
        { limit: 25, offset: 0 },
      ),
    responses: {
      "GET /api/boards/{board_id}/posts/{post_id}/attachments": {
        items: [readyFile],
      },
    },
  },
  {
    name: "attachBoardFile",
    run: () => attachBoardFile(eventTarget, fileId, versions),
    responses: {
      "POST /api/boards/{board_id}/events/{event_id}/attachments": readyFile,
    },
  },
  {
    name: "detachBoardFile",
    run: () => detachBoardFile(draftPostTarget, fileId, versions),
  },
  {
    name: "downloadBoardAttachment",
    run: () => downloadBoardAttachment(eventTarget, fileId, 2048),
    requestOnly: "The response is the file's bytes, not JSON",
  },
  {
    name: "listBoardRecordLinks",
    run: () => listBoardRecordLinks(draftPostTarget, 0),
    // The page size is fixed at 20 and must echo the requested offset.
    responses: {
      "GET /api/boards/{board_id}/posts/{post_id}/record-links": {
        items: [recordLink],
        limit: 20,
        offset: 0,
      },
    },
  },
  {
    name: "addBoardRecordLink",
    run: () => addBoardRecordLink(eventTarget, recordId, versions),
    responses: {
      "POST /api/boards/{board_id}/events/{event_id}/record-links": recordLink,
    },
  },
  {
    name: "removeBoardRecordLink",
    run: () => removeBoardRecordLink(draftPostTarget, linkId, versions),
  },
]);
