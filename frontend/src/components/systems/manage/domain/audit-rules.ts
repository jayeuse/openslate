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
 * Each kind has its own label, so the Area filter never lists two the same
 * (Phase 8, MG26); an unknown table reads as its own name in "Other".
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
  platform_operators: {
    noun: "Installation owner",
    plural: "Installation owners",
    area: "Manage",
  },
  boards: { noun: "Board", plural: "Boards", area: "Boards" },
  board_groups: { noun: "Board group", plural: "Board groups", area: "Boards" },
  board_widgets: { noun: "Widget", plural: "Widgets", area: "Boards" },
  board_posts: { noun: "Post", plural: "Posts", area: "Boards" },
  board_post_revisions: {
    noun: "Post edit",
    plural: "Post edits",
    area: "Boards",
  },
  board_post_revision_attachments: {
    noun: "Post edit attachment",
    plural: "Post edit attachments",
    area: "Boards",
  },
  board_post_revision_record_links: {
    noun: "Post edit record link",
    plural: "Post edit record links",
    area: "Boards",
  },
  board_attachments: {
    noun: "Board attachment",
    plural: "Board attachments",
    area: "Boards",
  },
  board_record_links: {
    noun: "Board record link",
    plural: "Board record links",
    area: "Boards",
  },
  board_events: { noun: "Event", plural: "Events", area: "Boards" },
  board_event_reminders: {
    noun: "Event reminder",
    plural: "Event reminders",
    area: "Boards",
  },
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
  report_schedules: {
    noun: "Report schedule",
    plural: "Report schedules",
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
  comms_members: {
    noun: "Conversation member",
    plural: "Conversation members",
    area: "OpenComms",
  },
  comms_channel_access: {
    noun: "Channel access",
    plural: "Channel access",
    area: "OpenComms",
  },
  comms_capability_grants: {
    noun: "OpenComms permission",
    plural: "OpenComms permissions",
    area: "OpenComms",
  },
  comms_setting_locks: {
    noun: "Locked setting",
    plural: "Locked settings",
    area: "OpenComms",
  },
  comms_direct_blocks: {
    noun: "Blocked person",
    plural: "Blocked people",
    area: "OpenComms",
  },
  comms_threads: { noun: "Thread", plural: "Threads", area: "OpenComms" },
  comms_message_revisions: {
    noun: "Message edit",
    plural: "Message edits",
    area: "OpenComms",
  },
  comms_message_attachments: {
    noun: "Message attachment",
    plural: "Message attachments",
    area: "OpenComms",
  },
  comms_message_record_links: {
    noun: "Message record link",
    plural: "Message record links",
    area: "OpenComms",
  },
  comms_mentions: { noun: "Mention", plural: "Mentions", area: "OpenComms" },
  comms_reactions: { noun: "Reaction", plural: "Reactions", area: "OpenComms" },
  comms_reports: {
    noun: "Reported message",
    plural: "Reported messages",
    area: "OpenComms",
  },
  comms_templates: {
    noun: "Message template",
    plural: "Message templates",
    area: "OpenComms",
  },
  comms_schedules: {
    noun: "Scheduled message",
    plural: "Scheduled messages",
    area: "OpenComms",
  },
  comms_exports: {
    noun: "OpenComms export",
    plural: "OpenComms exports",
    area: "OpenComms",
  },
  comms_retention_policies: {
    noun: "Message retention setting",
    plural: "Message retention settings",
    area: "OpenComms",
  },
  comms_retention_sweeps: {
    noun: "Message retention cleanup",
    plural: "Message retention cleanups",
    area: "OpenComms",
  },
  // Retired tables whose audit history stays (MG35): join requests and
  // invitations (`comms_admissions`), and a group's read or post access to a
  // conversation or category (`comms_conversation_groups`, now
  // `comms_channel_access`).
  comms_admissions: {
    noun: "Join request",
    plural: "Join requests",
    area: "OpenComms",
  },
  comms_conversation_groups: {
    noun: "Conversation group access",
    plural: "Conversation group access",
    area: "OpenComms",
  },
  // Tables whose audit is off now, which older history may still name.
  comms_member_preferences: {
    noun: "Conversation preference",
    plural: "Conversation preferences",
    area: "OpenComms",
  },
  comms_personal_preferences: {
    noun: "OpenComms preference",
    plural: "OpenComms preferences",
    area: "OpenComms",
  },
  comms_read_states: {
    noun: "Read position",
    plural: "Read positions",
    area: "OpenComms",
  },
  comms_thread_follows: {
    noun: "Followed thread",
    plural: "Followed threads",
    area: "OpenComms",
  },
};

/** The page an unknown table's prefix names; its words drop the prefix. */
const prefixAreas: readonly (readonly [string, string])[] = [
  ["comms_", "OpenComms"],
  ["board_", "Boards"],
  ["sandbox_", "Sandbox"],
  ["record_", "Sandbox"],
  ["report_", "OpenView"],
  ["identity_", "Access"],
];

/**
 * "foo_bars" reads "Foo bars", one "Foo bar": its own name, never "Item"; a
 * known prefix names the page ("comms_x" is "X" in OpenComms, never "Comms").
 */
function readableKind(entityType: string): Kind {
  const prefix = prefixAreas.find(([start]) => entityType.startsWith(start));
  const rest = prefix ? entityType.slice(prefix[0].length) : entityType;
  const words = rest.split(/_+/).filter(Boolean).join(" ") || "Item";
  const plural = words[0]!.toUpperCase() + words.slice(1);
  const noun = plural.endsWith("ies")
    ? `${plural.slice(0, -3)}y`
    : plural.endsWith("s") && !plural.endsWith("ss")
      ? plural.slice(0, -1)
      : plural;
  return { noun, plural, area: prefix?.[1] ?? "Other" };
}

export function auditKind(entityType: string): Kind {
  return Object.hasOwn(kinds, entityType)
    ? kinds[entityType]!
    : readableKind(entityType);
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

/** A record field's type and its select options (option id to label). */
export type AuditFieldKind = {
  type: string;
  options: ReadonlyMap<string, string>;
};

/**
 * Names the page already loaded, by id (Phase 8): the current organization
 * (the server has no name for it, since its row holds `display_name`), the
 * people the Person filter lists, the departments the Area column names,
 * and record fields' types and options from the field reads.
 */
export type AuditKnownNames = {
  organizations?: ReadonlyMap<string, string>;
  people?: ReadonlyMap<string, string>;
  departments?: ReadonlyMap<string, string>;
  fields?: ReadonlyMap<string, AuditFieldKind>;
};
const noKnownNames: AuditKnownNames = {};

/** Values that name a record when the server sent no name (MD20). */
const OWN_NAME_KEYS = [
  "display_name",
  "label",
  "subject",
  "department_name",
  "module_name",
];
/** Kinds whose record is a person's place in something: named by the person. */
const PERSON_RECORD_KINDS: ReadonlySet<string> = new Set([
  "group_members",
  "memberships",
  "comms_members",
  "platform_operators",
  "comms_direct_blocks",
]);

function ownName(
  log: Pick<ManageAuditLog, "entity_type" | "before" | "after">,
  names: AuditKnownNames,
): string | null {
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() && value !== "[REDACTED]"
      ? value.trim()
      : null;
  for (const values of [log.after, log.before]) {
    if (!values) continue;
    for (const key of OWN_NAME_KEYS) {
      const name = text(values[key]);
      if (name) return name;
    }
    if (log.entity_type.endsWith("settings")) {
      const key = text(values.key);
      if (key) return key;
    }
    if (PERSON_RECORD_KINDS.has(log.entity_type)) {
      const id = values.user_id ?? values.blocked_user_id;
      const person = typeof id === "string" ? names.people?.get(id) : null;
      if (person) return person;
    }
  }
  return null;
}

/**
 * The record's name (MD13, MD20). A record reads as its title ("Q-1042");
 * other kinds add their noun ("Group Sales Desk"). Without the server's
 * name, in order: the loaded organization name; a name in the event's own
 * values (display name, label, subject, department or module name, a
 * setting's key); for a person's membership, the person's loaded name; and
 * only then the kind alone ("Test run"), never a short id.
 */
export function auditTargetName(
  log: Pick<ManageAuditLog, "entity_type" | "entity_id" | "target_label"> &
    Partial<Pick<ManageAuditLog, "before" | "after">>,
  names: AuditKnownNames = noKnownNames,
): string {
  const kind = auditKind(log.entity_type);
  const label = log.target_label.trim();
  if (!label || label.endsWith(UNAVAILABLE_SUFFIX)) {
    const known =
      (log.entity_type === "organizations" && log.entity_id
        ? names.organizations?.get(log.entity_id)
        : undefined) ??
      ownName(
        {
          entity_type: log.entity_type,
          before: log.before ?? null,
          after: log.after ?? null,
        },
        names,
      );
    if (known) return `${kind.noun} ${known}`;
    // The kind alone: rows already differ by person and time, and the id
    // stays in the event sheet's Advanced (owner decision, MD20).
    return kind.noun;
  }
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
  /** Null for a reference with no loaded name: `after` alone says what. */
  before: string | null;
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
  /** Bookkeeping the server keeps: shown only in Advanced (Phase 8). */
  system: boolean;
  /**
   * For a reference (a person, a department, another record, a select
   * option): the loaded name of an id, if any. A reference without one reads
   * Set, Changed or Removed, never the id (MD20).
   */
  resolve?: (id: string) => string | undefined;
  old: unknown;
  next: unknown;
};

/** Bookkeeping columns: revisions, timestamps, keys, digests and ids. */
const SYSTEM_KEYS: ReadonlySet<string> = new Set([
  "id",
  "revision",
  "created_at",
  "updated_at",
  "schema_version",
  "singleton_key",
  "idempotency_key",
  "client_key",
  "lease_token",
  "lease_expires_at",
  "seq",
  "last_seq",
  "sequence",
  "digest",
  "fingerprint",
]);
const SYSTEM_SUFFIXES = [
  "_id",
  "_ids",
  "_digest",
  "_hash",
  "_fingerprint",
  "_generation",
  "_revision",
  "_tsv",
  "_token",
];

/** Person columns: a name when the page has it, else Set or Changed. */
const PERSON_KEYS: Readonly<Record<string, string>> = {
  user_id: "Person",
  author_id: "Author",
  recipient_id: "Recipient",
  owner_user_id: "Owner",
  sponsor_user_id: "Sponsor",
  blocked_user_id: "Blocked person",
  creator_id: "Created by",
  requester_id: "Requested by",
  reporter_id: "Reported by",
  publisher_id: "Published by",
};

/**
 * Columns that point at something a person knows (MD20): they stay labelled
 * rows, with the name when the page has it, else Set, Changed or Removed.
 * Every other id column is bookkeeping.
 */
const REFERENCE_LABELS: Readonly<Record<string, string>> = {
  department_id: "Department",
  module_id: "Module",
  group_id: "Group",
  category_id: "Category",
  conversation_id: "Conversation",
  title_field_id: "Title field",
  relationship_target_module_id: "Linked module",
  field_id: "Field",
  target_field_id: "Target field",
  value_field_id: "Value field",
  trigger_field_id: "Trigger field",
  board_id: "Board",
  record_id: "Record",
  target_record_id: "Target record",
  source_record_id: "Source record",
  dashboard_id: "Dashboard",
  chart_id: "Chart",
  report_id: "Report",
  trigger_id: "Trigger",
  parent_id: "Parent",
  reply_to_id: "Reply to",
  message_id: "Message",
  post_id: "Post",
  file_id: "File",
  logo_file_id: "Logo",
  avatar_file_id: "Photo",
};

/** A system column (not a record field, whose key is a field id). */
export function isAuditSystemField(key: string): boolean {
  if (uuidPattern.test(key)) return false;
  if (
    Object.hasOwn(PERSON_KEYS, key) ||
    Object.hasOwn(REFERENCE_LABELS, key) ||
    key.endsWith("_by")
  )
    return false;
  return (
    SYSTEM_KEYS.has(key) ||
    SYSTEM_SUFFIXES.some((suffix) => key.endsWith(suffix))
  );
}

/** How a column reads: its label and, for a reference, its name lookup. */
function keyRole(
  key: string,
  fieldNames: AuditFieldNames,
  names: AuditKnownNames,
): Pick<ChangedKey, "label" | "named" | "system" | "resolve"> {
  const people = (id: string) => names.people?.get(id);
  if (uuidPattern.test(key)) {
    // A record's own field: an option label, a person, or another record.
    const name = fieldNames.get(key);
    const field = names.fields?.get(key);
    return {
      label: name ?? auditFieldLabel(key),
      named: name !== undefined,
      system: false,
      resolve:
        field?.type === "select"
          ? (id) => field.options.get(id)
          : field?.type === "user"
            ? people
            : undefined,
    };
  }
  if (Object.hasOwn(PERSON_KEYS, key) || key.endsWith("_by"))
    return {
      label: PERSON_KEYS[key] ?? auditFieldLabel(key),
      named: true,
      system: false,
      resolve: people,
    };
  if (Object.hasOwn(REFERENCE_LABELS, key))
    return {
      label: REFERENCE_LABELS[key]!,
      named: true,
      system: false,
      resolve:
        key === "department_id"
          ? (id) => names.departments?.get(id)
          : key.endsWith("field_id")
            ? (id) => fieldNames.get(id)
            : () => undefined,
    };
  return {
    label: auditFieldLabel(key),
    named: true,
    system: isAuditSystemField(key),
  };
}

/** The keys of both snapshots, nested maps (a record's `data`) one level in. */
function changedKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fieldNames: AuditFieldNames,
  names: AuditKnownNames = noKnownNames,
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
        names,
      ).map((nested) => ({ ...nested, key: `${key}.${nested.key}` }));
    const role = keyRole(key, fieldNames, names);
    // A record value that holds an id with no known kind is a reference too.
    const resolve =
      role.resolve ??
      (uuidPattern.test(key) &&
      [old, next].some(
        (value) => typeof value === "string" && uuidPattern.test(value),
      )
        ? () => undefined
        : undefined);
    return [{ key, ...role, resolve, old, next }];
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

/** The keys of a change that differ, system values included. */
function differingKeys(
  log: Pick<ManageAuditLog, "before" | "after">,
  fieldNames: AuditFieldNames,
  names: AuditKnownNames,
): ChangedKey[] {
  return changedKeys(
    log.before ?? {},
    log.after ?? {},
    fieldNames,
    names,
  ).filter(({ old, next }) => {
    const before = auditValueText(old, undefined);
    const after = auditValueText(next, undefined);
    // A redacted value that changed still shows, as Hidden on both sides.
    return before !== after || before === "Hidden";
  });
}

/**
 * Old → new for each value that differs; equal values are left out, except
 * a redacted value, which the server records only when it changed. System
 * values (revision, timestamps, ids) stay in Advanced (Phase 8); a person id
 * reads as a name the page already loaded, else it stays there too.
 */
export function auditChanges(
  log: Pick<ManageAuditLog, "before" | "after">,
  region: WorkspaceRegion | undefined,
  fieldNames: AuditFieldNames = noFieldNames,
  names: AuditKnownNames = noKnownNames,
): AuditChange[] {
  return differingKeys(log, fieldNames, names).flatMap(
    ({ key, label, system, resolve, old, next }): AuditChange[] => {
      if (system) return [];
      if (!resolve)
        return [
          {
            key,
            label,
            before: auditValueText(old, region),
            after: auditValueText(next, region),
          },
        ];
      const before = referenceText(old, resolve);
      const after = referenceText(next, resolve);
      // Every id has a loaded name: old → new as names.
      if (before !== undefined && after !== undefined)
        return [{ key, label, before, after }];
      // Otherwise say what happened, never the id (MD20).
      const empty = (value: unknown) =>
        value === null || value === undefined || value === "";
      return [
        {
          key,
          label,
          before: null,
          after: empty(old) ? "Set" : empty(next) ? "Removed" : "Changed",
        },
      ];
    },
  );
}

/** A reference value as its name(s); undefined when an id has no name. */
function referenceText(
  value: unknown,
  resolve: (id: string) => string | undefined,
): string | undefined {
  if (value === null || value === undefined || value === "") return "Not set";
  const ids = Array.isArray(value) ? value : [value];
  const named = ids.map((id) =>
    typeof id === "string" ? resolve(id) : undefined,
  );
  return named.every((name) => name !== undefined)
    ? named.join(", ") || "None"
    : undefined;
}

/** Values changed, but only system ones: What changed lists nothing. */
export function auditOnlySystemChanges(
  log: Pick<ManageAuditLog, "before" | "after">,
  names: AuditKnownNames = noKnownNames,
): boolean {
  const keys = differingKeys(log, noFieldNames, names);
  return keys.length > 0 && keys.every(({ system }) => system);
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
  names: AuditKnownNames,
) {
  const all = changedKeys(log.before ?? {}, log.after ?? {}, fieldNames, names);
  if (!all.length) return null;
  const keys = all.filter((key) => !key.system);
  // Only bookkeeping changed (a revision, a time): "Changed settings".
  if (!keys.length) return "settings";
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
  names: AuditKnownNames = noKnownNames,
): AuditSentence {
  return {
    verb: verbs[log.action],
    fields:
      log.action === "update" ? fieldSummary(log, fieldNames, names) : null,
    target: auditTargetName(log, names),
  };
}

/** Between the change and its target in the row sentence (MD16). */
export const AUDIT_SENTENCE_SEPARATOR = " · ";

function sentenceWith(
  log: ManageAuditLog,
  fieldNames: AuditFieldNames,
  names: AuditKnownNames,
  separator: string,
): string {
  const { verb, fields, target } = auditSentence(log, fieldNames, names);
  return `${fields ? `${verb} ${fields}` : verb}${separator}${target}`;
}

/** "Changed Status, Sent on +3 · Q-1042", "Created · WO-3381". */
export function auditSentenceText(
  log: ManageAuditLog,
  fieldNames: AuditFieldNames = noFieldNames,
  names: AuditKnownNames = noKnownNames,
): string {
  return sentenceWith(log, fieldNames, names, AUDIT_SENTENCE_SEPARATOR);
}

/** The sentence as an accessible name: a period where the row shows "·". */
export function auditSentenceName(
  log: ManageAuditLog,
  fieldNames: AuditFieldNames = noFieldNames,
  names: AuditKnownNames = noKnownNames,
): string {
  return sentenceWith(log, fieldNames, names, ". ");
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
