import { Alert } from "@/components/ui/alert";
import type { LifecyclePurgePreview } from "@/lib/lifecycle";
import { formatWorkspaceDateTime, type WorkspaceRegion } from "@/lib/date-time";

const entityLabels: Record<string, readonly [string, string]> = {
  boards: ["Board", "Boards"],
  board: ["Board", "Boards"],
  records: ["record", "records"],
  record: ["record", "records"],
  relationship_edges: ["link", "links"],
  board_posts: ["post", "posts"],
  board_post_revisions: ["post revision", "post revisions"],
  board_groups: ["group assignment", "group assignments"],
  board_events: ["event", "events"],
  board_event_reminders: ["event reminder", "event reminders"],
  board_attachments: ["attachment", "attachments"],
  board_post_revision_attachments: [
    "post revision attachment",
    "post revision attachments",
  ],
  board_record_links: ["Board link", "Board links"],
  board_calendar_sources: ["calendar record source", "calendar record sources"],
  board_post_revision_record_links: [
    "post revision link",
    "post revision links",
  ],
  files: ["file", "files"],
  scheduled_work: ["scheduled task", "scheduled tasks"],
  in_app_notifications: ["notification", "notifications"],
  reports: ["report", "reports"],
  report_runs: ["report run", "report runs"],
  report_run_rows: ["report result", "report results"],
  dashboard_widgets: ["Dashboard widget", "Dashboard widgets"],
  charts: ["chart", "charts"],
  record_triggers: ["trigger", "triggers"],
  record_trigger_conditions: ["trigger condition", "trigger conditions"],
  record_trigger_actions: ["trigger action", "trigger actions"],
  record_trigger_history: [
    "automation history entry",
    "automation history entries",
  ],
  sandbox_bindings: ["design binding", "design bindings"],
};

type LifecyclePurgeReviewProps = {
  preview: LifecyclePurgePreview;
  region?: WorkspaceRegion;
};

function impactGroup(entityType: string): string {
  return entityType === "record_trigger_events" ||
    entityType === "record_trigger_runs"
    ? "record_trigger_history"
    : entityType;
}

/** The same review of server-owned impact precedes each target's confirmation. */
export function LifecyclePurgeReview({
  preview,
  region = { locale: "en-US", timezone: "UTC" },
}: LifecyclePurgeReviewProps) {
  const { impact, last_successful_backup_at } = preview;
  const counts = new Map<string, number>();
  for (const row of impact.rows) {
    const group = impactGroup(row.entity_type);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  const groups = Array.from(counts, ([entityType, count]) => {
    const labels = entityLabels[entityType];
    const label =
      labels?.[count === 1 ? 0 : 1] ?? entityType.replaceAll("_", " ");
    return `${count} ${label}`;
  });
  const summary = groups.length
    ? `This permanently removes ${new Intl.ListFormat("en", { type: "conjunction" }).format(groups)}.`
    : "No items are included in this permanent-deletion review.";

  return (
    <div className="space-y-3">
      <p className="text-sm" role="status">
        {summary}
      </p>
      <p className="text-muted-foreground text-sm break-words">
        Last successful backup:{" "}
        {last_successful_backup_at === null
          ? "No successful backup recorded."
          : `${formatWorkspaceDateTime(last_successful_backup_at, region)} · ${region.timezone}`}
      </p>
      {impact.external_impacts.length > 0 ? (
        <div className="space-y-2 text-sm">
          <p className="font-medium">Links to other records</p>
          <ul className="list-disc space-y-2 pl-5">
            {impact.external_impacts.map((external) => (
              <li
                key={`${external.edge_id}-${external.external_record_id}`}
                className="break-words"
              >
                Link to {external.external_record_label} in{" "}
                {external.external_module_label ||
                  external.external_module_name}{" "}
                (
                {external.external_department_label ||
                  external.external_department_name}
                ) will be removed.
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {impact.blockers.length > 0 ? (
        <Alert variant="warning" role="alert">
          <p className="font-medium">Permanent deletion is blocked</p>
          <p className="mt-1">Resolve these dependencies, then review again.</p>
          <ul className="mt-2 list-disc space-y-2 pl-5">
            {impact.blockers.map((blocker) => (
              <li
                key={`${blocker.code}-${blocker.entity_type}-${blocker.entity_id}`}
                className="break-words"
              >
                {blocker.detail}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
    </div>
  );
}
