import { Temporal } from "@js-temporal/polyfill";

import {
  formatWorkspaceDate,
  formatWorkspaceDateTime,
  type WorkspaceRegion,
} from "@/lib/date-time";

import type { ManageAuditLog } from "../adapters/audit-api";

/**
 * Audit rules for Manage › Audit (docs/specs/manage-relayout.md MD6, MD7,
 * MD13). Each audit row names a table (`entity_type`); these rules turn it
 * into words a person reads, decide which rows are machine updates, and
 * format the changed values.
 */

type Kind = { noun: string; plural: string; area: string };

/**
 * Every audited table the server writes, as a noun and the page it belongs
 * to, in customer words (glossary "Internal" terms such as Binding are not
 * shown). Tables whose audit is off (`__audit_enabled__ = False`) are absent.
 * An unknown table reads "Item" in "Other", never its split table name.
 */
const kinds: Readonly<Record<string, Kind>> = {
  records: { noun: "Record", plural: "Records", area: "Sandbox" },
  relationship_edges: { noun: "Link", plural: "Links", area: "Sandbox" },
  departments: { noun: "Department", plural: "Departments", area: "Sandbox" },
  modules: { noun: "Module", plural: "Modules", area: "Sandbox" },
  fields: { noun: "Field", plural: "Fields", area: "Sandbox" },
  record_triggers: { noun: "Trigger", plural: "Triggers", area: "Sandbox" },
  record_trigger_actions: {
    noun: "Trigger action",
    plural: "Trigger actions",
    area: "Sandbox",
  },
  record_trigger_conditions: {
    noun: "Trigger condition",
    plural: "Trigger conditions",
    area: "Sandbox",
  },
  record_trigger_events: {
    noun: "Trigger event",
    plural: "Trigger events",
    area: "Sandbox",
  },
  record_trigger_runs: {
    noun: "Trigger run",
    plural: "Trigger runs",
    area: "Sandbox",
  },
  sandbox_bindings: {
    noun: "Live item link",
    plural: "Live item links",
    area: "Sandbox",
  },
  sandbox_documents: {
    noun: "Sandbox design",
    plural: "Sandbox designs",
    area: "Sandbox",
  },
  sandbox_publications: {
    noun: "Published change",
    plural: "Published changes",
    area: "Sandbox",
  },
  sandbox_test_runs: { noun: "Test run", plural: "Test runs", area: "Sandbox" },
  sandbox_versions: { noun: "Version", plural: "Versions", area: "Sandbox" },
  users: { noun: "Person", plural: "People", area: "Access" },
  memberships: {
    noun: "Organization member",
    plural: "Organization members",
    area: "Access",
  },
  groups: { noun: "Group", plural: "Groups", area: "Access" },
  group_members: {
    noun: "Group member",
    plural: "Group members",
    area: "Access",
  },
  group_access: {
    noun: "Group access",
    plural: "Group access",
    area: "Access",
  },
  organizations: {
    noun: "Organization",
    plural: "Organizations",
    area: "Manage",
  },
  platform_settings: { noun: "Setting", plural: "Settings", area: "Manage" },
  backup_policies: {
    noun: "Backup schedule",
    plural: "Backup schedules",
    area: "Manage",
  },
  backup_runs: { noun: "Backup", plural: "Backups", area: "Manage" },
  backup_export_operations: {
    noun: "Backup export",
    plural: "Backup exports",
    area: "Manage",
  },
  update_statuses: {
    noun: "Update check",
    plural: "Update checks",
    area: "Manage",
  },
  boards: { noun: "Board", plural: "Boards", area: "Boards" },
  board_groups: { noun: "Board group", plural: "Board groups", area: "Boards" },
  board_widgets: { noun: "Widget", plural: "Widgets", area: "Boards" },
  saved_views: { noun: "View", plural: "Views", area: "OpenView" },
  dashboards: { noun: "Dashboard", plural: "Dashboards", area: "OpenView" },
  dashboard_widgets: {
    noun: "Dashboard widget",
    plural: "Dashboard widgets",
    area: "OpenView",
  },
  charts: { noun: "Chart", plural: "Charts", area: "OpenView" },
  reports: { noun: "Report", plural: "Reports", area: "OpenView" },
  report_runs: { noun: "Report run", plural: "Report runs", area: "OpenView" },
  report_run_rows: {
    noun: "Report result",
    plural: "Report results",
    area: "OpenView",
  },
  files: { noun: "File", plural: "Files", area: "Platform" },
  in_app_notifications: {
    noun: "Notification",
    plural: "Notifications",
    area: "Notifications",
  },
  comms_conversations: {
    noun: "Conversation",
    plural: "Conversations",
    area: "OpenComms",
  },
  comms_messages: { noun: "Message", plural: "Messages", area: "OpenComms" },
  comms_categories: {
    noun: "Category",
    plural: "Categories",
    area: "OpenComms",
  },
  comms_settings: {
    noun: "OpenComms setting",
    plural: "OpenComms settings",
    area: "OpenComms",
  },
};
const unknownKind: Kind = {
  noun: "Item",
  plural: "Items",
  area: "Other",
};

export function auditKind(entityType: string): Kind {
  return Object.hasOwn(kinds, entityType) ? kinds[entityType]! : unknownKind;
}

/** The Area filter's option label for a table. */
export function auditKindLabel(entityType: string): string {
  const kind = auditKind(entityType);
  return kind.plural === kind.area
    ? kind.plural
    : `${kind.plural} · ${kind.area}`;
}

/**
 * Tables the server writes as a side effect of something else: delivering or
 * reading a notification, running a trigger or a report, checking for an
 * update. Folding them keeps a person's own changes in view (M-F5).
 */
const systemKinds: ReadonlySet<string> = new Set([
  "in_app_notifications",
  "record_trigger_events",
  "record_trigger_runs",
  "report_run_rows",
  "update_statuses",
]);

export function isSystemEvent(
  log: Pick<ManageAuditLog, "entity_type">,
): boolean {
  return systemKinds.has(log.entity_type);
}

export type AuditListEntry =
  | { kind: "event"; log: ManageAuditLog }
  /** One row for this page's system events, where the first of them sits. */
  | { kind: "system"; count: number; shown: boolean };

/**
 * The rows of one page. System events fold into one row; when shown, that
 * row stays and the events follow in order. A search lists every match, and
 * so does a system kind chosen as the Area (`entity`), whose page would
 * otherwise be one fold row.
 */
export function auditListEntries(
  logs: readonly ManageAuditLog[],
  {
    showSystem,
    searching,
    entity = "",
  }: { showSystem: boolean; searching: boolean; entity?: string },
): AuditListEntry[] {
  if (searching || systemKinds.has(entity))
    return logs.map((log) => ({ kind: "event", log }));
  const count = logs.filter(isSystemEvent).length;
  const entries: AuditListEntry[] = [];
  let folded = false;
  for (const log of logs) {
    const system = isSystemEvent(log);
    if (system && !folded) {
      entries.push({ kind: "system", count, shown: showSystem });
      folded = true;
    }
    if (!system || showSystem) entries.push({ kind: "event", log });
  }
  return entries;
}

type ChoiceStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const SHOW_SYSTEM_PREFIX = "openslate:audit:show-system:";

function choiceStore(storage: ChoiceStore | null | undefined) {
  if (storage !== undefined) return storage;
  return typeof window === "undefined" ? null : window.localStorage;
}

/** Whether this viewer chose Show; blocked storage keeps the fold. */
export function readShowSystemEvents(
  viewerId: string,
  storage?: ChoiceStore | null,
): boolean {
  try {
    return (
      choiceStore(storage)?.getItem(SHOW_SYSTEM_PREFIX + viewerId) === "show"
    );
  } catch {
    return false;
  }
}

export function writeShowSystemEvents(
  viewerId: string,
  show: boolean,
  storage?: ChoiceStore | null,
): void {
  try {
    const store = choiceStore(storage);
    if (show) store?.setItem(SHOW_SYSTEM_PREFIX + viewerId, "show");
    else store?.removeItem(SHOW_SYSTEM_PREFIX + viewerId);
  } catch {
    // Private windows and blocked storage keep the fold for this visit.
  }
}

const UNAVAILABLE_SUFFIX = " · name unavailable";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * The record's name (MD13). A record reads as its title ("Q-1042"); other
 * kinds add their noun ("Group Sales Desk"). Without a name, the kind and the
 * short record id ("Notification 3f2a1b9c").
 */
export function auditTargetName(
  log: Pick<ManageAuditLog, "entity_type" | "entity_id" | "target_label">,
): string {
  const kind = auditKind(log.entity_type);
  const label = log.target_label.trim();
  if (!label || label.endsWith(UNAVAILABLE_SUFFIX))
    return log.entity_id ? `${kind.noun} ${shortId(log.entity_id)}` : kind.noun;
  return log.entity_type === "records" ? label : `${kind.noun} ${label}`;
}

/** The department the change belongs to, else the page of its kind. */
export function auditArea(
  log: Pick<ManageAuditLog, "entity_type" | "department_id">,
  departmentNames: ReadonlyMap<string, string>,
): string {
  const department = log.department_id
    ? departmentNames.get(log.department_id)
    : undefined;
  return department ?? auditKind(log.entity_type).area;
}

/** A column name as words; a record field id keeps a short id. */
export function auditFieldLabel(key: string): string {
  if (uuidPattern.test(key)) return `Field ${shortId(key)}`;
  const words = key
    .replace(/^is_/, "")
    .replace(/_id$/, "")
    .split(/_+/)
    .filter(Boolean)
    .join(" ");
  if (!words) return key;
  return words[0]!.toUpperCase() + words.slice(1);
}

const REDACTED = "[REDACTED]";
const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

/** A recorded value as words: Not set, Yes or No, organization dates. */
export function auditValueText(
  value: unknown,
  region: WorkspaceRegion | undefined,
): string {
  if (value === null || value === undefined || value === "") return "Not set";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (value === REDACTED) return "Hidden";
    if (region && isoDateTime.test(value))
      return formatWorkspaceDateTime(value, region);
    if (region && isoDate.test(value))
      return formatWorkspaceDate(value, region);
    return value;
  }
  if (Array.isArray(value))
    return value.length
      ? value.map((item) => auditValueText(item, region)).join(", ")
      : "None";
  return JSON.stringify(value) ?? String(value);
}

export type AuditChange = {
  key: string;
  label: string;
  before: string;
  after: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Names of record fields by id, as `GET /fields/{id}` returns them (MD16). */
export type AuditFieldNames = ReadonlyMap<string, string>;
const noFieldNames: AuditFieldNames = new Map();

type ChangedKey = {
  key: string;
  label: string;
  /** False for a record field id with no name: it reads "Field 9e8d7c6b". */
  named: boolean;
  old: unknown;
  next: unknown;
};

/** The keys of both snapshots, nested maps (a record's `data`) one level in. */
function changedKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fieldNames: AuditFieldNames,
): ChangedKey[] {
  const keys = [
    ...Object.keys(after),
    ...Object.keys(before).filter((key) => !Object.hasOwn(after, key)),
  ];
  return keys.flatMap((key) => {
    const old = before[key];
    const next = after[key];
    if (
      (isPlainObject(old) || old === undefined) &&
      (isPlainObject(next) || next === undefined) &&
      (isPlainObject(old) || isPlainObject(next))
    )
      return changedKeys(
        isPlainObject(old) ? old : {},
        isPlainObject(next) ? next : {},
        fieldNames,
      ).map((nested) => ({ ...nested, key: `${key}.${nested.key}` }));
    const name = fieldNames.get(key);
    const fieldId = uuidPattern.test(key);
    return [
      {
        key,
        label: name ?? auditFieldLabel(key),
        named: !fieldId || name !== undefined,
        old,
        next,
      },
    ];
  });
}

/** The record field ids these rows change, each once, in order. */
export function auditFieldIds(
  logs: readonly Pick<ManageAuditLog, "before" | "after">[],
): string[] {
  const ids = new Set<string>();
  for (const log of logs)
    for (const { key } of changedKeys(
      log.before ?? {},
      log.after ?? {},
      noFieldNames,
    )) {
      const last = key.split(".").at(-1)!;
      if (uuidPattern.test(last)) ids.add(last);
    }
  return [...ids];
}

/**
 * Old → new for each value that differs; equal values are left out, except
 * a redacted value, which the server records only when it changed.
 */
export function auditChanges(
  log: Pick<ManageAuditLog, "before" | "after">,
  region: WorkspaceRegion | undefined,
  fieldNames: AuditFieldNames = noFieldNames,
): AuditChange[] {
  return changedKeys(log.before ?? {}, log.after ?? {}, fieldNames).flatMap(
    ({ key, label, old, next }) => {
      const before = auditValueText(old, region);
      const after = auditValueText(next, region);
      // A redacted value that changed still shows, as Hidden on both sides.
      return before === after && before !== "Hidden"
        ? []
        : [{ key, label, before, after }];
    },
  );
}

const verbs = { create: "Created", update: "Changed", delete: "Deleted" };

export type AuditSentence = {
  verb: string;
  /** The changed fields of an update; null when none are named. */
  fields: string | null;
  target: string;
};

function fieldSummary(
  log: Pick<ManageAuditLog, "before" | "after">,
  fieldNames: AuditFieldNames,
) {
  const keys = changedKeys(log.before ?? {}, log.after ?? {}, fieldNames);
  if (!keys.length) return null;
  const named = keys.filter((key) => key.named);
  if (!named.length)
    return keys.length === 1 ? "1 field" : `${keys.length} fields`;
  const shown = named.slice(0, 2).map(({ label }) => label);
  const more = keys.length - shown.length;
  return more ? `${shown.join(", ")} +${more}` : shown.join(", ");
}

/**
 * The row sentence (MD16): the verb, up to two changed fields and a count of
 * the rest, then the target.
 */
export function auditSentence(
  log: ManageAuditLog,
  fieldNames: AuditFieldNames = noFieldNames,
): AuditSentence {
  return {
    verb: verbs[log.action],
    fields: log.action === "update" ? fieldSummary(log, fieldNames) : null,
    target: auditTargetName(log),
  };
}

/** Between the change and its target in the row sentence (MD16). */
export const AUDIT_SENTENCE_SEPARATOR = " · ";

function sentenceWith(
  log: ManageAuditLog,
  fieldNames: AuditFieldNames,
  separator: string,
): string {
  const { verb, fields, target } = auditSentence(log, fieldNames);
  return `${fields ? `${verb} ${fields}` : verb}${separator}${target}`;
}

/** "Changed Status, Sent on +3 · Q-1042", "Created · WO-3381". */
export function auditSentenceText(
  log: ManageAuditLog,
  fieldNames: AuditFieldNames = noFieldNames,
): string {
  return sentenceWith(log, fieldNames, AUDIT_SENTENCE_SEPARATOR);
}

/** The sentence as an accessible name: a period where the row shows "·". */
export function auditSentenceName(
  log: ManageAuditLog,
  fieldNames: AuditFieldNames = noFieldNames,
): string {
  return sentenceWith(log, fieldNames, ". ");
}

function zonedDay(value: string | Date, timezone: string) {
  const instant =
    typeof value === "string"
      ? Temporal.Instant.from(value)
      : Temporal.Instant.fromEpochMilliseconds(value.getTime());
  return instant.toZonedDateTimeISO(timezone).toPlainDate();
}

/**
 * "Today 3:07 PM", "Yesterday 5:40 PM", then "Oct 22, 9:05 AM" this year and
 * the whole date before it, or whenever the viewer chose a date order.
 */
export function auditRowTime(
  value: string,
  now: Date,
  region: WorkspaceRegion,
  { seconds = false }: { seconds?: boolean } = {},
): string {
  const day = zonedDay(value, region.timezone);
  const today = zonedDay(now, region.timezone);
  const clock: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    second: seconds ? "2-digit" : undefined,
  };
  const time = formatWorkspaceDateTime(value, region, clock);
  if (Temporal.PlainDate.compare(day, today) === 0) return `Today ${time}`;
  if (Temporal.PlainDate.compare(day, today.subtract({ days: 1 })) === 0)
    return `Yesterday ${time}`;
  // A personal date order (ymd, dmy, mdy) needs the whole date to apply.
  const personalOrder =
    region.dateFormat !== undefined && region.dateFormat !== "organization";
  return formatWorkspaceDateTime(
    value,
    region,
    day.year === today.year && !personalOrder
      ? { month: "short", day: "numeric", ...clock }
      : { dateStyle: "medium", timeStyle: seconds ? "medium" : "short" },
  );
}

export const AUDIT_EXPORT_LIMIT = 10_000;

/** Why Export is off for this many matching events, or null (MD7). */
export function auditExportBlockedReason(total: number): string | null {
  return total > AUDIT_EXPORT_LIMIT
    ? "Narrow the filters to 10,000 events or fewer to export."
    : null;
}
