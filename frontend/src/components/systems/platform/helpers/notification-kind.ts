import type { Notification } from "../../shared/adapters/notifications-api";

export type NotificationPresentation = {
  label: string;
  href: string | null;
  actionLabel: string;
  timeLabel: string;
};

/** The label, destination, action and time label of each notification kind. */
export function notificationPresentation(
  item: Notification,
): NotificationPresentation {
  let label: string, href: string | null, actionLabel: string;
  switch (item.kind) {
    case "report-run":
      label = "Scheduled report run";
      href = `/openview?section=reports&report=${item.reportId}&run=${item.runId}`;
      actionLabel = "Open report";
      break;
    case "report-run-failed":
      label = "Report run failed";
      href = `/openview?section=reports&report=${item.reportId}`;
      actionLabel = "Open report";
      break;
    case "post-publish":
      label = "Board post";
      href = `/boards?board=${item.boardId}&section=posts&post=${item.postId}`;
      actionLabel = "Open post";
      break;
    case "event-reminder":
      label = "Event reminder";
      href = `/boards?board=${item.boardId}&section=calendar&event=${item.eventId}`;
      actionLabel = "Open event";
      break;
    case "backup-failed":
      label = "Backup failed";
      href = "/manage?view=backup";
      actionLabel = "Open backup history";
      break;
    case "record-assigned":
      label = "Record assignment";
      href = `/openview?section=views&module=${item.moduleId}&record=${item.subjectId}`;
      actionLabel = "Open record";
      break;
    case "invitation-accepted":
      label = "Invitation accepted";
      href = `/access?view=people&user=${item.subjectId}`;
      actionLabel = "Open person";
      break;
    case "sandbox-published":
      label = "Sandbox publication";
      href = "/sandbox?section=history";
      actionLabel = "Open version history";
      break;
    case "access-changed":
      label = "Access changed";
      href = null;
      actionLabel = "";
      break;
  }
  const timeLabel =
    item.kind === "post-publish"
      ? "Publication time"
      : item.kind === "event-reminder"
        ? "Reminder due"
        : "Scheduled";
  return { label, href, actionLabel, timeLabel };
}
