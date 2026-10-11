import {
  archiveLibraryFile,
  downloadLibraryFile,
  getLibraryFile,
  listLibraryFiles,
  reopenLibraryFile,
  reserveLibraryFile,
  uploadLibraryFile,
} from "../../../src/components/systems/platform/adapters/library-files-api";
import {
  getNotificationUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../../../src/components/systems/shared/adapters/notifications-api";
import { describeContracts } from "./openapi-contract";

const departmentId = "00000000-0000-4000-8000-000000000001";
const fileId = "00000000-0000-4000-8000-000000000002";
const notificationId = "00000000-0000-4000-8000-000000000003";
const runId = "00000000-0000-4000-8000-000000000004";
const timestamp = "2026-10-04T18:30:00Z";
// The first identifier the schema generator writes; it keys creator_labels.
const generatedCreatorId = "01890000-0000-7000-8000-000000000001";

// A Library document always has its department and no Record or Board parent
// (backend/app/systems/platform/files/models.py:16-26, ck_files_purpose_parent).
const libraryDocument = {
  purpose: "library_document",
  department_id: departmentId,
  record_id: null,
  board_id: null,
};

describeContracts("Platform: library files and notifications", [
  {
    name: "listLibraryFiles",
    run: () => listLibraryFiles(departmentId),
    responses: {
      // The list filters by purpose and department (files/router.py:80, :86-87),
      // excludes archived files by default (common/listing/query.py:69-70),
      // labels only the creators of returned files (files/router.py:93-110)
      // and echoes the requested page (common/listing/query.py:128-135).
      "GET /api/files": {
        items: [
          {
            ...libraryDocument,
            creator_id: generatedCreatorId,
            is_deleted: false,
          },
        ],
        pagination: {
          limit: 25,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
      },
    },
  },
  {
    name: "getLibraryFile",
    run: () => getLibraryFile(departmentId, fileId),
    // The route loads the file it names (files/router.py:131).
    responses: {
      "GET /api/files/{file_id}": { ...libraryDocument, id: fileId },
    },
  },
  {
    name: "reserveLibraryFile",
    run: () =>
      reserveLibraryFile(departmentId, {
        filename: "guide.pdf",
        expectedSize: 2048,
      }),
    responses: {
      // The reservation is the request's file, awaiting its bytes
      // (files/service.py:138-140; is_deleted defaults to false,
      // core/base_model.py:35-37).
      "POST /api/files": {
        ...libraryDocument,
        filename: "guide.pdf",
        expected_size: 2048,
        state: "awaiting_upload",
        is_deleted: false,
      },
    },
  },
  {
    name: "uploadLibraryFile",
    run: () => uploadLibraryFile(departmentId, fileId, new Blob(["pdf"])),
    responses: {
      // A finished upload is the named file, ready, with the reserved size
      // and the detected media type (files/service.py:205, :219-220, :273,
      // :280).
      "PUT /api/files/{file_id}/content": {
        ...libraryDocument,
        id: fileId,
        state: "ready",
        expected_size: 3,
        actual_size: 3,
        media_type: "application/pdf",
      },
    },
  },
  {
    name: "archiveLibraryFile",
    run: () => archiveLibraryFile(departmentId, fileId),
    responses: {
      // Archive answers with the named file archived (files/service.py:317);
      // a file being removed is refused instead (files/service.py:315).
      "POST /api/files/{file_id}/archive": {
        ...libraryDocument,
        id: fileId,
        is_deleted: true,
      },
    },
  },
  {
    name: "reopenLibraryFile",
    run: () => reopenLibraryFile(departmentId, fileId),
    responses: {
      // Reopen shares the archive path with is_deleted cleared
      // (files/router.py:178, files/service.py:315-317).
      "POST /api/files/{file_id}/reopen": {
        ...libraryDocument,
        id: fileId,
        is_deleted: false,
      },
    },
  },
  {
    name: "downloadLibraryFile",
    run: () =>
      downloadLibraryFile({
        id: fileId,
        creatorId: departmentId,
        filename: "guide.pdf",
        mediaType: "application/pdf",
        expectedSize: 2048,
        actualSize: 2048,
        state: "ready",
        failureCode: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        departmentId,
        isDeleted: false,
      }),
    requestOnly: "The response is the file's bytes, not JSON",
  },
  {
    name: "getNotificationUnreadCount",
    run: () => getNotificationUnreadCount(),
  },
  {
    name: "listNotifications",
    run: () => listNotifications(),
    responses: {
      // A Report-run reference names its run as the subject
      // (scheduling/notification_router.py:263-268), and the page echoes the
      // request (common/listing/query.py:128-135).
      "GET /api/notifications": {
        items: [{ subject_id: runId, run_id: runId }],
        pagination: {
          limit: 25,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
      },
    },
  },
  {
    name: "markNotificationRead",
    run: () => markNotificationRead(notificationId),
    responses: {
      // The command answers with the named notice, now read
      // (scheduling/notification_router.py:454, :461-462, :194, :263-268).
      "POST /api/notifications/{notification_id}/read": {
        id: notificationId,
        status: "read",
        read_at: timestamp,
        subject_id: runId,
        run_id: runId,
      },
    },
  },
  {
    name: "markAllNotificationsRead",
    run: () => markAllNotificationsRead(),
  },
]);
