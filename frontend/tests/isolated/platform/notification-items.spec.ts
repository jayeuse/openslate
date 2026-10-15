import { expect, test } from "@playwright/test";

import type { Notification } from "../../../src/components/systems/shared/adapters/notifications-api";
import {
  notificationPresentation,
  type NotificationPresentation,
} from "../../../src/components/systems/platform/helpers/notification-kind";
import { ids, timestamp } from "./fixtures";

// Each notification kind has a fixed label, a destination built only from the
// IDs it carries (Access changes have none), its action name and a time
// label. The http journeys keep one destination with the source titles ("six
// new kinds show exact current-source titles and destinations with only one
// scheduled date") and one Board reference ("connected inbox shows Board
// publication and reminder references without content").

const common = {
  id: ids.notification,
  subjectId: ids.result,
  status: "unread",
  createdAt: timestamp,
  readAt: null,
} as const;

const rows: {
  item: Notification;
  presentation: NotificationPresentation;
}[] = [
  {
    item: {
      ...common,
      kind: "report-run",
      subjectType: "report_run",
      scheduledFor: timestamp,
      reportId: ids.report,
      runId: ids.run,
    },
    presentation: {
      label: "Scheduled report run",
      href: `/openview?section=reports&report=${ids.report}&run=${ids.run}`,
      actionLabel: "Open report",
      timeLabel: "Scheduled",
    },
  },
  {
    item: {
      ...common,
      kind: "report-run-failed",
      subjectType: "scheduled_work",
      scheduledFor: timestamp,
      reportId: ids.report,
    },
    presentation: {
      label: "Report run failed",
      href: `/openview?section=reports&report=${ids.report}`,
      actionLabel: "Open report",
      timeLabel: "Scheduled",
    },
  },
  {
    item: {
      ...common,
      kind: "post-publish",
      subjectType: "board_post",
      scheduledFor: timestamp,
      boardId: ids.board,
      postId: ids.post,
      publicationRevisionId: ids.revision,
    },
    presentation: {
      label: "Board post",
      href: `/boards?board=${ids.board}&section=posts&post=${ids.post}`,
      actionLabel: "Open post",
      timeLabel: "Publication time",
    },
  },
  {
    item: {
      ...common,
      kind: "event-reminder",
      subjectType: "board_event",
      scheduledFor: timestamp,
      boardId: ids.board,
      eventId: ids.event,
      occurrenceId: `${ids.event}:2026-10-04`,
      occurrenceStartAt: timestamp,
    },
    presentation: {
      label: "Event reminder",
      href: `/boards?board=${ids.board}&section=calendar&event=${ids.event}`,
      actionLabel: "Open event",
      timeLabel: "Reminder due",
    },
  },
  {
    item: {
      ...common,
      kind: "backup-failed",
      subjectType: "backup_run",
      scheduledFor: null,
    },
    presentation: {
      label: "Backup failed",
      href: "/manage?view=backup",
      actionLabel: "Open backup history",
      timeLabel: "Scheduled",
    },
  },
  {
    item: {
      ...common,
      kind: "record-assigned",
      subjectType: "record",
      scheduledFor: null,
      moduleId: ids.module,
    },
    presentation: {
      label: "Record assignment",
      href: `/openview?section=views&module=${ids.module}&record=${ids.result}`,
      actionLabel: "Open record",
      timeLabel: "Scheduled",
    },
  },
  {
    item: {
      ...common,
      kind: "invitation-accepted",
      subjectType: "user",
      scheduledFor: null,
    },
    presentation: {
      label: "Invitation accepted",
      href: `/access?view=people&user=${ids.result}`,
      actionLabel: "Open person",
      timeLabel: "Scheduled",
    },
  },
  {
    item: {
      ...common,
      kind: "sandbox-published",
      subjectType: "sandbox_version",
      scheduledFor: null,
      versionSequence: 8,
    },
    presentation: {
      label: "Sandbox publication",
      href: "/sandbox?section=history",
      actionLabel: "Open version history",
      timeLabel: "Scheduled",
    },
  },
  {
    item: {
      ...common,
      kind: "access-changed",
      subjectType: "user",
      scheduledFor: null,
    },
    presentation: {
      label: "Access changed",
      href: null,
      actionLabel: "",
      timeLabel: "Scheduled",
    },
  },
];

for (const row of rows)
  test(`notification kind ${row.item.kind} has its label, destination and time label`, () => {
    expect(notificationPresentation(row.item)).toEqual(row.presentation);
  });
